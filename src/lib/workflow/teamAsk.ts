/**
 * Ask a teammate (explicit) — multi-agent team, Lane B.
 *
 * One agent asks a specific teammate a question mid-run and (when
 * `requiresResponse` is true) waits for the answer. The asker names the
 * teammate by agent id, role, or name; resolution follows the same
 * ownership rule as `resolveNodes` — an unknown teammate or one the
 * caller does not own is an honest error, never a silent fallback.
 *
 * Both the question and the reply are persisted through the existing
 * message bus (`createMessage`, `agent_messages`): the question as type
 * `task` with `requiresResponse` as requested, the reply as type
 * `result` threaded under it via `parentMessageId`. Every message
 * carries sender/recipient and timestamps from the bus.
 *
 * The recipient's turn runs through the existing `chatCompletion` LLM
 * path, with a prompt built from the question + the conversation so far
 * + shared context. Its output is parsed with the FROZEN turn format
 * shared with all lanes (see `parseTeamTurn`): `{"kind":"final",...}`
 * or `{"kind":"message",...}`; unparsable output is a final answer,
 * never a message. This ask path is single-hop: if the recipient's
 * output parses as a `message` turn, its text is the reply — a nested
 * ask (the recipient questioning a third agent) belongs to the
 * conversation loop, not to this explicit ask.
 *
 * If no inference provider answers, the call throws an honest error —
 * never a fake reply. If `requiresResponse` is false, the question is
 * recorded and the call returns immediately without waiting.
 */

import { chatCompletion, type AgentKey } from '@/lib/llm'
import { getDb } from '@/lib/mongo/mongo'
import type { Agent } from '@/lib/mongo/agent'
// The message bus and the teammate resolver are loaded lazily inside
// askTeammate, not at module top level: this module also exports the pure
// parseTeamTurn helper, and the node dispatcher (which phase1's suite
// requires) must load without pulling the bus in. The bus/resolver are
// only needed when an ask actually runs.

/** One turn of an agent's LLM output, in the frozen team format. */
export type TeamTurn =
  | { kind: 'final'; text: string }
  | { kind: 'message'; to: string; text: string; requiresResponse: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse an agent turn's LLM output in the frozen format:
 *   {"kind":"final","text":"..."} — the turn ends with an answer;
 *   {"kind":"message","to":"<agent id | role | name>","text":"...","requiresResponse":true|false}
 *     — the turn sends a message to a teammate.
 * Unparsable output is treated as a final answer, never a message.
 * A JSON object embedded in surrounding prose is still recognised.
 */
export function parseTeamTurn(raw: string): TeamTurn {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const brace = trimmed.match(/\{[\s\S]*\}/)
  if (brace && brace[0] !== trimmed) candidates.push(brace[0])
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (!isRecord(parsed) || typeof parsed.kind !== 'string') continue
      if (parsed.kind === 'final' && typeof parsed.text === 'string') {
        return { kind: 'final', text: parsed.text }
      }
      if (
        parsed.kind === 'message' &&
        typeof parsed.to === 'string' &&
        typeof parsed.text === 'string'
      ) {
        return {
          kind: 'message',
          to: parsed.to,
          text: parsed.text,
          requiresResponse: parsed.requiresResponse !== false,
        }
      }
    } catch {
      // Not JSON — fall through to the final-answer default.
    }
  }
  return { kind: 'final', text: raw }
}

export type AskTeammateInput = {
  userId: string
  workflowId: string
  workflowRunId: string
  /** The agent asking (the node-running agent, or the run owner). */
  fromAgent: Agent | { _id: string; name?: string; role?: string }
  /** Teammate reference: agent id, role, or name. */
  toRef: string
  text: string
  /** False records the question and returns without waiting for a reply. */
  requiresResponse?: boolean
  /** Conversation so far, oldest first ({ from, text }). */
  conversation?: Array<{ from: string; text: string }>
  /** Shared run context (variables, intermediate results). */
  sharedContext?: unknown
  /** A caller-decrypted key, tried before shared keys (see llm.ts). */
  agentKey?: AgentKey
}

export type AskTeammateResult = {
  toAgent: Agent
  /** The recipient's reply text; null when no reply was requested. */
  reply: string | null
  questionMessageId: string
  replyMessageId: string | null
  provider: string | null
  model: string | null
}

export async function askTeammate(input: AskTeammateInput): Promise<AskTeammateResult> {
  const requiresResponse = input.requiresResponse !== false
  const db = await getDb()
  // Ownership is checked here, before anything is sent: never message an
  // agent the caller does not own.
  const { resolveTeammate } = await import('@/lib/orchestration/resolveTeammate')
  const { createMessage } = await import('@/lib/orchestration/messageBus')
  const toAgent = await resolveTeammate(db, input.userId, input.toRef)
  const fromAgentId = String(input.fromAgent._id)
  const fromName =
    input.fromAgent.name ?? `agent ${fromAgentId.slice(0, 8)}`
  const question = input.text.trim()
  if (!question) {
    throw new Error('Ask-a-teammate needs a question: the ask text is empty.')
  }

  const questionMessage = await createMessage({
    userId: input.userId,
    workflowId: input.workflowId,
    workflowRunId: input.workflowRunId,
    fromAgentId,
    toAgentId: String(toAgent._id),
    type: 'task',
    text: question,
    requiresResponse,
    payload: { fromAgentName: fromName, toAgentName: toAgent.name, question },
  })
  const questionMessageId = String(questionMessage._id)

  if (!requiresResponse) {
    return {
      toAgent,
      reply: null,
      questionMessageId,
      replyMessageId: null,
      provider: null,
      model: null,
    }
  }

  const parts: string[] = []
  parts.push(
    `You are ${toAgent.name}${toAgent.role ? `, the ${toAgent.role} agent` : ''}, answering a teammate's question during a team workflow run.`,
  )
  parts.push(
    `Your teammate ${fromName} asks you:\n${question}`,
  )
  if (input.conversation && input.conversation.length > 0) {
    const lines = input.conversation.map((turn) => `${turn.from}: ${turn.text}`)
    parts.push(`Conversation so far:\n${lines.join('\n')}`)
  }
  if (input.sharedContext !== undefined && input.sharedContext !== null) {
    try {
      parts.push(`Shared context:\n${JSON.stringify(input.sharedContext, null, 2)}`)
    } catch {
      parts.push(`Shared context:\n${String(input.sharedContext)}`)
    }
  }
  parts.push(
    'Answer the question directly. Reply as JSON {"kind":"final","text":"<your answer>"} — just the answer, no extra message.',
  )
  const system =
    toAgent.systemPrompt?.trim() ||
    `You are the "${toAgent.name}" agent in an AgentFlow workflow. Answer naturally and helpfully, like a human assistant.`
  const completion = await chatCompletion({
    system,
    prompt: parts.join('\n\n'),
    maxTokens: toAgent.maxTokenBudget ?? 1200,
    model: toAgent.model,
    temperature: 0.4,
    agentKey: input.agentKey,
  })
  if (!completion.ok) {
    throw new Error(
      `No inference provider answered for teammate ${toAgent.name}: ${completion.failures?.map((f) => f.message).join('; ') || 'unknown'}`,
    )
  }
  const turn = parseTeamTurn(completion.text)
  const replyText = turn.text

  const replyMessage = await createMessage({
    userId: input.userId,
    workflowId: input.workflowId,
    workflowRunId: input.workflowRunId,
    fromAgentId: String(toAgent._id),
    toAgentId: fromAgentId,
    parentMessageId: questionMessageId,
    type: 'result',
    text: replyText,
    requiresResponse: false,
    payload: {
      fromAgentName: toAgent.name,
      toAgentName: fromName,
      provider: completion.provider,
      model: completion.model,
      turnKind: turn.kind,
    },
  })

  return {
    toAgent,
    reply: replyText,
    questionMessageId,
    replyMessageId: String(replyMessage._id),
    provider: completion.provider,
    model: completion.model,
  }
}

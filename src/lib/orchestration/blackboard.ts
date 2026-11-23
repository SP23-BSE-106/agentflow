/**
 * Shared blackboard for a team run (multi-agent team, lane C1).
 *
 * Every agent in a team run sees the same running conversation plus the
 * shared context (variables, intermediate results), so a third agent can
 * build on a conversation between the first two.
 *
 * Storage:
 * - Conversation: the existing `agent_messages` collection, via the
 *   message bus (`messageBus.ts`). No second message store is created.
 * - Variables / intermediate results: the run's existing `shared_contexts`
 *   record, via `contextManager.ts`. The stored shape already holds both,
 *   so nothing about it is extended.
 *
 * Turn format (frozen, shared with all lanes): an agent turn's LLM output
 * is JSON `{"kind":"final","text":"..."}` or
 * `{"kind":"message","to":"<agent id | role | name>","text":"...",
 * "requiresResponse":true|false}`; unparsable output is a final answer.
 * `parseTurnOutput` implements exactly that, and nothing else in this
 * module depends on any other lane's files.
 */

import { ObjectId } from 'mongodb'
import { getDb } from '@/lib/mongo/mongo'
import { getSharedContext, updateSharedContext } from './contextManager'
import { createMessage, listMessages } from './messageBus'
import type { AgentMessage, AgentMessageType } from '@/lib/mongo/agentMessages'
import type { Agent } from '@/lib/mongo/agent'

/** One visible line of the team conversation. */
export type BlackboardEntry = {
  fromAgentId: string
  fromName: string
  fromRole?: string
  toAgentId?: string
  toName?: string
  type: AgentMessageType
  text: string
  requiresResponse: boolean
  parentMessageId?: string
  createdAt: Date
}

/** Everything a team member sees: the whole conversation + shared state. */
export type Blackboard = {
  conversation: BlackboardEntry[]
  variables: Record<string, unknown>
  intermediateResults: Record<string, unknown>
}

/** Default cap for the rendered conversation, in characters. */
export const DEFAULT_MAX_CONVERSATION_CHARS = 6000

/** Default cap for each rendered JSON block (variables / results). */
export const DEFAULT_MAX_JSON_CHARS = 4000

/** Look up display names/roles for the agents in a run's messages. */
async function agentDisplayNames(
  userId: string,
  agentIds: string[],
): Promise<Map<string, { name: string; role?: string }>> {
  const names = new Map<string, { name: string; role?: string }>()
  names.set('system', { name: 'system' })
  const ids = [...new Set(agentIds.filter((id) => id && id !== 'system'))]
  if (ids.length === 0) return names
  const db = await getDb()
  const validIds = ids.filter((id) => ObjectId.isValid(id))
  const agents = (await db
    .collection('agents')
    .find(
      { _id: { $in: validIds.map((id) => new ObjectId(id)) }, userId },
      { projection: { name: 1, role: 1 } },
    )
    .toArray()) as unknown as Pick<Agent, '_id' | 'name' | 'role'>[]
  for (const agent of agents) {
    names.set(String(agent._id), { name: agent.name, role: agent.role })
  }
  // An id with no matching agent is still shown, as its id, so the
  // conversation never silently drops a speaker.
  for (const id of ids) {
    if (!names.has(id)) names.set(id, { name: id })
  }
  return names
}

/**
 * Read the full blackboard for a run: the whole running conversation
 * (oldest first, every agent, not just one pair) plus the shared
 * variables and intermediate results.
 */
export async function readBlackboard(
  workflowRunId: string,
  userId: string,
): Promise<Blackboard> {
  const [messages, sharedContext] = await Promise.all([
    listMessages(userId, workflowRunId),
    getSharedContext(userId, workflowRunId),
  ])
  const agentIds = messages.flatMap((m) => [m.fromAgentId, m.toAgentId ?? ''])
  const names = await agentDisplayNames(userId, agentIds)
  const conversation: BlackboardEntry[] = messages
    .filter((m) => m.text !== undefined && m.text !== null && String(m.text).length > 0)
    .map((m) => ({
      fromAgentId: m.fromAgentId,
      fromName: names.get(m.fromAgentId)?.name ?? m.fromAgentId,
      fromRole: names.get(m.fromAgentId)?.role,
      toAgentId: m.toAgentId,
      toName: m.toAgentId ? (names.get(m.toAgentId)?.name ?? m.toAgentId) : undefined,
      type: m.type,
      text: String(m.text),
      requiresResponse: m.requiresResponse,
      parentMessageId: m.parentMessageId,
      createdAt: m.createdAt,
    }))
  return {
    conversation,
    variables: sharedContext.variables ?? {},
    intermediateResults: sharedContext.intermediateResults ?? {},
  }
}

export type BlackboardMessageKind = 'question' | 'answer' | 'note'

/**
 * Append a teammate message to the blackboard (persisted through the
 * existing message bus, so the whole team can see it). The kind maps to
 * the bus type: a question is a `task` that waits for a reply, an answer
 * is a `result` threaded under its question via `parentMessageId`, and a
 * note is `feedback` visible to everyone.
 */
export async function appendToBlackboard(input: {
  userId: string
  workflowId: string
  workflowRunId: string
  fromAgentId: string
  toAgentId?: string
  taskId?: string
  parentMessageId?: string
  kind: BlackboardMessageKind
  text: string
  requiresResponse?: boolean
}): Promise<AgentMessage & { _id: unknown }> {
  const type: AgentMessageType =
    input.kind === 'question' ? 'task' : input.kind === 'answer' ? 'result' : 'feedback'
  return createMessage({
    userId: input.userId,
    workflowId: input.workflowId,
    workflowRunId: input.workflowRunId,
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgentId,
    taskId: input.taskId,
    parentMessageId: input.parentMessageId,
    type,
    text: input.text,
    requiresResponse:
      input.requiresResponse ?? (input.kind === 'question'),
  })
}

/** Set one blackboard variable, visible to every agent in the run. */
export async function setBlackboardVariable(
  workflowRunId: string,
  userId: string,
  key: string,
  value: unknown,
): Promise<Record<string, unknown>> {
  const updated = await updateSharedContext(userId, workflowRunId, {
    variables: { [key]: value },
  })
  return updated.variables ?? {}
}

/** Read all blackboard variables for a run. */
export async function getBlackboardVariables(
  workflowRunId: string,
  userId: string,
): Promise<Record<string, unknown>> {
  const context = await getSharedContext(userId, workflowRunId)
  return context.variables ?? {}
}

/** Render one JSON block, capped, with the truncation said out loud. */
function renderCappedJson(
  label: string,
  value: Record<string, unknown>,
  maxChars: number,
): string | null {
  const keys = Object.keys(value)
  if (keys.length === 0) return null
  const json = JSON.stringify(value, null, 2)
  if (json.length <= maxChars) return `${label}:\n${json}`
  return `${label} (truncated to the first ${maxChars} characters):\n${json.slice(0, maxChars)}`
}

/**
 * Render the blackboard as plain text for a turn prompt: the conversation
 * in order with agent name/role, then variables, then intermediate
 * results. The conversation is bounded so prompts stay within token
 * budgets: the oldest entries are dropped first and the rendered text
 * says how many earlier messages were omitted.
 */
export function renderBlackboardText(
  blackboard: Blackboard,
  opts?: { maxConversationChars?: number; maxJsonChars?: number },
): string {
  const maxConversationChars = opts?.maxConversationChars ?? DEFAULT_MAX_CONVERSATION_CHARS
  const maxJsonChars = opts?.maxJsonChars ?? DEFAULT_MAX_JSON_CHARS
  const parts: string[] = []

  const lines = blackboard.conversation.map((entry) => {
    const from = entry.fromRole ? `${entry.fromName} (${entry.fromRole})` : entry.fromName
    const to = entry.toName ? ` -> ${entry.toName}` : ' -> everyone'
    const waiting = entry.requiresResponse ? ' [awaits reply]' : ''
    return `${from}${to}${waiting}: ${entry.text}`
  })

  // Keep the newest lines that fit; drop the oldest first.
  const kept: string[] = []
  let keptChars = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (keptChars + line.length + 1 > maxConversationChars && kept.length > 0) break
    kept.unshift(line)
    keptChars += line.length + 1
  }
  const omitted = lines.length - kept.length

  parts.push('Team conversation (shared blackboard — visible to every agent in this run):')
  if (kept.length === 0) {
    parts.push('(no teammate messages yet)')
  } else {
    if (omitted > 0) {
      parts.push(`[${omitted} earlier message(s) omitted to stay within the prompt budget — oldest first, showing the most recent ${kept.length}]`)
    }
    parts.push(kept.join('\n'))
  }

  const variables = renderCappedJson('Shared variables', blackboard.variables, maxJsonChars)
  if (variables) parts.push(`\n${variables}`)
  const results = renderCappedJson(
    'Intermediate results',
    blackboard.intermediateResults,
    maxJsonChars,
  )
  if (results) parts.push(`\n${results}`)

  return parts.join('\n')
}

/** Alias kept for the lane-C draft name; same implementation. */
export const renderBlackboard = renderBlackboardText

export type AgentTurn =
  | { kind: 'final'; text: string }
  | { kind: 'message'; to: string; text: string; requiresResponse: boolean }

/**
 * Parse an agent turn's LLM output under the frozen turn format.
 * A single surrounding ```json fenced block is unwrapped first; anything
 * unparsable, or parsed JSON that is not a well-formed turn, is treated
 * as a final answer carrying the raw output.
 */
export function parseTurnOutput(raw: string): AgentTurn {
  const trimmed = raw.trim()
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim()
  try {
    const parsed: unknown = JSON.parse(unfenced)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      if (obj.kind === 'final' && typeof obj.text === 'string') {
        return { kind: 'final', text: obj.text }
      }
      if (
        obj.kind === 'message' &&
        typeof obj.to === 'string' &&
        obj.to.trim().length > 0 &&
        typeof obj.text === 'string'
      ) {
        return {
          kind: 'message',
          to: obj.to.trim(),
          text: obj.text,
          requiresResponse: obj.requiresResponse === true,
        }
      }
    }
  } catch {
    // Unparsable output is a final answer (frozen format rule).
  }
  return { kind: 'final', text: raw }
}

/** Alias kept for the lane-C draft name; same implementation. */
export const parseAgentTurn = parseTurnOutput

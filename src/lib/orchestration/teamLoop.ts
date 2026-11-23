/**
 * Conversation loop for team runs (multi-agent, lane A).
 *
 * One agent's turn runs through the existing `chatCompletion` LLM path,
 * with a prompt built from the task + the conversation so far (the shared
 * transcript — the blackboard, visible to the whole team) + shared
 * context. A turn ends in a final answer or a message to a teammate
 * (frozen JSON format, see teamTurn.ts).
 *
 * A message with `requiresResponse` pauses the sender: the recipient
 * runs with the question + conversation + shared context and replies,
 * and the reply returns to the sender, which continues. The loop runs
 * until the task is done or a safety rail stops it:
 *
 *   - hard turn cap per run (default 10 exchanges, configurable per run,
 *     never unbounded);
 *   - per-run time budget, checked before every turn;
 *   - a message is never sent to an agent outside this run's team (the
 *     team is the user's own agents, resolved by the orchestrator — the
 *     same ownership rule as `resolveNodes`).
 *
 * If a rail is hit the run ends honestly with the work so far (status
 * `cap-exceeded` / `budget-exceeded` + a plain-words note), never a fake
 * completion.
 *
 * Every message is persisted through the existing `createMessage()` bus
 * with `parentMessageId` threading and `requiresResponse` — the bus is
 * not replaced or extended.
 *
 * Dependency seams (`TeamLoopDeps`): the live defaults are the real
 * `chatCompletion` / `createMessage` / `contextManager` paths. Tests
 * inject fakes through `deps` to prove cap/budget/parser behaviour with
 * direct calls; those injections are test-only and are never used by the
 * orchestrator.
 */

import { chatCompletion, type CompletionResult } from '@/lib/llm'
import { createMessage } from './messageBus'
import { getSharedContext, updateSharedContext } from './contextManager'
import { parseTeamTurn, TEAM_TURN_FORMAT_INSTRUCTIONS, type ParsedTeamTurn } from './teamTurn'
import type { TeamAgent, TeamRunOptions, TeamRunResult, TeamTranscriptEntry } from './teamTypes'

export const DEFAULT_TEAM_MAX_EXCHANGES = 10
export const DEFAULT_TEAM_TIME_BUDGET_MS = 300_000 // 5 minutes
const DEFAULT_TURN_MAX_TOKENS = 1200

export type TeamLoopDeps = {
  /** LLM turn. Defaults to the real `chatCompletion` chain. */
  complete?: (args: {
    system: string
    prompt: string
    maxTokens: number
    model?: string
  }) => Promise<CompletionResult>
  /** Persist one bus message. Defaults to the real `createMessage`. */
  persist?: (args: {
    fromAgentId: string
    toAgentId?: string
    parentMessageId?: string
    type: 'task' | 'result'
    text: string
    requiresResponse: boolean
  }) => Promise<{ id: string }>
  /** Read the shared-context summary for turn prompts. */
  readContextText?: () => Promise<string>
  /** Record one agent's contribution in the shared context. */
  recordContribution?: (agentId: string, text: string) => Promise<void>
  /** True when the run was cancelled. Defaults to "never cancelled". */
  isCancelled?: () => Promise<boolean>
}

/**
 * Resolve a teammate reference (agent id, role, or name) against the team
 * roster. Id wins, then exact name (case-insensitive), then role
 * (case-insensitive). Returns null when nobody on the team matches — the
 * caller ends the run with an honest error, never a silent fallback.
 */
export function resolveTeammate(team: TeamAgent[], ref: string): TeamAgent | null {
  const wanted = ref.trim()
  if (!wanted) return null
  const byId = team.find((agent) => agent.id === wanted)
  if (byId) return byId
  const lowered = wanted.toLowerCase()
  const byName = team.find((agent) => agent.name.toLowerCase() === lowered)
  if (byName) return byName
  const byRole = team.find((agent) => (agent.role ?? '').toLowerCase() === lowered)
  return byRole ?? null
}

/** Render the shared transcript as prompt text (the blackboard). */
export function formatTranscript(transcript: TeamTranscriptEntry[]): string {
  if (transcript.length === 0) return '(No conversation yet — you speak first.)'
  return transcript
    .map((entry) => {
      if (entry.kind === 'final') return `${entry.fromName}: ${entry.text}`
      const to = entry.toName ? ` → ${entry.toName}` : ''
      const wait = entry.requiresResponse ? ' (waiting for a reply)' : ''
      return `${entry.fromName}${to}: ${entry.text}${wait}`
    })
    .join('\n')
}

/** System prompt for one agent's turn: its own prompt + team format + roster. */
export function buildTeamSystemPrompt(agent: TeamAgent, team: TeamAgent[]): string {
  const roster = team
    .map(
      (member) =>
        `- ${member.name} (id: ${member.id}${member.role ? `, role: ${member.role}` : ''})${member.id === agent.id ? ' — you' : ''}`,
    )
    .join('\n')
  const base = agent.systemPrompt?.trim()
    ? agent.systemPrompt.trim()
    : `You are ${agent.name}, a helpful agent working on a shared job.`
  return [
    base,
    '',
    `You are ${agent.name}${agent.role ? ` (role: ${agent.role})` : ''}. Your teammates on this job are:`,
    roster,
    '',
    TEAM_TURN_FORMAT_INSTRUCTIONS,
  ].join('\n')
}

/** User prompt for one agent's turn: task + transcript + shared context. */
export function buildTeamUserPrompt(args: {
  task: string
  transcript: TeamTranscriptEntry[]
  sharedContextText: string
  pendingQuestion?: { fromName: string; text: string }
}): string {
  const parts = [
    `Job: ${args.task}`,
    '',
    'Conversation so far (visible to the whole team):',
    formatTranscript(args.transcript),
  ]
  if (args.pendingQuestion) {
    parts.push(
      '',
      `${args.pendingQuestion.fromName} asked you directly: ${args.pendingQuestion.text}`,
      'Answer their question. If you need another teammate\'s help first, message them; otherwise reply with {"kind":"final","text":"<your answer>"}.',
    )
  }
  if (args.sharedContextText.trim()) {
    parts.push('', 'Shared context:', args.sharedContextText.trim())
  }
  return parts.join('\n')
}

type PendingQuestion = {
  askerId: string
  askerName: string
  questionMessageId: string
  questionText: string
}

/**
 * Run the team conversation loop. Never throws for a bad turn, an unknown
 * teammate, a dead provider, or a hit rail — it returns a result whose
 * status says honestly what happened.
 */
export async function runTeamConversation(
  options: TeamRunOptions,
  deps: TeamLoopDeps = {},
): Promise<TeamRunResult> {
  const startedAt = Date.now()
  const maxExchanges =
    options.maxExchanges !== undefined && options.maxExchanges > 0
      ? Math.floor(options.maxExchanges)
      : DEFAULT_TEAM_MAX_EXCHANGES
  const timeBudgetMs =
    options.timeBudgetMs !== undefined && options.timeBudgetMs > 0
      ? options.timeBudgetMs
      : DEFAULT_TEAM_TIME_BUDGET_MS

  const transcript: TeamTranscriptEntry[] = []
  const pending: PendingQuestion[] = []
  let messagesCreated = 0
  let exchanges = 0
  let lastMessageId: string | undefined

  const complete = deps.complete ?? (async (args) =>
    chatCompletion({
      system: args.system,
      prompt: args.prompt,
      maxTokens: args.maxTokens,
      model: args.model,
      temperature: 0.4,
    }))
  const persist =
    deps.persist ??
    (async (args: {
      fromAgentId: string
      toAgentId?: string
      parentMessageId?: string
      type: 'task' | 'result'
      text: string
      requiresResponse: boolean
    }) => {
      const created = await createMessage({
        userId: options.userId,
        workflowId: options.workflowId,
        workflowRunId: options.workflowRunId,
        fromAgentId: args.fromAgentId,
        toAgentId: args.toAgentId,
        parentMessageId: args.parentMessageId,
        type: args.type,
        text: args.text,
        requiresResponse: args.requiresResponse,
      })
      return { id: String(created._id) }
    })
  const readContextText =
    deps.readContextText ??
    (async () => {
      const context = await getSharedContext(options.userId, options.workflowRunId)
      const results = context.intermediateResults ?? {}
      const entries = Object.entries(results)
      if (entries.length === 0) return ''
      return entries.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n')
    })
  const recordContribution =
    deps.recordContribution ??
    (async (agentId: string, text: string) => {
      await updateSharedContext(options.userId, options.workflowRunId, {
        intermediateResults: { [agentId]: text },
      })
    })
  const isCancelled = deps.isCancelled ?? (async () => false)

  const finish = (
    result: Omit<TeamRunResult, 'transcript' | 'exchanges' | 'messagesCreated'>,
  ): TeamRunResult => ({ ...result, transcript, exchanges, messagesCreated })

  if (options.team.length === 0) {
    return finish({
      status: 'failed',
      finalText: '',
      note: 'Team run started with no agents — nothing could work on the job.',
    })
  }

  // The lead (first agent) speaks first; turns then pass to whoever was
  // messaged, and a reply returns to the agent that asked. `pending` is
  // the stack of unanswered questions: its top is always the question
  // the current speaker owes an answer to, so a final from the speaker
  // answers that question (when one exists) and only completes the run
  // when nothing is pending.
  let current = options.team[0]

  for (;;) {
    if (await isCancelled()) {
      return finish({
        status: 'cancelled',
        finalText: '',
        note: 'Team run cancelled; the conversation so far is preserved below.',
      })
    }
    if (Date.now() - startedAt >= timeBudgetMs) {
      return finish({
        status: 'budget-exceeded',
        finalText: '',
        note: `Team run stopped: the ${Math.round(timeBudgetMs / 1000)}s time budget was reached after ${exchanges} exchange(s). The work so far is preserved below — this is not a completed job.`,
      })
    }
    if (exchanges >= maxExchanges) {
      return finish({
        status: 'cap-exceeded',
        finalText: '',
        note: `Team run stopped: the cap of ${maxExchanges} exchange(s) was reached. The work so far is preserved below — this is not a completed job.`,
      })
    }

    const sharedContextText = await readContextText().catch(() => '')
    const system = buildTeamSystemPrompt(current, options.team)
    // The question this speaker owes an answer to (stack top), if any.
    const answering = pending[pending.length - 1]
    const prompt = buildTeamUserPrompt({
      task: options.task,
      transcript,
      sharedContextText,
      pendingQuestion: answering
        ? { fromName: answering.askerName, text: answering.questionText }
        : undefined,
    })

    const completion = await complete({
      system,
      prompt,
      maxTokens: current.maxTokenBudget ?? DEFAULT_TURN_MAX_TOKENS,
      model: current.model,
    })
    exchanges += 1

    if (!completion.ok) {
      const detail = (completion.failures ?? [])
        .slice(0, 3)
        .map((failure) => `${failure.provider}: ${failure.message}`)
        .join('; ')
      return finish({
        status: 'failed',
        finalText: '',
        note: 'Team run stopped: no inference provider answered this turn, so the conversation could not continue.',
        failureDetail: detail || 'No provider answered.',
      })
    }

    const turn: ParsedTeamTurn = parseTeamTurn(completion.text)
    const answeredQuestion = answering

    if (turn.kind === 'final') {
      const entry: TeamTranscriptEntry = {
        fromAgentId: current.id,
        fromName: current.name,
        toAgentId: answeredQuestion?.askerId,
        toName: answeredQuestion?.askerName,
        kind: 'final',
        text: turn.text,
        requiresResponse: false,
      }
      const saved = await persist({
        fromAgentId: current.id,
        toAgentId: answeredQuestion?.askerId,
        parentMessageId: answeredQuestion?.questionMessageId ?? lastMessageId,
        type: 'result',
        text: turn.text,
        requiresResponse: false,
      }).catch(() => null)
      if (saved) {
        entry.messageId = saved.id
        lastMessageId = saved.id
        messagesCreated += 1
      }
      transcript.push(entry)
      await recordContribution(current.id, turn.text).catch(() => undefined)

      if (answeredQuestion) {
        // The reply returns to the asker, which continues its turn.
        pending.pop()
        const asker = options.team.find((agent) => agent.id === answeredQuestion.askerId)
        if (asker) current = asker
        continue
      }
      return finish({ status: 'completed', finalText: turn.text })
    }

    // A message turn: resolve the teammate, or end honestly.
    const recipient = resolveTeammate(options.team, turn.to)
    if (!recipient) {
      return finish({
        status: 'failed',
        finalText: '',
        note: `Team run stopped: ${current.name} tried to message "${turn.to}", but no agent with that id, name, or role is on this team. The message was not sent.`,
      })
    }
    if (recipient.id === current.id) {
      // An agent messaging itself is its own continuing thought: its
      // message text is its answer for this turn.
      const entry: TeamTranscriptEntry = {
        fromAgentId: current.id,
        fromName: current.name,
        kind: 'final',
        text: turn.text,
        requiresResponse: false,
      }
      const saved = await persist({
        fromAgentId: current.id,
        parentMessageId: answeredQuestion?.questionMessageId ?? lastMessageId,
        type: 'result',
        text: turn.text,
        requiresResponse: false,
      }).catch(() => null)
      if (saved) {
        entry.messageId = saved.id
        lastMessageId = saved.id
        messagesCreated += 1
      }
      transcript.push(entry)
      await recordContribution(current.id, turn.text).catch(() => undefined)
      if (answeredQuestion) {
        pending.pop()
        const asker = options.team.find((agent) => agent.id === answeredQuestion.askerId)
        if (asker) current = asker
        continue
      }
      return finish({ status: 'completed', finalText: turn.text })
    }

    const entry: TeamTranscriptEntry = {
      fromAgentId: current.id,
      fromName: current.name,
      toAgentId: recipient.id,
      toName: recipient.name,
      kind: 'message',
      text: turn.text,
      requiresResponse: turn.requiresResponse,
    }
    const saved = await persist({
      fromAgentId: current.id,
      toAgentId: recipient.id,
      parentMessageId: answeredQuestion?.questionMessageId ?? lastMessageId,
      type: 'task',
      text: turn.text,
      requiresResponse: turn.requiresResponse,
    }).catch(() => null)
    if (saved) {
      entry.messageId = saved.id
      lastMessageId = saved.id
      messagesCreated += 1
    }
    transcript.push(entry)
    await recordContribution(current.id, turn.text).catch(() => undefined)

    if (turn.requiresResponse) {
      pending.push({
        askerId: current.id,
        askerName: current.name,
        questionMessageId: entry.messageId ?? '',
        questionText: turn.text,
      })
    }
    // Without requiresResponse the stack is unchanged: the recipient now
    // speaks next, and if a question is still pending above, the
    // recipient's eventual final answers it (the transcript is shared,
    // so the asker sees it) instead of the run stranding the asker.
    current = recipient
  }
}

/**
 * Shared execution-context manager (implementation plan Phase 3).
 *
 * Reads and writes the shared run context stored in the `shared_contexts`
 * collection. Every agent in a run reads from and writes to the same context,
 * so intermediate results and decisions are visible to downstream agents.
 */

import { getDb } from '@/lib/mongo/mongo'
import { ensureSharedContextsIndex } from '@/lib/mongo/indices'
import { listMessages } from './messageBus'
import type { AgentMessage } from '@/lib/mongo/agentMessages'
import type { SharedContext, SharedContextDecision } from '@/lib/mongo/sharedContexts'

/** Fetch the shared context for a run, creating it if it does not exist. */
export async function getSharedContext(
  userId: string,
  workflowRunId: string,
): Promise<SharedContext> {
  const db = await getDb()
  await ensureSharedContextsIndex(db)

  const existing = await db.collection('shared_contexts').findOne({
    userId,
    workflowRunId,
  })

  if (existing) return existing as unknown as SharedContext

  const now = new Date()
  const context: SharedContext = {
    userId,
    workflowRunId,
    variables: {},
    documents: [],
    intermediateResults: {},
    decisions: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  }

  await db.collection('shared_contexts').insertOne(context as unknown as import('mongodb').Document)
  return context
}

/**
 * Merge updates into the shared context and bump the version.
 *
 * Only the fields provided are changed; everything else is preserved.
 */
export async function updateSharedContext(
  userId: string,
  workflowRunId: string,
  updates: Partial<{
    originalInput: string
    variables: Record<string, unknown>
    documents: string[]
    intermediateResults: Record<string, unknown>
    finalResult: unknown
  }>,
  decision?: Omit<SharedContextDecision, 'createdAt'>,
): Promise<SharedContext> {
  const db = await getDb()

  const context = await getSharedContext(userId, workflowRunId)

  const merged: SharedContext = {
    ...context,
    ...updates,
    version: context.version + 1,
    updatedAt: new Date(),
    intermediateResults: {
      ...context.intermediateResults,
      ...(updates.intermediateResults || {}),
    },
    variables: { ...context.variables, ...(updates.variables || {}) },
    documents: updates.documents ?? context.documents,
  }

  if (decision) {
    merged.decisions = [
      ...context.decisions,
      { ...decision, createdAt: new Date() },
    ]
  }

  await db
    .collection('shared_contexts')
    .updateOne(
      { userId, workflowRunId },
      { $set: merged },
    )

  return merged
}

/** Record a decision made by an agent in the shared context. */
export async function addDecision(
  userId: string,
  workflowRunId: string,
  agentId: string,
  decision: string,
  reason?: string,
): Promise<void> {
  await updateSharedContext(userId, workflowRunId, {}, {
    agentId,
    decision,
    reason,
  })
}

/** Default cap (characters) for the rendered team conversation in a turn. */
export const TEAM_BLACKBOARD_MAX_CHARS = 6000

/**
 * Deterministic team-run gate (multi-agent team, lane C2): a run is a team
 * run when its resolved nodes name >= 2 distinct agents. The gate is
 * derived from the run itself — no new stored flag, no dependency on any
 * other lane's files. Single-agent runs never fetch or render the
 * blackboard, so their prompts stay byte-identical.
 */
export function isTeamRun(agentIds: Array<string | undefined | null>): boolean {
  const distinct = new Set<string>()
  for (const id of agentIds) {
    if (typeof id === 'string' && id.trim()) distinct.add(id.trim())
  }
  return distinct.size >= 2
}

export type TeamTurnContext = {
  /** False for a single-agent run: the reader is a no-op (see below). */
  isTeamRun: boolean
  /** Null when `isTeamRun` is false (nothing was read). */
  sharedContext: SharedContext | null
  /** The run's messages, oldest first; empty when `isTeamRun` is false. */
  conversation: AgentMessage[]
  /** Rendered blackboard text for the prompt; '' when `isTeamRun` is false. */
  blackboardText: string
}

/**
 * Team-turn context (multi-agent team, lane C): the shared context for a
 * run PLUS the full running conversation from the message bus, oldest
 * first — every agent's messages, not just one pair — so a third agent
 * can build on a conversation between the first two.
 *
 * This is only assembled for team runs. Single-agent turns keep using
 * `getSharedContext` alone, so their context is unchanged.
 */
export async function getSharedContextForTeamTurn(
  userId: string,
  workflowRunId: string,
): Promise<{ sharedContext: SharedContext; conversation: AgentMessage[] }> {
  const [sharedContext, conversation] = await Promise.all([
    getSharedContext(userId, workflowRunId),
    listMessages(userId, workflowRunId),
  ])
  return { sharedContext, conversation }
}

/**
 * Render the blackboard as prompt text (pure function — no I/O).
 *
 * Sections: the shared-context variables, the intermediate results, then
 * the whole team conversation, oldest first. The conversation is capped
 * (default `TEAM_BLACKBOARD_MAX_CHARS` chars): the oldest messages are
 * dropped first and the rendered text says how many earlier messages were
 * omitted, so the newest context is always what the agent sees.
 */
export function renderBlackboardText(
  sharedContext: SharedContext,
  conversation: AgentMessage[],
  options?: { maxChars?: number },
): string {
  const maxChars = options?.maxChars ?? TEAM_BLACKBOARD_MAX_CHARS
  const sections: string[] = [
    'Team blackboard — shared context for this team run. Every agent on this run sees the same blackboard.',
  ]

  if (sharedContext.variables && Object.keys(sharedContext.variables).length > 0) {
    sections.push(`\nContext variables:\n${JSON.stringify(sharedContext.variables, null, 2)}`)
  }

  if (
    sharedContext.intermediateResults &&
    Object.keys(sharedContext.intermediateResults).length > 0
  ) {
    sections.push(
      `\nIntermediate results:\n${JSON.stringify(sharedContext.intermediateResults, null, 2)}`,
    )
  }

  const lines = conversation.map((message) => {
    const to = message.toAgentId ? ` -> ${message.toAgentId}` : ''
    const text =
      message.text ?? (message.payload != null ? JSON.stringify(message.payload) : '')
    return `${message.fromAgentId}${to} [${message.type}]: ${text}`
  })

  if (lines.length === 0) {
    sections.push('\nTeam conversation: (no messages yet)')
  } else {
    let omitted = 0
    let kept = lines
    while (kept.length > 1 && kept.join('\n').length > maxChars) {
      kept = kept.slice(1)
      omitted += 1
    }
    let body = kept.join('\n')
    if (body.length > maxChars) body = body.slice(0, maxChars)
    const omittedNote =
      omitted > 0 ? `, ${omitted} earlier message${omitted === 1 ? '' : 's'} omitted` : ''
    sections.push(
      `\nTeam conversation (${lines.length} message${lines.length === 1 ? '' : 's'}${omittedNote}):\n${body}`,
    )
  }

  return sections.join('\n')
}

/**
 * The team-turn reader the run path calls (multi-agent team, lane C2).
 *
 * For ANY agent's turn in a team run it assembles the full blackboard:
 * the whole running conversation (via `listMessages` — all teammates, not
 * just one pair) plus the shared context's variables and intermediate
 * results, rendered as prompt text.
 *
 * Single-agent runs are a strict no-op: the function returns
 * `blackboardText: ''` WITHOUT touching the database, so a single-agent
 * run's assembled context — and therefore its prompt — is byte-identical
 * to before this change. The caller passes the resolved nodes' agent ids;
 * the >= 2 distinct agents gate decides.
 *
 * NOTE: this deliberately does NOT import `blackboard.ts` (cycle
 * avoidance: `blackboard.ts` imports `contextManager` + `messageBus`).
 * The merge lane wires this into `runNodeExecution`: when `teamRun` is
 * true it calls this reader and passes `blackboardText` to
 * `buildUserPrompt` (see the patch in `tmp-c2/`).
 */
export async function getTeamTurnContext(
  userId: string,
  workflowRunId: string,
  agentIds: Array<string | undefined | null>,
  options?: { maxChars?: number },
): Promise<TeamTurnContext> {
  if (!isTeamRun(agentIds)) {
    return { isTeamRun: false, sharedContext: null, conversation: [], blackboardText: '' }
  }
  const { sharedContext, conversation } = await getSharedContextForTeamTurn(
    userId,
    workflowRunId,
  )
  return {
    isTeamRun: true,
    sharedContext,
    conversation,
    blackboardText: renderBlackboardText(sharedContext, conversation, options),
  }
}

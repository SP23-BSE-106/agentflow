/**
 * Team-conversation rendering rules (lane E, multi-agent team view).
 *
 * Pure functions only — no database, no network — so the rules are
 * unit-tested in tests/team-view without a browser. The component
 * (src/components/runs/TeamConversation.tsx) renders what these return.
 *
 * Message shape: the persisted `agent_messages` doc as returned by
 * GET /api/runs/:runId/messages — `{ _id, fromAgentId, toAgentId, type,
 * status, payload, text, requiresResponse, parentMessageId, createdAt }`.
 * There are no `sender` / `recipient` fields on the wire; sender is
 * `fromAgentId`, recipient is `toAgentId`.
 */

export type TeamMessage = {
  _id?: string
  id?: string
  fromAgentId?: string
  toAgentId?: string
  type?: string
  status?: string
  payload?: unknown
  text?: string
  requiresResponse?: boolean
  parentMessageId?: string
  createdAt?: string | Date
}

/** Stable id of a message, whatever key the source used. */
export function messageId(message: TeamMessage): string {
  const raw = message._id ?? message.id ?? ''
  return typeof raw === 'string' ? raw : String(raw)
}

/** Frozen turn format (shared with all lanes, display only): an agent
 *  turn's LLM output is JSON `{"kind":"final","text":"..."}` or
 *  `{"kind":"message","to":"...","text":"...","requiresResponse":...}`.
 *  A message payload carrying turn JSON renders its `text` field, never
 *  the raw JSON. Plain text passes through untouched. */
export function extractTurnText(message: TeamMessage): string {
  const fromValue = (value: unknown): string | null => {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.startsWith('{')) {
        try {
          const parsed: unknown = JSON.parse(trimmed)
          if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).text === 'string') {
            return (parsed as Record<string, unknown>).text as string
          }
        } catch {
          /* not JSON — fall through to the raw string */
        }
      }
      return value
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (typeof record.text === 'string') return record.text
    }
    return null
  }

  const fromText = fromValue(message.text)
  if (fromText !== null && fromText !== '') return fromText
  const fromPayload = fromValue(message.payload)
  if (fromPayload !== null && fromPayload !== '') return fromPayload
  return fromText ?? ''
}

/** System messages (approvals, evaluation notes, status) render
 *  distinctly from agent-to-agent messages. A message is system when its
 *  type is an approval/status type or it has no agent sender. */
export function isSystemMessage(message: TeamMessage): boolean {
  if (message.type === 'approval_request' || message.type === 'approval_response' || message.type === 'status') {
    return true
  }
  return !message.fromAgentId
}

/** A message with `requiresResponse` that is still unanswered shows as
 *  awaiting a reply. Answered = a later message threads onto it
 *  (`parentMessageId`) or the message itself completed. */
export function isAwaitingReply(message: TeamMessage, all: TeamMessage[]): boolean {
  if (!message.requiresResponse) return false
  if (message.status === 'completed') return false
  const id = messageId(message)
  if (!id) return false
  return !all.some((other) => other.parentMessageId === id)
}

/** Distinct agent ids appearing as senders or recipients. Used by the run
 *  view to decide whether a run is a team run at all: a single-agent run
 *  with no messages shows no team UI. */
export function distinctAgentIds(messages: TeamMessage[], extraIds?: Array<string | undefined>): string[] {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.fromAgentId) ids.add(message.fromAgentId)
    if (message.toAgentId) ids.add(message.toAgentId)
  }
  for (const id of extraIds ?? []) {
    if (id) ids.add(id)
  }
  return [...ids]
}

/** Human timestamp for a message. Invalid/missing dates render as an em
 *  dash, never as "Invalid Date". */
export function formatMessageTime(createdAt: string | Date | undefined): string {
  if (!createdAt) return '—'
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`
}

/** Run statuses on which the conversation is still growing and polling
 *  must continue. Every other status is terminal: polling stops. */
export function isLiveRunStatus(status: string): boolean {
  return status === 'running' || status === 'paused' || status === 'queued'
}

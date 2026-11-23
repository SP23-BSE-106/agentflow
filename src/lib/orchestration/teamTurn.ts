/**
 * Parse one agent turn's LLM output (multi-agent team runs, lane A).
 *
 * FROZEN FORMAT — every lane uses this, and team agents are instructed
 * to answer in it (see TEAM_TURN_FORMAT_INSTRUCTIONS):
 *
 *   {"kind":"final","text":"..."}
 *   {"kind":"message","to":"<agent id | role | name>","text":"...","requiresResponse":true|false}
 *
 * The parser never throws and never invents a message: the output is
 * stripped of ``` fences and JSON.parsed, and on ANY parse failure — bad
 * JSON, wrong shape, a message with no recipient or no text — the whole
 * output is treated as {"kind":"final"} with the raw text as the answer.
 * A turn that cannot be understood is an answer, never a fabricated
 * question to a teammate.
 */

export type ParsedTeamTurn =
  | { kind: 'final'; text: string }
  | { kind: 'message'; to: string; text: string; requiresResponse: boolean }

/**
 * System-prompt addition for team agents. Instructs the frozen JSON
 * format and how to name teammates (by id, role, or name — resolved
 * against the agents in this run only).
 */
export const TEAM_TURN_FORMAT_INSTRUCTIONS = [
  'You are working as part of a team of agents on one shared job. Your teammates are listed in your instructions by id, role, and name.',
  'Reply with JSON ONLY, in exactly one of these two shapes, with no other text before or after it:',
  '  {"kind":"final","text":"<your answer or contribution>"} — when you have finished your part, or when you are answering a teammate\'s question and have nothing further to ask.',
  '  {"kind":"message","to":"<teammate agent id, role, or name>","text":"<your question or note>","requiresResponse":true} — when you need a teammate\'s answer before you can continue. Set "requiresResponse":false when you are only passing them a note they do not need to answer.',
  'Name a teammate by their agent id, role, or name exactly as listed. Never invent a teammate: a message to someone who is not on this team fails the run.',
  'When a teammate asks you a question, answer it directly in your "text". Keep answers short and concrete.',
].join('\n')

/** Strip one pair of ``` fences (optionally ```json) from around the text. */
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const withoutOpen = trimmed.replace(/^```[a-zA-Z]*\s*\n?/, '')
  const withoutClose = withoutOpen.replace(/\n?```\s*$/, '')
  return withoutClose.trim()
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Parse an agent turn. Never throws: any failure yields a final answer
 * carrying the whole raw output.
 */
export function parseTeamTurn(raw: string): ParsedTeamTurn {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return { kind: 'final', text: '' }
  try {
    const parsed: unknown = JSON.parse(stripCodeFences(text))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { kind: 'final', text }
    }
    const record = parsed as Record<string, unknown>
    if (record.kind === 'message') {
      const to = asNonEmptyString(record.to)
      const messageText = asNonEmptyString(record.text)
      // A message without a recipient or without text is malformed —
      // treat the whole output as a final answer, never fake a message.
      if (to === null || messageText === null) return { kind: 'final', text }
      return {
        kind: 'message',
        to,
        text: messageText,
        requiresResponse: record.requiresResponse === true,
      }
    }
    if (record.kind === 'final') {
      const finalText = asNonEmptyString(record.text)
      return { kind: 'final', text: finalText ?? text }
    }
    return { kind: 'final', text }
  } catch {
    return { kind: 'final', text }
  }
}

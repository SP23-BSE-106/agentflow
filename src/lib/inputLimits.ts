/**
 * Server-side length caps for user text inputs. Anything over the cap is
 * rejected with an honest 400/413 — never silently truncated, never stored
 * unbounded. Caps are generous (a workflow prompt is a document, not a tweet)
 * but bounded, so one request cannot bloat a collection or a model call.
 */
export const MAX_INPUT_CHARS = 8_000
export const MAX_QUESTION_CHARS = 4_000
export const MAX_PROMPT_CHARS = 8_000
export const MAX_SYSTEM_PROMPT_CHARS = 4_000
export const MAX_DESCRIPTION_CHARS = 2_000
export const MAX_NAME_CHARS = 120
export const MAX_MESSAGE_CHARS = 5_000
export const MAX_SUBJECT_CHARS = 200
export const MAX_URL_CHARS = 2_048

export function isTooLong(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length > max
}

/** Error body + status for an over-long field. 413 when it is a payload problem. */
export function lengthError(field: string, max: number): { error: string; status: number } {
  return { error: `${field} must be at most ${max} characters`, status: 413 }
}

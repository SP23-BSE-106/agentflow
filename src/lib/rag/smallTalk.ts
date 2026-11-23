/**
 * Small-talk detection for RAG chat.
 *
 * A greeting ("hello", "how are you?", "thank you") is not a grounded
 * question: there is nothing to retrieve for it, so it must never hit the
 * "no documents" or "no relevant documents" refusals. These patterns are
 * deliberately strict — the WHOLE message must be small talk. Anything
 * with real content ("hello, I want an appointment with Dr. Khan") does
 * not match and still goes through retrieval, so factual questions can
 * never slip past grounding by starting with a greeting.
 */

/** Whole-message patterns, matched against the lower-cased, trimmed text. */
const SMALL_TALK_PATTERNS: RegExp[] = [
  // Greetings (including the common Pakistani "aoa" / "salam").
  /^(hi|hii+|hello|helloo+|hey|heyy+|salam|salaam|assalamu?\s*alaikum|aoa|good\s(morning|afternoon|evening|day))[\s!.,]*$/,
  // "How are you?" and friends.
  /^(how\sare\syou|how\sare\su|how\sare\syou\sdoing|how\syou\sdoing|how'?s\sit\sgoing|how\sdo\syou\sdo|what'?s\sup|wassup|whats\s+up)[\s!?.]*$/,
  // Thanks.
  /^(thank\syou|thanks|thank\syou\sso\smuch|thanks\sa\slot|shukran|jazak\s*allah)[\s!.,]*$/,
  // Goodbyes.
  /^(bye|goodbye|good\sbye|see\syou|see\syou\slater|take\scare|good\snight)[\s!.,]*$/,
  // Short acknowledgements.
  /^(ok|okay|alright|great|nice|good|cool|perfect|awesome|fine)[\s!.,]*$/,
  // Bare yes / no (a stateless chat can only answer these generically).
  /^(yes|yeah|yep|no|nope)[\s!.,]*$/,
]

export function isSmallTalk(question: string): boolean {
  const q = question.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!q) return false
  return SMALL_TALK_PATTERNS.some((re) => re.test(q))
}

/**
 * System prompt for the small-talk reply. It forbids inventing facts: a
 * greeting must never turn into a made-up doctor, time, price, or schedule.
 */
export const SMALL_TALK_SYSTEM_PROMPT =
  'You are a helpful, friendly AI assistant. The user just greeted you or made small talk. ' +
  'Reply briefly and warmly, in plain everyday language. ' +
  'Do not invent any facts about a hospital, doctor, service, price, or schedule. ' +
  'If they seem to want help with something, invite them to tell you what they need.'

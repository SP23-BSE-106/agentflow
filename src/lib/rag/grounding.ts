/**
 * RAG grounding rules shared by every retrieval caller (rag chat, rag query,
 * /api/execute, and the workflow RAG node).
 *
 * Two rules, both plain:
 *   1. A retrieved chunk only counts as grounding when its cosine similarity
 *      with the question is at least SIMILARITY_THRESHOLD. Below that the
 *      chunk is irrelevant text, not evidence, and must not be pasted into a
 *      prompt as if it supported the answer.
 *   2. A non-numeric topK means nothing — it defaults to 3 instead of
 *      silently producing zero hits (NaN used to flow into Math.min and then
 *      into `.slice(0, NaN)`).
 */

import type { ChunkHit } from './vectorStore'

/**
 * Minimum cosine similarity for a chunk to ground an answer.
 * MiniLM cosine scores for genuinely related text are typically well above
 * 0.3, while unrelated text scores near 0 or below; 0.30 is the floor that
 * keeps unrelated chunks out of the prompt without dropping real matches.
 */
export const SIMILARITY_THRESHOLD = 0.30

/** Keep only the hits that are similar enough to ground an answer. */
export function filterGroundedHits<T extends { similarity: number }>(hits: T[]): T[] {
  return hits.filter((hit) => typeof hit.similarity === 'number' && hit.similarity >= SIMILARITY_THRESHOLD)
}

/** True when at least one retrieved hit is similar enough to ground an answer. */
export function hasGrounding(hits: Array<{ similarity: number }>): boolean {
  return filterGroundedHits(hits).length > 0
}

/**
 * Parse a caller-supplied topK into a safe integer.
 * Non-numeric, missing, or out-of-range values fall back to 3 (clamped to
 * 1..50, matching the vector store's own ceiling).
 */
export function parseTopK(value: unknown, fallback = 3): number {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string' && value.trim() === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(Math.round(n), 50))
}

/** Message used whenever a grounded question has no documents to stand on. */
export const NO_DOCUMENTS_MESSAGE =
  'No documents have been added to the knowledge base yet. Upload a document first, then ask again — I will not guess from general knowledge when you asked a grounded question.'

/** Message used when documents exist but none of them answer the question. */
export const NO_RELEVANT_DOCUMENTS_MESSAGE =
  'The documents in the knowledge base do not contain an answer to this question, so I will not guess. Upload a document that covers it, or rephrase the question.'

export type { ChunkHit }

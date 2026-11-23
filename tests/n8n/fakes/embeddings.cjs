/**
 * Embeddings stand-in used ONLY by the Phase 3 tests (tests/phase3).
 * generateEmbedding returns a fixed 384-dimension vector the case chooses
 * (default: the first basis vector), so RAG cases control cosine similarity
 * exactly. cosineSimilarity is the real formula, not a stub.
 */
'use strict'

const EMBEDDING_DIMENSION = 384
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'

let queryVector = null

function basisVector(index) {
  const vector = new Array(EMBEDDING_DIMENSION).fill(0)
  vector[index] = 1
  return vector
}

async function generateEmbedding() {
  return queryVector ? [...queryVector] : basisVector(0)
}

function cosineSimilarity(a, b) {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function warmUpEmbeddingModel() {}

function __setQueryVector(vector) {
  queryVector = vector
}

function __basisVector(index) {
  return basisVector(index)
}

function __reset() {
  queryVector = null
}

module.exports = {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  generateEmbedding,
  cosineSimilarity,
  warmUpEmbeddingModel,
  __setQueryVector,
  __basisVector,
  __reset,
}

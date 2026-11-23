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

// H12 (lane F2): the real module gained three exports the chat handler
// calls on every RAG request. The fake must mirror them (test double,
// not product code) or phase3 chat cases fail with
// "getEmbeddingModelState is not a function" -> chat 500.
// Fake state defaults to 'ready' so existing RAG cases proceed; the
// 503-while-downloading path is proven live on the lane, not via this fake.
const EMBEDDING_MODEL_RETRY_AFTER_SECONDS = 30

let fakeModelState = 'ready'
let fakeModelStateDetail = ''

function getEmbeddingModelState() {
  return { state: fakeModelState, detail: fakeModelStateDetail }
}

function embeddingModelNotReadyBody() {
  return {
    error:
      fakeModelState === 'failed'
        ? 'The embedding model failed to load and is retrying. Please try again shortly.'
        : 'The embedding model is still downloading. Please try again shortly.',
    modelState: fakeModelState,
    retryAfterSeconds: EMBEDDING_MODEL_RETRY_AFTER_SECONDS,
  }
}

function __setQueryVector(vector) {
  queryVector = vector
}

function __basisVector(index) {
  return basisVector(index)
}

function __reset() {
  queryVector = null
  fakeModelState = 'ready'
  fakeModelStateDetail = ''
}

module.exports = {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_RETRY_AFTER_SECONDS,
  generateEmbedding,
  getEmbeddingModelState,
  embeddingModelNotReadyBody,
  cosineSimilarity,
  warmUpEmbeddingModel,
  __setQueryVector,
  __basisVector,
  __reset,
}

import { NextRequest, NextResponse } from 'next/server'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { generateEmbedding, getEmbeddingModelState, warmUpEmbeddingModel, embeddingModelNotReadyBody, EMBEDDING_MODEL_RETRY_AFTER_SECONDS } from '@/lib/rag/embeddings'
import { searchChunks } from '@/lib/rag/vectorStore'
import {
  filterGroundedHits,
  NO_RELEVANT_DOCUMENTS_MESSAGE,
  parseTopK,
  SIMILARITY_THRESHOLD,
} from '@/lib/rag/grounding'
import { MAX_QUESTION_CHARS, isTooLong, lengthError } from '@/lib/inputLimits'
import { errorResponse } from '@/lib/api/errors'
import { getClientIp, rateLimit } from '@/lib/rateLimit'
import { GUEST_LOGIN_REQUIRED } from '@/lib/auth/session'

/**
 * POST /api/rag/query
 *
 * Semantic search over the caller's knowledge base.
 * Embedding is local (Transformers.js) and retrieval goes through the Atlas
 * vector index, with an exact-cosine fallback while the index is still building.
 * Only hits at or above SIMILARITY_THRESHOLD are returned: below-threshold
 * hits are irrelevant text, not results.
 */
export async function POST(req: NextRequest) {
  // Rate limit (Lane A3, D1 remainder): 30/min per client IP — a query
  // embeds the question before it searches, so it is not a cheap read.
  const queryRl = await rateLimit(`rag:query:${getClientIp(req)}`, { windowMs: 60_000, max: 30 })
  if (!queryRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: queryRl.retryAfterMs }, { status: 429 })
  }
  try {
    const token = await getSessionTokenFromCookies()
    if (!token) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

    let payload
    try {
      payload = await verifyJwtSession(token)
    } catch {
      return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })
    }
    const userId = String(payload.sub)

    const body = await req.json().catch(() => ({}))
    const { query } = body
    const topK = parseTopK(body.topK, 3)

    if (!query || !query.trim()) {
      return NextResponse.json({ error: 'Query string is required' }, { status: 400 })
    }
    if (isTooLong(query, MAX_QUESTION_CHARS)) {
      const err = lengthError('query', MAX_QUESTION_CHARS)
      return NextResponse.json({ error: err.error }, { status: err.status })
    }

    // H12: honest retryable 503 while the embedding model is still
    // downloading on a fresh environment, instead of a 500.
    {
      const model = getEmbeddingModelState()
      if (model.state !== 'ready') {
        if (model.state === 'cold' || model.state === 'failed') warmUpEmbeddingModel()
        return NextResponse.json(embeddingModelNotReadyBody(), {
          status: 503,
          headers: { 'Retry-After': String(EMBEDDING_MODEL_RETRY_AFTER_SECONDS) },
        })
      }
    }

    const queryVector = await generateEmbedding(query)
    const { hits, engine } = await searchChunks({ userId, queryVector, topK })
    const grounded = filterGroundedHits(hits)

    if (hits.length === 0) {
      return NextResponse.json({
        query,
        engine,
        results: [],
        similarityThreshold: SIMILARITY_THRESHOLD,
        message: 'No documents uploaded in knowledge base yet.',
      })
    }

    if (grounded.length === 0) {
      return NextResponse.json({
        query,
        engine,
        results: [],
        similarityThreshold: SIMILARITY_THRESHOLD,
        message: NO_RELEVANT_DOCUMENTS_MESSAGE,
      })
    }

    return NextResponse.json({
      query,
      engine,
      similarityThreshold: SIMILARITY_THRESHOLD,
      results: grounded.map((hit) => ({
        id: hit.id,
        documentId: hit.documentId,
        text: hit.text,
        similarity: hit.similarity,
      })),
    })
  } catch (error) {
    console.error('[RAG Query] Error:', error)
    // Never echo the raw error (it can name server config, e.g. a down
    // database); errorResponse maps that to 503, the rest to a generic 500.
    return errorResponse(error, 'Vector query failed. Try again.')
  }
}

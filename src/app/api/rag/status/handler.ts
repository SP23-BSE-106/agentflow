import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/mongo/mongo'
import { getOptionalAuth, loginRequiredResponse } from '@/lib/auth/session'
import { errorResponse } from '@/lib/api/errors'
import { getClientIp, rateLimit } from '@/lib/rateLimit'
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL, warmUpEmbeddingModel } from '@/lib/rag/embeddings'
import { countStaleEmbeddings, getIndexStatus, VECTOR_INDEX_NAME } from '@/lib/rag/vectorStore'

/**
 * GET /api/rag/status
 *
 * Diagnostic endpoint to check knowledge base status for current user,
 * including the state of the Atlas vector index and whether any stored
 * embeddings are stale (written by a different model, or never written).
 */
export async function GET(req: NextRequest) {
  // Rate limit (Lane A3, D1 remainder): 60/min per client IP. Status
  // pre-warms the embedding model, so it is not free — but it is a read.
  const statusRl = await rateLimit(`rag:status:${getClientIp(req)}`, { windowMs: 60_000, max: 60 })
  if (!statusRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: statusRl.retryAfterMs }, { status: 429 })
  }
  try {
    const auth = await getOptionalAuth()
    if (auth === 'invalid') return loginRequiredResponse()
    // Guest mode: a guest has no knowledge base — empty counts, no DB read
    // at all, never another user's documents. (The dashboard and the
    // sandbox only read knowledge_base.documents/chunks/dimension.)
    if (auth === 'guest') {
      return NextResponse.json({
        status: 'ok',
        userId: null,
        knowledge_base: {
          documents: 0,
          chunks: 0,
          documents_list: [],
          sample_chunks: [],
          embedding_model: EMBEDDING_MODEL,
          embedding_dimension: EMBEDDING_DIMENSION,
          vector_index: { name: VECTOR_INDEX_NAME, state: 'MISSING', queryable: false },
          stale_embeddings: 0,
        },
      })
    }

    const userId = String(auth.userId)

    // Pre-warm the local embedding model so the first run does not pay the load cost.
    warmUpEmbeddingModel()

    const db = await getDb()

    // Get document count
    const docCount = await db.collection('rag_documents').countDocuments({ userId })
    
    // Get chunk count
    const chunkCount = await db.collection('rag_chunks').countDocuments({ userId })

    // Get sample chunks to verify they have embeddings
    const sampleChunks = await db
      .collection('rag_chunks')
      .find({ userId })
      .limit(3)
      .toArray()

    const documents = await db
      .collection('rag_documents')
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray()

    const { total, fresh } = await countStaleEmbeddings(userId)
    const vectorIndex = await getIndexStatus({ refresh: true })

    return NextResponse.json({
      status: 'ok',
      userId,
      knowledge_base: {
        documents: docCount,
        chunks: chunkCount,
        documents_list: documents.map(d => ({
          id: d._id.toString(),
          name: d.name,
          createdAt: d.createdAt
        })),
        sample_chunks: sampleChunks.map(c => ({
          id: c._id.toString(),
          documentId: c.documentId,
          text: c.text.slice(0, 100) + '...',
          has_embedding: !!c.embedding && Array.isArray(c.embedding) && c.embedding.length > 0
        })),
        // Embedding / vector index health
        embedding_model: EMBEDDING_MODEL,
        embedding_dimension: EMBEDDING_DIMENSION,
        vector_index: {
          name: VECTOR_INDEX_NAME,
          state: vectorIndex,
          queryable: vectorIndex === 'READY'
        },
        stale_embeddings: total - fresh,
      }
    })
  } catch (error) {
    console.error('[RAG Status] Error:', error)
    // Never echo the raw error: with the database down it used to answer
    // `MONGODB_URI is not set`, naming server config to the caller.
    return errorResponse(error)
  }
}

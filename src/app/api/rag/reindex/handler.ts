import { NextRequest, NextResponse } from 'next/server'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from '@/lib/rag/embeddings'
import { getReindexJob, startReindexJob } from '@/lib/rag/reindexJobs'
import { errorResponse } from '@/lib/api/errors'
import { getClientIp, rateLimit } from '@/lib/rateLimit'
import { GUEST_LOGIN_REQUIRED } from '@/lib/auth/session'

/**
 * POST /api/rag/reindex
 *
 * Rebuild every embedding for the current user with the current model.
 *
 * Why this exists: chunks written before the embedding fix carry hash-based
 * (garbage) vectors, or vectors from a different model/dimension. Their text is
 * fine — only the vectors are bad — so re-embedding in place is enough; there
 * is no need to re-upload the original files.
 *
 * This is a background job, not a 90s await inside a 60s route: POST starts
 * the job and returns its id immediately, chunks are written back
 * incrementally as they are embedded, and GET polls the job status.
 */
export async function POST(req: NextRequest) {
  // Rate limit (Lane A3, D1 remainder): 10/min per client IP — starting
  // a reindex re-embeds every chunk in the knowledge base, so it is the
  // most expensive RAG write.
  const reindexRl = await rateLimit(`rag:reindex:${getClientIp(req)}`, { windowMs: 60_000, max: 10 })
  if (!reindexRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: reindexRl.retryAfterMs }, { status: 429 })
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

    const job = await startReindexJob(userId)

    if (job.total === 0) {
      return NextResponse.json({
        success: true,
        jobId: job.jobId,
        status: job.status,
        total: 0,
        reindexed: 0,
        message: 'Knowledge base is empty — nothing to reindex yet.',
      }, { status: 202 })
    }

    return NextResponse.json({
      success: true,
      jobId: job.jobId,
      status: job.status,
      total: job.total,
      embedding_model: EMBEDDING_MODEL,
      embedding_dimension: EMBEDDING_DIMENSION,
      message: `Reindex started for ${job.total} chunk(s). Poll GET /api/rag/reindex?jobId=${job.jobId} for status.`,
    }, { status: 202 })
  } catch (error) {
    console.error('[RAG Reindex] Error:', error)
    // Never echo the raw error; errorResponse maps a down database to 503.
    return errorResponse(error, 'Reindex failed. Try again.')
  }
}

/**
 * GET /api/rag/reindex?jobId=…
 *
 * Poll a reindex job. Without jobId, returns the caller's most recent job.
 */
export async function GET(req: NextRequest) {
  // Rate limit (Lane A3, D1 remainder): job polling is a read, 60/min.
  const pollRl = await rateLimit(`rag:reindex:read:${getClientIp(req)}`, { windowMs: 60_000, max: 60 })
  if (!pollRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: pollRl.retryAfterMs }, { status: 429 })
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
    const jobId = new URL(req.url).searchParams.get('jobId') ?? undefined

    const job = await getReindexJob(userId, jobId)
    if (!job) {
      return NextResponse.json({ error: 'No reindex job found' }, { status: 404 })
    }

    return NextResponse.json({
      jobId: job.jobId,
      status: job.status,
      total: job.total,
      reindexed: job.reindexed,
      failed: job.failed,
      error: job.error,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
    })
  } catch (error) {
    console.error('[RAG Reindex] Status error:', error)
    // Never echo the raw error; errorResponse maps a down database to 503.
    return errorResponse(error, 'Failed to read reindex status. Try again.')
  }
}

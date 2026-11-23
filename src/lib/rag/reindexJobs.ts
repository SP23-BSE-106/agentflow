/**
 * Reindex as a background job (P1-5).
 *
 * The old route awaited the whole re-embedding plus a 90s index build inside
 * a route capped at 60s, and only wrote chunks at the very end — a slow run
 * died mid-flight and lost all its work. Now POST starts a job and returns
 * its id immediately; the job re-embeds in batches and writes each chunk
 * back as soon as it is embedded, so progress survives and the client polls
 * GET for status. Job state lives in Mongo (`rag_reindex_jobs`), not in
 * process memory, so a status poll is answered by any instance.
 */

import { ObjectId } from 'mongodb'
import { getDb } from '@/lib/mongo/mongo'
import { generateEmbeddings, EMBEDDING_MODEL } from '@/lib/rag/embeddings'
import { kickOffIndexBuild } from '@/lib/rag/vectorStore'

export type ReindexJobStatus = 'running' | 'completed' | 'failed'

export type ReindexJob = {
  jobId: string
  userId: string
  status: ReindexJobStatus
  total: number
  reindexed: number
  failed: number
  error: string | null
  createdAt: Date
  updatedAt: Date
  finishedAt: Date | null
}

const PAGE_SIZE = 100
const EMBED_CONCURRENCY = 4

function toJob(doc: Record<string, unknown>): ReindexJob {
  return {
    jobId: String(doc._id),
    userId: String(doc.userId),
    status: doc.status as ReindexJobStatus,
    total: Number(doc.total ?? 0),
    reindexed: Number(doc.reindexed ?? 0),
    failed: Number(doc.failed ?? 0),
    error: (doc.error as string | null) ?? null,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
    finishedAt: (doc.finishedAt as Date | null) ?? null,
  }
}

/** Start a reindex job and return its id immediately. The work runs behind it. */
export async function startReindexJob(userId: string): Promise<ReindexJob> {
  const db = await getDb()
  const now = new Date()
  const total = await db.collection('rag_chunks').countDocuments({ userId })
  const result = await db.collection('rag_reindex_jobs').insertOne({
    userId,
    status: 'running' as ReindexJobStatus,
    total,
    reindexed: 0,
    failed: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  })
  const job: ReindexJob = {
    jobId: String(result.insertedId),
    userId,
    status: 'running',
    total,
    reindexed: 0,
    failed: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  }
  // Fire-and-forget by design: the route has already answered. Any failure
  // is recorded on the job row, never swallowed.
  void runReindexJob(job.jobId, userId).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[RAG Reindex] Job failed:', message)
    await getDb()
      .then((db2) => db2.collection('rag_reindex_jobs').updateOne(
        { _id: new ObjectId(job.jobId), userId },
        { $set: { status: 'failed', error: message, finishedAt: new Date(), updatedAt: new Date() } },
      ))
      .catch(() => undefined)
  })
  return job
}

/** Fetch one job by id, or the caller's most recent job when no id is given. */
export async function getReindexJob(userId: string, jobId?: string): Promise<ReindexJob | null> {
  const db = await getDb()
  const filter: Record<string, unknown> = { userId }
  if (jobId && ObjectId.isValid(jobId)) filter._id = new ObjectId(jobId)
  const doc = await db
    .collection('rag_reindex_jobs')
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray()
  if (doc.length === 0) return null
  return toJob(doc[0] as unknown as Record<string, unknown>)
}

/**
 * Re-embed every chunk for the user, writing each chunk back as soon as it
 * is embedded (incremental writes — no all-at-end bulk write to lose).
 * Pages through the collection by _id so memory stays bounded.
 */
export async function runReindexJob(jobId: string, userId: string): Promise<void> {
  const db = await getDb()
  const jobs = db.collection('rag_reindex_jobs')
  const chunks = db.collection('rag_chunks')

  let reindexed = 0
  let failed = 0
  let lastId: ObjectId | null = null

  for (;;) {
    const pageFilter: Record<string, unknown> = { userId }
    if (lastId) pageFilter._id = { $gt: lastId }
    const page = await chunks
      .find(pageFilter)
      .sort({ _id: 1 })
      .limit(PAGE_SIZE)
      .toArray()
    if (page.length === 0) break
    lastId = page[page.length - 1]._id as ObjectId

    const texts = page.map((chunk) => String(chunk.text ?? '').trim())
    let vectors: number[][]
    try {
      vectors = await generateEmbeddings(texts, EMBED_CONCURRENCY)
    } catch (error) {
      // The batch shares one model load; if it fails, count the whole page
      // as failed and move on rather than aborting the job.
      console.error('[RAG Reindex] Embedding batch failed:', error)
      failed += page.length
      await jobs.updateOne(
        { _id: new ObjectId(jobId), userId },
        { $set: { reindexed, failed, updatedAt: new Date() } },
      )
      continue
    }

    for (let i = 0; i < page.length; i++) {
      const chunk = page[i]
      if (!texts[i]) {
        failed += 1
        continue
      }
      try {
        await chunks.updateOne(
          { _id: chunk._id },
          { $set: { embedding: vectors[i], embeddingModel: EMBEDDING_MODEL, reindexedAt: new Date() } },
        )
        reindexed += 1
      } catch (error) {
        console.error(`[RAG Reindex] Failed to write chunk ${chunk._id}:`, error)
        failed += 1
      }
    }

    await jobs.updateOne(
      { _id: new ObjectId(jobId), userId },
      { $set: { reindexed, failed, updatedAt: new Date() } },
    )
  }

  // Rebuild/repair the vector index in the background; never awaited here.
  kickOffIndexBuild()

  await jobs.updateOne(
    { _id: new ObjectId(jobId), userId },
    { $set: { status: 'completed', reindexed, failed, finishedAt: new Date(), updatedAt: new Date() } },
  )
  console.log(`[RAG Reindex] Job ${jobId} finished: ${reindexed} re-embedded, ${failed} failed.`)
}

/**
 * Shared rate limiting, backed by MongoDB so every serverless instance sees
 * the same counters. One document per key in the `rate_limits` collection,
 * with a TTL index on `resetAt` so expired buckets are deleted by MongoDB
 * instead of growing forever. Atomic findOneAndUpdate makes the increment
 * safe under concurrent requests.
 *
 * If MongoDB is unreachable the limiter FAILS CLOSED to a per-process
 * in-memory bucket with the same window and cap — a database outage
 * degrades to a local limiter instead of switching every limit off.
 * The in-memory buckets are capped in count and pruned on use so a
 * long-lived process cannot grow them forever. The shared-store attempt
 * is time-boxed to 2 s, so a dead database costs a request 2 s, not the
 * driver's ~30 s server-selection timeout, before the fallback runs.
 *
 * Client IP (see `getClientIp`): `x-forwarded-for` is client-controlled,
 * so it is never trusted on its own. With no trusted proxy configured the
 * caller gets one shared bucket per route (`direct`) — a spoofed header
 * cannot rotate into a fresh bucket. Set TRUSTED_PROXY_COUNT to the number
 * of proxies in front of this server (1 for the Pinggy tunnel) and the
 * entry the nearest trusted proxy appended — the last Nth entry — is used
 * instead. `x-real-ip` is never used: it is just as client-settable.
 */
import type { NextRequest } from 'next/server'

import { getDb } from '@/lib/mongo/mongo'

export type RateLimitOptions = {
  /** Time window in milliseconds */
  windowMs: number
  /** Maximum number of requests allowed within the window */
  max: number
}

let rateLimitIndex: Promise<unknown> | null = null

function ensureRateLimitIndex(db: Awaited<ReturnType<typeof getDb>>) {
  if (!rateLimitIndex) {
    rateLimitIndex = Promise.all([
      db.collection('rate_limits').createIndex({ key: 1 }, { unique: true }),
      db.collection('rate_limits').createIndex({ resetAt: 1 }, { expireAfterSeconds: 0 }),
    ]).catch(() => null)
  }
  return rateLimitIndex
}

/**
 * The client IP for rate limiting, from a request.
 *
 * No trusted proxy configured (the default): returns `'direct'`, so every
 * caller shares one bucket per route key. There is no trustworthy per-IP
 * value in a route handler without a trusted proxy — the socket address is
 * not exposed to App Router handlers, and both `x-forwarded-for` and
 * `x-real-ip` are whatever the caller sent.
 *
 * TRUSTED_PROXY_COUNT=N: each trusted proxy appends the address it was
 * connected from, so the last N entries were written by trusted proxies
 * and the entry just before them is the client address the outermost
 * trusted proxy saw. With one proxy (the Pinggy tunnel) that is the last
 * entry.
 */
export function getClientIp(request: NextRequest | Request | null | undefined): string {
  // Defensive: a handler called without a request (direct unit-test call)
  // must not throw — it shares the single 'direct' bucket instead.
  const raw = request?.headers?.get?.('x-forwarded-for') ?? ''
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const trusted = Math.max(0, Math.floor(Number(process.env.TRUSTED_PROXY_COUNT ?? '0')) || 0)
  if (trusted > 0 && parts.length > 0) {
    return parts[Math.max(0, parts.length - trusted)]
  }
  return 'direct'
}

// ── In-memory fallback (MongoDB down) ──────────────────────────────────

const MAX_MEMORY_BUCKETS = 10_000

type MemoryBucket = { count: number; resetAt: number }
const memoryBuckets = new Map<string, MemoryBucket>()

function memoryRateLimit(key: string, opts: RateLimitOptions) {
  const now = Date.now()
  // Prune expired buckets on use so the map stays bounded.
  if (memoryBuckets.size > MAX_MEMORY_BUCKETS) {
    for (const [k, bucket] of memoryBuckets) {
      if (bucket.resetAt <= now) memoryBuckets.delete(k)
    }
  }
  let bucket = memoryBuckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + opts.windowMs }
    memoryBuckets.set(key, bucket)
  }
  bucket.count += 1
  if (bucket.count > opts.max) {
    return { ok: false as const, remaining: 0, retryAfterMs: Math.max(0, bucket.resetAt - now) }
  }
  return { ok: true as const, remaining: Math.max(0, opts.max - bucket.count) }
}

export async function rateLimit(key: string, opts: RateLimitOptions) {
  // The shared-store attempt is time-boxed: without this, a dead MongoDB
  // costs every rate-limited request the driver's ~30 s server-selection
  // timeout before the fallback runs. The timed-out attempt keeps running
  // in the background (its write, if it ever lands, only makes the shared
  // bucket slightly stricter) while the caller is limited locally, fast.
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('rate-limit store timeout')), MONGO_TIMEOUT_MS),
  )
  try {
    return await Promise.race([mongoRateLimit(key, opts), timeout])
  } catch (error) {
    // MongoDB is down (or too slow): limit locally instead of letting
    // every request through. The limit still bites, just per-process
    // instead of shared.
    console.warn('[rateLimit] shared store unavailable, using in-memory bucket:', error)
    return memoryRateLimit(key, opts)
  }
}

/** How long the shared-store attempt gets before the local fallback wins. */
const MONGO_TIMEOUT_MS = 2_000

async function mongoRateLimit(key: string, opts: RateLimitOptions) {
  const now = Date.now()
  {
    const db = await getDb()
    await ensureRateLimitIndex(db)
    const col = db.collection('rate_limits')
    const current = await col.findOneAndUpdate(
      { key, resetAt: { $gt: new Date(now) } },
      { $inc: { count: 1 } },
      { returnDocument: 'after' },
    )
    if (current) {
      const count = Number(current.count) || 0
      const resetAt = new Date(current.resetAt as Date).getTime()
      if (count > opts.max) {
        return { ok: false as const, remaining: 0, retryAfterMs: Math.max(0, resetAt - now) }
      }
      return { ok: true as const, remaining: Math.max(0, opts.max - count) }
    }
    // No live bucket: start a fresh one (upsert handles a concurrent creator).
    try {
      await col.updateOne(
        { key },
        { $set: { count: 1, resetAt: new Date(now + opts.windowMs) } },
        { upsert: true },
      )
    } catch {
      // A concurrent request created the bucket first; the next call sees it.
    }
    return { ok: true as const, remaining: opts.max - 1 }
  }
}

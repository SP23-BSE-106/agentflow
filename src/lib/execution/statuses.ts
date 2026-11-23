/**
 * Execution statuses (n8n §6 of the feature map).
 *
 * Records in `workflow_runs` use:
 *   new | running | waiting | success | error | crashed | canceled
 * Completed = crashed / error / success; terminal = completed + canceled.
 *
 * `markStaleRunsCrashed` is crash recovery: runs still marked `new` or
 * `running` long after they started (default: older than 30 minutes) are
 * presumed to have died with their process and are marked `crashed`.
 * Call it from the executions list endpoint and from run start — the item
 * executor calls it at the start of every run (best effort, never fatal).
 */

import type { Db } from 'mongodb'
import { getDb } from '@/lib/mongo/mongo'

export const EXECUTION_STATUSES = [
  'new',
  'running',
  'waiting',
  'success',
  'error',
  'crashed',
  'canceled',
] as const

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number]

export const COMPLETED_STATUSES: ExecutionStatus[] = ['crashed', 'error', 'success']

export const TERMINAL_STATUSES: ExecutionStatus[] = [...COMPLETED_STATUSES, 'canceled']

export function isCompletedStatus(status: string): boolean {
  return (COMPLETED_STATUSES as string[]).includes(status)
}

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as string[]).includes(status)
}

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000

/**
 * Mark stale `new`/`running` runs `crashed`. Returns how many were marked.
 * Uses find + updateOne (not updateMany) so the same code runs against the
 * test fake DB as well as real MongoDB.
 */
export async function markStaleRunsCrashed(
  db?: Db,
  options?: { staleAfterMs?: number; userId?: string },
): Promise<number> {
  const handle = db ?? (await getDb())
  const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const cutoff = new Date(Date.now() - staleAfterMs)
  const filter: Record<string, unknown> = { status: { $in: ['new', 'running'] } }
  if (options?.userId) filter.userId = options.userId
  const stale = await handle.collection('workflow_runs').find(filter).toArray()
  let marked = 0
  for (const run of stale) {
    const createdAt = run.createdAt instanceof Date ? run.createdAt : new Date(run.createdAt)
    if (Number.isNaN(createdAt.getTime()) || createdAt >= cutoff) continue
    const result = await handle.collection('workflow_runs').updateOne(
      { _id: run._id },
      { $set: { status: 'crashed', finishedAt: new Date(), error: 'Run did not finish; marked crashed.' } },
    )
    if (result.modifiedCount > 0) marked += 1
  }
  return marked
}

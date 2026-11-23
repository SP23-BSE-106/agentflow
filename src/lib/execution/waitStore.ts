/**
 * Durable wait state (n8n §6 of the feature map).
 *
 * When a Wait node pauses a run, the run's state is saved in Mongo
 * collection `waiting_executions` — not in memory — so the process can
 * restart and the run can still resume:
 *   { executionId, workflowId, userId, nodeId, resumeAt,
 *     resumeKind: 'time' | 'webhook' | 'form', state }
 * `state` holds everything needed to continue: the graph snapshot, the
 * items the wait node received, the node results so far, and the run
 * context (vars, workflow name). Time-based waits are resumed by the
 * triggers/check sweep (Lane G) via `listDueWaitingExecutions`, or by
 * `POST /api/executions/[id]/resume`; webhook/form waits resume through
 * the same endpoint when the external event arrives.
 */

import { ObjectId, type Db } from 'mongodb'
import { getDb } from '@/lib/mongo/mongo'
import type { WorkflowItem } from '@/lib/nodes/items'
import type { NodeItemResult } from '@/lib/workflow/itemExecutor'
import type { WorkflowGraph } from '@/lib/mongo/workflow'

export type WaitingExecutionState = {
  graph: WorkflowGraph
  items: WorkflowItem[]
  nodeResults: NodeItemResult[]
  vars: Record<string, unknown>
  workflowName?: string
}

export type WaitingExecution = {
  _id?: unknown
  executionId: string
  workflowId: string
  userId: string
  nodeId: string
  resumeAt: Date
  resumeKind: 'time' | 'webhook' | 'form'
  state: WaitingExecutionState
  createdAt: Date
}

export async function saveWaitingExecution(
  record: Omit<WaitingExecution, '_id' | 'createdAt'>,
  db?: Db,
): Promise<string> {
  const handle = db ?? (await getDb())
  const executionId = record.executionId || new ObjectId().toHexString()
  await handle.collection('waiting_executions').insertOne({
    ...record,
    executionId,
    createdAt: new Date(),
  })
  return executionId
}

export async function getWaitingExecution(
  executionId: string,
  db?: Db,
): Promise<WaitingExecution | null> {
  const handle = db ?? (await getDb())
  const record = await handle.collection('waiting_executions').findOne({ executionId })
  return (record as WaitingExecution | null) ?? null
}

export async function deleteWaitingExecution(executionId: string, db?: Db): Promise<boolean> {
  const handle = db ?? (await getDb())
  const result = await handle
    .collection('waiting_executions')
    .deleteOne({ executionId })
  return result.deletedCount > 0
}

/** Waiting rows whose resume time has passed, oldest first. */
export async function listDueWaitingExecutions(db?: Db, now: Date = new Date()): Promise<WaitingExecution[]> {
  const handle = db ?? (await getDb())
  const rows = await handle
    .collection('waiting_executions')
    .find({ resumeKind: 'time' })
    .toArray()
  return (rows as WaitingExecution[])
    .filter((row) => {
      const resumeAt = row.resumeAt instanceof Date ? row.resumeAt : new Date(row.resumeAt)
      return !Number.isNaN(resumeAt.getTime()) && resumeAt <= now
    })
    .sort((a, b) => {
      const at = a.resumeAt instanceof Date ? a.resumeAt.getTime() : new Date(a.resumeAt).getTime()
      const bt = b.resumeAt instanceof Date ? b.resumeAt.getTime() : new Date(b.resumeAt).getTime()
      return at - bt
    })
}

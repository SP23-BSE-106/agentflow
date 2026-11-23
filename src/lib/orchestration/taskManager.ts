/**
 * Agent task lifecycle manager (implementation plan Phase 4).
 *
 * Represents work separately from messages: one task can produce progress
 * messages, retry messages, a final result, reviewer feedback, and approval
 * requests. Tasks flow through statuses: pending → assigned → running →
 * completed/failed/retrying.
 */

import { getDb } from '@/lib/mongo/mongo'
import { ObjectId } from 'mongodb'
import { ensureAgentTasksIndex } from '@/lib/mongo/indices'
import type { AgentTask, AgentTaskStatus } from '@/lib/mongo/agentTasks'

export type CreateTaskInput = {
  userId: string
  workflowRunId: string
  agentId: string
  title: string
  description: string
  input?: unknown
  parentTaskId?: string
  assignedByAgentId?: string
  dependsOnTaskIds?: string[]
  maxRetries?: number
}

/** Create a pending task. */
export async function createTask(input: CreateTaskInput): Promise<
  Omit<AgentTask, '_id'> & { _id: string }
> {
  const db = await getDb()
  await ensureAgentTasksIndex(db)

  const now = new Date()
  const task: Omit<AgentTask, '_id'> = {
    userId: input.userId,
    workflowRunId: input.workflowRunId,
    agentId: input.agentId,
    title: input.title,
    description: input.description,
    input: input.input,
    status: 'pending' as AgentTaskStatus,
    dependsOnTaskIds: input.dependsOnTaskIds ?? [],
    retryCount: 0,
    maxRetries: input.maxRetries ?? 3,
    parentTaskId: input.parentTaskId,
    assignedByAgentId: input.assignedByAgentId,
    createdAt: now,
    updatedAt: now,
  }

  const result = await db.collection('agent_tasks').insertOne(
    task as unknown as import('mongodb').Document,
  )
  return { ...task, _id: String(result.insertedId) }
}

/**
 * Transition a task to a new status, recording output or error and timing.
 *
 * Valid statuses: assigned, running, waiting, completed, failed, retrying.
 */
export async function updateTaskStatus(
  taskId: string,
  userId: string,
  workflowRunId: string,
  updates: Partial<Pick<AgentTask, 'status' | 'output' | 'error' | 'retryCount'>> & {
    startedAt?: boolean
    completedAt?: boolean
  },
): Promise<AgentTask | null> {
  const db = await getDb()
  const set: Record<string, unknown> = { updatedAt: new Date() }

  if (updates.status) set.status = updates.status
  if (updates.output !== undefined) set.output = updates.output
  if (updates.error !== undefined) set.error = updates.error
  if (updates.retryCount !== undefined) set.retryCount = updates.retryCount
  if (updates.startedAt) set.startedAt = new Date()
  if (updates.completedAt) set.completedAt = new Date()

  const result = await db
    .collection('agent_tasks')
    .findOneAndUpdate(
      { _id: new ObjectId(taskId), userId, workflowRunId },
      { $set: set },
      { returnDocument: 'after' },
    )

  return (result as unknown as AgentTask) || null
}

/** Mark a task completed with its output. */
export async function completeTask(
  taskId: string,
  userId: string,
  workflowRunId: string,
  output: unknown,
): Promise<AgentTask | null> {
  return updateTaskStatus(taskId, userId, workflowRunId, {
    status: 'completed',
    output,
    completedAt: true,
  })
}

/** Mark a task failed with an error message. */
export async function failTask(
  taskId: string,
  userId: string,
  workflowRunId: string,
  error: string,
): Promise<AgentTask | null> {
  return updateTaskStatus(taskId, userId, workflowRunId, {
    status: 'failed',
    error,
    completedAt: true,
  })
}

/** List tasks for a run, oldest first. */
export async function listTasks(
  userId: string,
  workflowRunId: string,
): Promise<AgentTask[]> {
  const db = await getDb()
  return db
    .collection('agent_tasks')
    .find({ userId, workflowRunId })
    .sort({ createdAt: 1 })
    .toArray() as unknown as AgentTask[]
}

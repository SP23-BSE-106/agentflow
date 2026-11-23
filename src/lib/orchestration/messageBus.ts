/**
 * Agent message bus (implementation plan Phase 2).
 *
 * Persists structured agent-to-agent messages to the `agent_messages`
 * collection and exposes chronological reads. Every message belongs to a
 * workflow run and has a sender; it may optionally address one recipient.
 */

import { getDb } from '@/lib/mongo/mongo'
import { ensureAgentMessagesIndex } from '@/lib/mongo/indices'
import type { AgentMessage, AgentMessageStatus, AgentMessageType } from '@/lib/mongo/agentMessages'

/** Create a structured message and persist it. */
export async function createMessage(input: {
  userId: string
  workflowId: string
  workflowRunId: string
  fromAgentId: string
  toAgentId?: string
  taskId?: string
  parentMessageId?: string
  type: AgentMessageType
  payload?: unknown
  text?: string
  priority?: 'low' | 'normal' | 'high'
  requiresResponse?: boolean
}): Promise<AgentMessage & { _id: unknown }> {
  const db = await getDb()
  await ensureAgentMessagesIndex(db)

  const now = new Date()
  const message: AgentMessage = {
    userId: input.userId,
    workflowId: input.workflowId,
    workflowRunId: input.workflowRunId,
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgentId,
    taskId: input.taskId,
    parentMessageId: input.parentMessageId,
    type: input.type,
    status: 'queued' as AgentMessageStatus,
    payload: input.payload,
    text: input.text,
    priority: input.priority ?? 'normal',
    requiresResponse: input.requiresResponse ?? false,
    retryCount: 0,
    createdAt: now,
  }

  const result = await db.collection('agent_messages').insertOne(
    message as unknown as import('mongodb').Document,
  )

  // Mark delivered immediately (no separate transport layer in MVP).
  await db
    .collection('agent_messages')
    .updateOne(
      { _id: result.insertedId },
      { $set: { status: 'delivered' as AgentMessageStatus, deliveredAt: now } },
    )
    .catch(() => undefined)

  return { ...message, _id: String(result.insertedId) }
}

/** List messages for a run, oldest first. */
export async function listMessages(
  userId: string,
  workflowRunId: string,
): Promise<AgentMessage[]> {
  const db = await getDb()
  return db
    .collection('agent_messages')
    .find({ userId, workflowRunId })
    .sort({ createdAt: 1 })
    .toArray() as unknown as AgentMessage[]
}

/**
 * Human approval checkpoints (implementation plan Phase 11).
 *
 * Allows users to approve, reject, or edit important outputs. When an
 * approval is required, the workflow pauses until the user responds.
 *
 * Modules it composes:
 *   - taskManager      — pause/resume task state
 *   - messageBus       — emit approval request/response messages
 *   - contextManager   — record approval decisions in shared context
 */

import { getDb } from '@/lib/mongo/mongo'
import { ObjectId } from 'mongodb'

import { createMessage } from './messageBus'
import { addDecision } from './contextManager'
import type { ApprovalRequest } from '@/lib/mongo/approvalRequests'

/** Create an approval request and pause the workflow run. */
export async function createApprovalRequest(input: {
  userId: string
  workflowRunId: string
  taskId: string
  requestedByAgentId: string
  title: string
  description: string
  payload?: unknown
}): Promise<ApprovalRequest & { _id: string }> {
  const db = await getDb()
  const now = new Date()

  const approval: ApprovalRequest = {
    userId: input.userId,
    workflowRunId: input.workflowRunId,
    taskId: input.taskId,
    requestedByAgentId: input.requestedByAgentId,
    title: input.title,
    description: input.description,
    payload: input.payload,
    status: 'pending',
    createdAt: now,
  }

  const result = await db
    .collection('approval_requests')
    .insertOne(approval as unknown as import('mongodb').Document)

  const id = String(result.insertedId)

  // Emit an approval_request message so the trace shows the pause point.
  await createMessage({
    userId: input.userId,
    workflowId: input.workflowRunId,
    workflowRunId: input.workflowRunId,
    fromAgentId: input.requestedByAgentId,
    toAgentId: undefined,
    taskId: input.taskId,
    type: 'approval_request',
    text: `${input.title}: ${input.description}`,
    payload: { approvalId: id },
    priority: 'high',
    requiresResponse: true,
  })

  // Record the pause in shared context.
  await addDecision(
    input.userId,
    input.workflowRunId,
    input.requestedByAgentId,
    'approval_requested',
    `${input.title} — ${input.description}`,
  )

  // Mark the workflow run as paused.
  await db
    .collection('workflow_runs')
    .updateOne(
      { _id: new ObjectId(input.workflowRunId), userId: input.userId },
      { $set: { status: 'paused', updatedAt: now } },
    )

  return { ...approval, _id: id }
}

/** Approve an approval request and resume the workflow. */
export async function approveApproval(
  approvalId: string,
  userId: string,
  response?: string,
  respondedBy?: string,
): Promise<ApprovalRequest | null> {
  return resolveApproval(approvalId, userId, 'approved', response, respondedBy)
}

/** Reject an approval request. */
export async function rejectApproval(
  approvalId: string,
  userId: string,
  response?: string,
  respondedBy?: string,
): Promise<ApprovalRequest | null> {
  return resolveApproval(approvalId, userId, 'rejected', response, respondedBy)
}

/** Edit and approve an approval request (user provides edited output). */
export async function editApproval(
  approvalId: string,
  userId: string,
  response: string,
  respondedBy?: string,
  editedPayload?: unknown,
): Promise<ApprovalRequest | null> {
  const db = await getDb()
  const now = new Date()

  const approval = await db.collection('approval_requests').findOne({
    _id: new ObjectId(approvalId),
    userId,
    status: 'pending',
  })
  if (!approval) return null

  const update: Record<string, unknown> = {
    status: 'edited',
    response: response || '',
    respondedBy: respondedBy || null,
    respondedAt: now,
    updatedAt: now,
  }
  if (editedPayload !== undefined) update.payload = editedPayload

  const result = await db
    .collection('approval_requests')
    .findOneAndUpdate(
      // status: 'pending' in the filter makes the update itself the atomic
      // guard: two concurrent edits cannot both succeed.
      { _id: new ObjectId(approvalId), userId, status: 'pending' },
      { $set: update },
      { returnDocument: 'after' },
    )

  const resolved = (result as unknown as ApprovalRequest) || null
  if (!resolved) return null

  // Emit an approval_response message.
  await createMessage({
    userId,
    workflowId: approval.workflowRunId,
    workflowRunId: approval.workflowRunId,
    fromAgentId: respondedBy || 'user',
    toAgentId: approval.requestedByAgentId,
    taskId: approval.taskId,
    type: 'approval_response',
    text: response,
    payload: { approvalId, status: 'edited', editedPayload },
    priority: 'high',
  })

  // Record the decision in shared context.
  await addDecision(
    userId,
    approval.workflowRunId,
    respondedBy || 'user',
    'approval_edited',
    response || 'Edited output approved.',
  )

  // Resume the workflow run.
  await db
    .collection('workflow_runs')
    .updateOne(
      { _id: new ObjectId(approval.workflowRunId), userId },
      { $set: { status: 'running', updatedAt: now } },
    )

  return resolved
}

/** List pending approval requests for a run. */
export async function listPendingApprovals(
  userId: string,
  workflowRunId: string,
): Promise<ApprovalRequest[]> {
  const db = await getDb()
  return db
    .collection('approval_requests')
    .find({ userId, workflowRunId, status: 'pending' })
    .sort({ createdAt: 1 })
    .toArray() as unknown as ApprovalRequest[]
}

/**
 * Internal: resolve (approve/reject) an approval request.
 */
async function resolveApproval(
  approvalId: string,
  userId: string,
  status: 'approved' | 'rejected',
  response?: string,
  respondedBy?: string,
): Promise<ApprovalRequest | null> {
  const db = await getDb()
  const now = new Date()

  const approval = await db.collection('approval_requests').findOne({
    _id: new ObjectId(approvalId),
    userId,
    status: 'pending',
  })
  if (!approval) return null

  const update: Record<string, unknown> = {
    status,
    response: response || null,
    respondedBy: respondedBy || null,
    respondedAt: now,
    updatedAt: now,
  }

  const result = await db
    .collection('approval_requests')
    .findOneAndUpdate(
      // status: 'pending' in the filter makes the update itself the atomic
      // guard: two concurrent decisions cannot both succeed.
      { _id: new ObjectId(approvalId), userId, status: 'pending' },
      { $set: update },
      { returnDocument: 'after' },
    )

  const resolved = (result as unknown as ApprovalRequest) || null
  if (!resolved) return null

  // Emit an approval_response message.
  await createMessage({
    userId,
    workflowId: approval.workflowRunId,
    workflowRunId: approval.workflowRunId,
    fromAgentId: respondedBy || 'user',
    toAgentId: approval.requestedByAgentId,
    taskId: approval.taskId,
    type: 'approval_response',
    text: response || '',
    payload: { approvalId, status },
    priority: 'high',
  })

  // Record the decision in shared context.
  await addDecision(
    userId,
    approval.workflowRunId,
    respondedBy || 'user',
    `approval_${status}`,
    response || `${status.charAt(0).toUpperCase() + status.slice(1)}`,
  )

  // Resume the workflow run if approved; leave paused if rejected.
  if (status === 'approved') {
    await db
      .collection('workflow_runs')
      .updateOne(
        { _id: new ObjectId(approval.workflowRunId), userId },
        { $set: { status: 'running', updatedAt: now } },
      )
  }

  return resolved
}

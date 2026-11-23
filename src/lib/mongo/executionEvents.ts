// TypeScript types for the execution_events collection.
// Immutable timeline of everything that happened during a workflow run.
// Used by the live execution monitor and run analytics.

export type ExecutionEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.paused'
  | 'run.resumed'
  | 'run.cancelled'
  | 'task.created'
  | 'task.assigned'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'task.retrying'
  | 'message.created'
  | 'message.delivered'
  | 'approval.requested'
  | 'approval.approved'
  | 'approval.rejected'
  | 'approval.edited'
  | 'evaluation.created'
  | 'error'

export type ExecutionEvent = {
  _id?: string
  userId: string
  workflowRunId: string
  agentId?: string
  taskId?: string
  messageId?: string
  type: ExecutionEventType
  payload?: Record<string, unknown>
  createdAt: Date
}

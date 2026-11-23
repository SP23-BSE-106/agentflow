// TypeScript types for the approval_requests collection.
// Human approval checkpoints that pause a workflow run until a user
// approves, rejects, or edits an important output.

export type ApprovalRequest = {
  _id?: string
  userId: string
  workflowRunId: string
  taskId: string
  requestedByAgentId: string
  title: string
  description: string
  payload?: unknown
  status: 'pending' | 'approved' | 'rejected' | 'edited' | 'expired'
  response?: string
  respondedBy?: string
  createdAt: Date
  respondedAt?: Date
}

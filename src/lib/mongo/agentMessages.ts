// TypeScript types for the agent_messages collection.
// Structured agent-to-agent communication during a workflow run.
// Every message belongs to a workflow run and has a sender. A message may
// have one recipient or be broadcast to permitted agents.

export type AgentMessageType =
  | 'task'
  | 'result'
  | 'feedback'
  | 'approval_request'
  | 'approval_response'
  | 'status'
  | 'error'
  | 'question'

export type AgentMessageStatus =
  | 'queued'
  | 'delivered'
  | 'processing'
  | 'completed'
  | 'failed'

export type AgentMessage = {
  _id?: string
  userId: string
  workflowId: string
  workflowRunId: string
  fromAgentId: string
  toAgentId?: string
  taskId?: string
  parentMessageId?: string
  type: AgentMessageType
  status: AgentMessageStatus
  payload?: unknown
  text?: string
  priority: 'low' | 'normal' | 'high'
  requiresResponse: boolean
  retryCount: number
  createdAt: Date
  deliveredAt?: Date
  completedAt?: Date
  error?: string
}

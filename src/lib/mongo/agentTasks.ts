// TypeScript types for the agent_tasks collection.
// Represents a unit of work assigned to an agent during a workflow run.
// Tasks are separate from messages: one task can produce progress messages,
// retry messages, a final result, reviewer feedback, and approval requests.

export type AgentTaskStatus =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'retrying'

export type AgentTask = {
  _id?: string
  userId: string
  workflowRunId: string
  agentId: string
  /** Optional parent task this task was decomposed from. */
  parentTaskId?: string
  /** Optional agent that assigned/delegated this task (e.g. a supervisor). */
  assignedByAgentId?: string
  title: string
  description: string
  input?: unknown
  output?: unknown
  status: AgentTaskStatus
  dependsOnTaskIds: string[]
  retryCount: number
  maxRetries: number
  startedAt?: Date
  completedAt?: Date
  error?: string
  createdAt: Date
  updatedAt?: Date
}

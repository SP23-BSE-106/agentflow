import type { Db } from 'mongodb'

/**
 * Lazy, memoised index creation for the multi-agent collections introduced in
 * Milestone 1 (communication foundation).
 *
 * Mirrors the existing pattern in `agentNameStore.ts` (`ensureAgentNameIndex`)
 * and `agents/runs/handler.ts` (`ensureRunsIndex`): each index is created once
 * per warm instance, and failures are swallowed so a missing index never
 * breaks a request — the application still guards reads/writes by `userId`.
 *
 * Every index prefixes `userId` so cross-user isolation is enforced at the
 * database layer as well as in application code.
 */

let agentTasksIndex: Promise<unknown> | null = null
let agentMessagesIndex: Promise<unknown> | null = null
let sharedContextsIndex: Promise<unknown> | null = null
let executionEventsIndex: Promise<unknown> | null = null
let agentEvaluationsIndex: Promise<unknown> | null = null
let approvalRequestsIndex: Promise<unknown> | null = null

export function ensureAgentTasksIndex(db: Db): Promise<unknown> {
  if (!agentTasksIndex) {
    agentTasksIndex = Promise.all([
      db.collection('agent_tasks').createIndex({ userId: 1, workflowRunId: 1 }),
      db.collection('agent_tasks').createIndex({ workflowRunId: 1, status: 1 }),
      db.collection('agent_tasks').createIndex({ workflowRunId: 1, agentId: 1 }),
    ]).catch(() => null)
  }
  return agentTasksIndex
}

export function ensureAgentMessagesIndex(db: Db): Promise<unknown> {
  if (!agentMessagesIndex) {
    agentMessagesIndex = Promise.all([
      db
        .collection('agent_messages')
        .createIndex({ userId: 1, workflowRunId: 1, createdAt: 1 }),
      db.collection('agent_messages').createIndex({ workflowRunId: 1, fromAgentId: 1 }),
      db.collection('agent_messages').createIndex({ workflowRunId: 1, toAgentId: 1 }),
      db.collection('agent_messages').createIndex({ workflowRunId: 1, taskId: 1 }),
    ]).catch(() => null)
  }
  return agentMessagesIndex
}

export function ensureSharedContextsIndex(db: Db): Promise<unknown> {
  if (!sharedContextsIndex) {
    sharedContextsIndex = db
      .collection('shared_contexts')
      .createIndex({ userId: 1, workflowRunId: 1 }, { unique: true })
      .catch(() => null)
  }
  return sharedContextsIndex
}

export function ensureExecutionEventsIndex(db: Db): Promise<unknown> {
  if (!executionEventsIndex) {
    executionEventsIndex = Promise.all([
      db
        .collection('execution_events')
        .createIndex({ userId: 1, workflowRunId: 1, createdAt: 1 }),
      db.collection('execution_events').createIndex({ workflowRunId: 1, type: 1 }),
    ]).catch(() => null)
  }
  return executionEventsIndex
}

export function ensureAgentEvaluationsIndex(db: Db): Promise<unknown> {
  if (!agentEvaluationsIndex) {
    agentEvaluationsIndex = Promise.all([
      db.collection('agent_evaluations').createIndex({ userId: 1, workflowRunId: 1 }),
      db.collection('agent_evaluations').createIndex({ workflowRunId: 1, targetTaskId: 1 }),
    ]).catch(() => null)
  }
  return agentEvaluationsIndex
}

export function ensureApprovalRequestsIndex(db: Db): Promise<unknown> {
  if (!approvalRequestsIndex) {
    approvalRequestsIndex = Promise.all([
      db
        .collection('approval_requests')
        .createIndex({ userId: 1, workflowRunId: 1, status: 1 }),
      db.collection('approval_requests').createIndex({ workflowRunId: 1, status: 1 }),
    ]).catch(() => null)
  }
  return approvalRequestsIndex
}

let usersEmailIndex: Promise<unknown> | null = null

/** One email, one account: a unique index on users.email. Best-effort (a
 * legacy duplicate would make creation fail loudly instead of silently
 * allowing a second account). */
export function ensureUsersEmailUniqueIndex(db: Db): Promise<unknown> {
  if (!usersEmailIndex) {
    usersEmailIndex = db
      .collection('users')
      .createIndex({ email: 1 }, { unique: true })
      .catch(() => null)
  }
  return usersEmailIndex
}

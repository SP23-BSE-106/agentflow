/**
 * Audit logging utility (implementation plan Phase 15 + Milestone 7).
 *
 * Records security-sensitive and business events to the `audit_events`
 * collection. Every call is fire-and-forget: a failure to write an audit
 * log must never break the user-facing request.
 */

import { getDb } from '@/lib/mongo/mongo'
import type { AuditEvent } from '@/lib/mongo/auditEvent'

/**
 * Write an audit event. Best-effort: errors are logged to console, not
 * thrown, so audit logging can never break the request being audited.
 */
export async function auditLog(input: {
  userId?: string
  action: AuditEvent['action']
  resourceType?: AuditEvent['resourceType']
  resourceId?: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  try {
    const db = await getDb()
    const event: AuditEvent = {
      action: input.action,
      createdAt: new Date(),
    }
    if (input.userId) event.userId = input.userId
    if (input.resourceType) event.resourceType = input.resourceType
    if (input.resourceId) event.resourceId = input.resourceId
    if (input.metadata) event.metadata = input.metadata
    await db.collection<AuditEvent>('audit_events').insertOne(event)
  } catch (error) {
    console.warn('[audit] failed to write audit event:', error)
  }
}

/** Convenience: log a workflow execution event. */
export async function auditWorkflowExecute(input: {
  userId: string
  workflowId?: string
  runId?: string
  mode?: string
  status?: string
  durationMs?: number
  agentId?: string
}): Promise<void> {
  await auditLog({
    userId: input.userId,
    action: 'workflow.execute',
    resourceType: 'workflow',
    resourceId: input.workflowId,
    metadata: {
      runId: input.runId ?? undefined,
      mode: input.mode ?? undefined,
      status: input.status ?? undefined,
      durationMs: input.durationMs ?? undefined,
      agentId: input.agentId ?? undefined,
    } as Record<string, unknown>,
  })
}

/** Convenience: log an agent lifecycle event. */
export async function auditAgentLifecycle(input: {
  userId: string
  action: 'agent.create' | 'agent.update' | 'agent.delete' | 'agent.generate_workflow'
  agentId: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  await auditLog({
    userId: input.userId,
    action: input.action,
    resourceType: 'agent',
    resourceId: input.agentId,
    metadata: input.metadata,
  })
}

/** Convenience: log a multi-agent orchestration event. */
export async function auditOrchestration(input: {
  userId: string
  workflowRunId: string
  action: 'orchestrate.started' | 'orchestrate.completed' | 'orchestrate.failed' | string
  metadata?: Record<string, unknown>
}): Promise<void> {
  await auditLog({
    userId: input.userId,
    action: input.action as AuditEvent['action'],
    resourceType: 'workflow',
    resourceId: input.workflowRunId,
    metadata: input.metadata,
  })
}

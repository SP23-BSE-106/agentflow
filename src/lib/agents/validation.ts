/**
 * Validation for the agent fields the API writes (P1-1).
 *
 * The Agent type promises these knobs, and the orchestrator reads them, so
 * the API has to accept and store them — validated, with sane bounds — or the
 * critic and per-agent approval can never exist.
 */

import type { AgentRole } from '@/lib/mongo/agent'

/** Every role an agent may be created with. 'critic' is a real role: the
 *  orchestrator picks its evaluator by it. */
export const AGENT_ROLES: AgentRole[] = [
  'supervisor',
  'planner',
  'researcher',
  'writer',
  'reviewer',
  'critic',
  'fact_checker',
  'analyst',
  'custom',
]

/** Largest completion a single agent turn may request. */
export const MAX_TOKEN_BUDGET_MIN = 128
export const MAX_TOKEN_BUDGET_MAX = 8192
/** Largest retry count an agent may carry. */
export const MAX_RETRY_COUNT_MIN = 0
export const MAX_RETRY_COUNT_MAX = 5
/** Longest system prompt accepted. */
export const SYSTEM_PROMPT_MAX_LENGTH = 8000

export type AgentFieldValues = {
  role?: AgentRole
  systemPrompt?: string
  maxTokenBudget?: number
  maxRetryCount?: number
  humanApprovalRequired?: boolean
  fallbackAgentId?: string
}

export type AgentFieldValidation = {
  ok: boolean
  errors: string[]
  /** Only the fields that were present and valid. */
  fields: AgentFieldValues
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate the agent fields in a POST/PATCH body. Fields that are absent are
 * left out of `fields` (so PATCH only touches what the caller sent); fields
 * that are present but invalid produce an error and are left out.
 */
export function validateAgentFields(body: unknown): AgentFieldValidation {
  const errors: string[] = []
  const fields: AgentFieldValues = {}
  if (!isRecord(body)) return { ok: false, errors: ['Request body must be an object.'], fields }

  if ('role' in body && body.role !== undefined && body.role !== null) {
    if (typeof body.role !== 'string' || !(AGENT_ROLES as string[]).includes(body.role)) {
      errors.push(`role must be one of: ${AGENT_ROLES.join(', ')}.`)
    } else {
      fields.role = body.role as AgentRole
    }
  }

  if ('systemPrompt' in body && body.systemPrompt !== undefined && body.systemPrompt !== null) {
    if (typeof body.systemPrompt !== 'string') {
      errors.push('systemPrompt must be a string.')
    } else if (body.systemPrompt.length > SYSTEM_PROMPT_MAX_LENGTH) {
      errors.push(`systemPrompt must be at most ${SYSTEM_PROMPT_MAX_LENGTH} characters.`)
    } else {
      fields.systemPrompt = body.systemPrompt
    }
  }

  if ('maxTokenBudget' in body && body.maxTokenBudget !== undefined && body.maxTokenBudget !== null) {
    const n = Number(body.maxTokenBudget)
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      errors.push('maxTokenBudget must be a whole number.')
    } else if (n < MAX_TOKEN_BUDGET_MIN || n > MAX_TOKEN_BUDGET_MAX) {
      errors.push(`maxTokenBudget must be between ${MAX_TOKEN_BUDGET_MIN} and ${MAX_TOKEN_BUDGET_MAX}.`)
    } else {
      fields.maxTokenBudget = n
    }
  }

  if ('maxRetryCount' in body && body.maxRetryCount !== undefined && body.maxRetryCount !== null) {
    const n = Number(body.maxRetryCount)
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      errors.push('maxRetryCount must be a whole number.')
    } else if (n < MAX_RETRY_COUNT_MIN || n > MAX_RETRY_COUNT_MAX) {
      errors.push(`maxRetryCount must be between ${MAX_RETRY_COUNT_MIN} and ${MAX_RETRY_COUNT_MAX}.`)
    } else {
      fields.maxRetryCount = n
    }
  }

  if ('humanApprovalRequired' in body && body.humanApprovalRequired !== undefined && body.humanApprovalRequired !== null) {
    if (typeof body.humanApprovalRequired !== 'boolean') {
      errors.push('humanApprovalRequired must be true or false.')
    } else {
      fields.humanApprovalRequired = body.humanApprovalRequired
    }
  }

  if ('fallbackAgentId' in body && body.fallbackAgentId !== undefined && body.fallbackAgentId !== null) {
    if (typeof body.fallbackAgentId !== 'string' || !body.fallbackAgentId.trim()) {
      errors.push('fallbackAgentId must be a non-empty agent id string.')
    } else {
      fields.fallbackAgentId = body.fallbackAgentId.trim()
    }
  }

  return { ok: errors.length === 0, errors, fields }
}

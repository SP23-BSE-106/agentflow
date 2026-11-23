/**
 * Permission and execution-budget checks (implementation plan Phase 15 +
 * Milestone 7).
 *
 * Provides helpers to enforce cross-user isolation, per-user rate limits,
 * and execution budgets. All checks are best-effort: they fail closed
 * (deny) when the database is unreachable, and they never throw — they
 * return a result object the caller can turn into an HTTP response.
 */

import { getDb } from '@/lib/mongo/mongo'
import { rateLimit } from '@/lib/rateLimit'
import type { UserSettings } from '@/lib/mongo/userSettings'
import { ObjectId, type Document, type Filter } from 'mongodb'

/** Result of a permission check. */
export type PermissionResult = {
  allowed: boolean
  reason?: string
  status?: number
}

/** Result of an execution-budget check. */
export type BudgetResult = {
  allowed: boolean
  reason?: string
  status?: number
  remaining?: number
}

/** Default budgets when none are configured in user settings. */
const DEFAULT_BUDGETS: Required<NonNullable<UserSettings['executionBudget']>> = {
  maxRunsPerHour: 60,
  maxRunDurationMs: 300_000,
  maxTasksPerRun: 50,
  maxMessagesPerRun: 500,
}

export async function getExecutionBudget(
  userId: string,
): Promise<Required<NonNullable<UserSettings['executionBudget']>>> {
  let db
  try {
    db = await getDb()
  } catch {
    // Fail closed on a database error: deny by returning the most
    // restrictive budget (0 runs/hour) is handled by callers via
    // checkExecutionBudget catching below; here return defaults so a
    // read-only budget query never throws.
    return { ...DEFAULT_BUDGETS }
  }
  const settings = (await db.collection('workspace_settings').findOne({ userId })) as
    | UserSettings
    | null
    | undefined

  return {
    maxRunsPerHour: settings?.executionBudget?.maxRunsPerHour ?? DEFAULT_BUDGETS.maxRunsPerHour,
    maxRunDurationMs: settings?.executionBudget?.maxRunDurationMs ?? DEFAULT_BUDGETS.maxRunDurationMs,
    maxTasksPerRun: settings?.executionBudget?.maxTasksPerRun ?? DEFAULT_BUDGETS.maxTasksPerRun,
    maxMessagesPerRun: settings?.executionBudget?.maxMessagesPerRun ?? DEFAULT_BUDGETS.maxMessagesPerRun,
  }
}

/**
 * Check that a resource (agent, workflow, run, message, task) belongs to the
 * calling user. Prevents cross-user data access.
 *
 * @param db - MongoDB database handle
 * @param collection - collection name
 * @param resourceId - id of the resource
 * @param userId - calling user's id
 */
export async function checkOwnership(
  collection: string,
  resourceId: string,
  userId: string,
): Promise<PermissionResult> {
  let resource
  try {
    const db = await getDb()
    const ids: (string | ObjectId)[] = [resourceId]
    if (ObjectId.isValid(resourceId)) ids.push(new ObjectId(resourceId))
    resource = await db
      .collection(collection)
      .findOne({ _id: { $in: ids }, userId } as Filter<Document>)
  } catch {
    return { allowed: false, reason: 'Could not verify ownership', status: 503 }
  }
  if (!resource) {
    return { allowed: false, reason: 'Resource not found or not owned by you', status: 404 }
  }
  return { allowed: true }
}

/**
 * Check a specific permission flag for a user.
 *
 * A workspace with no settings document yet is the owner's own workspace,
 * so it keeps the owner defaults (allowed). A flag missing from an existing
 * document likewise keeps the owner default — only an explicit `false`
 * denies. That is the B-7 fix: a document written before a flag existed
 * (notably `canCreateAgents`) used to deny it, locking the owner out of
 * creating agents with no reset — the settings endpoint never accepts
 * permissions from the client, so a missing flag was never a deliberate
 * denial. A database error also denies.
 * Roles and permissions are server-side only: the workspace settings
 * endpoint no longer accepts them from the client (see
 * src/app/api/settings/workspace/handler.ts).
 */
export async function checkPermission(
  userId: string,
  flag: keyof NonNullable<UserSettings['permissions']>,
): Promise<PermissionResult> {
  let settings: (UserSettings & { permissions?: UserSettings['permissions'] }) | null | undefined
  try {
    const db = await getDb()
    settings = (await db.collection('workspace_settings').findOne({ userId })) as
      | (UserSettings & { permissions?: UserSettings['permissions'] })
      | null
      | undefined
  } catch {
    return { allowed: false, reason: 'Could not verify permission', status: 503 }
  }

  if (!settings) return { allowed: true }
  const enabled = settings.permissions?.[flag] ?? true
  if (!enabled) {
    return {
      allowed: false,
      reason: `Permission '${flag}' is disabled for your workspace`,
      status: 403,
    }
  }
  return { allowed: true }
}

/**
 * Check rate limits for a scoped key (e.g. `execute:userId`).
 */
export async function checkRateLimit(
  key: string,
  opts: { windowMs: number; max: number },
): Promise<{ ok: boolean; remaining: number; retryAfterMs?: number }> {
  return rateLimit(key, opts)
}

/**
 * Check execution budgets for a user. Returns allowed=false if any budget
 * is exceeded. Also checks the per-hour run rate limit.
 */
export async function checkExecutionBudget(userId: string): Promise<BudgetResult> {
  let budget: Awaited<ReturnType<typeof getExecutionBudget>>
  try {
    budget = await getExecutionBudget(userId)
  } catch {
    return { allowed: false, reason: 'Could not verify execution budget', status: 503 }
  }

  // ── Rate limit: max runs per hour ──────────────────────────────────
  const rl = await checkRateLimit(`budget:runs:${userId}`, {
    windowMs: 60_000 * 60,
    max: budget.maxRunsPerHour,
  })
  if (!rl.ok) {
    return {
      allowed: false,
      reason: `Hourly run limit exceeded (${budget.maxRunsPerHour}/hour). Try again later.`,
      status: 429,
      remaining: 0,
    }
  }

  return { allowed: true, remaining: rl.remaining ?? 0 }
}

/**
 * Combine a permission check and budget check into one result.
 */
export async function authorizeExecution(
  userId: string,
  permissionFlag: keyof NonNullable<UserSettings['permissions']> = 'canExecute',
): Promise<PermissionResult & BudgetResult> {
  const permission = await checkPermission(userId, permissionFlag)
  if (!permission.allowed) {
    return { ...permission, remaining: undefined }
  }

  const budget = await checkExecutionBudget(userId)
  if (!budget.allowed) {
    return { ...budget, reason: budget.reason, status: budget.status }
  }

  return { allowed: true, remaining: budget.remaining }
}

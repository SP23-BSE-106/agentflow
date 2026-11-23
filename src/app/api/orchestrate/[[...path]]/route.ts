import type { NextRequest } from 'next/server'

import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { GUEST_LOGIN_REQUIRED } from '@/lib/auth/session'
import { authorizeExecution, checkOwnership } from '@/lib/permissions'
import { auditWorkflowExecute } from '@/lib/audit'
import { rateLimit, getClientIp } from '@/lib/rateLimit'
import { isCrossOriginRequest } from '@/lib/originCheck'
import { orchestrate } from '@/lib/orchestration/orchestrator'
import { orchestrationRequestSchema } from '@/lib/validation/orchestrationSchemas'
import {
  generateSupervisorPlan,
  listAvailableAgents,
  validateSupervisorPlan,
} from '@/lib/orchestration/supervisor'
import { type DispatchContext } from '@/lib/api/routeDispatch'
import { webhookPost } from '@/lib/triggers/webhookRoute'
import { registerTestWebhookPost, unregisterTestWebhookDelete } from '@/lib/triggers/registerRoute'
import { triggersCheckPost } from '@/lib/triggers/checkRoute'
import { formsGet, formsPost } from '@/lib/triggers/formsRoute'

export const maxDuration = 60

async function getAuthenticatedUserId(): Promise<string | null> {
  const token = await getSessionTokenFromCookies()
  if (!token) return null
  try {
    return (await verifyJwtSession(token)).sub
  } catch {
    return null
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * POST /api/orchestrate — execute a workflow as a multi-agent run.
 *
 * Body: { agentId, input, mode?, conversational? }
 *   - agentId: the agent whose workflow graph will be executed
 *   - input:   the original user request
 *   - mode:    'sequential' | 'parallel' | 'supervisor' | 'team' (default 'sequential')
 *   - conversational: true asks the supervisor to run conversationally
 *     (ask agents questions, re-plan from answers); default false.
 *
 * Returns the orchestration result (run id, status, output, task/message
 * counts, duration).
 */
async function orchestratePost(request: NextRequest) {
  if (isCrossOriginRequest(request)) {
    return json({ error: 'Cross-origin requests are not allowed here.' }, 403)
  }
  // Orchestrate runs real (and LLM-spending) work, so it is throttled
  // (30/min) like the other mutating routes.
  const rl = await rateLimit(`orchestrate:${getClientIp(request)}`, { windowMs: 60_000, max: 30 })
  if (!rl.ok) {
    return json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, 429)
  }
  const userId = await getAuthenticatedUserId()
  if (!userId) {
    return json({ error: GUEST_LOGIN_REQUIRED }, 401)
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return json({ error: 'Invalid request body' }, 400)
  }

  const parsed = orchestrationRequestSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      {
        error: 'Invalid orchestration request',
        issues: parsed.error.issues,
      },
      400,
    )
  }
  const { agentId, input, mode, topK, conversational } = parsed.data

  // ── Permission check ───────────────────────────────────────────────
  const permission = await authorizeExecution(userId, 'canExecute')
  if (!permission.allowed) {
    return json({ error: permission.reason }, permission.status ?? 403)
  }

  // ── Ownership: agent must belong to the caller ─────────────────────
  const owned = await checkOwnership('agents', agentId, userId)
  if (!owned.allowed) {
    return json({ error: owned.reason }, owned.status ?? 404)
  }

  try {
    const startedAt = Date.now()
    const result = await orchestrate({ agentId, input, userId, mode: mode ?? 'sequential', topK, conversational })
    const durationMs = Date.now() - startedAt

    // ── Audit log ────────────────────────────────────────────────────
    await auditWorkflowExecute({
      userId,
      workflowId: agentId,
      runId: result.runId,
      mode,
      status: result.status,
      durationMs,
      agentId,
    })

    return json(result, 200)
  } catch (error) {
    // Generic client-facing message on purpose: the real error can carry
    // provider / database internals. It is logged server-side instead.
    console.error('[orchestrate] run failed:', error)

    // ── Audit log for failure ────────────────────────────────────────
    await auditWorkflowExecute({
      userId,
      workflowId: agentId,
      mode,
      status: 'failed',
      agentId,
    })

    return json({ error: 'Running them together failed. Please try again.' }, 500)
  }
}

/**
 * POST /api/orchestrate/plan — generate a supervisor execution plan from a
 * natural-language request WITHOUT executing it. Returns the plan plus
 * validation results so the user can preview and approve before running.
 *
 * Body: { input, agentId? }
 *   - input:   the natural-language request
 *   - agentId: optional id of the supervisor agent to use
 *
 * The old URL /api/supervisor/plan still works: next.config.ts rewrites it
 * here, so existing callers do not need to change.
 */
async function planPost(request: NextRequest) {
  if (isCrossOriginRequest(request)) {
    return json({ error: 'Cross-origin requests are not allowed here.' }, 403)
  }
  // Plan generation calls the LLM, so it is throttled too (30/min).
  const rl = await rateLimit(`orchestrate:plan:${getClientIp(request)}`, { windowMs: 60_000, max: 30 })
  if (!rl.ok) {
    return json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, 429)
  }
  const userId = await getAuthenticatedUserId()
  if (!userId) {
    return json({ error: GUEST_LOGIN_REQUIRED }, 401)
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return json({ error: 'Invalid request body' }, 400)
  }

  const { input } = body
  if (!input || typeof input !== 'string' || !input.trim()) {
    return json({ error: 'input is required' }, 400)
  }

  try {
    const agents = await listAvailableAgents(userId)
    const plan = await generateSupervisorPlan(userId, input, agents)
    const validation = validateSupervisorPlan(plan, agents)

    return json({ plan, validation, agents }, 200)
  } catch (error) {
    // Generic client-facing message on purpose: the real error can carry
    // provider / database internals. It is logged server-side instead.
    console.error('[orchestrate] plan failed:', error)
    return json({ error: 'Plan generation failed. Please try again.' }, 500)
  }
}

async function run(
  method: string,
  request: NextRequest,
  ctx: DispatchContext,
): Promise<Response> {
  const { path = [] } = await ctx.params
  // n8n trigger/form entry points. Their public URLs
  // (/api/webhooks/:workflowId/:mode, /api/triggers/check,
  // /api/forms/:workflowId) are preserved by rewrites in next.config.ts,
  // which land here so the Vercel Hobby 12-function budget holds.
  if (method === 'GET' && path.length === 2 && path[0] === 'forms') {
    return formsGet(path[1])
  }
  // Test-webhook unregistration (Lane A5): DELETE is handled before the
  // POST-only guard below, so stopping a listener works.
  if (
    method === 'DELETE' &&
    path.length === 4 &&
    path[0] === 'webhooks' &&
    path[2] === 'test' &&
    path[3] === 'register'
  ) {
    return unregisterTestWebhookDelete(request, path[1])
  }
  if (method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }
  if (path.length === 0) return orchestratePost(request)
  if (path.length === 1 && path[0] === 'plan') return planPost(request)
  // Test-webhook registration (Lane A5): POST .../test/register starts
  // listening and returns the test URL with its ?token=. Lives in this
  // catch-all so no new route file (and no new function) is needed.
  if (
    path.length === 4 &&
    path[0] === 'webhooks' &&
    path[2] === 'test' &&
    path[3] === 'register'
  ) {
    return registerTestWebhookPost(request, path[1])
  }
  if (path.length === 3 && path[0] === 'webhooks') {
    return webhookPost(request, path[1], path[2])
  }
  if (path.length === 2 && path[0] === 'triggers' && path[1] === 'check') {
    return triggersCheckPost(request)
  }
  if (path.length === 2 && path[0] === 'forms') {
    return formsPost(request, path[1])
  }
  return json({ error: 'Not found' }, 404)
}

export function POST(request: NextRequest, ctx: DispatchContext) {
  return run('POST', request, ctx)
}

export function GET(request: NextRequest, ctx: DispatchContext) {
  return run('GET', request, ctx)
}

export function PUT(request: NextRequest, ctx: DispatchContext) {
  return run('PUT', request, ctx)
}

export function PATCH(request: NextRequest, ctx: DispatchContext) {
  return run('PATCH', request, ctx)
}

export function DELETE(request: NextRequest, ctx: DispatchContext) {
  return run('DELETE', request, ctx)
}

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { ObjectId, type Db } from 'mongodb'

import { rateLimit } from '@/lib/rateLimit'
import { getClientIp } from '@/lib/rateLimit'
import { isCrossOriginRequest } from '@/lib/originCheck'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { getOptionalAuth, GUEST_LOGIN_REQUIRED } from '@/lib/auth/session'
import { parseAgentKey } from '@/lib/byok'
import { MAX_INPUT_CHARS, isTooLong, lengthError } from '@/lib/inputLimits'
import { getDb } from '@/lib/mongo/mongo'
import { runWorkflow } from '@/lib/workflow/runWorkflow'
import { executeWorkflow } from '@/lib/workflow/executor'
import { validateGuestWorkflow } from '@/lib/workflow/guestValidation'
import { parseTopK } from '@/lib/rag/grounding'

// The model call below can take most of half a minute on a cold provider; the
// route has to declare the budget or Vercel cuts the function off first.
export const maxDuration = 60

type AuthContext = {
  db: Db
  userId: string
  /** Set when the caller authenticated with an API key rather than a cookie. */
  keyId: ObjectId | null
}

/**
 * Accepts either an `Authorization: Bearer sk_live_…` key (the point of a
 * public API) or the dashboard's session cookie. Keys are stored hashed, so a
 * leaked database does not yield working credentials.
 */
async function authenticate(request: NextRequest): Promise<AuthContext | { error: string; status: number }> {
  const header = request.headers.get('authorization')

  if (header) {
    if (!header.startsWith('Bearer ')) {
      return { error: 'Authorization header must use the Bearer scheme.', status: 400 }
    }

    const rawKey = header.slice(7).trim()
    if (!rawKey) return { error: 'Empty bearer token.', status: 400 }

    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    const db = await getDb()
    const key = await db.collection('personal_api_keys').findOne({ keyHash })

    if (!key) return { error: 'Invalid API key.', status: 401 }
    return { db, userId: String(key.userId), keyId: key._id }
  }

  const token = await getSessionTokenFromCookies()
  if (!token) {
    return { error: GUEST_LOGIN_REQUIRED, status: 401 }
  }

  try {
    const payload = await verifyJwtSession(token)
    return { db: await getDb(), userId: String(payload.sub), keyId: null }
  } catch {
    return { error: GUEST_LOGIN_REQUIRED, status: 401 }
  }
}

/**
 * Stateless guest run: a client-supplied workflow, validated, run through
 * the sandboxed string engine with no user id that owns anything ('guest'),
 * and nothing written anywhere — no run record, no session, no workspace
 * settings. The response shape mirrors the signed-in run (including the
 * step-by-step trace on failure, so the pages can show the record even
 * when a step failed), plus `guest: true` and `agentId: null`.
 */
async function runGuest(body: Record<string, unknown>): Promise<NextResponse> {
  // An expired session must be told to log in again, never silently
  // downgraded to a guest run.
  const optional = await getOptionalAuth()
  if (optional === 'invalid') {
    return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })
  }

  const { input, topK } = body as { input?: unknown; topK?: unknown }
  if (!input || typeof input !== 'string' || !input.trim()) {
    return NextResponse.json({ error: 'input is required' }, { status: 400 })
  }
  if (isTooLong(input, MAX_INPUT_CHARS)) {
    const err = lengthError('input', MAX_INPUT_CHARS)
    return NextResponse.json({ error: err.error }, { status: err.status })
  }
  // H18: one topK source of truth — parseTopK (1..50) everywhere. The old
  // 10-cap here disagreed with rag/query and the RAG node (both 50), so the
  // same question + topK=50 retrieved 10 sources here and 22 there.
  const effectiveTopK = parseTopK(topK, 3)

  // A guest may bring their own provider key, as a separate body field —
  // never part of the workflow, so guest validation is untouched. An
  // invalid shape is a 400, not a silent fall back to shared providers.
  const callerKey = body.agentKey === undefined ? undefined : (parseAgentKey(body.agentKey) ?? undefined)
  if (body.agentKey !== undefined && !callerKey) {
    return NextResponse.json(
      { error: 'That key does not look right. Check the provider and key and try again.' },
      { status: 400 },
    )
  }

  const validated = validateGuestWorkflow(body.workflow)
  if ('error' in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 })
  }
  const { graph } = validated
  const workflowName =
    typeof (body.workflow as Record<string, unknown>)?.name === 'string' &&
    ((body.workflow as Record<string, unknown>).name as string).trim()
      ? ((body.workflow as Record<string, unknown>).name as string).trim()
      : 'Guest workflow'

  let result
  try {
    result = await executeWorkflow(graph, input.trim(), 'guest', {
      topK: effectiveTopK,
      ...(callerKey ? { agentKey: callerKey } : {}),
    })
  } catch (error) {
    // Generic client-facing message on purpose: the real error can carry
    // provider / database internals (hostnames, paths). It is logged
    // server-side instead. The run's own step errors still reach the
    // caller through the result trace below — those are the owner's own
    // workflow diagnostics, not infra internals.
    console.error('[execute] guest run failed:', error)
    return NextResponse.json({ error: 'Execution failed. Please try again.' }, { status: 500 })
  }

  const allOk = result.trace.every((step) => step.ok)
  const payload = {
    executed: allOk,
    agentId: null,
    agentName: workflowName,
    output: result.output,
    model: result.model,
    provider: result.provider,
    sources: result.sources,
    trace: result.trace,
    deployed: false,
    grounded: result.sources.length > 0,
    guest: true,
    executedAt: new Date().toISOString(),
  }
  if (!allOk) {
    const firstFailure = result.trace.find((step) => !step.ok)
    return NextResponse.json(
      { ...payload, error: firstFailure?.error ?? firstFailure?.summary ?? 'Execution failed' },
      { status: 502 },
    )
  }
  return NextResponse.json(payload)
}

/**
 * POST /api/execute
 *
 * Runs one turn of an agent. The work itself lives in
 * src/lib/workflow/runWorkflow.ts — this route only authenticates, rate
 * limits, and maps the result to HTTP. The builder's Run path calls this
 * same route, so production and builder runs cannot drift apart.
 *
 * Guest runs (no account, no agentId): a visitor may POST a workflow they
 * hold in their browser (`{ workflow, input }`) and it runs statelessly
 * through the same sandboxed string engine (`executeWorkflow`) — the six
 * legacy node types only, validated exactly as server workflows are (see
 * src/lib/workflow/guestValidation.ts). Nothing is persisted, no server
 * session is created, and no user data is touched: RAG has no files for a
 * guest, keys, approvals, uploads and payments stay login-only. Guests get
 * their own tighter rate limit (10/min per IP vs 20 for signed-in runs).
 * An expired session cookie is still a 401, never a silent guest run.
 */
export async function POST(request: NextRequest) {
  try {
    if (isCrossOriginRequest(request)) {
      return NextResponse.json({ error: 'Cross-origin requests are not allowed here.' }, { status: 403 })
    }
    const ip = getClientIp(request)
    const body = await request.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    // A guest run carries a client-supplied workflow and no agentId. When
    // both are present the agentId wins and the workflow is ignored.
    const isGuestRun = body.workflow !== undefined && body.agentId === undefined
    const rl = await rateLimit(isGuestRun ? `execute-guest:${ip}` : `execute:${ip}`, {
      windowMs: 60_000,
      max: isGuestRun ? 10 : 20,
    })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many requests', retryAfterMs: rl.retryAfterMs },
        { status: 429 },
      )
    }

    if (isGuestRun) return runGuest(body)

    const auth = await authenticate(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const { db, userId, keyId } = auth

    const { agentId, input, topK } = body

    const workspaceSettings = await db.collection('workspace_settings').findOne({ userId })
    const permissions = workspaceSettings?.permissions || {}
    if (permissions.canExecute === false) {
      return NextResponse.json({ error: 'Execution permission is disabled for this workspace.' }, { status: 403 })
    }

    // H18: one topK source of truth — parseTopK (1..50) everywhere. The old
    // 10-cap here disagreed with rag/query and the RAG node (both 50), so the
    // same question + topK=50 retrieved 10 sources here and 22 there.
    const requestedTopK = Number.isFinite(Number(topK)) ? parseTopK(topK) : null
    let effectiveTopK = requestedTopK
    if (effectiveTopK === null) {
      effectiveTopK = parseTopK(workspaceSettings?.defaults?.topK, 3)
    }

    if (!input || typeof input !== 'string' || !input.trim()) {
      return NextResponse.json({ error: 'input is required' }, { status: 400 })
    }
    if (isTooLong(input, MAX_INPUT_CHARS)) {
      const err = lengthError('input', MAX_INPUT_CHARS)
      return NextResponse.json({ error: err.error }, { status: err.status })
    }
    if (!agentId || !ObjectId.isValid(agentId)) {
      return NextResponse.json({ error: 'agentId must be a valid agent id' }, { status: 400 })
    }

    if (keyId) {
      db.collection('personal_api_keys')
        .updateOne({ _id: keyId }, { $set: { lastUsedAt: new Date() } })
        .catch(() => undefined)
    }

    let result
    try {
      result = await runWorkflow({ db, userId, agentId, input: input.trim(), topK: effectiveTopK })
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500
      // 4xx failures are deliberate, safe messages (e.g. agent not found);
      // 5xx failures are infra detail — generic client-side, logged here.
      if (status < 500) {
        const message = error instanceof Error ? error.message : 'Execution failed'
        return NextResponse.json({ error: message }, { status })
      }
      console.error('[execute] run failed:', error)
      return NextResponse.json({ error: 'Execution failed. Please try again.' }, { status })
    }

    if (!result.ok) {
      // A failed node or a dead provider is a failure, not a 200 with a
      // partial answer.
      return NextResponse.json(
        {
          executed: false,
          agentId: result.agentId,
          agentName: result.agentName,
          output: result.output,
          model: result.model,
          provider: result.provider,
          sources: result.sources,
          trace: result.trace,
          deployed: result.deployed,
          grounded: result.grounded,
          error: result.error ?? 'Execution failed',
          failures: result.failures,
          executedAt: new Date().toISOString(),
        },
        { status: 502 },
      )
    }

    return NextResponse.json({
      executed: true,
      agentId: result.agentId,
      agentName: result.agentName,
      output: result.output,
      model: result.model,
      provider: result.provider,
      sources: result.sources,
      trace: result.trace,
      deployed: result.deployed,
      grounded: result.grounded,
      executedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[execute] failed:', error)
    return NextResponse.json({ error: 'Execution failed' }, { status: 500 })
  }
}

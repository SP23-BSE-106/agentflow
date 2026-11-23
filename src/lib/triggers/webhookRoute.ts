/**
 * POST /api/webhooks/[workflowId]/[mode] — served from the
 * /api/orchestrate catch-all (next.config.ts rewrites the public URL
 * there, so the Vercel Hobby 12-function budget holds).
 *
 * The webhook entry point.
 * The webhook entry point. The URL plus its per-workflow token is the
 * secret — no session is needed to call it, so treat a production URL
 * like a password. Test URLs carry the registration's secret as
 * `?token=`; production URLs carry the agent's `webhookSecret` the same
 * way when one exists (see `webhooks.ts`).
 *
 * Test vs production (the n8n split, re-implemented here):
 *   - `test` fires only when a test registration exists in the
 *     `webhook_registrations` collection (created by the owner while
 *     listening for a test call). Otherwise 404.
 *   - `production` fires only when the agent is active. Otherwise 403.
 *
 * Both run the workflow for real through the existing `runWorkflow`
 * (string path). The reply is the run output as JSON — unless the
 * workflow's graph contains a Respond To Webhook node, in which case that
 * node's status, body and headers shape the reply. (The string executor
 * cannot execute that node type — Lane H wires it into the item executor —
 * so the route reads its config from the graph rather than from the run.)
 *
 * Bodies: a JSON body becomes the workflow input as a JSON string; any
 * other body is used as plain text. Inputs are capped at 8,000 characters.
 */

import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'

import { rateLimit, getClientIp } from '@/lib/rateLimit'
import { MAX_INPUT_CHARS, isTooLong, lengthError } from '@/lib/inputLimits'
import { getDb } from '@/lib/mongo/mongo'
import { runWorkflow, loadRunnableAgent } from '@/lib/workflow/runWorkflow'
import {
  getWebhookRegistration,
  webhookTokenMatches,
  type WebhookMode,
} from '@/lib/triggers/webhooks'
import { resolveWebhookResponse } from '@/lib/triggers/respond'

async function readInput(request: NextRequest): Promise<{ input: string } | { error: string; status: number }> {
  const contentType = request.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => null)
    if (body === null || body === undefined) return { input: '' }
    return { input: typeof body === 'string' ? body : JSON.stringify(body) }
  }
  const text = await request.text().catch(() => '')
  return { input: text }
}

export async function webhookPost(
  request: NextRequest,
  workflowId: string,
  mode: string,
): Promise<Response> {
  if (!ObjectId.isValid(workflowId)) {
    return NextResponse.json({ error: 'workflowId must be a valid id' }, { status: 400 })
  }
  if (mode !== 'test' && mode !== 'production') {
    return NextResponse.json(
      { error: "mode must be 'test' or 'production'" },
      { status: 400 },
    )
  }
  const webhookMode = mode as WebhookMode

  const ip = getClientIp(request)
  const rl = await rateLimit(`webhook:${workflowId}:${ip}`, { windowMs: 60_000, max: 60 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfterMs: rl.retryAfterMs },
      { status: 429 },
    )
  }

  const read = await readInput(request)
  if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status })
  if (isTooLong(read.input, MAX_INPUT_CHARS)) {
    const err = lengthError('input', MAX_INPUT_CHARS)
    return NextResponse.json({ error: err.error }, { status: err.status })
  }

  let db
  try {
    db = await getDb()
  } catch {
    return NextResponse.json({ error: 'Database is not available' }, { status: 503 })
  }

  let userId: string
  if (webhookMode === 'test') {
    const registration = await getWebhookRegistration(db, workflowId, 'test')
    // Unknown workflow, missing registration, or wrong token all answer the
    // same 404: a caller must not learn which of the three failed. (C-6:
    // the test URL carries the registration's secret as ?token=, checked in
    // constant time.)
    if (!registration) {
      return NextResponse.json(
        { error: 'No test webhook is listening for this workflow. Register a test webhook first, then call the test URL.' },
        { status: 404 },
      )
    }
    if (!webhookTokenMatches(new URL(request.url).searchParams.get('token'), registration.secret)) {
      return NextResponse.json(
        { error: 'No test webhook is listening for this workflow. Register a test webhook first, then call the test URL.' },
        { status: 404 },
      )
    }
    userId = registration.userId
  } else {
    const agent = await db.collection('agents').findOne({ _id: new ObjectId(workflowId) })
    if (!agent) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
    // C-6: when the agent carries a webhookSecret (minted at creation),
    // the production URL must carry it as ?token= — checked in constant
    // time, wrong token answers the same 404 as an unknown workflow.
    // Agents created before the secret existed keep the old secret-URL
    // model (workflow id + active status) until a secret is minted for them.
    const secret = typeof agent.webhookSecret === 'string' ? agent.webhookSecret : undefined
    if (secret && !webhookTokenMatches(new URL(request.url).searchParams.get('token'), secret)) {
      return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
    }
    if (agent.status !== 'active') {
      return NextResponse.json(
        { error: 'This workflow is not active. Deploy it first — production webhooks only fire for active workflows.' },
        { status: 403 },
      )
    }
    userId = String(agent.userId)
  }

  // The graph, for Respond To Webhook shaping (the run itself re-loads it).
  const loaded = await loadRunnableAgent(db, userId, workflowId)
  const graph = 'error' in loaded ? null : loaded.graph

  let result
  try {
    result = await runWorkflow({ db, userId, agentId: workflowId, input: read.input })
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500
    const message = error instanceof Error ? error.message : 'Workflow run failed'
    return NextResponse.json({ error: message }, { status })
  }

  if (!result.ok) {
    return NextResponse.json(
      {
        executed: false,
        agentId: result.agentId,
        agentName: result.agentName,
        output: result.output,
        error: result.error || 'Workflow run failed',
        trace: result.trace,
        deployed: result.deployed,
      },
      { status: 500 },
    )
  }

  const shaped = resolveWebhookResponse(graph, result.output)
  if (shaped) {
    return new NextResponse(shaped.body, { status: shaped.status, headers: shaped.headers })
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
  })
}

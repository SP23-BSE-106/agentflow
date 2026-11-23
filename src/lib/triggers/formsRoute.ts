/**
 * /api/forms/[workflowId] — served from the /api/orchestrate catch-all
 * (next.config.ts rewrites the public URL there, so the Vercel Hobby
 * 12-function budget holds).
 *
 * GET  — the form definition (fields, title) as JSON, for the hosted form
 *        page and for API clients.
 * POST — a form submission. Runs the workflow for real through
 *        `runFormSubmission` and shows the result.
 *
 * Bodies: JSON (`{ field: value }`) or a browser form post
 * (`application/x-www-form-urlencoded`). A browser form post gets a plain
 * HTML result page back; a JSON call gets JSON. The form link is public —
 * the workflow id in the URL is the only secret — the same as a webhook
 * URL.
 */

import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'

import { getDb } from '@/lib/mongo/mongo'
import { MAX_INPUT_CHARS, isTooLong, lengthError } from '@/lib/inputLimits'
import { rateLimit, getClientIp } from '@/lib/rateLimit'
import {
  getFormDefinition,
  runFormSubmission,
} from '@/lib/triggers/forms'
import type { Agent } from '@/lib/mongo/agent'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function resultPage(workflowId: string, ok: boolean, output: string, error?: string): Response {
  const title = ok ? 'Thanks — your form was submitted' : 'Something went wrong'
  const body = ok
    ? `<p>Your workflow ran and returned:</p><pre>${escapeHtml(output)}</pre>`
    : `<p>${escapeHtml(error || 'The workflow could not run.')}</p>`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem;line-height:1.5}pre{white-space:pre-wrap;background:#f4f4f4;padding:1rem;border-radius:8px}</style></head><body><h1>${escapeHtml(title)}</h1>${body}<p><a href="/form/${escapeHtml(workflowId)}">Submit another response</a></p></body></html>`
  return new NextResponse(html, { status: ok ? 200 : 500, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

export async function formsGet(workflowId: string): Promise<Response> {
  if (!ObjectId.isValid(workflowId)) {
    return NextResponse.json({ error: 'workflowId must be a valid id' }, { status: 400 })
  }
  let db
  try {
    db = await getDb()
  } catch {
    return NextResponse.json({ error: 'Database is not available' }, { status: 503 })
  }
  const agent = await db.collection('agents').findOne({ _id: new ObjectId(workflowId) })
  if (!agent) return NextResponse.json({ error: 'Form not found' }, { status: 404 })
  const definition = getFormDefinition(agent as unknown as Agent)
  if (!definition) {
    return NextResponse.json(
      { error: 'This workflow has no Form Trigger, so it has no hosted form' },
      { status: 404 },
    )
  }
  return NextResponse.json(definition)
}

export async function formsPost(
  request: NextRequest,
  workflowId: string,
): Promise<Response> {
  if (!ObjectId.isValid(workflowId)) {
    return NextResponse.json({ error: 'workflowId must be a valid id' }, { status: 400 })
  }

  const contentType = request.headers.get('content-type') || ''
  const wantsHtml =
    contentType.includes('application/x-www-form-urlencoded') ||
    (request.headers.get('accept') || '').includes('text/html')

  // A public form submission runs a real workflow (LLM spend), so it is
  // throttled per workflow (30/min). No origin check here: forms are
  // meant to be submitted from outside pages too.
  const formRl = await rateLimit(`forms:${workflowId}:${getClientIp(request)}`, { windowMs: 60_000, max: 30 })
  if (!formRl.ok) {
    const msg = 'Too many requests'
    if (wantsHtml) return resultPage(workflowId, false, '', msg)
    return NextResponse.json({ error: msg, retryAfterMs: formRl.retryAfterMs }, { status: 429 })
  }

  let values: Record<string, unknown>
  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Body must be a JSON object of field values' }, { status: 400 })
    }
    values = body as Record<string, unknown>
  } else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    if (!form) return NextResponse.json({ error: 'Could not read the submitted form' }, { status: 400 })
    values = {}
    for (const [key, value] of form.entries()) {
      values[key] = typeof value === 'string' ? value : value.name
    }
  } else {
    const text = await request.text().catch(() => '')
    if (!text.trim()) {
      return NextResponse.json({ error: 'Body must be JSON or a form submission' }, { status: 400 })
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      values = parsed as Record<string, unknown>
    } catch {
      values = { input: text }
    }
  }

  const asText = JSON.stringify(values)
  if (isTooLong(asText, MAX_INPUT_CHARS)) {
    const err = lengthError('input', MAX_INPUT_CHARS)
    if (wantsHtml) return resultPage(workflowId, false, '', err.error)
    return NextResponse.json({ error: err.error }, { status: err.status })
  }

  let db
  try {
    db = await getDb()
  } catch {
    if (wantsHtml) return resultPage(workflowId, false, '', 'Database is not available')
    return NextResponse.json({ error: 'Database is not available' }, { status: 503 })
  }

  let result
  try {
    result = await runFormSubmission(db, workflowId, values)
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500
    // 4xx failures are deliberate, safe messages (e.g. form not found);
    // 5xx failures are infra detail — generic client-side, logged here.
    if (status < 500) {
      const message = error instanceof Error ? error.message : 'Form submission failed'
      if (wantsHtml) return resultPage(workflowId, false, '', message)
      return NextResponse.json({ error: message }, { status })
    }
    console.error('[forms] submission failed:', error)
    const generic = 'Form submission failed. Please try again.'
    if (wantsHtml) return resultPage(workflowId, false, '', generic)
    return NextResponse.json({ error: generic }, { status })
  }

  if (wantsHtml) return resultPage(workflowId, result.ok, result.output, result.error)
  if (!result.ok) {
    return NextResponse.json(
      { executed: false, agentId: result.agentId, output: result.output, error: result.error || 'Workflow run failed' },
      { status: 500 },
    )
  }
  return NextResponse.json({
    executed: true,
    agentId: result.agentId,
    agentName: result.agentName,
    output: result.output,
    model: result.model,
    provider: result.provider,
    deployed: result.deployed,
    grounded: result.grounded,
  })
}

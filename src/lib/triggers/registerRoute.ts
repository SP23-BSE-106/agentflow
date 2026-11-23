/**
 * Test-webhook registration endpoints (Lane A5).
 *
 * `registerWebhook` was dead code — defined in `webhooks.ts` with zero
 * callers, so no test registration could ever exist and test webhooks
 * always 404'd. These handlers wire it up, served from the existing
 * /api/orchestrate catch-all so the 12-function budget holds:
 *
 *   POST   /api/webhooks/:workflowId/test/register — start listening, returns the test URL (with ?token=)
 *   DELETE /api/webhooks/:workflowId/test/register — stop listening
 *
 * Both are owner-only: a session cookie is required and the agent must
 * belong to the caller (a foreign agent answers 404, never 403-with-a-hint).
 * The returned test URL carries the registration's per-workflow secret as
 * `?token=` — that is the only place the secret is ever shown, and only to
 * the owner over their own authenticated session.
 */

import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'

import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { GUEST_LOGIN_REQUIRED } from '@/lib/auth/session'
import { checkOwnership } from '@/lib/permissions'
import { rateLimit } from '@/lib/rateLimit'
import { getDb } from '@/lib/mongo/mongo'
import {
  deleteWebhookRegistration,
  registerWebhook,
  webhookPath,
  webhookUrl,
} from '@/lib/triggers/webhooks'

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

async function authorize(
  request: NextRequest,
  workflowId: string,
): Promise<{ userId: string } | Response> {
  const userId = await getAuthenticatedUserId()
  if (!userId) {
    return json({ error: GUEST_LOGIN_REQUIRED }, 401)
  }
  if (!ObjectId.isValid(workflowId)) {
    return json({ error: 'workflowId must be a valid id' }, 400)
  }
  const owned = await checkOwnership('agents', workflowId, userId)
  if (!owned.allowed) {
    return json({ error: owned.reason }, owned.status ?? 404)
  }
  const rl = await rateLimit(`webhook-register:${userId}:${workflowId}`, {
    windowMs: 60_000,
    max: 30,
  })
  if (!rl.ok) {
    return json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, 429)
  }
  return { userId }
}

export async function registerTestWebhookPost(
  request: NextRequest,
  workflowId: string,
): Promise<Response> {
  const auth = await authorize(request, workflowId)
  if (auth instanceof Response) return auth
  const { userId } = auth

  let db
  try {
    db = await getDb()
  } catch {
    return json({ error: 'Database is not available' }, 503)
  }

  let registration
  try {
    registration = await registerWebhook(db, { workflowId, userId, mode: 'test' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not register test webhook'
    return json({ error: message }, 500)
  }

  // The token travels in the URL, shown once to the owner who just asked
  // for it. `path` is the bare path (no token) for display; `url` is the
  // callable test URL.
  const origin = new URL(request.url).origin
  return json(
    {
      workflowId,
      mode: 'test',
      listening: true,
      path: webhookPath(workflowId, 'test'),
      url: webhookUrl(workflowId, 'test', origin, registration.secret),
    },
    200,
  )
}

export async function unregisterTestWebhookDelete(
  request: NextRequest,
  workflowId: string,
): Promise<Response> {
  const auth = await authorize(request, workflowId)
  if (auth instanceof Response) return auth
  const { userId } = auth

  let db
  try {
    db = await getDb()
  } catch {
    return json({ error: 'Database is not available' }, 503)
  }

  const deleted = await deleteWebhookRegistration(db, workflowId, 'test', userId)
  return json({ workflowId, mode: 'test', listening: false, deleted }, 200)
}

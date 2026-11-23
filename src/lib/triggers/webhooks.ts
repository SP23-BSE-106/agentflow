/**
 * Webhook registration store.
 *
 * n8n keeps test webhooks and production webhooks apart: a test URL only
 * fires while the editor is listening for it, a production URL only fires
 * for an active workflow. AgentFlow does the same with a Mongo collection,
 * `webhook_registrations`:
 *
 *   { workflowId, userId, mode: 'test' | 'production', path, secret, createdAt }
 *
 * Here `workflowId` is the agent id — in this codebase an agent owns its
 * workflow graph, so the agent id is the workflow's id. The URL shape is
 * `POST /api/webhooks/[workflowId]/[mode]`.
 *
 * Test registrations are created when the owner asks for a test URL (the
 * editor's "listen" step, via POST /api/webhooks/[workflowId]/test/register);
 * production has no registration row — the production URL fires when the
 * agent is active, and is refused otherwise.
 *
 * Per-workflow secret (C-6, ported from the no-auth D1 fix): every test
 * registration carries a random `secret`, and the test URL carries it as
 * `?token=<secret>`. The route checks the token in constant time and answers
 * 404 — the same as for an unknown workflow — when it is missing or wrong,
 * so a wrong token teaches an attacker nothing. Production webhooks use the
 * same check when the agent doc carries a `webhookSecret` (minted at agent
 * creation); agents created before that field existed keep the old
 * secret-URL model until one is minted for them — see `webhookRoute.ts`.
 */

import crypto from 'node:crypto'
import type { Db } from 'mongodb'

export type WebhookMode = 'test' | 'production'

export type WebhookRegistration = {
  _id?: unknown
  workflowId: string
  userId: string
  mode: WebhookMode
  path: string
  /** Random per-registration secret; the test URL carries it as ?token=. */
  secret?: string
  createdAt: Date
}

/** Constant-time token check: a wrong token must not be distinguishable by timing. */
export function webhookTokenMatches(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function webhookPath(workflowId: string, mode: WebhookMode, secret?: string): string {
  const base = `/api/webhooks/${workflowId}/${mode}`
  return secret ? `${base}?token=${secret}` : base
}

/** Full URL for a webhook when the site's base URL is known, else the path. */
export function webhookUrl(workflowId: string, mode: WebhookMode, baseUrl?: string, secret?: string): string {
  const base = (baseUrl || '').replace(/\/$/, '')
  return `${base}${webhookPath(workflowId, mode, secret)}`
}

/**
 * Create (or refresh) a test registration. Production URLs need no row —
 * they fire for active agents — so registering 'production' is refused
 * rather than stored.
 */
export async function registerWebhook(
  db: Db,
  input: { workflowId: string; userId: string; mode: WebhookMode },
): Promise<WebhookRegistration> {
  const { workflowId, userId, mode } = input
  if (!workflowId || !userId) {
    throw new Error('registerWebhook needs a workflowId and a userId')
  }
  if (mode !== 'test') {
    throw new Error(
      "Only test webhooks are registered. Production webhooks fire for active workflows and need no registration row.",
    )
  }
  const path = webhookPath(workflowId, mode)
  const now = new Date()
  const existing = await db
    .collection('webhook_registrations')
    .findOne({ workflowId, mode, userId })
  if (existing) {
    // Refresh keeps the existing secret: rotating it here would silently
    // break the test URL the owner already has.
    await db.collection('webhook_registrations').updateOne(
      { workflowId, mode, userId },
      { $set: { userId, path, createdAt: now } },
    )
  } else {
    // Plain insert instead of an upsert: explicit, and it works against
    // stores that do not implement upsert.
    await db.collection('webhook_registrations').insertOne({
      workflowId,
      userId,
      mode,
      path,
      secret: crypto.randomBytes(32).toString('hex'),
      createdAt: now,
    })
  }
  const row = await db
    .collection('webhook_registrations')
    .findOne({ workflowId, mode, userId })
  if (!row) throw new Error('Webhook registration could not be saved')
  return row as unknown as WebhookRegistration
}

export async function getWebhookRegistration(
  db: Db,
  workflowId: string,
  mode: WebhookMode,
  userId?: string,
): Promise<WebhookRegistration | null> {
  const filter: Record<string, unknown> = { workflowId, mode }
  if (userId) filter.userId = userId
  const row = await db
    .collection('webhook_registrations')
    .findOne(filter)
  return (row as unknown as WebhookRegistration) ?? null
}

export async function listWebhookRegistrations(
  db: Db,
  workflowId?: string,
  userId?: string,
): Promise<WebhookRegistration[]> {
  const filter: Record<string, unknown> = {}
  if (workflowId) filter.workflowId = workflowId
  if (userId) filter.userId = userId
  const rows = await db
    .collection('webhook_registrations')
    .find(filter)
    .toArray()
  return rows as unknown as WebhookRegistration[]
}

export async function deleteWebhookRegistration(
  db: Db,
  workflowId: string,
  mode: WebhookMode,
  userId?: string,
): Promise<boolean> {
  const filter: Record<string, unknown> = { workflowId, mode }
  if (userId) filter.userId = userId
  const result = await db
    .collection('webhook_registrations')
    .deleteOne(filter)
  return result.deletedCount === 1
}

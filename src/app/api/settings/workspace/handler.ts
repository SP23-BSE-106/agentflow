import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/mongo/mongo'
import { rateLimit } from '@/lib/rateLimit'
import { requireAuth } from '@/lib/auth/session'

async function requireUser(): Promise<{ userId: string } | NextResponse> {
  const auth = await requireAuth()
  if (auth instanceof NextResponse) return auth
  return { userId: auth.userId }
}

const DEFAULTS = {
  role: 'admin',
  permissions: {
    canExecute: true,
    canDeploy: true,
    canManageKeys: true,
    canEditWorkflows: true,
    // The full flag set: an older document that predates a flag (notably
    // `canCreateAgents`) used to lock the owner out of creating agents
    // with no reset. The owner default is allowed for every flag.
    canCreateAgents: true,
    canViewAnalytics: true,
  },
  appearance: {
    density: 'comfortable',
    accent: 'emerald',
  },
  defaults: {
    topK: 3,
  },
}

export async function GET() {
  const auth = await requireUser()
  if (auth instanceof NextResponse) return auth
  const db = await getDb()
  const doc = await db.collection('workspace_settings').findOne({ userId: auth.userId })
  if (!doc) return NextResponse.json({ settings: DEFAULTS })
  // Deep-merge the stored permissions over the defaults, so a document
  // written before a flag existed still reports the full flag set instead
  // of silently dropping a capability.
  return NextResponse.json({
    settings: {
      ...DEFAULTS,
      ...doc,
      permissions: { ...DEFAULTS.permissions, ...(doc.permissions || {}) },
    },
  })
}

export async function POST(request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof NextResponse) return auth

  const rl = await rateLimit(`settings:workspace:${auth.userId}`, { windowMs: 60_000, max: 10 })
  if (!rl.ok) return NextResponse.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, { status: 429 })

  const body = await request.json().catch(() => ({}))
  // Role and permissions are server-side only: a client must not be able to
  // grant itself admin or re-enable a disabled permission by posting here.
  // They are read from the stored document and left unchanged by this call.
  // Only appearance and defaults are user-writable.
  const appearance = { ...DEFAULTS.appearance, ...(body.appearance || {}) }
  const defaults = {
    ...DEFAULTS.defaults,
    ...(body.defaults || {}),
    topK: Number.isFinite(Number(body.defaults?.topK)) ? Math.min(10, Math.max(1, Math.round(Number(body.defaults.topK)))) : DEFAULTS.defaults.topK,
  }

  const db = await getDb()
  const existing = await db.collection('workspace_settings').findOne({ userId: auth.userId })
  const role = typeof existing?.role === 'string' ? existing.role : DEFAULTS.role
  // Stored permissions are filled in from the defaults (an older document
  // may predate a flag), and agent creation can never be switched off for
  // the workspace owner — there is no other account that could create
  // agents, so disabling it is a lockout with no reset, not a permission.
  const permissions = {
    ...DEFAULTS.permissions,
    ...((existing?.permissions as typeof DEFAULTS.permissions | undefined) ?? {}),
    canCreateAgents: true,
  }
  await db.collection('workspace_settings').updateOne(
    { userId: auth.userId },
    { $set: { userId: auth.userId, role, permissions, appearance, defaults, updatedAt: new Date() } },
    { upsert: true },
  )

  return NextResponse.json({ success: true, settings: { role, permissions, appearance, defaults } })
}

export async function PATCH(request: NextRequest) {
  return POST(request)
}

import { NextRequest, NextResponse } from 'next/server'

import { getDb } from '@/lib/mongo/mongo'

const COLLECTIONS = [
  'workflow_runs',
  'agent_versions',
  'workflow_templates',
  'rag_documents',
  'rag_chunks',
  'audit_events',
  'user_settings',
  // Multi-agent upgrade collections (implementation plan Phase 2–4, 14).
  'agent_tasks',
  'agent_messages',
  'shared_contexts',
  'execution_events',
  'agent_evaluations',
  'approval_requests',
] as const

/**
 * Dev-only endpoint to force MongoDB collections to appear in the UI/Compass.
 *
 * This does NOT change your existing runtime behavior.
 * It only inserts ONE dummy document per missing collection.
 *
 * Fail-closed by design:
 * - There is no default secret. `DEV_INIT_COLLECTIONS_SECRET` must be set,
 *   or every call is refused.
 * - The endpoint refuses to run in production unless the explicit allow
 *   flag `DEV_INIT_COLLECTIONS_ALLOW_PRODUCTION=true` is also set.
 */
function checkAccess(request: NextRequest): NextResponse | null {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.DEV_INIT_COLLECTIONS_ALLOW_PRODUCTION !== 'true'
  ) {
    return NextResponse.json(
      { error: 'This endpoint is not available in production.' },
      { status: 403 },
    )
  }

  const expected = process.env.DEV_INIT_COLLECTIONS_SECRET
  if (!expected) {
    return NextResponse.json(
      { error: 'DEV_INIT_COLLECTIONS_SECRET is not configured.' },
      { status: 503 },
    )
  }

  const secret = request.headers.get('x-dev-secret')
  if (!secret || secret !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return null
}

async function initCollections() {
  const db = await getDb()

  const results: Record<string, { inserted: boolean }> = {}

  for (const name of COLLECTIONS) {
    const col = db.collection<{ _id: string; createdAt: Date }>(name)

    const existing = await col.findOne({})
    if (existing) {
      results[name] = { inserted: false }
      continue
    }

    await col.insertOne({
      _id: `${name}:dev-init`,
      createdAt: new Date(),
    })

    results[name] = { inserted: true }
  }

  return results
}

export async function GET(request: NextRequest) {
  const denied = checkAccess(request)
  if (denied) return denied

  const results = await initCollections()
  return NextResponse.json({ success: true, results })
}

export async function POST(request: NextRequest) {
  const denied = checkAccess(request)
  if (denied) return denied

  const results = await initCollections()
  return NextResponse.json({ success: true, results })
}

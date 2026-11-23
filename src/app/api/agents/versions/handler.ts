import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'

import { getDb } from '@/lib/mongo/mongo'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { ensureAgentVersionsIndex, saveAgentVersion } from '@/lib/agentVersionStore'
import { checkPermission } from '@/lib/permissions'
import { getClientIp, rateLimit } from '@/lib/rateLimit'
import { GUEST_LOGIN_REQUIRED } from '@/lib/auth/session'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Rate limit (Lane A3, D1 remainder): reads 60/min per client IP.
  const verRl = await rateLimit(`agents:versions:read:${getClientIp(request)}`, { windowMs: 60_000, max: 60 })
  if (!verRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: verRl.retryAfterMs }, { status: 429 })
  }
  const token = await getSessionTokenFromCookies()
  if (!token) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  let userId: string
  try {
    userId = (await verifyJwtSession(token)).sub
  } catch {
    return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })
  }

  const { id } = await params
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid agent ID' }, { status: 400 })
  }

  const db = await getDb()
  const agent = await db.collection('agents').findOne({ _id: new ObjectId(id), userId })
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const limit = Math.min(100, Math.max(1, Number(request.nextUrl.searchParams.get('limit')) || 20))
  await ensureAgentVersionsIndex(db)
  const versions = await db
    .collection('agent_versions')
    .find({ userId, agentId: id })
    .sort({ version: -1 })
    .limit(limit)
    .toArray()

  return NextResponse.json(versions)
}

/**
 * POST /api/agents/:id/versions/:version/restore — restore an old version (H22).
 *
 * The version list existed but there was no way to go back to one except
 * hand-PATCHing the old workflow. Restoring copies the version's workflow
 * (and prompt / provider, when the snapshot has them) onto the agent's
 * draft and bumps `workflowVersion`, minting a fresh version row that
 * records the restore — so the pre-restore draft is itself still listed
 * and restorable. The deployed snapshot is untouched: restoring changes
 * the draft, and the agent runs the restored workflow once redeployed
 * (or immediately, for a draft agent served by /api/execute).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; version?: string }> },
) {
  const restoreRl = await rateLimit(`agents:versions:restore:${getClientIp(request)}`, { windowMs: 60_000, max: 30 })
  if (!restoreRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: restoreRl.retryAfterMs }, { status: 429 })
  }
  const token = await getSessionTokenFromCookies()
  if (!token) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  let userId: string
  try {
    userId = (await verifyJwtSession(token)).sub
  } catch {
    return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })
  }

  const { id, version } = await params
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid agent ID' }, { status: 400 })
  }
  const versionNumber = Number(version)
  if (version === undefined || !Number.isFinite(versionNumber)) {
    return NextResponse.json({ error: 'Invalid version' }, { status: 400 })
  }

  const db = await getDb()
  const permission = await checkPermission(userId, 'canEditWorkflows')
  if (!permission.allowed) {
    return NextResponse.json({ error: permission.reason }, { status: permission.status ?? 403 })
  }

  const agent = await db.collection('agents').findOne({ _id: new ObjectId(id), userId })
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await ensureAgentVersionsIndex(db)
  const snapshot = await db.collection('agent_versions').findOne({
    userId,
    agentId: id,
    version: versionNumber,
  })
  if (!snapshot) {
    return NextResponse.json({ error: `No version ${versionNumber} for this agent` }, { status: 404 })
  }
  if (!snapshot.workflow) {
    return NextResponse.json({ error: `Version ${versionNumber} has no workflow to restore` }, { status: 409 })
  }

  const restored = await db.collection('agents').findOneAndUpdate(
    { _id: new ObjectId(id), userId },
    {
      $set: {
        workflow: snapshot.workflow,
        ...(typeof snapshot.prompt === 'string' ? { prompt: snapshot.prompt } : {}),
        ...(typeof snapshot.llmProvider === 'string' ? { llmProvider: snapshot.llmProvider } : {}),
        updatedAt: new Date(),
      },
      $inc: { workflowVersion: 1 },
    },
    { returnDocument: 'after', projection: { userApiKey: 0, webhookSecret: 0 } },
  )
  if (!restored) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await saveAgentVersion(db, {
    userId,
    agentId: id,
    version: restored.workflowVersion ?? versionNumber + 1,
    prompt: typeof restored.prompt === 'string' ? restored.prompt : undefined,
    workflow: restored.workflow,
    llmProvider: typeof restored.llmProvider === 'string' ? restored.llmProvider : undefined,
    notes: `Restored version ${versionNumber}`,
  })

  return NextResponse.json({ ...restored, restoredFromVersion: versionNumber })
}

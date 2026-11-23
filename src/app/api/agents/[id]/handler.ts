import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'

import { getDb } from '@/lib/mongo/mongo'
import { MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS, MAX_PROMPT_CHARS, isTooLong, lengthError } from '@/lib/inputLimits'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import {
  cleanAgentName,
  isDuplicateAgentName,
  isUsableAgentName,
  normalizeAgentName,
} from '@/lib/agentName'
import { listTakenNames, ensureAgentNameIndex, repairLegacyDuplicateNames } from '@/lib/agentNameStore'
import { checkPermission } from '@/lib/permissions'
import { getClientIp, rateLimit } from '@/lib/rateLimit'
import { auditAgentLifecycle } from '@/lib/audit'
import { saveAgentVersion } from '@/lib/agentVersionStore'
import { encrypt } from '@/lib/crypto'
import { validateWorkflowGraph } from '@/lib/workflow/condition'
import { validateAgentFields } from '@/lib/agents/validation'
import { validateScheduleInput } from '@/lib/agents/scheduleInput'
import { GUEST_LOGIN_REQUIRED } from '@/lib/auth/session'

async function getAuthenticatedUserId() {
  const token = await getSessionTokenFromCookies()
  if (!token) return null
  try {
    const payload = await verifyJwtSession(token)
    return payload.sub
  } catch {
    return null
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Rate limit (Lane A3, D1 remainder): reads 60/min per client IP.
  const byIdRl = await rateLimit(`agents:byid:read:${getClientIp(request)}`, { windowMs: 60_000, max: 60 })
  if (!byIdRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: byIdRl.retryAfterMs }, { status: 429 })
  }
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  const { id } = await params
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid agent ID' }, { status: 400 })
  }

  const db = await getDb()
  const agent = await db
    .collection('agents')
    .findOne(
      { _id: new ObjectId(id), userId },
      { projection: { userApiKey: 0, webhookSecret: 0 } },
    )

  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(agent)
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Rate limit (Lane A3, D1 remainder): writes 30/min per client IP.
  const delRl = await rateLimit(`agents:byid:write:${getClientIp(request)}`, { windowMs: 60_000, max: 30 })
  if (!delRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: delRl.retryAfterMs }, { status: 429 })
  }
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  const { id } = await params
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid agent ID' }, { status: 400 })
  }

  const db = await getDb()
  const permission = await checkPermission(userId, 'canEditWorkflows')
  if (!permission.allowed) {
    return NextResponse.json({ error: permission.reason }, { status: permission.status ?? 403 })
  }

  const result = await db
    .collection('agents')
    .deleteOne({ _id: new ObjectId(id), userId })

  if (result.deletedCount === 0) {
    return NextResponse.json({ error: 'Not found or not authorised to delete' }, { status: 404 })
  }

  await auditAgentLifecycle({ userId, action: 'agent.delete', agentId: id })
  return NextResponse.json({ success: true })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Rate limit (Lane A3, D1 remainder): writes 30/min per client IP.
  const patchRl = await rateLimit(`agents:byid:write:${getClientIp(request)}`, { windowMs: 60_000, max: 30 })
  if (!patchRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: patchRl.retryAfterMs }, { status: 429 })
  }
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  const { id } = await params
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid agent ID' }, { status: 400 })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  // Fields this endpoint never writes are refused with a 400 that names
  // them, instead of being silently dropped (or, when one of them tripped
  // a later step, surfacing as an empty 500). The UI only ever sends the
  // allowlisted fields below, so a rejection here is always a bad caller.
  const writable = new Set([
    'name', 'description', 'status', 'tags', 'llmProvider', 'prompt',
    'workflow', 'userApiKey', 'role', 'systemPrompt', 'maxTokenBudget',
    'maxRetryCount', 'humanApprovalRequired', 'fallbackAgentId', 'schedule',
  ])
  const rejected = Object.keys(body).filter((key) => !writable.has(key))
  if (rejected.length > 0) {
    return NextResponse.json(
      { error: `These fields cannot be changed here: ${rejected.join(', ')}.` },
      { status: 400 },
    )
  }
  if ('tags' in body && body.tags !== undefined && body.tags !== null) {
    if (!Array.isArray(body.tags) || body.tags.some((tag: unknown) => typeof tag !== 'string')) {
      return NextResponse.json({ error: 'tags must be a list of words.' }, { status: 400 })
    }
  }
  if ('status' in body && body.status !== undefined && body.status !== null) {
    if (!['draft', 'active', 'paused'].includes(body.status)) {
      return NextResponse.json(
        { error: 'status must be one of: draft, active, paused.' },
        { status: 400 },
      )
    }
  }

  // H23: a schedule is settable here — the cron the trigger checker reads.
  // `null` clears it; anything else must be a valid cron expression.
  let validatedSchedule: { cron: string; timezone?: string } | null | undefined
  if ('schedule' in body) {
    const checked = validateScheduleInput(body.schedule)
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error }, { status: 400 })
    }
    validatedSchedule = checked.schedule
  }

  if (body.workflow !== undefined && body.workflow !== null) {
    const workflowError = validateWorkflowGraph(body.workflow)
    if (workflowError) {
      return NextResponse.json({ error: workflowError }, { status: 400 })
    }
  }

  // Over-long text fields are refused before they reach the database.
  for (const [field, max] of [['prompt', MAX_PROMPT_CHARS], ['description', MAX_DESCRIPTION_CHARS], ['name', MAX_NAME_CHARS]] as const) {
    if (isTooLong(body[field], max)) {
      const err = lengthError(field, max)
      return NextResponse.json({ error: err.error }, { status: err.status })
    }
  }

  // Only allow updating safe fields (P1-1 adds the orchestrator knobs).
  const allowed = ['name', 'description', 'status', 'tags', 'llmProvider', 'prompt', 'workflow', 'userApiKey', 'role', 'systemPrompt', 'maxTokenBudget', 'maxRetryCount', 'humanApprovalRequired', 'fallbackAgentId', 'schedule']
  const update: Record<string, unknown> = { updatedAt: new Date() }
  for (const key of allowed) {
    if (key in body) update[key] = body[key]
  }
  // The schedule stored is the validated one (cron + optional timezone),
  // never the raw body value — `null` clears it.
  if (validatedSchedule !== undefined) update.schedule = validatedSchedule

  // A replacement API key is encrypted exactly as on create. Storing the raw
  // body value would leave a live key in plaintext in the database.
  if (typeof update.userApiKey === 'string' && update.userApiKey.trim()) {
    update.userApiKey = encrypt(update.userApiKey.trim())
  } else if ('userApiKey' in update) {
    update.userApiKey = null
  }

  const agentFields = validateAgentFields(body)
  if (!agentFields.ok) {
    return NextResponse.json({ error: agentFields.errors.join(' ') }, { status: 400 })
  }
  Object.assign(update, agentFields.fields)

  const db = await getDb()
  const permission = await checkPermission(userId, 'canEditWorkflows')
  if (!permission.allowed) {
    return NextResponse.json({ error: permission.reason }, { status: permission.status ?? 403 })
  }

  // Deploy publishes a snapshot: activating an agent records the graph as it
  // stands right now (the workflow in this request, else the stored one) as
  // deployedWorkflow, and /api/execute serves that snapshot — not the draft.
  // Editing the draft afterwards cannot change the deployed behaviour until
  // the next deploy.
  if (update.status === 'active') {
    const existing = await db.collection('agents').findOne({ _id: new ObjectId(id), userId })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const deployGraph = (update.workflow ?? existing.workflow ?? null) as unknown
    if (deployGraph) {
      update.deployedWorkflow = deployGraph
      update.deployedAt = new Date()
    }
  }

  // A rename goes through the same rules as a create — otherwise renaming one
  // agent onto another would quietly break the "no two agents share a name"
  // guarantee that POST enforces.
  if ('name' in update) {
    const requested = cleanAgentName(update.name)

    if (!requested) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    if (!isUsableAgentName(requested)) {
      return NextResponse.json(
        { error: 'Agent names must contain letters or numbers.' },
        { status: 400 },
      )
    }

    // Repaired names must be visible before we compare, otherwise a rename
    // could be judged against a list that is about to change.
    await ensureAgentNameIndex(db)
    await repairLegacyDuplicateNames(db, userId)
    const taken = await listTakenNames(db, userId, id)

    const clash = taken.find((existing) => isDuplicateAgentName(existing, requested))
    if (clash) {
      return NextResponse.json(
        {
          error: `You already have an agent named "${clash}". Choose a different name.`,
          existingName: clash,
        },
        { status: 409 },
      )
    }

    update.name = requested
    update.nameNormalized = normalizeAgentName(requested)
  }

  const result = await db
    .collection('agents')
      .findOneAndUpdate(
        { _id: new ObjectId(id), userId },
        { $set: update, $inc: { workflowVersion: 1 } },
        { returnDocument: 'after', projection: { userApiKey: 0, webhookSecret: 0 } },
      )

    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const version = result.workflowVersion ?? 1
    await saveAgentVersion(db, {
      userId,
      agentId: id,
      version,
      prompt: typeof result.prompt === 'string' ? result.prompt : undefined,
      workflow: result.workflow,
      llmProvider: typeof result.llmProvider === 'string' ? result.llmProvider : undefined,
      notes: 'Workflow updated',
    })
    await auditAgentLifecycle({ userId, action: 'agent.update', agentId: id })
    return NextResponse.json({ ...result, workflowVersion: version })
}

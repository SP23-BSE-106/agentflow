import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { ObjectId } from 'mongodb'

import { getDb } from '@/lib/mongo/mongo'
import { MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS, MAX_PROMPT_CHARS, isTooLong, lengthError } from '@/lib/inputLimits'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { GUEST_LOGIN_REQUIRED, getOptionalAuth, loginRequiredResponse } from '@/lib/auth/session'
import { encrypt } from '@/lib/crypto'
import {
  agentNameFromPrompt,
  cleanAgentName,
  isDuplicateAgentName,
  isUsableAgentName,
  nextAvailableAgentName,
  normalizeAgentName,
} from '@/lib/agentName'
import {
  ensureAgentNameIndex,
  isDuplicateKeyError,
  listTakenNames,
  repairLegacyDuplicateNames,
} from '@/lib/agentNameStore'
import { checkPermission } from '@/lib/permissions'
import { hasActiveAccess, type SubscriptionLike } from '@/lib/payments'
import { getClientIp, rateLimit } from '@/lib/rateLimit'
import { auditAgentLifecycle } from '@/lib/audit'
import { saveAgentVersion } from '@/lib/agentVersionStore'
import { validateWorkflowGraph } from '@/lib/workflow/condition'
import { validateAgentFields } from '@/lib/agents/validation'
import { validateScheduleInput } from '@/lib/agents/scheduleInput'

export async function GET(request: NextRequest) {
  // Rate limit (Lane A3, D1 remainder): list is a read, 60/min per client IP.
  const listRl = await rateLimit(`agents:list:${getClientIp(request)}`, { windowMs: 60_000, max: 60 })
  if (!listRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: listRl.retryAfterMs }, { status: 429 })
  }
  const auth = await getOptionalAuth()
  if (auth === 'invalid') return loginRequiredResponse()
  // Guest mode: a guest has no saved agents — empty list, never another
  // user's agents and never a shared/demo account.
  if (auth === 'guest') return NextResponse.json([])

  const userId = auth.userId
  const db = await getDb()

  const agents = await db
    .collection('agents')
    .find({ userId }, { projection: { userApiKey: 0, webhookSecret: 0 } }) // never expose the encrypted key or the webhook token
    .sort({ createdAt: -1 })
    .toArray()

  return NextResponse.json(agents)
}

export async function POST(request: NextRequest) {
  // Rate limit (Lane A3, D1 remainder): creating an agent is a write,
  // 30/min per client IP — placed before auth so unauthenticated hammering
  // is throttled too.
  const createRl = await rateLimit(`agents:create:${getClientIp(request)}`, { windowMs: 60_000, max: 30 })
  if (!createRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: createRl.retryAfterMs }, { status: 429 })
  }
  const token = await getSessionTokenFromCookies()
  if (!token) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  let payload
  try {
    payload = await verifyJwtSession(token)
  } catch {
    return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })
  }

  const userId = payload.sub
  const permission = await checkPermission(userId, 'canCreateAgents')
  if (!permission.allowed) {
    return NextResponse.json({ error: permission.reason }, { status: permission.status ?? 403 })
  }

  const body = await request.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  // A workflow with an unsafe Condition node is refused at save time, not
  // discovered when it runs.
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

  const {
    name,
    description,
    prompt,
    workflow,
    llmProvider,
    userApiKey, // plain-text key supplied by the user — we encrypt before storing
    status = 'draft',
    tags = [],
    // Set by callers that never showed the user a name field (the builder's
    // autosave). Those accept a numbered variant instead of failing the save.
    autoName = false,
  } = body

  // No usable name from the caller: derive one rather than storing "Untitled".
  // Chain is name → readable summary of the prompt → the prompt itself → error.
  const source = cleanAgentName(prompt) || cleanAgentName(description)
  const requested =
    cleanAgentName(name) ||
    agentNameFromPrompt(source, '') ||
    source

  if (!requested) {
    return NextResponse.json(
      { error: 'name is required' },
      { status: 400 },
    )
  }

  if (!isUsableAgentName(requested)) {
    return NextResponse.json(
      { error: 'Agent names must contain letters or numbers.' },
      { status: 400 },
    )
  }

  // H23: a schedule may be set at creation — same validation as PATCH.
  // An invalid cron is a 400, never a silently dropped field.
  let createSchedule: { cron: string; timezone?: string } | null = null
  if ('schedule' in body && body.schedule !== undefined) {
    const checked = validateScheduleInput(body.schedule)
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error }, { status: 400 })
    }
    createSchedule = checked.schedule
  }

  // Agent knobs the orchestrator reads (role, system prompt, budgets,
  // approval, fallback). Validated with sane bounds; a bad value is a 400,
  // not a silently dropped field.
  const agentFields = validateAgentFields(body)
  if (!agentFields.ok) {
    return NextResponse.json(
      { error: agentFields.errors.join(' ') },
      { status: 400 },
    )
  }

  // Encrypt the API key only if one was provided
  const encryptedKey = userApiKey?.trim() ? encrypt(userApiKey.trim()) : undefined

  const db = await getDb()

  // C1: a lapsed subscription is not Pro. Agent creation needs a live trial
  // or a live paid term; an expired trial or an expired Pro term is refused
  // with 403 instead of letting the API bypass the upgrade modal (the
  // trial-expiry half of this check is the same rule, applied to creation
  // only — listing and other reads are untouched). The session check above
  // guarantees the user row exists in production (verifyJwtSession throws
  // without it), so a missing row — only reachable against a stand-in DB —
  // is not treated as expired.
  const owner = await db
    .collection('users')
    .findOne<SubscriptionLike>({ _id: new ObjectId(userId) })
  if (owner && !hasActiveAccess(owner)) {
    return NextResponse.json(
      { error: 'Your subscription has ended. Upgrade to Pro to create agents.' },
      { status: 403 },
    )
  }

  const settings = await db.collection('workspace_settings').findOne({ userId })
  if (settings?.permissions?.canEditWorkflows === false) {
    return NextResponse.json({ error: 'Workflow editing permission is disabled for this workspace.' }, { status: 403 })
  }
  await ensureAgentNameIndex(db)
  // Agents saved before uniqueness was enforced can still share a name; clean
  // those up first so the list we are about to compare against is truthful.
  await repairLegacyDuplicateNames(db, userId)

  const taken = await listTakenNames(db, userId)
  const clash = taken.find((existing) => isDuplicateAgentName(existing, requested))

  let agentName = requested
  if (clash) {
    if (!autoName) {
      return NextResponse.json(
        {
          error: `You already have an agent named "${clash}". Choose a different name.`,
          existingName: clash,
        },
        { status: 409 },
      )
    }
    agentName = nextAvailableAgentName(requested, taken)
  }

  const now = new Date()

  let result
  try {
    result = await db.collection('agents').insertOne({
      userId,
      name: agentName,
      nameNormalized: normalizeAgentName(agentName),
      description: description?.trim() ?? '',
      prompt: prompt?.trim() ?? '',
      workflow: workflow ?? null,
      llmProvider: llmProvider ?? null,
      userApiKey: encryptedKey ?? null,
      // C-6: per-workflow webhook secret, minted at creation. The
      // production webhook URL must carry it as ?token= (checked in
      // constant time in webhookRoute.ts). It is returned once, in the
      // create response below — list/get responses exclude it, so the
      // token is only ever seen by the owner at creation time.
      webhookSecret: crypto.randomBytes(32).toString('hex'),
      status,
      tags: Array.isArray(tags) ? tags : [],
      workflowVersion: 1,
      ...(createSchedule ? { schedule: createSchedule } : {}),
      // P1-1: the orchestrator's critic lookup, budgets, approval gate and
      // fallback all read these — they are stored, not just typed.
      ...(agentFields.fields.role !== undefined ? { role: agentFields.fields.role } : {}),
      ...(agentFields.fields.systemPrompt !== undefined ? { systemPrompt: agentFields.fields.systemPrompt } : {}),
      ...(agentFields.fields.maxTokenBudget !== undefined ? { maxTokenBudget: agentFields.fields.maxTokenBudget } : {}),
      ...(agentFields.fields.maxRetryCount !== undefined ? { maxRetryCount: agentFields.fields.maxRetryCount } : {}),
      ...(agentFields.fields.humanApprovalRequired !== undefined ? { humanApprovalRequired: agentFields.fields.humanApprovalRequired } : {}),
      ...(agentFields.fields.fallbackAgentId !== undefined ? { fallbackAgentId: agentFields.fields.fallbackAgentId } : {}),
      createdAt: now,
      updatedAt: now,
    })
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return NextResponse.json(
        { error: `You already have an agent named "${agentName}". Choose a different name.` },
        { status: 409 },
      )
    }
    throw error
  }

  const inserted = await db.collection('agents').findOne(
    { _id: result.insertedId },
    { projection: { userApiKey: 0 } }, // don't return the encrypted key; webhookSecret IS returned once here (C-6)
  )

  await auditAgentLifecycle({
    userId,
    action: 'agent.create',
    agentId: String(result.insertedId),
  })
  await saveAgentVersion(db, {
    userId,
    agentId: String(result.insertedId),
    version: 1,
    prompt: prompt?.trim() ?? '',
    workflow: workflow ?? undefined,
    llmProvider: llmProvider ?? undefined,
    notes: 'Initial workflow version',
  })

  return NextResponse.json(inserted, { status: 201 })
}

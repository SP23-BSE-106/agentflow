import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'

import { getDb } from '@/lib/mongo/mongo'
import { errorResponse } from '@/lib/api/errors'
import { getClientIp, rateLimit } from '@/lib/rateLimit'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { GUEST_LOGIN_REQUIRED, getOptionalAuth, loginRequiredResponse } from '@/lib/auth/session'
import {
  ensureAgentMessagesIndex,
  ensureAgentTasksIndex,
  ensureExecutionEventsIndex,
} from '@/lib/mongo/indices'
import type {
  AgentMessage,
  AgentMessageStatus,
  AgentMessageType,
} from '@/lib/mongo/agentMessages'
import type { AgentTaskStatus } from '@/lib/mongo/agentTasks'
import { validateWorkflowGraph } from '@/lib/workflow/condition'
import { reexecuteFailedTask, resumeRun } from '@/lib/orchestration/orchestrator'
import { executionsListGet, executionsResumePost } from '@/lib/execution/executionsRoute'

/**
 * Multi-agent run, task and message API (implementation plan Milestone 1).
 *
 * All reads/writes are scoped to the caller's own workspace (`userId`) so
 * cross-user data access is prevented. Runs live in the existing
 * `workflow_runs` collection; tasks, messages and execution events live in
 * their own collections, linked by `workflowRunId`.
 *
 * URL shapes handled:
 *
 *   GET/POST   /api/runs
 *   GET/POST   /api/runs/:runId            (POST body: { action: 'cancel'|'resume' })
 *   GET        /api/runs/:runId/tasks
 *   GET/POST   /api/runs/:runId/tasks/:taskId/retry   (POST)
 *   GET/POST   /api/runs/:runId/messages
 *   GET        /api/runs/:runId/messages/:messageId
 *   GET/POST   /api/runs/:runId/evaluations
 *   GET        /api/runs/:runId/approvals
 *   GET        /api/runs/executions             (n8n: execution list)
 *   POST       /api/runs/executions/:id/resume  (n8n: resume a Wait pause)
 *
 * The two executions shapes are the serving end of the public
 * /api/executions URLs (next.config.ts rewrites them here so the Vercel
 * Hobby 12-function budget holds). They are matched before the generic
 * :runId shape, so the literal segment 'executions' is never read as a
 * run id (run ids are ObjectIds, which can never equal that string).
 *
 * Exports a single `handle(request, method, pathParams)` so the route can
 * dispatch on both HTTP method and URL shape without duplicate export names.
 */

async function getAuthenticatedUserId(): Promise<string | null> {
  const token = await getSessionTokenFromCookies()
  if (!token) return null
  try {
    return (await verifyJwtSession(token)).sub
  } catch {
    return null
  }
}

function isValidId(id: string): boolean {
  return ObjectId.isValid(id)
}

type PathParams = {
  runId?: string
  section?: 'tasks' | 'messages' | 'evaluations' | 'approvals' | 'events'
  id?: string // taskId or messageId
}

/* ───────────────────────── runs ───────────────────────── */

/** GET /api/runs — recent runs for the caller's workspace. */
async function listRuns(request: NextRequest) {
  const optional = await getOptionalAuth()
  if (optional === 'invalid') return loginRequiredResponse()
  // Guest mode: a guest has no runs — empty list, never another user's.
  if (optional === 'guest') return NextResponse.json([])

  const userId = optional.userId

  const db = await getDb()
  const url = new URL(request.url)
  const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100)

  const runs = await db
    .collection('workflow_runs')
    .find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray()

  return NextResponse.json(
    runs.map((row) => ({
      id: String(row._id),
      agentId: typeof row.agentId === 'string' ? row.agentId : null,
      status: row.status,
      input: row.input,
      output: row.output,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      createdAt: row.createdAt,
      metadata: row.metadata,
    })),
  )
}

/** POST /api/runs — create a new workflow run. */
async function createRun(request: NextRequest) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { agentId, workflow, input, mode = 'sequential' } = body
  if (agentId && !isValidId(agentId)) {
    return NextResponse.json({ error: 'Invalid agent ID' }, { status: 400 })
  }
  if (workflow !== undefined && workflow !== null) {
    const workflowError = validateWorkflowGraph(workflow)
    if (workflowError) {
      return NextResponse.json({ error: workflowError }, { status: 400 })
    }
  }

  const db = await getDb()
  await ensureAgentTasksIndex(db)
  await ensureAgentMessagesIndex(db)
  await ensureExecutionEventsIndex(db)

  const now = new Date()
  const record = {
    userId,
    agentId: agentId || null,
    workflow: workflow ?? null,
    input: typeof input === 'object' && input !== null ? input : {},
    status: 'queued' as const,
    mode,
    startedAt: now,
    createdAt: now,
    metadata: { mode },
  }

  const result = await db.collection('workflow_runs').insertOne(record)

  await db.collection('execution_events').insertOne({
    userId,
    workflowRunId: String(result.insertedId),
    type: 'run.started',
    payload: { mode, agentId },
    createdAt: now,
  })

  return NextResponse.json(
    { ok: true, id: String(result.insertedId), status: 'queued', mode },
    { status: 201 },
  )
}

/** POST /api/runs/:runId — cancel or resume a run (body: { action }). */
async function actionRun(request: NextRequest, { runId }: PathParams) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  if (!runId || !isValidId(runId)) {
    return NextResponse.json({ error: 'Invalid run ID' }, { status: 400 })
  }

  const body = await request.json().catch(() => null)
  const action = body?.action
  if (action !== 'cancel' && action !== 'resume') {
    return NextResponse.json({ error: 'action must be "cancel" or "resume"' }, { status: 400 })
  }

  const db = await getDb()
  const run = await db.collection('workflow_runs').findOne({
    _id: new ObjectId(runId),
    userId,
  })
  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  }

  if (action === 'cancel' && !['queued', 'running', 'paused'].includes(run.status)) {
    return NextResponse.json(
      { error: `Cannot cancel a run in '${run.status}' state` },
      { status: 409 },
    )
  }

  if (action === 'resume') {
    if (['completed', 'cancelled'].includes(run.status)) {
      return NextResponse.json(
        { error: `Cannot resume a run in '${run.status}' state` },
        { status: 409 },
      )
    }
    // Resume re-executes the run from its checkpoint: completed tasks are
    // skipped and their outputs reused, remaining tasks run again. It does
    // not just flip the status string.
    await db.collection('execution_events').insertOne({
      userId,
      workflowRunId: runId,
      type: 'run.resumed',
      payload: { previousStatus: run.status },
      createdAt: new Date(),
    })
    try {
      const result = await resumeRun({ runId, userId })
      return NextResponse.json({ ok: true, id: runId, action, ...result })
    } catch (error) {
      // 'Cannot resume …' is a product verdict from the orchestrator, safe
      // to repeat. Anything else is a server failure: answer it through
      // errorResponse so the raw message never reaches the caller.
      const message = error instanceof Error ? error.message : 'Resume failed'
      if (message.startsWith('Cannot resume')) {
        return NextResponse.json({ error: message }, { status: 409 })
      }
      return errorResponse(error, 'Resume failed. Try again.')
    }
  }

  const newStatus = 'cancelled'

  await db
    .collection('workflow_runs')
    .updateOne({ _id: new ObjectId(runId), userId }, { $set: { status: newStatus } })

  await db.collection('execution_events').insertOne({
    userId,
    workflowRunId: runId,
    type: 'run.cancelled',
    payload: { previousStatus: run.status, newStatus },
    createdAt: new Date(),
  })

  return NextResponse.json({ ok: true, id: runId, status: newStatus, action })
}

/** GET /api/runs/:runId — get one run plus its tasks, messages and evaluations. */
async function getRun(_request: NextRequest, { runId }: PathParams) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  if (!runId || !isValidId(runId)) {
    return NextResponse.json({ error: 'Invalid run ID' }, { status: 400 })
  }

  const db = await getDb()
  const run = await db.collection('workflow_runs').findOne({
    _id: new ObjectId(runId),
    userId,
  })
  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  }

  const [tasks, messages, evaluations] = await Promise.all([
    db
      .collection('agent_tasks')
      .find({ userId, workflowRunId: runId })
      .sort({ createdAt: 1 })
      .toArray(),
    db
      .collection('agent_messages')
      .find({ userId, workflowRunId: runId })
      .sort({ createdAt: 1 })
      .toArray(),
    db
      .collection('agent_evaluations')
      .find({ userId, workflowRunId: runId })
      .sort({ createdAt: 1 })
      .toArray(),
  ])

  return NextResponse.json({
    id: String(run._id),
    agentId: run.agentId,
    status: run.status,
    mode: run.mode,
    input: run.input,
    output: run.output,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
    tasks,
    messages,
    evaluations,
  })
}

/* ──────────────────── tasks ───────────────────── */

/** GET /api/runs/:runId/tasks — list tasks for a run. */
async function listTasks(_request: NextRequest, { runId }: PathParams) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  if (!runId || !isValidId(runId)) {
    return NextResponse.json({ error: 'Invalid run ID' }, { status: 400 })
  }

  const db = await getDb()
  const tasks = await db
    .collection('agent_tasks')
    .find({ userId, workflowRunId: runId })
    .sort({ createdAt: 1 })
    .toArray()

  return NextResponse.json(tasks)
}

/** GET /api/runs/:runId/tasks/:taskId — get one task. */
async function getTask(_request: NextRequest, { runId, id: taskId }: PathParams) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  if (!runId || !isValidId(runId) || !taskId || !isValidId(taskId)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 })
  }

  const db = await getDb()
  const task = await db.collection('agent_tasks').findOne({
    _id: new ObjectId(taskId),
    userId,
    workflowRunId: runId,
  })
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  return NextResponse.json(task)
}

/** POST /api/runs/:runId/tasks/:taskId/retry — retry a failed task.
 *
 * H21: this used to only flip the task row to `retrying` and return — no
 * code anywhere consumed that status, so the row sat `retrying` forever
 * and a resume created a *new* failed task row. It now re-executes the
 * failed node's work for real (see `reexecuteFailedTask` in the
 * orchestrator) on the same task row, synchronously, before answering:
 * the row ends `completed` or `failed` (terminal), never `retrying`.
 * Only a `failed` (or already-`retrying`) task can be retried; anything
 * else is a 409. An optional `{ "input": "..." }` body retries the node
 * with replacement input text instead of the original input.
 */
async function retryTask(request: NextRequest, { runId, id: taskId }: PathParams) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  if (!runId || !isValidId(runId) || !taskId || !isValidId(taskId)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 })
  }

  const body = await request.json().catch(() => null)
  const inputOverride =
    body && typeof body.input === 'string' ? body.input : undefined

  const db = await getDb()
  const task = await db.collection('agent_tasks').findOne({
    _id: new ObjectId(taskId),
    userId,
    workflowRunId: runId,
  })
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  if (task.status !== 'failed' && task.status !== 'retrying') {
    return NextResponse.json(
      { error: `Cannot retry a task in '${task.status}' state` },
      { status: 409 },
    )
  }

  const retryCount = (task.retryCount || 0) + 1
  const maxRetries = task.maxRetries ?? 3
  if (retryCount > maxRetries) {
    return NextResponse.json({ error: 'Maximum retry count exceeded' }, { status: 400 })
  }

  // Mark it `retrying` first (the status the old endpoint promised), then
  // actually re-execute it — the row below is re-read after the run, so
  // the caller sees the terminal outcome, never a stuck `retrying`.
  await db.collection('agent_tasks').updateOne(
    { _id: new ObjectId(taskId), userId, workflowRunId: runId },
    {
      $set: {
        status: 'retrying' as AgentTaskStatus,
        retryCount,
        error: null,
        updatedAt: new Date(),
      },
    },
  )

  await db.collection('execution_events').insertOne({
    userId,
    workflowRunId: runId,
    taskId,
    agentId: task.agentId,
    type: 'task.retrying',
    payload: { retryCount, maxRetries },
    createdAt: new Date(),
  })

  try {
    const result = await reexecuteFailedTask({
      userId,
      runId,
      taskId,
      input: inputOverride,
    })
    const run = await db.collection('workflow_runs').findOne({
      _id: new ObjectId(runId),
      userId,
    })
    return NextResponse.json({
      ...result.task,
      reexecuted: true,
      ok: result.ok,
      error: result.error ?? null,
      runStatus: run?.status ?? null,
      resumed: result.resumed ?? null,
    })
  } catch (error) {
    // The re-execution itself could not run (run/node vanished mid-call):
    // put the task back to `failed` with the reason instead of leaving
    // it `retrying` forever — a retry must never orphan a row.
    const message = error instanceof Error ? error.message : 'Retry failed'
    await db
      .collection('agent_tasks')
      .updateOne(
        { _id: new ObjectId(taskId), userId, workflowRunId: runId },
        { $set: { status: 'failed' as AgentTaskStatus, error: message, updatedAt: new Date() } },
      )
    if (message.startsWith('Cannot retry') || message === 'Run not found' || message === 'Task not found') {
      return NextResponse.json({ error: message }, { status: 409 })
    }
    return errorResponse(error, 'Retry failed. Try again.')
  }
}

/* ──────────────────── messages ───────────────────── */

/** GET /api/runs/:runId/messages — list messages chronologically. */
async function listMessages(_request: NextRequest, { runId }: PathParams) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  if (!runId || !isValidId(runId)) {
    return NextResponse.json({ error: 'Invalid run ID' }, { status: 400 })
  }

  const db = await getDb()
  const messages = await db
    .collection('agent_messages')
    .find({ userId, workflowRunId: runId })
    .sort({ createdAt: 1 })
    .toArray()

  return NextResponse.json(messages)
}

/** POST /api/runs/:runId/messages — create a structured agent message. */
async function createMessage(request: NextRequest, { runId }: PathParams) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  if (!runId || !isValidId(runId)) {
    return NextResponse.json({ error: 'Invalid run ID' }, { status: 400 })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const {
    fromAgentId,
    toAgentId,
    taskId,
    parentMessageId,
    type = 'status',
    payload,
    text,
    priority = 'normal',
    requiresResponse = false,
    workflowId,
  } = body

  if (!fromAgentId || typeof fromAgentId !== 'string') {
    return NextResponse.json({ error: 'fromAgentId is required' }, { status: 400 })
  }
  const validTypes: AgentMessageType[] = [
    'task',
    'result',
    'feedback',
    'approval_request',
    'approval_response',
    'status',
    'error',
    'question',
  ]
  if (!validTypes.includes(type)) {
    return NextResponse.json({ error: 'Invalid message type' }, { status: 400 })
  }

  const db = await getDb()
  await ensureAgentMessagesIndex(db)

  const now = new Date()
  const message: AgentMessage = {
    userId,
    workflowId: workflowId || runId,
    workflowRunId: runId,
    fromAgentId,
    toAgentId: toAgentId || undefined,
    taskId: taskId || undefined,
    parentMessageId: parentMessageId || undefined,
    type,
    status: 'queued' as AgentMessageStatus,
    payload: payload ?? undefined,
    text: typeof text === 'string' ? text : undefined,
    priority,
    requiresResponse,
    retryCount: 0,
    createdAt: now,
  }

  // `_id` is omitted on insert so MongoDB generates an ObjectId.
  type MessageInsert = Omit<AgentMessage, '_id'>
  const result = await db.collection('agent_messages').insertOne(
    message as MessageInsert,
  )

  await db.collection('execution_events').insertOne({
    userId,
    workflowRunId: runId,
    agentId: fromAgentId,
    taskId: message.taskId,
    messageId: String(result.insertedId),
    type: 'message.created',
    payload: { messageType: type, toAgentId },
    createdAt: now,
  })

  const saved = { ...message, _id: result.insertedId }
  return NextResponse.json(saved, { status: 201 })
}

/** GET /api/runs/:runId/messages/:messageId — get one message. */
async function getMessage(
  _request: NextRequest,
  { runId, id: messageId }: PathParams,
) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  if (!runId || !isValidId(runId) || !messageId || !isValidId(messageId)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 })
  }

  const db = await getDb()
  const message = await db.collection('agent_messages').findOne({
    _id: new ObjectId(messageId),
    userId,
    workflowRunId: runId,
  })
  if (!message) return NextResponse.json({ error: 'Message not found' }, { status: 404 })

  return NextResponse.json(message)
}

/* ──────────────────── evaluations ───────────────────── */

/** GET /api/runs/:runId/evaluations — list evaluations for a run. */
async function listEvaluations(_request: NextRequest, { runId }: PathParams) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  if (!runId || !isValidId(runId)) {
    return NextResponse.json({ error: 'Invalid run ID' }, { status: 400 })
  }

  const db = await getDb()
  const evaluations = await db
    .collection('agent_evaluations')
    .find({ userId, workflowRunId: runId })
    .sort({ createdAt: 1 })
    .toArray()

  return NextResponse.json(evaluations)
}

/** POST /api/runs/:runId/evaluate — record a critic/fact-checker evaluation. */
async function createEvaluation(request: NextRequest, { runId }: PathParams) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  if (!runId || !isValidId(runId)) {
    return NextResponse.json({ error: 'Invalid run ID' }, { status: 400 })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { targetTaskId, evaluatorAgentId, scores, feedback } = body
  if (!targetTaskId || !isValidId(targetTaskId)) {
    return NextResponse.json({ error: 'targetTaskId is required' }, { status: 400 })
  }
  if (!evaluatorAgentId || typeof evaluatorAgentId !== 'string') {
    return NextResponse.json({ error: 'evaluatorAgentId is required' }, { status: 400 })
  }

  const scoreFields = ['accuracy', 'relevance', 'completeness', 'groundedness']
  const parsed: Record<string, number> = {}
  for (const field of scoreFields) {
    const value = Number(scores?.[field])
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return NextResponse.json({ error: `scores.${field} must be 0-1` }, { status: 400 })
    }
    parsed[field] = value
  }
  const overallScore =
    (parsed.accuracy + parsed.relevance + parsed.completeness + parsed.groundedness) / 4

  const db = await getDb()
  const now = new Date()
  const evaluation = {
    userId,
    workflowRunId: runId,
    targetTaskId,
    evaluatorAgentId,
    scores: parsed,
    overallScore,
    passed: overallScore >= 0.7,
    feedback: Array.isArray(feedback) ? feedback : [],
    createdAt: now,
  }

  const result = await db.collection('agent_evaluations').insertOne(evaluation)

  await db.collection('execution_events').insertOne({
    userId,
    workflowRunId: runId,
    agentId: evaluatorAgentId,
    taskId: targetTaskId,
    type: 'evaluation.created',
    payload: { overallScore, passed: evaluation.passed },
    createdAt: now,
  })

  return NextResponse.json({ ...evaluation, _id: result.insertedId }, { status: 201 })
}

/* ──────────────────── approvals ───────────────────── */

/** GET /api/runs/:runId/approvals — list approval requests for a run. */
async function listApprovals(_request: NextRequest, { runId }: PathParams) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  if (!runId || !isValidId(runId)) {
    return NextResponse.json({ error: 'Invalid run ID' }, { status: 400 })
  }

  const db = await getDb()
  const approvals = await db
    .collection('approval_requests')
    .find({ userId, workflowRunId: runId })
    .sort({ createdAt: 1 })
    .toArray()

  return NextResponse.json(approvals)
}

/** GET /api/runs/:runId/events — live execution timeline (polling/SSE). */
async function listEvents(_request: NextRequest, { runId }: PathParams) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

  if (!runId || !isValidId(runId)) {
    return NextResponse.json({ error: 'Invalid run ID' }, { status: 400 })
  }

  const db = await getDb()
  const events = await db
    .collection('execution_events')
    .find({ userId, workflowRunId: runId })
    .sort({ createdAt: 1 })
    .toArray()

  return NextResponse.json(events)
}

/* ──────────────────── dispatcher ───────────────────── */

type RouteShape =
  | { kind: 'runs' }                                 // /api/runs
  | { kind: 'executions' }                           // /api/runs/executions
  | { kind: 'executionResume'; executionId: string } // /api/runs/executions/:id/resume
  | { kind: 'run'; runId: string }                   // /api/runs/:runId
  | { kind: 'section'; runId: string; section: PathParams['section'] } // /api/runs/:runId/:section
  | { kind: 'item'; runId: string; section: 'tasks' | 'messages'; id: string } // /api/runs/:runId/:section/:id
  | { kind: 'taskRetry'; runId: string; taskId: string } // /api/runs/:runId/tasks/:taskId/retry
function classify(
  path: string[],
): RouteShape | null {
  if (path.length === 0) return { kind: 'runs' }
  if (path.length === 1 && path[0] === 'executions') return { kind: 'executions' }
  if (path.length === 3 && path[0] === 'executions' && path[2] === 'resume') {
    return { kind: 'executionResume', executionId: path[1] }
  }
  if (path.length === 1) return { kind: 'run', runId: path[0] }

  const [runId, section, id] = path
  if (!isValidId(runId)) return null

  if (path.length === 2) {
    if (
      section === 'tasks' ||
      section === 'messages' ||
      section === 'evaluations' ||
      section === 'approvals' ||
      section === 'events'
    ) {
      return { kind: 'section', runId, section }
    }
    return null
  }

  if (path.length === 3) {
    if ((section === 'tasks' || section === 'messages') && id && isValidId(id)) {
      return { kind: 'item', runId, section, id }
    }
    return null
  }

  // H20: the documented 4-segment retry URL had no case here, so it 404d
  // while the route docstring and handler header both documented it.
  if (path.length === 4) {
    if (section === 'tasks' && id && isValidId(id) && path[3] === 'retry') {
      return { kind: 'taskRetry', runId, taskId: id }
    }
    return null
  }

  return null
}

export async function handle(
  request: NextRequest,
  method: string,
  path: string[],
): Promise<Response> {
  const shape = classify(path)
  if (!shape) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Rate limit (Lane A3, D1 remainder): reads 60/min, writes 30/min per
  // client IP (getClientIp — never the spoofable first x-forwarded-for
  // entry). Placed after the 404 so unknown shapes don't consume budget.
  // Resume/retry re-execute work, so they share the write bucket.
  const ip = getClientIp(request)
  const isRead = method === 'GET'
  const rl = await rateLimit(`runs:${isRead ? 'read' : 'write'}:${ip}`, {
    windowMs: 60_000,
    max: isRead ? 60 : 30,
  })
  if (!rl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, { status: 429 })
  }

  switch (shape.kind) {
    case 'executions':
      if (method === 'GET') return executionsListGet()
      return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })

    case 'executionResume':
      if (method === 'POST') return executionsResumePost(request, shape.executionId)
      return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })

    case 'runs':
      if (method === 'GET') return listRuns(request)
      if (method === 'POST') return createRun(request)
      return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })

    case 'run':
      if (method === 'GET') return getRun(request, { runId: shape.runId })
      if (method === 'POST') return actionRun(request, { runId: shape.runId })
      return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })

    case 'section': {
      const { runId, section } = shape
      const params: PathParams = { runId, section }
      if (section === 'tasks') {
        if (method === 'GET') return listTasks(request, params)
        return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
      }
      if (section === 'messages') {
        if (method === 'GET') return listMessages(request, params)
        if (method === 'POST') return createMessage(request, params)
        return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
      }
      if (section === 'evaluations') {
        if (method === 'GET') return listEvaluations(request, params)
        if (method === 'POST') return createEvaluation(request, params)
        return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
      }
      if (section === 'approvals') {
        if (method === 'GET') return listApprovals(request, params)
        return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
      }
      if (section === 'events') {
        if (method === 'GET') return listEvents(request, params)
        return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
      }
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    case 'item': {
      const { runId, section, id } = shape
      const params: PathParams = { runId, section, id }
      if (section === 'tasks') {
        if (method === 'GET') return getTask(request, params)
        if (method === 'POST') return retryTask(request, params)
        return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
      }
      if (section === 'messages') {
        if (method === 'GET') return getMessage(request, params)
        return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
      }
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    case 'taskRetry': {
      // H20: the documented URL. The 3-segment POST above keeps working
      // for existing callers; both shapes run the same re-executing retry.
      if (method === 'POST') {
        return retryTask(request, { runId: shape.runId, id: shape.taskId })
      }
      return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
    }
  }
}

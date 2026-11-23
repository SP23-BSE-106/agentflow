/**
 * POST /api/triggers/check — served from the /api/orchestrate catch-all
 * (next.config.ts rewrites the public URL there, so the Vercel Hobby
 * 12-function budget holds).
 *
 * Fires due schedules. This is the ONLY thing that fires schedules — a
 * schedule never fires by itself. The Vercel cron entry in `vercel.json`
 * calls this endpoint every minute; a manual POST works the same way.
 *
 * Auth: when `CRON_SECRET` is set (Vercel sets it automatically for cron
 * jobs), the caller must send `Authorization: Bearer <CRON_SECRET>`. When
 * it is not set, the endpoint accepts unauthenticated calls — that is the
 * manual-hit mode for local development. Set CRON_SECRET in production so
 * only the cron caller can trigger runs.
 *
 * A schedule lives on the agent doc as `schedule: { cron, timezone }` and
 * only fires for active agents. Each due agent is fired at most once per
 * minute: `schedule.lastFiredAt` is stamped before the run, and a second
 * call inside the same minute skips it. A bad cron expression is reported
 * in the response and skipped — it never fails the whole sweep.
 *
 * Time-based resume of waiting executions IS done here: after the
 * schedules, rows in `waiting_executions` whose resume time has passed
 * are continued (see src/lib/execution/resume.ts). A failed resume is
 * reported in the response and never fails the whole sweep.
 */

import { NextRequest, NextResponse } from 'next/server'

import { getDb } from '@/lib/mongo/mongo'
import { rateLimit, getClientIp } from '@/lib/rateLimit'
import { runWorkflow } from '@/lib/workflow/runWorkflow'
import { parseCron, isDue } from '@/lib/triggers/schedule'
import { listDueWaitingExecutions } from '@/lib/execution/waitStore'
import { resumeWaitingExecution } from '@/lib/execution/resume'
import { itemsToText } from '@/lib/nodes/items'

export type ScheduleCheckResult = {
  checked: number
  fired: Array<{ agentId: string; agentName: string; ok: boolean; output?: string; error?: string }>
  skipped: Array<{ agentId: string; reason: string }>
  errors: Array<{ agentId: string; error: string }>
  resumed: Array<{ executionId: string; workflowId: string; status: string; output?: string }>
}

function minuteBucket(date: Date): string {
  return date.toISOString().slice(0, 16) // YYYY-MM-DDTHH:mm
}

export async function triggersCheckPost(request: NextRequest): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const header = request.headers.get('authorization') || ''
    if (header !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        { error: 'This endpoint only accepts calls from the scheduled cron job.' },
        { status: 401 },
      )
    }
  }

  let db
  try {
    db = await getDb()
  } catch {
    return NextResponse.json({ error: 'Database is not available' }, { status: 503 })
  }

  // Firing schedules runs real (and LLM-spending) work, so the sweep is
  // throttled (30/min). The Vercel cron calls once a minute; manual hits
  // share the same bucket. Placed after the CRON_SECRET check above so the
  // legitimate cron caller is never throttled. No origin check: the cron
  // caller is not a browser and sends no Origin.
  const checkRl = await rateLimit(`triggers:check:${getClientIp(request)}`, { windowMs: 60_000, max: 30 })
  if (!checkRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: checkRl.retryAfterMs }, { status: 429 })
  }

  const now = new Date()
  const bucket = minuteBucket(now)
  const result: ScheduleCheckResult = { checked: 0, fired: [], skipped: [], errors: [], resumed: [] }

  const agents = await db
    .collection('agents')
    .find({ 'schedule.cron': { $exists: true } })
    .toArray()
  result.checked = agents.length

  for (const agent of agents) {
    const agentId = String(agent._id)
    const agentName = typeof agent.name === 'string' ? agent.name : agentId
    const schedule = agent.schedule as { cron?: unknown; timezone?: unknown; lastFiredAt?: unknown } | undefined
    const cronText = typeof schedule?.cron === 'string' ? schedule.cron : ''
    const timezone = typeof schedule?.timezone === 'string' && schedule.timezone.trim()
      ? schedule.timezone.trim()
      : undefined

    if (agent.status !== 'active') {
      result.skipped.push({ agentId, reason: 'Workflow is not active' })
      continue
    }

    let cron
    try {
      cron = parseCron(cronText)
    } catch (error) {
      result.errors.push({
        agentId,
        error: error instanceof Error ? error.message : 'Invalid cron expression',
      })
      continue
    }

    let due = false
    try {
      due = isDue(cron, now, timezone)
    } catch (error) {
      result.errors.push({
        agentId,
        error: error instanceof Error ? error.message : 'Schedule could not be evaluated',
      })
      continue
    }
    if (!due) {
      result.skipped.push({ agentId, reason: 'Not due' })
      continue
    }

    const lastFired = schedule?.lastFiredAt
    if (lastFired instanceof Date && minuteBucket(lastFired) === bucket) {
      result.skipped.push({ agentId, reason: 'Already fired this minute' })
      continue
    }

    // Stamp first so a second call inside the same minute cannot fire twice.
    await db
      .collection('agents')
      .updateOne({ _id: agent._id }, { $set: { 'schedule.lastFiredAt': now } })
      .catch(() => undefined)

    try {
      const run = await runWorkflow({
        db,
        userId: String(agent.userId),
        agentId,
        input: `Scheduled run at ${now.toISOString()}`,
      })
      result.fired.push({
        agentId,
        agentName,
        ok: run.ok,
        output: run.ok ? run.output : undefined,
        error: run.ok ? undefined : run.error || 'Workflow run failed',
      })
    } catch (error) {
      result.fired.push({
        agentId,
        agentName,
        ok: false,
        error: error instanceof Error ? error.message : 'Workflow run failed',
      })
    }
  }

  // ── Time-based Wait resumes ────────────────────────────────────────
  // Rows whose resume time passed are continued, oldest first. Each
  // resume deletes its waiting row before running, so a second sweep in
  // the same minute cannot resume it twice. A failed resume is reported
  // and never fails the sweep.
  const due = await listDueWaitingExecutions(db, now)
  for (const waiting of due) {
    try {
      const resumed = await resumeWaitingExecution(waiting)
      result.resumed.push({
        executionId: waiting.executionId,
        workflowId: waiting.workflowId,
        status: resumed.status,
        output: itemsToText(resumed.output),
      })
    } catch (error) {
      result.errors.push({
        agentId: waiting.workflowId,
        error: error instanceof Error ? error.message : 'Wait resume failed',
      })
    }
  }

  return NextResponse.json(result)
}

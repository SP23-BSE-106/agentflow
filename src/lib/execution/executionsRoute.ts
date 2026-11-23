/**
 * Execution list + Wait resume — served from the /api/runs catch-all
 * (next.config.ts rewrites the public URLs /api/executions and
 * /api/executions/[id]/resume there, so the Vercel Hobby 12-function
 * budget holds).
 *
 * GET  /api/executions — list the caller's workflow runs, newest first.
 * POST /api/executions/[id]/resume — resume a run paused at a Wait node.
 */

import { NextRequest, NextResponse } from 'next/server'

import { getDb } from '@/lib/mongo/mongo'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { markStaleRunsCrashed } from '@/lib/execution/statuses'
import { getWaitingExecution } from '@/lib/execution/waitStore'
import { resumeWaitingExecution } from '@/lib/execution/resume'
import type { WorkflowItem } from '@/lib/nodes/items'

export async function executionsListGet() {
  try {
    const token = await getSessionTokenFromCookies()
    if (!token) return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    let userId: string
    try {
      userId = (await verifyJwtSession(token)).sub
    } catch {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    }

    try {
      await markStaleRunsCrashed(undefined, { userId })
    } catch {
      // Ignore: listing must still work.
    }

    const db = await getDb()
    const limit = 50
    const runs = await db
      .collection('workflow_runs')
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()

    return NextResponse.json({
      runs: runs.map((run) => ({
        id: String(run._id),
        agentId: run.agentId ? String(run.agentId) : undefined,
        workflowId: run.workflowId ? String(run.workflowId) : undefined,
        status: String(run.status),
        input: typeof run.input === 'string' ? run.input : undefined,
        output: typeof run.output === 'string' ? run.output : undefined,
        durationMs: typeof run.durationMs === 'number' ? run.durationMs : undefined,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list executions.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function executionsResumePost(
  request: NextRequest,
  id: string,
) {
  try {
    const token = await getSessionTokenFromCookies()
    if (!token) return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    let userId: string
    try {
      userId = (await verifyJwtSession(token)).sub
    } catch {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    }

    const waiting = await getWaitingExecution(id)
    if (!waiting) {
      return NextResponse.json({ error: 'No waiting execution with that id.' }, { status: 404 })
    }
    if (waiting.userId !== userId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Stale runs are marked crashed before a resume starts, so the list
    // never shows a dead run as still running.
    try {
      await markStaleRunsCrashed(undefined, { userId })
    } catch {
      // Ignore.
    }

    const body = await request.json().catch(() => null)
    const resumeItems =
      body && Array.isArray((body as Record<string, unknown>).items)
        ? ((body as Record<string, unknown>).items as WorkflowItem[])
        : undefined

    const result = await resumeWaitingExecution(waiting, resumeItems)

    return NextResponse.json({
      executionId: waiting.executionId,
      status: result.status,
      output: result.output,
      nodeResults: result.nodeResults,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Resume failed.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

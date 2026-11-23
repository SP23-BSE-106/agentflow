import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'

import { getDb } from '@/lib/mongo/mongo'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { rateLimit, getClientIp } from '@/lib/rateLimit'
import { isCrossOriginRequest } from '@/lib/originCheck'
import {
  approveApproval,
  rejectApproval,
  editApproval,
} from '@/lib/orchestration/approvalManager'
import { GUEST_LOGIN_REQUIRED } from '@/lib/auth/session'

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

/**
 * `/api/approvals` handler:
 *
 *   GET    /api/approvals                      — list pending approvals (query: ?runId=...)
 *   POST   /api/approvals/:approvalId/approve
 *   POST   /api/approvals/:approvalId/reject
 *   POST   /api/approvals/:approvalId/edit
 */

export async function handle(
  request: NextRequest,
  method: string,
  path: string[],
): Promise<Response> {
  // Approvals move a run forward, so the mutating actions are throttled
  // (30/min) on top of a general 60/min cap for the whole handler.
  // Cross-site POSTs are refused; the dashboard calls this same-origin.
  if (method === 'POST' && isCrossOriginRequest(request)) {
    return NextResponse.json({ error: 'Cross-origin requests are not allowed here.' }, { status: 403 })
  }
  const ip = getClientIp(request)
  const rl = await rateLimit(`approvals:${ip}`, { windowMs: 60_000, max: 60 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfterMs: rl.retryAfterMs },
      { status: 429 },
    )
  }

  const userId = await getAuthenticatedUserId()
  if (!userId) {
    return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })
  }

  const db = await getDb()

  // GET /api/approvals — list pending approvals (optionally filtered by runId)
  if (path.length === 0 && method === 'GET') {
    const url = new URL(request.url)
    const runId = url.searchParams.get('runId')

    const filter: Record<string, unknown> = { userId, status: 'pending' }
    if (runId && isValidId(runId)) filter.workflowRunId = runId

    const approvals = await db
      .collection('approval_requests')
      .find(filter)
      .sort({ createdAt: 1 })
      .toArray()

    return NextResponse.json(approvals)
  }

  // POST /api/approvals/:approvalId/approve | reject | edit
  if (path.length === 2 && method === 'POST') {
    const writeRl = await rateLimit(`approvals:write:${ip}`, { windowMs: 60_000, max: 30 })
    if (!writeRl.ok) {
      return NextResponse.json(
        { error: 'Too many requests', retryAfterMs: writeRl.retryAfterMs },
        { status: 429 },
      )
    }
    const [approvalId, action] = path
    if (!isValidId(approvalId)) {
      return NextResponse.json({ error: 'Invalid approval ID' }, { status: 400 })
    }
    if (action !== 'approve' && action !== 'reject' && action !== 'edit') {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const { response, respondedBy, editedPayload } = body

    switch (action) {
      case 'approve': {
        const result = await approveApproval(approvalId, userId, response, respondedBy)
        if (!result) {
          return NextResponse.json({ error: 'Approval request not found' }, { status: 404 })
        }
        return NextResponse.json({ ok: true, status: 'approved', approval: result })
      }
      case 'reject': {
        const result = await rejectApproval(approvalId, userId, response, respondedBy)
        if (!result) {
          return NextResponse.json({ error: 'Approval request not found' }, { status: 404 })
        }
        return NextResponse.json({ ok: true, status: 'rejected', approval: result })
      }
      case 'edit': {
        const result = await editApproval(
          approvalId,
          userId,
          typeof response === 'string' ? response : '',
          respondedBy,
          editedPayload,
        )
        if (!result) {
          return NextResponse.json({ error: 'Approval request not found' }, { status: 404 })
        }
        return NextResponse.json({ ok: true, status: 'edited', approval: result })
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

import type { NextRequest } from 'next/server'

import { type DispatchContext } from '@/lib/api/routeDispatch'
import { errorResponse } from '@/lib/api/errors'

import * as handler from './handler'

// Resume re-executes remaining tasks through the orchestrator, which can
// take most of half a minute on a cold provider.
export const maxDuration = 60

/**
 * `/api/runs` catch-all:
 *
 *   GET/POST   /api/runs
 *   GET/POST   /api/runs/:runId            (POST body: { action: 'cancel'|'resume' })
 *   GET        /api/runs/:runId/tasks
 *   GET/POST   /api/runs/:runId/tasks/:taskId/retry
 *   GET/POST   /api/runs/:runId/messages
 *   GET        /api/runs/:runId/messages/:messageId
 *   GET/POST   /api/runs/:runId/evaluations
 *   GET        /api/runs/:runId/approvals
 */

async function run(
  method: string,
  request: NextRequest,
  ctx: DispatchContext,
): Promise<Response> {
  const { path = [] } = await ctx.params
  // A throw anywhere in the handler used to escape as an empty HTTP 500.
  // Map it to an honest JSON error instead (503 when the database is down).
  try {
    return await handler.handle(request, method, path)
  } catch (error) {
    console.error('[api/runs] Unhandled handler error:', error)
    return errorResponse(error)
  }
}

export function GET(request: NextRequest, ctx: DispatchContext) {
  return run('GET', request, ctx)
}

export function POST(request: NextRequest, ctx: DispatchContext) {
  return run('POST', request, ctx)
}

export function PUT(request: NextRequest, ctx: DispatchContext) {
  return run('PUT', request, ctx)
}

export function PATCH(request: NextRequest, ctx: DispatchContext) {
  return run('PATCH', request, ctx)
}

export function DELETE(request: NextRequest, ctx: DispatchContext) {
  return run('DELETE', request, ctx)
}

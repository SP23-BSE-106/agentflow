import type { NextRequest } from 'next/server'

import { type DispatchContext } from '@/lib/api/routeDispatch'
import { errorResponse } from '@/lib/api/errors'

import * as handler from './handler'

/**
 * `/api/approvals` catch-all:
 *
 *   POST /api/approvals/:approvalId/approve   (body: { response?, respondedBy? })
 *   POST /api/approvals/:approvalId/reject    (body: { response?, respondedBy? })
 *   POST /api/approvals/:approvalId/edit      (body: { response, respondedBy?, editedPayload? })
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
    console.error('[api/approvals] Unhandled handler error:', error)
    return errorResponse(error)
  }
}

export function POST(request: NextRequest, ctx: DispatchContext) {
  return run('POST', request, ctx)
}

export function GET(request: NextRequest, ctx: DispatchContext) {
  return run('GET', request, ctx)
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

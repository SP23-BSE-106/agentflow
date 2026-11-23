import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { dispatch, type DispatchContext } from '@/lib/api/routeDispatch'
import { rateLimit, getClientIp } from '@/lib/rateLimit'

import * as initCollections from '../init-collections/handler'

const routes = {
  'init-collections': initCollections,
}

function handle(method: string) {
  return async (request: NextRequest, ctx: DispatchContext) => {
    // Dev-only admin endpoint (creates collections/indexes) — throttled
    // (30/min) rather than left open to hammering. No origin check: it is
    // also called server-side / by curl, which send no Origin.
    const rl = await rateLimit(`dev:${getClientIp(request)}`, { windowMs: 60_000, max: 30 })
    if (!rl.ok) {
      return NextResponse.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, { status: 429 })
    }
    return dispatch(routes, method, request, ctx)
  }
}

export const GET = handle('GET')
export const POST = handle('POST')
export const PUT = handle('PUT')
export const PATCH = handle('PATCH')
export const DELETE = handle('DELETE')

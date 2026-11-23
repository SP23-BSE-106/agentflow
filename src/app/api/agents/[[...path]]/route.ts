import type { NextRequest } from 'next/server'

import { methodNotAllowed, notFound, type DispatchContext } from '@/lib/api/routeDispatch'
import { errorResponse } from '@/lib/api/errors'

import * as generate from '../generate/handler'
import * as root from '../handler'
import * as runs from '../runs/handler'
import * as byId from '../[id]/handler'
import * as capabilities from '../capabilities/handler'
import * as versions from '../versions/handler'

// Workflow generation calls a model end to end. Without an explicit budget
// Vercel applies its default, which is shorter than the request below — the
// function would be killed and the caller would see a 504 instead of the
// fallback the handler already knows how to produce.
export const maxDuration = 60

type Handler = (request: NextRequest, ctx?: unknown) => Promise<Response> | Response

/**
 * Four shapes live under one prefix, resolved here in Next's own precedence
 * order (static segments beat dynamic ones):
 *
 *   /api/agents            -> root        (GET, POST)
 *   /api/agents/generate   -> generate    (POST)
 *   /api/agents/runs       -> runs        (GET, POST)
 *   /api/agents/{id}/versions -> versions (GET)
 *   /api/agents/{id}/versions/{version}/restore -> versions (POST, H22)
 *   /api/agents/{id}       -> byId        (GET, DELETE, PATCH)
 *
 * `runs` is matched before `{id}` so it can never be mistaken for one — agent
 * ids are 24 hex characters, so nothing legitimate collides either way.
 * `byId` is the only handler in the app that reads `params`, so its context is
 * rebuilt as `{ id }` rather than the catch-all's `{ path }`.
 */
async function run(
  method: string,
  request: NextRequest,
  ctx: DispatchContext,
): Promise<Response> {
  const { path = [] } = await ctx.params

  let mod: object
  let handlerCtx: unknown = { params: Promise.resolve({ path }) }

  if (path.length === 0) {
    mod = root
  } else if (path.length === 1 && path[0] === 'generate') {
    mod = generate
  } else if (path.length === 1 && path[0] === 'runs') {
    mod = runs
  } else if (path.length === 2 && path[1] === 'versions') {
    mod = versions
    handlerCtx = { params: Promise.resolve({ id: path[0] }) }
  } else if (path.length === 4 && path[1] === 'versions' && path[3] === 'restore') {
    // H22: POST /api/agents/:id/versions/:version/restore
    mod = versions
    handlerCtx = { params: Promise.resolve({ id: path[0], version: path[2] }) }
  } else if (path.length === 1) {
    mod = byId
    handlerCtx = { params: Promise.resolve({ id: path[0] }) }
  } else if (path.length === 2 && path[1] === 'capabilities') {
    mod = capabilities
    handlerCtx = { params: Promise.resolve({ id: path[0] }) }
  } else if (path.length === 3 && path[1] === 'capabilities') {
    mod = capabilities
    handlerCtx = { params: Promise.resolve({ id: path[0], capabilityId: path[2] }) }
  } else {
    return notFound()
  }

  const handler = (mod as Record<string, unknown>)[method] as Handler | undefined
  if (typeof handler !== 'function') return methodNotAllowed()

  // A throw anywhere in the handler used to escape as an empty HTTP 500.
  // Map it to an honest JSON error instead (503 when the database is down,
  // 503 with a plain-words message when an API key cannot be encrypted).
  try {
    return await handler(request, handlerCtx)
  } catch (error) {
    console.error('[api/agents] Unhandled handler error:', error)
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

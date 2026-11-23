/**
 * Cheap CSRF guard for same-origin browser flows (Lane A3, ported from Lane D1).
 *
 * This build HAS session cookies, so classic CSRF applies: a state-changing
 * POST from a site the user visits could ride their session. A browser always
 * sends an `Origin` header on a POST fetch, so a POST whose Origin host differs
 * from this request's Host is a cross-site call and is refused. Requests with
 * no Origin at all (curl, server-to-server calls, webhooks, form posts from
 * non-browser clients) are left alone, so the guest flow and the public
 * trigger endpoints keep working.
 *
 * Deliberately NOT applied to the webhook / form / trigger-check
 * endpoints: those are meant to be called from outside origins.
 */
import type { NextRequest } from 'next/server'

export function isCrossOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return true // a malformed Origin is not a same-origin call
  }
  const host = request.headers.get('host') || request.nextUrl.host
  return originHost.toLowerCase() !== host.toLowerCase()
}

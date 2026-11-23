/**
 * The ONE auth helper for API handlers. Before this file, every handler
 * pasted its own copy of "read the session cookie, verifyJwt, 401 on
 * failure" — with different error shapes and, in the old verifyJwt, no
 * revocation check. Handlers should call `requireAuth()` and nothing else.
 *
 * Guest mode (2026-11-18): there is no auth gate between a visitor and the
 * product. A visitor with no session cookie is a GUEST, not an error: page
 * routes let them straight through (see src/proxy.ts) and read-only list
 * endpoints answer with empty state for them via `getOptionalAuth()`.
 * Anything that would read or change a real user's data stays login-only
 * and answers 401 with GUEST_LOGIN_REQUIRED — never with another user's
 * data, never with a shared or demo account.
 */
import { NextResponse } from 'next/server'

import { getSessionTokenFromCookies, verifyJwtSession, type JwtPayload } from '@/lib/auth/jwt'

export type AuthResult =
  | { userId: string; email: string; tokenVersion: number; payload: JwtPayload }
  | NextResponse

/** The one plain line a guest sees when a part of the product needs login. */
export const GUEST_LOGIN_REQUIRED = 'Log in to use this part.'

/** 401 carrying the guest login line. Used by every login-only route. */
export function loginRequiredResponse(): NextResponse {
  return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })
}

/** Return the authenticated user, or a ready-made 401 response. */
export async function requireAuth(): Promise<AuthResult> {
  const token = await getSessionTokenFromCookies()
  if (!token) return loginRequiredResponse()
  try {
    const payload = await verifyJwtSession(token)
    return {
      userId: payload.sub,
      email: payload.email,
      tokenVersion: payload.tokenVersion ?? 0,
      payload,
    }
  } catch {
    return loginRequiredResponse()
  }
}

/**
 * Guest-aware auth for read endpoints that can answer a visitor with empty
 * state. Returns the authenticated user, `'guest'` when there is no session
 * cookie at all, or `'invalid'` when a cookie is present but does not verify
 * (expired / tampered). Callers must treat `'invalid'` exactly like a failed
 * login — 401 — and never like a guest: a visitor whose session expired must
 * be told to log in again, not silently shown an empty workspace.
 */
export type OptionalAuth =
  | { userId: string; email: string; tokenVersion: number; payload: JwtPayload }
  | 'guest'
  | 'invalid'

export async function getOptionalAuth(): Promise<OptionalAuth> {
  const token = await getSessionTokenFromCookies()
  if (!token) return 'guest'
  try {
    const payload = await verifyJwtSession(token)
    return {
      userId: payload.sub,
      email: payload.email,
      tokenVersion: payload.tokenVersion ?? 0,
      payload,
    }
  } catch {
    return 'invalid'
  }
}

/** Same as requireAuth, for handlers that answer with a plain Response. */
export async function requireAuthUserId(): Promise<string | null> {
  const auth = await requireAuth()
  if (auth instanceof NextResponse) return null
  return auth.userId
}

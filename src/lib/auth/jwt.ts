import crypto from 'crypto'

import { cookies } from 'next/headers'

import {
  base64urlDecode,
  base64urlEncode,
  jwtIssuer,
  parseJwtParts,
  validateJwtClaims,
  type JwtClaims,
} from '@/lib/auth/jwtCore'
import { getDb } from '@/lib/mongo/mongo'

const JWT_SECRET = process.env.JWT_SECRET

export type JwtPayload = JwtClaims

export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp' | 'iss'>,
  maxAgeSeconds: number,
) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not set')

  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + maxAgeSeconds

  const header = { alg: 'HS256', typ: 'JWT' }
  const body: JwtPayload = {
    sub: payload.sub,
    email: payload.email,
    fullName: payload.fullName,
    tokenVersion: payload.tokenVersion ?? 0,
    iat,
    exp,
    iss: jwtIssuer(),
  }

  const encodedHeader = base64urlEncode(Buffer.from(JSON.stringify(header)))
  const encodedBody = base64urlEncode(Buffer.from(JSON.stringify(body)))
  const data = `${encodedHeader}.${encodedBody}`

  const signature = crypto.createHmac('sha256', JWT_SECRET).update(data).digest()
  const encodedSignature = base64urlEncode(signature)

  return `${data}.${encodedSignature}`
}

export function verifyJwt(token: string): JwtPayload {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not set')

  const { encodedHeader, encodedBody, encodedSignature, signingInput } = parseJwtParts(token)

  const expected = crypto.createHmac('sha256', JWT_SECRET).update(signingInput).digest()
  const presented = base64urlDecode(encodedSignature)

  // timingSafeEqual throws when the buffers differ in length — a malformed
  // token must be "invalid signature", not a 500.
  if (expected.length !== presented.length || !crypto.timingSafeEqual(expected, presented)) {
    throw new Error('Invalid token signature')
  }

  return validateJwtClaims(encodedHeader, encodedBody)
}

/**
 * Verify a session token AND its revocation state: the token's
 * `tokenVersion` must match the user's current `tokenVersion` in MongoDB.
 * Changing or resetting a password bumps the version, so every session
 * issued before the change stops working. Users created before token
 * versions existed have no field, which counts as version 0 — the same
 * version their old tokens carry.
 */
export async function verifyJwtSession(token: string): Promise<JwtPayload> {
  const payload = verifyJwt(token)
  const db = await getDb()
  const { ObjectId } = await import('mongodb')
  const id = ObjectId.isValid(payload.sub) ? new ObjectId(payload.sub) : payload.sub
  const user = await db.collection('users').findOne({ _id: id as never })
  if (!user) throw new Error('Invalid session')
  const currentVersion = typeof user.tokenVersion === 'number' ? user.tokenVersion : 0
  const tokenVersion = payload.tokenVersion ?? 0
  if (tokenVersion !== currentVersion) throw new Error('Session revoked — sign in again')
  if (user.passwordChangedAt) {
    const changedAt = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000)
    if (payload.iat < changedAt) throw new Error('Session revoked — sign in again')
  }
  return payload
}

export const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'agentflow_session'

/**
 * Session lifetime in seconds.
 *
 * This MUST be passed to `signJwt()` for every session we mint AND used as the
 * cookie's `maxAge`. If the cookie outlives the JWT the browser keeps sending a
 * dead token (every request 401s / redirects to login). If the cookie expires
 * first — which is what happened before: cookie = 1h, JWT = 7d — the browser
 * silently drops it mid-session, so a page that is already open renders fine
 * but every subsequent API call fails with a real 401.
 */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7

export async function getSessionTokenFromCookies() {
  const cookieStore = await cookies()
  return cookieStore.get(SESSION_COOKIE)?.value
}

export async function setSessionToken(token: string) {
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    // Must equal the `maxAgeSeconds` used when signing — see SESSION_MAX_AGE.
    maxAge: SESSION_MAX_AGE,
  })
}

export async function clearSessionToken() {
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE)
}

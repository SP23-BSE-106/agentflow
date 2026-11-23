/**
 * JWT stand-in used ONLY by the n8n tests (tests/n8n).
 * `getSessionTokenFromCookies` returns the token the current case sets
 * with __setToken (default: 'tok-user-a'); `verifyJwt` and
 * `verifyJwtSession` accept 'tok-user-a' as user-a and 'tok-user-b' as
 * user-b, and reject anything else — so route cases can test both the
 * happy path and the 401 path. `verifyJwtSession` mirrors the real one
 * (revocation-aware session check); the fake has no user rows, so it
 * accepts the same test tokens as `verifyJwt`.
 */
'use strict'

let token = 'tok-user-a'

async function getSessionTokenFromCookies() {
  return token
}

function verifyJwt(value) {
  if (value === 'tok-user-a') return { sub: 'user-a', email: 'a@example.com' }
  if (value === 'tok-user-b') return { sub: 'user-b', email: 'b@example.com' }
  throw new Error('Invalid token')
}

async function verifyJwtSession(value) {
  return verifyJwt(value)
}

function __setToken(value) {
  token = value
}

function __reset() {
  token = 'tok-user-a'
}

module.exports = { getSessionTokenFromCookies, verifyJwt, verifyJwtSession, __setToken, __reset }

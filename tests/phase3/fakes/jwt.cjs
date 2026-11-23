/**
 * Session stand-in used ONLY by the Phase 3 tests (tests/phase3).
 * The JWT itself is not under test here; the handlers' user-scoping is.
 * getSessionTokenFromCookies returns whichever test token the case set;
 * verifyJwt maps that token to a fixed user id, and throws for anything else.
 * Subjects are real 24-hex ObjectId strings because product code calls
 * new ObjectId(payload.sub).
 */
'use strict'

const USER_A_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const USER_B_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb'

let currentToken = null

const TOKENS = {
  'tok-user-a': { sub: USER_A_ID, email: 'a@example.com' },
  'tok-user-b': { sub: USER_B_ID, email: 'b@example.com' },
}

async function getSessionTokenFromCookies() {
  return currentToken
}

function verifyJwt(token) {
  const payload = TOKENS[token]
  if (!payload) throw new Error('Invalid session')
  return payload
}

// requireAuth (src/lib/auth/session.ts) calls verifyJwtSession, the async
// verifier from src/lib/auth/jwt.ts. Same token map, same claims shape
// (sub/email/tokenVersion) as the real one.
async function verifyJwtSession(token) {
  const payload = TOKENS[token]
  if (!payload) throw new Error('Invalid session')
  return { ...payload, tokenVersion: 0, iat: 0, exp: 9999999999, iss: 'agentflow' }
}

function __setToken(token) {
  currentToken = token
}

function __reset() {
  currentToken = null
}

module.exports = { getSessionTokenFromCookies, verifyJwt, verifyJwtSession, __setToken, __reset, USER_A_ID, USER_B_ID }

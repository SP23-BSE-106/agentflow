/* Phase 2 unit checks: JWT claim rules, SSRF allowlist, input caps, run-status mapping.
 *   npm run test:phase2   (tsc -p tests/phase2/tsconfig.json && node tests/phase2/out/tests/phase2/test.js)
 * Pure functions only — no database, no network, no secrets.
 */
import { base64urlEncode, validateJwtClaims } from '../../src/lib/auth/jwtCore'
import { isPrivateIp } from '../../src/lib/ssrf'
import { isTooLong, lengthError, MAX_INPUT_CHARS } from '../../src/lib/inputLimits'
import { mapRunStatus } from '../../src/lib/runs/status'

let pass = 0
const failures: string[] = []

function t(name: string, fn: () => void) {
  try {
    fn()
    pass += 1
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : String(err)}`)
  }
}

function eq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}

function throws(fn: () => unknown, what: string) {
  try {
    fn()
  } catch {
    return
  }
  throw new Error(`${what}: expected a throw, got none`)
}

function makeToken(header: Record<string, unknown>, body: Record<string, unknown>): { h: string; b: string } {
  return {
    h: base64urlEncode(Buffer.from(JSON.stringify(header))),
    b: base64urlEncode(Buffer.from(JSON.stringify(body))),
  }
}

const goodBody = { sub: 'user-1', email: 'a@b.c', iat: 1, exp: Math.floor(Date.now() / 1000) + 3600, iss: 'agentflow' }

// JWT claims
t('jwt: valid claims pass', () => {
  const { h, b } = makeToken({ alg: 'HS256', typ: 'JWT' }, goodBody)
  eq(validateJwtClaims(h, b).sub, 'user-1', 'sub')
})
t('jwt: alg none is rejected', () => {
  const { h, b } = makeToken({ alg: 'none' }, goodBody)
  throws(() => validateJwtClaims(h, b), 'alg none')
})
t('jwt: missing exp is rejected', () => {
  const { exp, ...rest } = goodBody
  void exp
  const { h, b } = makeToken({ alg: 'HS256' }, rest)
  throws(() => validateJwtClaims(h, b), 'missing exp')
})
t('jwt: expired token is rejected', () => {
  const { h, b } = makeToken({ alg: 'HS256' }, { ...goodBody, exp: 1 })
  throws(() => validateJwtClaims(h, b), 'expired')
})
t('jwt: missing sub is rejected', () => {
  const { sub, ...rest } = goodBody
  void sub
  const { h, b } = makeToken({ alg: 'HS256' }, rest)
  throws(() => validateJwtClaims(h, b), 'missing sub')
})
t('jwt: wrong issuer is rejected', () => {
  const { h, b } = makeToken({ alg: 'HS256' }, { ...goodBody, iss: 'other' })
  throws(() => validateJwtClaims(h, b), 'wrong issuer')
})

// SSRF allowlist
t('ssrf: loopback is private', () => eq(isPrivateIp('127.0.0.1'), true, '127.0.0.1'))
t('ssrf: RFC1918 is private', () => {
  eq(isPrivateIp('10.0.0.5'), true, '10/8')
  eq(isPrivateIp('172.16.0.1'), true, '172.16/12')
  eq(isPrivateIp('192.168.1.1'), true, '192.168/16')
})
t('ssrf: link-local is private', () => eq(isPrivateIp('169.254.169.254'), true, '169.254 (cloud metadata)'))
t('ssrf: IPv6 loopback and ULA are private', () => {
  eq(isPrivateIp('::1'), true, '::1')
  eq(isPrivateIp('fc00::1'), true, 'fc00::/7')
  eq(isPrivateIp('fe80::1'), true, 'fe80::/10')
})
t('ssrf: public IPs are allowed', () => {
  eq(isPrivateIp('8.8.8.8'), false, '8.8.8.8')
  eq(isPrivateIp('1.1.1.1'), false, '1.1.1.1')
})

// Input caps
t('caps: over-long input is too long', () => eq(isTooLong('x'.repeat(MAX_INPUT_CHARS + 1), MAX_INPUT_CHARS), true, 'over cap'))
t('caps: at-cap input is fine', () => eq(isTooLong('x'.repeat(MAX_INPUT_CHARS), MAX_INPUT_CHARS), false, 'at cap'))
t('caps: over-long field is a 413', () => eq(lengthError('input', MAX_INPUT_CHARS).status, 413, 'status'))

// Run-status mapping (analytics counts only real successes)
t('runs: only success/completed count as success', () => {
  eq(mapRunStatus('success'), 'success', 'success')
  eq(mapRunStatus('completed'), 'success', 'completed')
})
t('runs: running/paused/queued are in progress, not successes', () => {
  eq(mapRunStatus('running'), 'in-progress', 'running')
  eq(mapRunStatus('paused'), 'in-progress', 'paused')
  eq(mapRunStatus('queued'), 'in-progress', 'queued')
})
t('runs: cancelled is cancelled, failed is failed', () => {
  eq(mapRunStatus('cancelled'), 'cancelled', 'cancelled')
  eq(mapRunStatus('failed'), 'failed', 'failed')
})
t('runs: unknown status is in progress, never success', () => eq(mapRunStatus('weird'), 'in-progress', 'unknown'))

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)

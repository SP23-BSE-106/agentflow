/**
 * Shared JWT claim logic — the ONE place that knows what a valid AgentFlow
 * token looks like. Both verifiers use it:
 *  - src/lib/auth/jwt.ts (Node, HMAC with node:crypto)
 *  - src/proxy.ts (Edge, HMAC with WebCrypto)
 * The signature algorithm differs by runtime; the claim rules must not.
 * Pure functions only — no node:crypto, no process.env reads at import time
 * beyond the issuer helper, so the Edge runtime can import this file.
 */

export type JwtClaims = {
  sub: string
  email: string
  fullName?: string
  iat: number
  exp: number
  iss: string
  /** Bumped on every password change/reset; stale tokens are rejected. */
  tokenVersion?: number
}

export function jwtIssuer(): string {
  return process.env.JWT_ISSUER || 'agentflow'
}

export function base64urlEncode(input: Uint8Array | Buffer): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

export function base64urlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  return Buffer.from(normalized + pad, 'base64')
}

/** Split a compact JWT into its three parts. Throws on a malformed token. */
export function parseJwtParts(token: string): {
  encodedHeader: string
  encodedBody: string
  encodedSignature: string
  signingInput: string
} {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid token')
  const [encodedHeader, encodedBody, encodedSignature] = parts
  if (!encodedHeader || !encodedBody || !encodedSignature) throw new Error('Invalid token')
  return { encodedHeader, encodedBody, encodedSignature, signingInput: `${encodedHeader}.${encodedBody}` }
}

/**
 * Validate the header and payload claims of an already signature-checked
 * token. Throws on: wrong alg, missing/non-string sub, wrong issuer,
 * missing/non-numeric exp, expired token.
 */
export function validateJwtClaims(
  encodedHeader: string,
  encodedBody: string,
  issuer: string = jwtIssuer(),
): JwtClaims {
  let header: { alg?: unknown }
  let body: JwtClaims
  try {
    header = JSON.parse(base64urlDecode(encodedHeader).toString('utf8')) as { alg?: unknown }
    body = JSON.parse(base64urlDecode(encodedBody).toString('utf8')) as JwtClaims
  } catch {
    throw new Error('Invalid token')
  }
  if (header.alg !== 'HS256') throw new Error('Invalid token algorithm')
  if (typeof body.sub !== 'string' || !body.sub) throw new Error('Invalid token subject')
  if (body.iss !== issuer) throw new Error('Invalid token issuer')
  if (typeof body.exp !== 'number' || !Number.isFinite(body.exp)) {
    throw new Error('Invalid token expiry')
  }
  if (Math.floor(Date.now() / 1000) >= body.exp) throw new Error('Token expired')
  return body
}

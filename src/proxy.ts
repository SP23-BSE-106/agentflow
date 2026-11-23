import { NextRequest, NextResponse } from 'next/server'
import { jwtIssuer, parseJwtParts, validateJwtClaims } from '@/lib/auth/jwtCore'

// ─── Edge-compatible JWT verification ────────────────────────────────────────
// The signature check needs WebCrypto (node:crypto is unavailable on the
// Edge Runtime), but the claim rules live in one place only:
// src/lib/auth/jwtCore.ts, shared with src/lib/auth/jwt.ts. Any claim added
// to one verifier (alg, sub, exp, tokenVersion) is checked by both.

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'agentflow_session'

const JWT_SECRET = process.env.JWT_SECRET

function fromBase64url(input: string): Uint8Array {
  input = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  const binary = atob(input + pad)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

async function verifyJwtEdge(token: string): Promise<boolean> {
  try {
    if (!JWT_SECRET) return false

    const { encodedHeader, encodedBody, encodedSignature, signingInput } = parseJwtParts(token)

    const keyData = new TextEncoder().encode(JWT_SECRET)
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )

    const signature = fromBase64url(encodedSignature)
    const data = new TextEncoder().encode(signingInput)
    const signatureBuffer = signature.buffer.slice(
      signature.byteOffset,
      signature.byteOffset + signature.byteLength,
    ) as ArrayBuffer

    const valid = await crypto.subtle.verify('HMAC', key, signatureBuffer, data)
    if (!valid) return false

    // Claim rules (alg, sub, issuer, exp) are shared with the Node verifier.
    validateJwtClaims(encodedHeader, encodedBody, jwtIssuer())
    return true
  } catch {
    return false
  }
}

// ─── Guest mode (2026-11-18) ─────────────────────────────────────────────────
// There is NO auth gate between a visitor and the product: /dashboard,
// /workflow-builder and /testing-sandbox are open to guests, who use the
// product with no login redirect and no signup prompt. Login stays available
// as a small link for existing accounts.
//
// This proxy therefore never redirects. Its only job is hygiene: a session
// cookie that no longer verifies (expired / tampered) is cleared so the
// visitor continues as a clean guest instead of carrying a dead token.
// Every API route still verifies the session itself before touching a real
// user's data — a guest gets empty state or a 401 with "Log in to use this
// part.", never another user's data. No auth code was deleted: signup/login
// handlers, JWT/session code and the whole auth system stay in the tree.

export async function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value

  if (token) {
    const valid = await verifyJwtEdge(token)
    if (!valid) {
      // Dead token → clear it and continue as a guest, no redirect.
      const response = NextResponse.next()
      response.cookies.delete(SESSION_COOKIE)
      return response
    }
  }

  // No token, or a valid one — either way the request goes through.
  // Logged-in users are unaffected; guests browse as guests.
  return NextResponse.next()
}

// Tell Next.js which routes the proxy should run on.
// Using a broad matcher and then doing the filtering above ourselves
// gives us full, readable control over the logic.
export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     * - _next/static  (static files)
     * - _next/image   (image optimization)
     * - favicon.ico
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}

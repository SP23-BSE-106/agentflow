import { NextRequest, NextResponse } from 'next/server'

import { parseAgentKey } from '@/lib/byok'
import { chatCompletion } from '@/lib/llm'
import { getClientIp, rateLimit } from '@/lib/rateLimit'
import { getOptionalAuth, loginRequiredResponse } from '@/lib/auth/session'

// Guests may test a key without an account, with the same limit as guest
// generation: 10 tests per hour per IP.
const LLM_TEST_WINDOW_MS = 60 * 60 * 1000
const LLM_TEST_MAX = 10

/**
 * POST /api/settings/llm-test
 *
 * Tests one caller-supplied provider key with a single tiny call. The
 * request body IS the key ({provider, key, model?, baseUrl?}) — nothing
 * else. Guests are allowed; an expired session is a 401, never a silent
 * guest test. The key is never echoed back or logged.
 */
export async function POST(request: NextRequest) {
  // ── Auth (optional) ─────────────────────────────────────────────────────
  const auth = await getOptionalAuth()
  if (auth === 'invalid') return loginRequiredResponse()

  // ── Parse + validate the key ────────────────────────────────────────────
  const body = await request.json().catch(() => null)
  const agentKey = parseAgentKey(body)
  if (!agentKey) {
    return NextResponse.json(
      { ok: false, error: 'That key does not look right. Check the provider and key and try again.' },
      { status: 400 },
    )
  }

  // ── Rate limit ──────────────────────────────────────────────────────────
  // x-forwarded-for is client-controlled, so it is never trusted on its
  // own — getClientIp returns the shared 'direct' bucket unless a trusted
  // proxy count is configured (see rateLimit.ts). A spoofed header must
  // not rotate this LLM-spending endpoint into a fresh bucket.
  const ip = getClientIp(request)
  const rl = await rateLimit(`llm-test:${ip}`, { windowMs: LLM_TEST_WINDOW_MS, max: LLM_TEST_MAX })
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: 'Too many key tests from this address. Please try again later.', retryAfterMs: rl.retryAfterMs },
      { status: 429 },
    )
  }

  // ── One tiny call ───────────────────────────────────────────────────────
  // 300 tokens, not 10: reasoning models (Kimi K3.1 Pro) spend their first
  // tokens thinking, and with only 10 the answer comes back empty even
  // though the call succeeded. Still one short call.
  const completion = await chatCompletion({
    system: 'You are a helpful assistant.',
    prompt: 'Say hi',
    maxTokens: 300,
    agentKey,
  })

  if (!completion.ok) {
    const reason = completion.failures?.[0]?.message || 'The provider did not answer.'
    return NextResponse.json({ ok: false, error: reason }, { status: 502 })
  }

  return NextResponse.json({ ok: true, provider: completion.provider, model: completion.model })
}

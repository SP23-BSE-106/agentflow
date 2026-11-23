import { NextRequest, NextResponse } from 'next/server'

import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { parseAgentKey } from '@/lib/byok'
import { chatCompletion } from '@/lib/llm'
import { loadFirstStoredAgentKey } from '@/lib/storedProviderKey'
import type { WorkflowGraph } from '@/lib/mongo/workflow'
import { validateGeneratedWorkflow, expandCompactWorkflow, GENERATE_MAX_TOKENS, GENERATE_SYSTEM_PROMPT } from '@/lib/workflow/generate'
import { MAX_PROMPT_CHARS, isTooLong, lengthError } from '@/lib/inputLimits'
import { rateLimit, getClientIp } from '@/lib/rateLimit'
import { WORKFLOW_TEMPLATES } from '@/lib/workflow/templates'

// Guests (no account) may generate, with a tighter limit than signed-in
// users: 10 generations per hour per IP, enforced with the shared
// Mongo-backed limiter (same helper the auth and contact routes use).
const GUEST_GENERATE_WINDOW_MS = 60 * 60 * 1000
const GUEST_GENERATE_MAX = 10

// ─── Dev-mode mock ───────────────────────────────────────────────────────────
// Used automatically when NEXT_PUBLIC_MOCK_LLM=true OR when the inference
// server is unreachable in development (NODE_ENV !== 'production').

function buildMockWorkflow(prompt: string): WorkflowGraph {
  const lower = prompt.toLowerCase()
  const scored = WORKFLOW_TEMPLATES.map((template) => ({
    template,
    score: template.keywords.reduce((total, keyword) => total + (lower.includes(keyword) ? 2 : 0), 0),
  })).sort((a, b) => b.score - a.score)

  const selected = scored[0]?.template ?? WORKFLOW_TEMPLATES[0]

  const agentName = prompt
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ') + ' Agent'

  // Copy the template graph so the caller receives a fresh object and the
  // shared template stays immutable.
  const graph = JSON.parse(JSON.stringify(selected.graph)) as WorkflowGraph
  const customName = agentName.trim() || selected.name
  return {
    // @ts-expect-error — name/description are extra convenience fields
    name: customName,
    description: `Generated from the "${selected.name}" pattern for: "${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}".`,
    nodes: graph.nodes,
    edges: graph.edges,
  }
}

function fallbackWorkflowResponse(prompt: string, reason: string) {
  return NextResponse.json({ workflow: buildMockWorkflow(prompt), _mock: true, source: 'template' as const, warning: reason })
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // ── Auth (optional) ─────────────────────────────────────────────────────
  // Guests may generate without an account. A valid session token marks the
  // caller as signed in (no guest limit). No token at all means guest — but
  // a token that is PRESENT and does not verify (expired, tampered, or
  // revoked by a password change) is a 401, never a silent downgrade to
  // guest: a revoked session must not keep generating as a guest.
  let signedIn = false
  let userId: string | undefined
  const token = await getSessionTokenFromCookies()
  if (token) {
    try {
      userId = (await verifyJwtSession(token)).sub
      signedIn = true
    } catch {
      return NextResponse.json(
        { error: 'Session expired or revoked — log in again.' },
        { status: 401 },
      )
    }
  }

  // ── Parse body ───────────────────────────────────────────────────────────
  const body = await request.json().catch(() => null)
  const prompt: string = body?.prompt ?? ''

  if (!prompt.trim()) {
    return NextResponse.json(
      { error: 'prompt is required' },
      { status: 400 },
    )
  }
  if (isTooLong(prompt, MAX_PROMPT_CHARS)) {
    const err = lengthError('prompt', MAX_PROMPT_CHARS)
    return NextResponse.json({ error: err.error }, { status: err.status })
  }

  // A caller may bring their own provider key. It is validated here and
  // passed straight to the shared chain as the caller's key only.
  let callerKey = body?.agentKey === undefined ? undefined : (parseAgentKey(body.agentKey) ?? undefined)
  if (body?.agentKey !== undefined && !callerKey) {
    return NextResponse.json(
      { error: 'That key does not look right. Check the provider and key and try again.' },
      { status: 400 },
    )
  }

  // Signed in with no caller key: fall back to the first key the user
  // stored for any provider, in preset order. Precedence: caller key >
  // user's stored provider key > env keys (generate has no agent, so the
  // agent's saved key does not apply here).
  if (!callerKey && signedIn && userId) {
    callerKey = (await loadFirstStoredAgentKey(userId)) ?? undefined
  }

  // ── Guest rate limit ────────────────────────────────────────────────────
  // Same prompt limits as signed-in users above; guests additionally get
  // 10 generations per hour per IP so one address cannot burn the LLM budget.
  if (!signedIn) {
    // x-forwarded-for is client-controlled, so it is never trusted on its
    // own — getClientIp returns the shared 'direct' bucket unless a trusted
    // proxy count is configured (see rateLimit.ts). A spoofed header must
    // not rotate this LLM-spending endpoint into a fresh bucket.
    const ip = getClientIp(request)
    const rl = await rateLimit(`guest:generate:${ip}`, { windowMs: GUEST_GENERATE_WINDOW_MS, max: GUEST_GENERATE_MAX })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many generations from this address. Please try again later.', retryAfterMs: rl.retryAfterMs },
        { status: 429 },
      )
    }
  }

  const useMock =
    process.env.NEXT_PUBLIC_MOCK_LLM === 'true' ||
    process.env.MOCK_LLM === 'true'

  // ── Dev mock path ────────────────────────────────────────────────────────
  if (useMock) {
    // Simulate model thinking time
    await new Promise((r) => setTimeout(r, 2500))
    return NextResponse.json({ workflow: buildMockWorkflow(prompt), _mock: true, source: 'template' as const })
  }

  // ── Inference via the single shared chain (src/lib/llm.ts) ─────────────
  // The provider list used to live inline here with different model strings
  // from the shared chain and different timeouts; it has drifted once
  // already, so it is deleted. One chain, one place to change a model. The
  // chain's own deadline keeps this inside the route's 60s budget.
  // The system prompt and token budget live in src/lib/workflow/generate.ts
  // (H11): a compact node schema (short ids, no per-node name/description,
  // edges as [source, target] pairs) and GENERATE_MAX_TOKENS = 256, so the
  // whole workflow JSON fits inside the ~300 tokens the shared OpenRouter
  // key could still afford at QA-sweep end — the old 1200-token request
  // 402-retried to ~325 tokens and truncated mid-JSON every time.
  const systemPrompt = GENERATE_SYSTEM_PROMPT

  const completion = await chatCompletion({
    system: systemPrompt,
    prompt,
    maxTokens: GENERATE_MAX_TOKENS,
    temperature: 0.7,
    agentKey: callerKey,
  })

  if (!completion.ok) {
    const reason = completion.failures?.map((f) => `${f.provider}: ${f.message}`).join('; ') || 'All endpoints unavailable'
    console.warn('[generate] All inference endpoints failed — using fallback workflow.', reason)
    return fallbackWorkflowResponse(prompt, reason)
  }

  let workflow = null;
  try {
    const content = completion.text || "";
    const cleanContent = content.replace(/^\s*```json/mi, '').replace(/```\s*$/m, '').trim();
    const parsed = JSON.parse(cleanContent);
    const expanded = expandCompactWorkflow(parsed);
    if ('error' in expanded) {
      console.warn('[generate] AI workflow failed expansion — using fallback workflow.', expanded.error)
      return fallbackWorkflowResponse(prompt, expanded.error)
    }
    workflow = expanded.workflow;
  } catch (e) {
    console.warn('Failed to parse API response — using fallback workflow.', e)
    return fallbackWorkflowResponse(prompt, 'invalid response payload')
  }

  if (!workflow || typeof workflow !== 'object') {
    console.warn('Inference server returned an invalid workflow payload — using fallback workflow.')
    return fallbackWorkflowResponse(prompt, 'invalid workflow payload')
  }

  // The model is only told the node shape — it can still return a workflow
  // that cannot run (e.g. a condition node with no condition). The same
  // check the save path enforces runs here, plus the GAP-3 rag rule: a
  // document question whose AI workflow has no `rag` node is rejected.
  // Either way a broken AI workflow never reaches the user as source 'ai':
  // it falls back to the template with the reason, exactly like a failed
  // inference does.
  const graphError = validateGeneratedWorkflow(workflow, prompt)
  if (graphError) {
    console.warn('[generate] AI workflow failed validation — using fallback workflow.', graphError)
    return fallbackWorkflowResponse(prompt, graphError)
  }

  return NextResponse.json({ workflow, source: 'ai' as const })
}

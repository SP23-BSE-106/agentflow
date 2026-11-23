/**
 * One place that knows how to reach the configured inference providers.
 *
 * The provider list used to live inline in the RAG chat handler and again in
 * the workflow generator, so changing a model meant editing two files — and
 * the public `/api/execute` endpoint had no model access at all, which is why
 * it could only answer with a canned "Workflow executed".
 *
 * Providers come from the BYOK preset registry (`./llmProviders`): one list
 * drives the UI selector AND this chain. Every preset is OpenAI-shaped
 * except Anthropic, which uses its native Messages API (`x-api-key`,
 * `anthropic-version`, `system` separate, answer at `content[0].text`).
 *
 * Keys are never logged — not on their own, not inside a request body, and
 * not as part of an endpoint URL.
 */

import { LLM_PROVIDERS, getProviderPreset, type LlmProviderPreset } from './llmProviders'

export type InferenceEndpoint = {
  url: string
  key: string | undefined
  model: string
  name: string
  kind: 'openai' | 'anthropic'
  /** Caller-supplied base URL, only for `custom` agent-key endpoints. */
  baseUrl?: string
  /** Per-attempt timeout for this endpoint, in ms. Defaults to the chain's
   *  12s cap when unset (see PER_PROVIDER_TIMEOUT_MS). */
  timeoutMs?: number
}

export type InferenceFailure = {
  provider: string
  status?: number
  message: string
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

/** First set variable wins (e.g. Moonshot tries MOONSHOT_API_KEY, then KIMI_API_KEY). */
function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = readEnv(name)
    if (value) return value
  }
  return undefined
}

/** Kept model overrides for the providers that had them before the registry. */
const MODEL_ENV_VARS: Record<string, string> = {
  openrouter: 'OPENROUTER_MODEL',
  nvidia: 'NVIDIA_MODEL',
  huggingface: 'HF_MODEL',
  google: 'GOOGLE_MODEL',
}

/**
 * The chain, in registry order: OpenRouter, NVIDIA, Hugging Face, Moonshot,
 * then Google, OpenAI, Groq, Anthropic, Cohere. Moonshot is listed only when
 * a key exists (its old behaviour); the rest are listed always and the chain
 * skips keyless endpoints. `custom` has no endpoint or env key, so it never
 * appears here — it only runs through an agent key with a base URL.
 */
export function inferenceEndpoints(): InferenceEndpoint[] {
  const endpoints: InferenceEndpoint[] = []
  for (const preset of LLM_PROVIDERS) {
    if (!preset.endpoint) continue
    const key = firstEnv(preset.envVars)
    if (preset.id === 'moonshot' && !key) continue
    const modelEnv = MODEL_ENV_VARS[preset.id]
    const model = (modelEnv ? readEnv(modelEnv) : undefined) || preset.defaultModel
    endpoints.push({
      url: preset.endpoint,
      key,
      model,
      name: `${preset.label} (${model})`,
      kind: preset.kind,
      timeoutMs: preset.timeoutMs,
    })
  }
  return endpoints
}

export type CompletionResult = {
  text: string
  model: string | null
  provider: string | null
  ok: boolean
  failures?: InferenceFailure[]
}

/**
 * A caller-decrypted API key saved on an agent, tried before the shared
 * environment keys. `provider` is the agent's `llmProvider` value (a preset
 * id such as 'nvidia', 'google', 'anthropic', or 'custom', with aliases
 * 'gemini', 'hf', 'kimi' resolved by the registry). `model` overrides the
 * preset's default model and `baseUrl` is required for 'custom'. Only
 * providers this file knows how to reach can use a stored key; anything else
 * is reported as a failure and the environment providers are tried instead.
 * The plaintext key is never stored or logged — it lives only in this call.
 */
export type AgentKey = {
  provider: string
  key: string
  model?: string
  baseUrl?: string
}

/**
 * Fallback for stored provider strings that are not exact preset ids
 * (e.g. a legacy free-text value): match the first preset id contained in
 * the string, in registry order so 'openrouter' wins over 'openai'.
 */
function findPresetBySubstring(provider: string): LlmProviderPreset | null {
  for (const preset of LLM_PROVIDERS) {
    if (provider.includes(preset.id)) return preset
  }
  return null
}

/** The endpoint a stored agent key talks to, or null when unknown. */
export function endpointForAgentKey(agentKey: AgentKey): InferenceEndpoint | null {
  const provider = agentKey.provider.trim().toLowerCase()
  const preset = getProviderPreset(provider) ?? findPresetBySubstring(provider)
  if (!preset) return null

  if (preset.id === 'custom') {
    // A custom key with no base URL has nowhere to send the request.
    const baseUrl = agentKey.baseUrl?.trim().replace(/\/+$/, '')
    if (!baseUrl) return null
    const model = agentKey.model?.trim() || ''
    return {
      url: `${baseUrl}/chat/completions`,
      key: agentKey.key,
      model,
      name: model ? `${preset.label} (${model})` : preset.label,
      kind: 'openai',
      baseUrl,
    }
  }

  const model = agentKey.model?.trim() || preset.defaultModel
  return {
    url: preset.endpoint,
    key: agentKey.key,
    model,
    name: `${preset.label} (${model})`,
    kind: preset.kind,
    timeoutMs: preset.timeoutMs,
  }
}
/**
 * Overall deadline for one chatCompletion call, across all providers.
 * Routes that call this live inside a 60s serverless budget, so the whole
 * chain must finish well inside it — 48s leaves room for the caller to write
 * its response. Per-provider attempts are capped at 12s each, except a
 * preset's own timeoutMs (NVIDIA: 30s — Kimi K3.1 Pro is a reasoning model
 * and warm calls take ~7-15s); the 48s deadline still caps the whole chain.
 */
export const CHAIN_DEADLINE_MS = 48_000
export const PER_PROVIDER_TIMEOUT_MS = 12_000

type BuiltRequest = {
  headers: Record<string, string>
  body: string
}

/** Headers + body for one attempt, shaped by the endpoint's kind. */
function buildRequest(
  endpoint: InferenceEndpoint,
  attemptModel: string,
  system: string,
  prompt: string,
  maxTokens: number,
  temperature: number,
): BuiltRequest {
  if (endpoint.kind === 'anthropic') {
    return {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': endpoint.key ?? '',
        'anthropic-version': '2023-06-01',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: attemptModel,
        system,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
      }),
    }
  }
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${endpoint.key}`,
      Accept: 'application/json',
      ...(endpoint.url.includes('openrouter.ai')
        ? {
            'HTTP-Referer': readEnv('OPENROUTER_SITE_URL') || 'http://localhost:3000',
            'X-Title': readEnv('OPENROUTER_SITE_NAME') || 'AgentFlow',
          }
        : {}),
    },
    body: JSON.stringify({
      model: attemptModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens,
      temperature,
      top_p: 0.95,
      stream: false,
    }),
  }
}

/** The answer text out of a provider's JSON, or null when there is none. */
function extractText(endpoint: InferenceEndpoint, data: unknown): string | null {
  if (endpoint.kind === 'anthropic') {
    const content = (data as { content?: unknown })?.content
    const blocks = Array.isArray(content) ? content : []
    const textBlock = blocks.find(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    return textBlock?.text ?? null
  }
  const text = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
    ?.message?.content
  return typeof text === 'string' ? text : null
}

/**
 * A provider's rejection, readably. OpenRouter returns error as an OBJECT
 * {message, code}; taking it verbatim stringified the failure as
 * "[object Object]" and hid the real reason (e.g. a 402 for exhausted
 * credits). Anthropic errors are {error:{type, message}} — the same object
 * shape, so the same parse takes the message string.
 */
export function parseErrorMessage(body: string, response: Response): string {
  let message = body.slice(0, 300).replace(/\s+/g, ' ').trim()
  try {
    const parsed = JSON.parse(body) as
      | {
          error?: string | { message?: string; code?: string }
          message?: string
          detail?: string
        }
      | Array<{
          error?: string | { message?: string; code?: string }
          message?: string
          detail?: string
        }>
    // Some providers (Google's OpenAI-compatible endpoint) wrap the error
    // in a one-element array; without this the raw "[{...}]" blob leaks
    // through to the user as the failure message.
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    const errText = typeof first?.error === 'object' ? first.error?.message : first?.error
    message = errText || first?.message || first?.detail || message
  } catch {
    // Keep the bounded response text for non-JSON provider errors.
  }
  return message || response.statusText || 'Provider rejected the request.'
}

/**
 * What a provider says it can still afford, read from its own rejection.
 * OpenRouter 402s a nearly-empty key with "You requested up to 1200 tokens,
 * but can only afford 1042." — the number is the token budget the key can
 * still cover. Returns null when the message carries no such number, so
 * callers never guess a budget.
 */
export function parseAffordableTokens(message: string): number | null {
  const match = /can only afford[^0-9]*([0-9][0-9,]*)/i.exec(message)
  if (!match) return null
  const value = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Runs one completion, walking the provider list until one accepts the request.
 *
 * Never throws and never returns a partial success: callers get `ok: false`
 * and decide how to phrase the failure, so a dead provider can't be mistaken
 * for a real answer.
 *
 * Budget: the whole chain aborts at CHAIN_DEADLINE_MS (48s) and no single
 * provider attempt runs longer than its cap — 12s by default, or the
 * preset's own timeoutMs when one is set (NVIDIA: 30s) — so the chain can
 * never outlive the 60s route budget that contains it. A provider that
 * 402s with an affordable-token count gets ONE retry at that smaller
 * budget (see parseAffordableTokens) — the key is nearly out of credits
 * and the provider itself says what it can still afford. `model`, when set (e.g. from a node's config), overrides the model string for every
 * provider attempt; a provider that rejects the override just falls through
 * to the next one.
 */
export async function chatCompletion(options: {
  system: string
  prompt: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  agentKey?: AgentKey
  /** Pin the call to one configured model (from a node's saved config). */
  model?: string
}): Promise<CompletionResult> {
  const { system, prompt, maxTokens = 1024, temperature = 0.4, timeoutMs = PER_PROVIDER_TIMEOUT_MS, model, agentKey } = options
  const failures: InferenceFailure[] = []
  const deadline = Date.now() + CHAIN_DEADLINE_MS

  let endpoints = inferenceEndpoints()
  if (model) {
    endpoints = endpoints.filter((endpoint) => endpoint.model === model)
    if (endpoints.length === 0) {
      // Do not silently fall back to another model: the user picked this one.
      return {
        text: '',
        model: null,
        provider: null,
        ok: false,
        failures: [{ provider: 'model', message: `Model ${model} is not configured. Set its provider key first.` }],
      }
    }
  }
  if (agentKey?.key) {
    const agentEndpoint = endpointForAgentKey(agentKey)
    if (agentEndpoint) {
      // The agent's own key is tried first — unless a model is pinned and
      // this key's endpoint is a different model; a pin is never overridden.
      if (!model || agentEndpoint.model === model) {
        endpoints.unshift(agentEndpoint)
      } else {
        failures.push({
          provider: `agent key (${agentKey.provider || 'unknown provider'})`,
          message: `The agent key is for model ${agentEndpoint.model}, not the pinned model ${model}; using shared providers instead.`,
        })
      }
    } else {
      failures.push({
        provider: `agent key (${agentKey.provider || 'unknown provider'})`,
        message: 'No matching inference endpoint for this provider; using shared providers instead.',
      })
    }
  }

  for (const endpoint of endpoints) {
    if (!endpoint.key) {
      failures.push({ provider: endpoint.name, message: 'API key is not configured.' })
      continue
    }
    const attemptModel = model?.trim() ? model.trim() : endpoint.model

    // A provider that 402s with an affordable-token count gets ONE retry at
    // the smaller budget — the key is nearly out of credits, and the provider
    // itself says what it can still afford. Bounded to one retry per
    // provider, and the retry never runs past the chain deadline.
    let attemptTokens = maxTokens
    let retriedForBudget = false
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        failures.push({ provider: 'chain', message: `Inference deadline of ${CHAIN_DEADLINE_MS / 1000}s exceeded before all providers were tried.` })
        break
      }
      // One attempt never runs past the chain deadline. The cap is the
      // larger of the caller's timeoutMs and the endpoint's own timeoutMs
      // (a preset floor — NVIDIA's 30s, because Kimi K3.1 Pro reasons
      // before answering and warm calls take ~7-15s). The caller's 12s
      // default must not clamp a preset that needs longer.
      const attemptTimeoutMs = Math.max(1, Math.min(Math.max(timeoutMs, endpoint.timeoutMs ?? PER_PROVIDER_TIMEOUT_MS), remaining))

      try {
        const { headers, body } = buildRequest(endpoint, attemptModel, system, prompt, attemptTokens, temperature)
        const response = await fetch(endpoint.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(attemptTimeoutMs),
        })

        if (!response.ok) {
          const responseBody = await response.text().catch(() => '')
          const message = parseErrorMessage(responseBody, response)
          failures.push({
            provider: endpoint.name,
            status: response.status,
            message,
          })
          if (!retriedForBudget && response.status === 402) {
            const affordable = parseAffordableTokens(message)
            const retryTokens = affordable === null ? null : Math.max(64, affordable - 50)
            if (retryTokens !== null && retryTokens < attemptTokens) {
              attemptTokens = retryTokens
              retriedForBudget = true
              continue
            }
          }
          break
        }

        const data = await response.json().catch(() => null)
        const text = extractText(endpoint, data)

        if (typeof text === 'string' && text.trim().length > 0) {
          return { text, model: attemptModel, provider: endpoint.name, ok: true, failures }
        }
        failures.push({ provider: endpoint.name, status: 502, message: 'Provider returned no text.' })
        break
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Timeout or transport failure — try the next provider.
        failures.push({ provider: endpoint.name, message: message.slice(0, 300) })
        break
      }
    }
    if (Date.now() >= deadline) break
  }

  return { text: '', model: null, provider: null, ok: false, failures }
}

/** True when at least one provider is actually configured in this environment. */
export function hasInferenceProvider(): boolean {
  return inferenceEndpoints().some((endpoint) => Boolean(endpoint.key))
}

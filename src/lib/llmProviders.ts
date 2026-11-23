/**
 * The BYOK preset registry — the single source of truth for provider presets.
 *
 * One list drives the UI selector (create page + Settings) AND the LLM chain
 * (src/lib/llm.ts). Never keep a second provider list anywhere: if a preset
 * is added or renamed here, both the selector and the chain follow.
 *
 * Endpoints verified 2026-11-18 against the providers' own docs:
 * - Google Gemini has an OpenAI-compatible endpoint at
 *   generativelanguage.googleapis.com/v1beta/openai/ using
 *   `Authorization: Bearer $GEMINI_API_KEY` (NOT `x-goog-api-key` on this path).
 * - Cohere's OpenAI-compatible endpoint is api.cohere.com/compatibility/v1.
 * - Groq's OpenAI-compatible endpoint is api.groq.com/openai/v1.
 * Anthropic is the ONLY preset that is not OpenAI-shaped (native Messages
 * API: `x-api-key` header, `anthropic-version`, `system` separate,
 * `max_tokens` required, answer at `content[0].text`).
 */

export type ProviderKind = 'openai' | 'anthropic'

export type LlmProviderPreset = {
  /** Stable id used in stored keys, BYOK storage, and `llmProvider`. */
  id: string
  /** Plain-English label shown in the selector. */
  label: string
  /** Request/response shape. Only Anthropic differs from the OpenAI shape. */
  kind: ProviderKind
  /** Chat-completions endpoint. Empty for `custom` — the user enters a base URL. */
  endpoint: string
  /** Model used when the user does not pick one. Empty for `custom`. */
  defaultModel: string
  /** Env var name(s) holding a shared key for this preset, in try order. */
  envVars: string[]
  /** Key-field placeholder, e.g. `sk-or-v1-...`. */
  placeholder: string
  /** Plain-words where-to-get-a-key text. */
  keyHelp: string
  /** Page where the user makes a key. */
  keyUrl: string
  /** Per-attempt timeout for this provider, in ms. Defaults to the chain's
   *  12s cap when unset. NVIDIA gets 30s: Kimi K3.1 Pro is a reasoning model
   *  and warm calls take ~7-15s. */
  timeoutMs?: number
  /** True when the preset needs a user-entered base URL (custom only). */
  needsBaseUrl?: boolean
  /** True when the preset needs a user-entered model (custom only). */
  needsModel?: boolean
}

export const LLM_PROVIDERS: LlmProviderPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'openai/gpt-4o',
    envVars: ['OPENROUTER_API_KEY'],
    placeholder: 'sk-or-v1-...',
    keyHelp: 'Make a key in your OpenRouter account, on the Keys page.',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA',
    kind: 'openai',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    // moonshotai/kimi-k3 reached end of life on 2026-10-15 (NVIDIA's own
    // answer); kimi-k3.1-pro is the live Kimi model on the same endpoint,
    // proven 2026-11-18 (answered "Damaged order" in ~15s).
    defaultModel: 'moonshotai/kimi-k3.1-pro',
    timeoutMs: 30_000,
    envVars: ['NVIDIA_API_KEY'],
    placeholder: 'nvapi-...',
    keyHelp: 'Make a key in your NVIDIA account, under API keys.',
    keyUrl: 'https://build.nvidia.com/',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    kind: 'openai',
    endpoint: 'https://router.huggingface.co/v1/chat/completions',
    defaultModel: 'moonshotai/Kimi-K3:together',
    envVars: ['HF_TOKEN'],
    placeholder: 'hf_...',
    keyHelp: 'Make a token in your Hugging Face account, under Access Tokens.',
    keyUrl: 'https://huggingface.co/settings/tokens',
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    kind: 'openai',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    defaultModel: 'moonshot-v1-8k',
    envVars: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    placeholder: 'sk-...',
    keyHelp: 'Make a key in your Moonshot AI platform account, under API Keys.',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    kind: 'openai',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    defaultModel: 'gemini-3.8-flash',
    envVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    placeholder: 'AIza...',
    keyHelp: 'Make a key in Google AI Studio, on the API keys page.',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    envVars: ['OPENAI_API_KEY'],
    placeholder: 'sk-...',
    keyHelp: 'Make a key in your OpenAI account, on the API Keys page.',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
    envVars: ['GROQ_API_KEY'],
    placeholder: 'gsk_...',
    keyHelp: 'Make a key in your Groq account, on the API Keys page.',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-5',
    envVars: ['ANTHROPIC_API_KEY'],
    placeholder: 'sk-ant-...',
    keyHelp: 'Make a key in your Anthropic account, under API Keys.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'cohere',
    label: 'Cohere',
    kind: 'openai',
    endpoint: 'https://api.cohere.com/compatibility/v1/chat/completions',
    defaultModel: 'command-a-03-2025',
    envVars: ['COHERE_API_KEY'],
    placeholder: '...',
    keyHelp: 'Make a key in your Cohere account, on the API Keys page.',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    kind: 'openai',
    endpoint: '',
    defaultModel: '',
    envVars: [],
    placeholder: 'Your key',
    keyHelp: 'Paste the web address of any service that works like OpenAI, plus your key for it.',
    keyUrl: '',
    needsBaseUrl: true,
    needsModel: true,
  },
]

/** Ids users type that mean another preset (`gemini` is Google's model name). */
const PRESET_ALIASES: Record<string, string> = {
  gemini: 'google',
  hf: 'huggingface',
  kimi: 'moonshot',
}

export function getProviderPreset(id: string): LlmProviderPreset | null {
  const key = (id || '').trim().toLowerCase()
  const resolved = PRESET_ALIASES[key] ?? key
  return LLM_PROVIDERS.find((p) => p.id === resolved) ?? null
}

/** Preset ids in the order the chain tries them and the UI lists them. */
export const PRESET_ORDER: string[] = LLM_PROVIDERS.map((p) => p.id)

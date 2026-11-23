/**
 * Bring-your-own-key (BYOK): one caller-supplied provider key, kept in the
 * browser only, sent with a request when the caller wants their own key
 * used instead of the shared providers.
 *
 * The validator in this file is pure and importable server-side, so it must
 * never touch `window` or `localStorage` at the top level — every browser
 * access is guarded by a `typeof window === 'undefined'` check.
 *
 * The full key is never logged, never echoed back, and never leaves the
 * browser except as the `agentKey` field of the request that needs it.
 */

import { getProviderPreset } from './llmProviders'

export type ByokKey = {
  provider: string
  key: string
  model?: string
  baseUrl?: string
}

const STORAGE_KEY = 'agentflow.byok.v1'

/** The most a key value may hold: long enough for any real API key. */
const MAX_KEY_CHARS = 4096
/** Provider names and model ids stay short; anything longer is a typo. */
const MAX_PROVIDER_CHARS = 64
const MAX_MODEL_CHARS = 256
const MAX_BASE_URL_CHARS = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null
}

/**
 * Validate an unknown value as a caller key. Returns the cleaned key, or
 * null when the shape is wrong:
 * - provider: a string, 1–64 characters
 * - key: a string, 1–4096 characters
 * - model / baseUrl, when present: strings of at most 256 characters
 * - baseUrl, when present: must start with 'https://'
 *
 * Extra fields are ignored. An empty model or baseUrl is dropped.
 */
export function parseAgentKey(value: unknown): ByokKey | null {
  if (!isRecord(value)) return null

  const provider = cleanString(value.provider)
  if (!provider || provider.length > MAX_PROVIDER_CHARS) return null

  const key = cleanString(value.key)
  if (!key || key.length > MAX_KEY_CHARS) return null

  const parsed: ByokKey = { provider, key }

  if (value.model !== undefined) {
    if (typeof value.model !== 'string' || value.model.length > MAX_MODEL_CHARS) return null
    const model = value.model.trim()
    if (model) parsed.model = model
  }

  if (value.baseUrl !== undefined) {
    if (typeof value.baseUrl !== 'string' || value.baseUrl.length > MAX_BASE_URL_CHARS) return null
    const baseUrl = value.baseUrl.trim()
    if (baseUrl) {
      if (!baseUrl.startsWith('https://')) return null
      parsed.baseUrl = baseUrl
    }
  }

  return parsed
}

/** Read the saved key from the browser, or null when none is saved. */
export function loadByokKey(): ByokKey | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return parseAgentKey(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Save one key in the browser, replacing any key saved before it. */
export function saveByokKey(key: ByokKey): void {
  if (typeof window === 'undefined') return
  const parsed = parseAgentKey(key)
  if (!parsed) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
  } catch {
    // Storage full or blocked: the key simply is not saved.
  }
}

/** Forget the saved key. */
export function clearByokKey(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing saved, or storage blocked — either way it is gone.
  }
}

/**
 * The safe way to show which key is saved: one plain-words line with the
 * provider name and the last four characters of the key, never the full
 * key. The UI renders this string directly as the saved-state line.
 */
export function maskedByokKey(): string | null {
  const saved = loadByokKey()
  if (!saved) return null
  const label = getProviderPreset(saved.provider)?.label ?? saved.provider
  return `${label} key saved in this browser · …${saved.key.slice(-4)}`
}

/**
 * HTTP Request node — fetches a URL for real, with the SSRF guard.
 *
 * Config:
 *   url: string (may contain `{{ }}` templates, resolved per item)
 *   method: string (default GET)
 *   headers: Record<string, string>
 *   body: string | object (sent as-is for string, JSON for object)
 *   credentials: { [credentialTypeName]: credentialId } — resolved by the
 *     item executor into `ctx.credentials` before this runs. httpBasicAuth
 *     adds a Basic Authorization header, httpHeaderAuth adds its named
 *     header, oAuth2Api adds `Bearer <accessToken>`.
 * One request runs per input item; each response becomes one item
 * `{ json: { status, headers, body } }` (body parsed as JSON when it
 * parses, else kept as text under `bodyText`). Non-2xx responses fail the
 * node honestly — they are not silently treated as data.
 *
 * SSRF: every hop (initial URL + up to 3 redirects) is fetched through
 * `fetchPinnedUrl` from `src/lib/ssrf.ts` — the hostname is resolved once
 * and the request connects to the resolved IP, private, loopback,
 * link-local and reserved addresses are refused, and the body streams
 * with an incremental 1 MiB cap and a 10 s timeout. Only GET, POST, PUT,
 * PATCH, DELETE, and HEAD are allowed.
 */

import { fetchPinnedUrl } from '@/lib/ssrf'
import { itemFromJson } from '@/lib/nodes/items'
import { renderTemplateValue } from '@/lib/expression/engine'
import { buildItemScope } from './context'
import type { NodeExecutor } from './context'

/** The only HTTP methods a workflow may issue. Anything else (TRACE,
 *  CONNECT, custom verbs) is refused — a workflow is not a raw socket. */
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])

async function fetchGuarded(
  rawUrl: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  // One shared guard for every fetch: DNS is resolved once per hop and the
  // request connects to the resolved IP, the body streams with the same
  // incremental 1 MiB cap as fetchPublicUrl, and the request is time-boxed.
  return fetchPinnedUrl(rawUrl, { method, headers, body })
}

function credentialHeaders(
  config: Record<string, unknown>,
  ctxCredentials: Map<string, Record<string, unknown>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  const refs =
    config.credentials && typeof config.credentials === 'object'
      ? (config.credentials as Record<string, string>)
      : {}
  for (const [typeName, credentialId] of Object.entries(refs)) {
    const fields = ctxCredentials?.get(credentialId)
    if (!fields) throw new Error(`HTTP node: credential "${credentialId}" (${typeName}) was not resolved.`)
    if (typeName === 'httpBasicAuth') {
      const username = String(fields.username ?? '')
      const password = String(fields.password ?? '')
      out.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    } else if (typeName === 'httpHeaderAuth') {
      const name = String(fields.name ?? '')
      const value = String(fields.value ?? '')
      if (name) out[name] = value
    } else if (typeName === 'oAuth2Api') {
      const token = String(fields.accessToken ?? '')
      if (token) out.Authorization = `Bearer ${token}`
    }
  }
  return out
}

export const executeHttpNode: NodeExecutor = async ({ config, items, ctx }) => {
  const method = (typeof config.method === 'string' ? config.method : 'GET').toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`HTTP node method "${method}" is not allowed. Use GET, POST, PUT, PATCH, DELETE, or HEAD.`)
  }
  const headerConfig =
    config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)
      ? (config.headers as Record<string, string>)
      : {}
  const out = []
  for (const item of items) {
    const scope = buildItemScope(item, items, ctx)
    const resolveString = (value: unknown): string | undefined => {
      if (typeof value !== 'string') return undefined
      const rendered = value.includes('{{') ? renderTemplateValue(value, scope) : value
      return typeof rendered === 'string' ? rendered : String(rendered ?? '')
    }
    const url = resolveString(config.url)
    if (!url) throw new Error('HTTP node needs config.url.')
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(headerConfig)) {
      const rendered = resolveString(value)
      if (rendered !== undefined) headers[key] = rendered
    }
    Object.assign(headers, credentialHeaders(config, ctx.credentials))
    let body: string | undefined
    if (config.body !== undefined) {
      if (typeof config.body === 'string') {
        body = resolveString(config.body)
      } else {
        body = JSON.stringify(config.body)
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json'
        }
      }
    }
    let response: { status: number; headers: Record<string, string>; text: string }
    try {
      response = await fetchGuarded(url, method, headers, body)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'HTTP node failed.'
      throw new Error(`HTTP node failed: ${message}`)
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP node got status ${response.status} from ${url}.`)
    }
    let parsed: unknown = null
    let parsedOk = false
    try {
      parsed = JSON.parse(response.text)
      parsedOk = true
    } catch {
      parsedOk = false
    }
    const json: Record<string, unknown> = {
      status: response.status,
      headers: response.headers,
      body: parsedOk ? parsed : response.text,
    }
    if (!parsedOk) json.bodyText = response.text
    out.push(itemFromJson(json, item.pairedItem ?? 0))
  }
  return { items: out }
}

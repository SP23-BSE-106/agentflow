/**
 * SSRF guard for API nodes: an API node URL comes from a user-built workflow,
 * so it is untrusted input. Only public http/https targets are fetched:
 * private, loopback, link-local and reserved IPs are blocked, redirects are
 * followed manually (max 3) with every hop re-checked, and the response is
 * capped in size and time.
 *
 * DNS is PINNED, not just checked: each hop resolves the hostname once, and
 * the request connects directly to that resolved IP (with the original
 * hostname kept as the Host header and, for https, as the TLS SNI name so
 * certificate verification still checks the hostname). A hostname whose DNS
 * flips between a check and a fetch — DNS rebinding — cannot redirect the
 * connection to an internal address, because the connection never
 * re-resolves.
 *
 * Loopback is REFUSED by default. It is allowed only behind the explicit
 * opt-in `ALLOW_LOOPBACK_FETCH=true` — never by `NODE_ENV`, so a
 * non-production demo server is not an open loopback proxy. Set the flag
 * only for local development / the builder end-to-end test that fetches
 * from a local server.
 */
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

export class SsrfError extends Error {}

const MAX_BYTES = 1_048_576
const MAX_REDIRECTS = 3

/** Loopback only behind an explicit opt-in flag — never by NODE_ENV. */
export function loopbackAllowed(): boolean {
  return process.env.ALLOW_LOOPBACK_FETCH === 'true'
}

// ── IP parsing ─────────────────────────────────────────────────────────

/** Expand an IPv6 literal to its eight 16-bit groups, or null if invalid. */
function expandIpv6(ip: string): number[] | null {
  let addr = ip.toLowerCase()
  let tail: number[] = []
  const v4match = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr)
  if (v4match) {
    const octets = v4match[1].split('.').map(Number)
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]]
    addr = addr.slice(0, addr.length - v4match[1].length)
    // The dotted part was separated from the hex part by ':' — drop it.
    if (addr.endsWith(':')) addr = addr.slice(0, -1)
  }
  const parseGroups = (s: string): number[] | null => {
    if (s === '') return []
    const out: number[] = []
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const parts = addr.split('::')
  if (parts.length > 2) return null
  let groups: number[]
  if (parts.length === 2) {
    const left = parseGroups(parts[0])
    const right = parseGroups(parts[1])
    if (!left || !right) return null
    const missing = 8 - tail.length - left.length - right.length
    if (missing < 0) return null
    groups = [...left, ...Array(missing).fill(0), ...right]
  } else {
    const g = parseGroups(parts[0])
    if (!g) return null
    groups = g
  }
  groups = [...groups, ...tail]
  if (groups.length !== 8) return null
  return groups
}

/** The IPv4 dotted string embedded in an IPv6 address, or null. Handles
 *  ::ffff:0:0/96 mapped forms (dotted, hex, or expanded), the deprecated
 *  ::/96 compatible form, and 6to4 (2002::/16). */
function embeddedIpv4(groups: number[]): string | null {
  const firstFiveZero = groups.slice(0, 5).every((g) => g === 0)
  if (firstFiveZero && groups[5] === 0xffff) {
    return ipv4FromGroups(groups[6], groups[7])
  }
  if (firstFiveZero && groups[5] === 0) {
    // ::/96 compatible form (::127.0.0.1). :: itself is handled before this.
    if (groups[6] === 0 && groups[7] === 0) return null
    return ipv4FromGroups(groups[6], groups[7])
  }
  if (groups[0] === 0x2002) {
    return ipv4FromGroups(groups[1], groups[2])
  }
  return null
}

function ipv4FromGroups(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
}

function ipv4Octets(ip: string): number[] {
  return ip.split('.').map((p) => Number(p))
}

export function isPrivateIp(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 4) {
    const [a, b] = ipv4Octets(ip)
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 0) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    // Documentation / benchmarking / multicast / broadcast ranges.
    if (a === 192 && b === 0) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a === 198 && b === 51) return true
    if (a === 203 && b === 0) return true
    if (a >= 224) return true
    return false
  }
  if (family === 6) {
    const groups = expandIpv6(ip)
    if (!groups) return true // unparseable — treat as unsafe
    if (groups.every((g) => g === 0)) return true // ::
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true // ::1
    // fe80::/10 link-local, fc00::/7 unique-local, ff00::/8 multicast,
    // 2001:db8::/32 documentation.
    if ((groups[0] & 0xffc0) === 0xfe80) return true
    if ((groups[0] & 0xfe00) === 0xfc00) return true
    if ((groups[0] & 0xff00) === 0xff00) return true
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true
    // IPv4-mapped / compatible / 6to4 forms: judge the embedded IPv4.
    const embedded = embeddedIpv4(groups)
    if (embedded) return isPrivateIp(embedded)
    return false
  }
  return true // not an IP at all — treat as unsafe
}

/** True for loopback in any spelling: 127.0.0.0/8, ::1, ::ffff:127.x.x.x
 *  (dotted, hex, or expanded), and the ::/96 form. */
export function isLoopback(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 4) return ip.startsWith('127.')
  if (family === 6) {
    const groups = expandIpv6(ip)
    if (!groups) return false
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true
    const embedded = embeddedIpv4(groups)
    if (embedded) return embedded.startsWith('127.')
    return false
  }
  return false
}

// ── Resolution + pinning ───────────────────────────────────────────────

/** Resolve a hostname and reject it unless every address is public.
 *  Returns the pinned addresses (in DNS order) for the caller to connect
 *  to — the check and the connection use the SAME addresses, so a DNS
 *  flip between the two cannot smuggle in a private IP. */
export async function resolvePublicAddresses(
  hostname: string,
  opts: { allowLoopback?: boolean } = {},
): Promise<string[]> {
  const host = hostname.replace(/^\[|\]$/g, '')
  const allowLoopback = opts.allowLoopback ?? loopbackAllowed()
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      if (allowLoopback && isLoopback(host)) return [host]
      throw new SsrfError(`Refusing to fetch private IP ${host}`)
    }
    return [host]
  }
  let addresses: { address: string }[]
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true })
  } catch {
    throw new SsrfError(`Could not resolve host ${host}`)
  }
  if (addresses.length === 0) throw new SsrfError(`Could not resolve host ${host}`)
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      if (allowLoopback && isLoopback(address)) continue
      throw new SsrfError(`Refusing to fetch host ${host} (resolves to private IP ${address})`)
    }
  }
  return addresses.map((a) => a.address)
}

/** Resolve a hostname and reject it unless every address is public. */
export async function assertPublicHostname(hostname: string, opts: { allowLoopback?: boolean } = {}): Promise<void> {
  await resolvePublicAddresses(hostname, opts)
}

// ── Pinned fetch ───────────────────────────────────────────────────────

export type PinnedFetchOptions = {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBytes?: number
}

export type PinnedFetchResult = {
  status: number
  headers: Record<string, string>
  text: string
}

function requestOnce(
  url: URL,
  pinnedIp: string,
  opts: PinnedFetchOptions,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ status: number; headers: Record<string, string>; text: string; location: string | null }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:'
    const lib = isHttps ? https : http
    const hostHeader = url.host // hostname (bracketed for IPv6) + port when given
    const headers: Record<string, string> = { ...(opts.headers ?? {}), Host: hostHeader }
    const requestOptions: http.RequestOptions & { servername?: string } = {
      hostname: pinnedIp,
      port: url.port ? Number(url.port) : isHttps ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: opts.method ?? 'GET',
      headers,
    }
    // TLS must still verify the ORIGINAL hostname (SNI + cert name), not
    // the pinned IP — otherwise a pinned connection would accept any cert.
    // servername must not be an IP literal, so only set it for names.
    if (isHttps && !net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
      requestOptions.servername = url.hostname
    }
    const req = lib.request(requestOptions, (res) => {
      const responseHeaders: Record<string, string> = {}
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value)
      }
      const location =
        res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400
          ? (typeof res.headers.location === 'string' ? res.headers.location : null)
          : null
      if (location !== null) {
        // Redirect: drain nothing, report the hop and let the caller
        // re-resolve the new URL from scratch.
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: responseHeaders, text: '', location }))
        return
      }
      const chunks: Uint8Array[] = []
      let total = 0
      let failed = false
      res.on('data', (chunk: Buffer | string) => {
        if (failed) return
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        total += buf.byteLength
        if (total > maxBytes) {
          failed = true
          req.destroy(new SsrfError('API response exceeded the 1 MiB size cap'))
          return
        }
        chunks.push(buf)
      })
      res.on('end', () => {
        if (failed) return
        const merged = Buffer.concat(chunks, total)
        resolve({ status: res.statusCode ?? 0, headers: responseHeaders, text: merged.toString('utf8'), location: null })
      })
      res.on('error', (error) => {
        if (failed) return
        failed = true
        reject(error instanceof SsrfError ? error : new SsrfError(`Fetch failed: ${error instanceof Error ? error.message : 'request failed'}`))
      })
    })
    req.on('error', (error) => {
      reject(error instanceof SsrfError ? error : new SsrfError(`Fetch failed: ${error instanceof Error ? error.message : 'request failed'}`))
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy(new SsrfError('Fetch timed out'))
    })
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

/**
 * Fetch a user-supplied URL with SSRF checks on the initial URL and on every
 * redirect hop. Each hop resolves once and connects to the resolved IP, the
 * body is streamed with an incremental size cap, and the whole request is
 * time-boxed. Returns status, headers, and the body as text.
 */
export async function fetchPinnedUrl(
  rawUrl: string,
  opts: PinnedFetchOptions = {},
): Promise<PinnedFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const maxBytes = opts.maxBytes ?? MAX_BYTES
  let current = rawUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let url: URL
    try {
      url = new URL(current)
    } catch {
      throw new SsrfError(`Invalid API URL: ${current}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SsrfError('API URL must use http or https')
    }
    const pinned = await resolvePublicAddresses(url.hostname)
    const result = await requestOnce(url, pinned[0], opts, timeoutMs, maxBytes)
    if (result.location !== null) {
      if (hop === MAX_REDIRECTS) throw new SsrfError('Too many redirects')
      current = new URL(result.location, url).toString()
      continue
    }
    return { status: result.status, headers: result.headers, text: result.text }
  }
  throw new SsrfError('Too many redirects')
}

/**
 * Fetch a user-supplied URL with SSRF checks on the initial URL and on every
 * redirect hop. Returns the response body as text (capped at 1 MiB).
 */
export async function fetchPublicUrl(
  rawUrl: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<string> {
  const result = await fetchPinnedUrl(rawUrl, { method: 'GET', timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes })
  return result.text
}

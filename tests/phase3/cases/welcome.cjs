/**
 * Welcome / onboarding page tests (contract WELCOME-PAGE-CONTRACT.md).
 *
 * Unlike the other phase-3 cases, which call route handlers directly
 * through the require hook, the welcome page is a React page
 * (src/app/welcome/page.tsx) — it has no route handler to require, and
 * its HTML only exists when Next renders it. So this case boots the
 * REAL production server (`next start` on a scratch port, default 3591)
 * and fetches the real pages over HTTP as a guest: no Cookie header,
 * no session, no key anywhere. No mocks, no stubs.
 *
 * Server selection, in order:
 *   1. AGENTFLOW_WELCOME_TEST_URL — use an already-running server
 *      (the gate lane's server, or any server built from a tree that
 *      contains the welcome page). Nothing is spawned or stopped.
 *   2. Otherwise the case builds the tree if `.next/BUILD_ID` is
 *      missing (`next build`, disk-backed TMPDIR under the worktree,
 *      removed afterwards) and spawns `next start -H 127.0.0.1 -p
 *      $AGENTFLOW_WELCOME_TEST_PORT` (default 3591). The last test
 *      stops the server again, so the suite never leaks a process.
 *
 * What is covered here (HTTP level only):
 *   (a) GET /welcome returns 200 HTML as a guest — no 401, no
 *       redirect to login — and carries step 1 (the reused provider
 *       selector + key field), the guide copy, and a Skip control.
 *   (b) The dashboard ships the "Welcome guide" re-open link. It is
 *       NOT in the initial HTML: DashboardLayout waits for its client
 *       /api/auth/me check and renders only a "Loading…" shell during
 *       SSR, so the whole dashboard page renders after hydration. The
 *       test therefore checks the shipped dashboard JS chunks for the
 *       link text + /welcome target (and passes directly on the HTML
 *       if a later change makes the dashboard SSR its content).
 *   (c) The welcome page works with no key at all (guest, no cookie).
 *   Skip is a button, not a link, so its destination is checked in the
 *   page's shipped JS chunk (it sets agentflow.welcome-seen.v1 and
 *   pushes /dashboard) — see the Skip test.
 *
 * What is NOT covered here, honestly: the first-visit localStorage
 * flag (`agentflow.welcome-seen.v1`) and the client-side redirect from
 * / or /dashboard to /welcome live in the browser (FirstVisitRedirect
 * runs in useEffect after hydration). No HTTP test can observe
 * localStorage or a client-side router.replace, so that behaviour is
 * NOT_TESTED at this level — the gate lane proves it with a real
 * browser. Do not fake browser behaviour in this file.
 *
 * Copy assertions are grounded in the contract plus the components
 * lane W1 reuses: the preset labels come from the shared registry
 * (src/lib/llmProviders.ts), the selector label / key label / "Check
 * key" button from src/components/byok/ProviderKeyField.tsx, and the
 * dashboard link text from lane W2's dashboard change
 * (<Link href="/welcome">Welcome guide</Link>). If W1 words the guide
 * or the Skip control differently, update ONLY the strings below to
 * match the real page — never weaken the status/redirect assertions.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { test, assert } = require('../harness.cjs')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const NEXT_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'next')
const BUILD_ID = path.join(REPO_ROOT, '.next', 'BUILD_ID')
const PORT = process.env.AGENTFLOW_WELCOME_TEST_PORT || '3591'
const EXTERNAL_URL = (process.env.AGENTFLOW_WELCOME_TEST_URL || '').replace(/\/$/, '')

let serverChild = null
let serverBase = null

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Run a command, keep the tail of its output, reject on non-zero exit. */
function runCommand(argv, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines = []
    const collect = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) lines.push(line)
        if (lines.length > 200) lines.shift()
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(lines)
      else reject(new Error(`${argv.join(' ')} exited ${code}\n${lines.slice(-40).join('\n')}`))
    })
  })
}

/** Build the tree if no production build exists yet. */
async function ensureBuild() {
  if (fs.existsSync(BUILD_ID)) return
  const tmpDir = path.join(REPO_ROOT, '.tmp-welcome-build')
  fs.mkdirSync(tmpDir, { recursive: true })
  try {
    console.log('    (welcome) no .next build found — running `next build` first')
    await runCommand([process.execPath, NEXT_BIN, 'build'], {
      cwd: REPO_ROOT,
      env: { ...process.env, TMPDIR: tmpDir, NEXT_TELEMETRY_DISABLED: '1' },
    })
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
  assert.ok(fs.existsSync(BUILD_ID), 'next build finished but .next/BUILD_ID is still missing')
}

/** Boot the real production server and wait until /welcome answers 200. */
async function ensureServer() {
  if (serverBase) return serverBase
  if (EXTERNAL_URL) {
    serverBase = EXTERNAL_URL
    return serverBase
  }
  await ensureBuild()
  serverBase = `http://127.0.0.1:${PORT}`
  const child = spawn(process.execPath, [NEXT_BIN, 'start', '-H', '127.0.0.1', '-p', PORT], {
    cwd: REPO_ROOT,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverChild = child
  const lines = []
  const collect = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) lines.push(line)
      if (lines.length > 100) lines.shift()
    }
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const deadline = Date.now() + 120000
  for (;;) {
    try {
      // Any HTTP response means the server is up. The tests themselves
      // assert the status — a 404 here is a real test failure (no
      // /welcome route in this tree), not a readiness failure, so the
      // loop must NOT wait for a 200 that will never come.
      const res = await fetch(`${serverBase}/welcome`, { redirect: 'manual' })
      await res.text()
      return serverBase
    } catch {
      // Server is not listening yet.
    }
    if (child.exitCode !== null) {
      throw new Error(`next start exited ${child.exitCode} before serving\n${lines.slice(-40).join('\n')}`)
    }
    if (Date.now() > deadline) {
      throw new Error(`next start did not serve /welcome within 120s\n${lines.slice(-40).join('\n')}`)
    }
    await sleep(500)
  }
}

function stopServer() {
  if (!serverChild) return Promise.resolve()
  const child = serverChild
  serverChild = null
  return new Promise((resolve) => {
    child.once('close', () => resolve())
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 5000)
  })
}

/** Guest fetch: no Cookie header, no following redirects. */
async function guestGet(pathname) {
  const base = await ensureServer()
  return fetch(`${base}${pathname}`, { redirect: 'manual' })
}

async function guestHtml(pathname) {
  const res = await guestGet(pathname)
  assert.strictEqual(res.status, 200, `GET ${pathname} returned ${res.status} (expected 200 as a guest)`)
  const contentType = res.headers.get('content-type') || ''
  assert.ok(contentType.includes('text/html'), `GET ${pathname} is not HTML: ${contentType}`)
  return res.text()
}

// Preset labels from the shared registry (src/lib/llmProviders.ts).
const PRESET_LABELS = [
  'OpenRouter',
  'Google Gemini',
  'OpenAI',
  'Groq',
  'Anthropic',
  'Cohere',
  'NVIDIA',
  'Hugging Face',
  'Moonshot',
  'Custom',
]

test('welcome: GET /welcome as a guest returns 200 HTML, no redirect, no login wall', async () => {
  const res = await guestGet('/welcome')
  assert.strictEqual(res.status, 200, `GET /welcome returned ${res.status} — a guest must not be bounced`)
  assert.ok(![301, 302, 303, 307, 308].includes(res.status), 'GET /welcome redirected a guest')
  assert.ok(!res.headers.get('location'), `GET /welcome redirected to ${res.headers.get('location')}`)
  const contentType = res.headers.get('content-type') || ''
  assert.ok(contentType.includes('text/html'), `GET /welcome is not HTML: ${contentType}`)
  const html = await res.text()
  assert.ok(html.length > 1000, `GET /welcome HTML is suspiciously short (${html.length} chars)`)
})

test('welcome: step 1 shows the provider selector and key field', async () => {
  const html = await guestHtml('/welcome')
  // The reused ProviderKeyField labels its selector "AI service".
  assert.ok(html.includes('AI service'), 'welcome page has no "AI service" provider selector')
  const present = PRESET_LABELS.filter((label) => html.includes(label))
  assert.ok(
    present.length >= 6,
    `welcome page shows only ${present.length} provider presets (${present.join(', ')}) — expected the shared registry`,
  )
  // The reused key field: label "Your key", password input, default
  // (OpenRouter) placeholder, and the where-to-get-a-key help link.
  assert.ok(html.includes('Your key'), 'welcome page has no "Your key" field')
  assert.ok(html.includes('type="password"'), 'welcome page key field is not a password input')
  assert.ok(html.includes('sk-or-v1-...'), 'welcome page key field lacks the default preset placeholder')
  assert.ok(html.includes('Where to get a key'), 'welcome page has no "Where to get a key" help')
  // Contract req 2: one plain line saying why the user brings a key.
  assert.ok(
    /bring your own/i.test(html) || /no AI key/i.test(html),
    'welcome page never explains why the user brings their own key',
  )
})

test('welcome: step 1 has Test and Save controls', async () => {
  const html = await guestHtml('/welcome')
  // The reused field calls its test button "Check key".
  assert.ok(html.includes('Check key'), 'welcome page has no "Check key" (Test) button')
  // Contract req 2: a Save button (guest saves to byok.ts localStorage).
  assert.ok(html.includes('Save'), 'welcome page has no Save button')
})

test('welcome: step 2 guide covers the journey in plain words', async () => {
  const html = await guestHtml('/welcome')
  const lower = html.toLowerCase()
  // Contract req 2 journey: plain words -> edit steps on the canvas ->
  // test in the sandbox -> add your files -> make it live (deploy) ->
  // teams asking each other questions.
  for (const word of ['canvas', 'sandbox']) {
    assert.ok(lower.includes(word), `welcome guide never mentions "${word}"`)
  }
  assert.ok(
    lower.includes('deploy') || lower.includes('make it live') || lower.includes('go live'),
    'welcome guide never mentions making it live (deploy)',
  )
  assert.ok(lower.includes('team'), 'welcome guide never mentions teams')
})

test('welcome: Skip sets the seen flag and goes to the dashboard', async () => {
  const html = await guestHtml('/welcome')
  assert.ok(html.includes('Skip'), 'welcome page has no Skip control')
  // Skip is a button (router.push in markSeenAndGo), not a link, so its
  // destination is not in the HTML — it lives in the page's shipped JS.
  // Check the wiring statically in the welcome page's own chunk: the
  // Skip/Continue handler sets agentflow.welcome-seen.v1 and pushes
  // /dashboard. (Whether the click itself works in a browser is the
  // gate lane's browser proof, not this HTTP test.)
  const chunkUrls = [...html.matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map((m) => m[1])
  assert.ok(chunkUrls.length > 0, 'welcome HTML references no JS chunks')
  const welcomeChunks = chunkUrls.filter((url) => url.includes('welcome'))
  const toCheck = welcomeChunks.length > 0 ? welcomeChunks : chunkUrls
  let js = ''
  for (const url of new Set(toCheck)) {
    const res = await guestGet(url)
    assert.strictEqual(res.status, 200, `chunk ${url} returned ${res.status}`)
    js += `\n${await res.text()}`
  }
  assert.ok(
    js.includes('agentflow.welcome-seen.v1'),
    'welcome page JS never mentions the seen flag agentflow.welcome-seen.v1',
  )
  assert.ok(
    js.includes('"/dashboard"') || js.includes("'/dashboard'"),
    'welcome page JS never routes to /dashboard',
  )
})

test('welcome: dashboard ships the Welcome guide re-open link', async () => {
  const html = await guestHtml('/dashboard')
  // The link is NOT in the initial HTML — and that is a property of the
  // layout, not of the link. DashboardLayout is a client component that
  // waits for its /api/auth/me check (userLoading starts true) and
  // returns only a "Loading…" shell until it settles, so during SSR the
  // children — the whole dashboard page, link included — are never
  // rendered. The link therefore only exists after hydration. Prove it
  // ships in the dashboard's own JS instead: the chunks the browser
  // loads to render the page contain the link text and its /welcome
  // target. If a later change makes the dashboard SSR its content, the
  // direct HTML check below passes first and the chunk fetch is skipped.
  if (html.includes('Welcome guide')) {
    assert.ok(html.includes('href="/welcome"'), 'dashboard "Welcome guide" link does not point at /welcome')
    return
  }
  const chunkUrls = [...html.matchAll(/\/_next\/static\/chunks\/[A-Za-z0-9/_-]+\.js/g)].map((m) => m[0])
  assert.ok(chunkUrls.length > 0, 'dashboard HTML references no JS chunks')
  let js = ''
  for (const url of new Set(chunkUrls)) {
    const res = await guestGet(url)
    assert.strictEqual(res.status, 200, `chunk ${url} returned ${res.status}`)
    js += `\n${await res.text()}`
  }
  assert.ok(js.includes('Welcome guide'), 'dashboard JS never mentions "Welcome guide"')
  assert.ok(
    js.includes('"/welcome"') || js.includes("'/welcome'"),
    'dashboard JS never links to /welcome',
  )
})

test('welcome: stop the test server', async () => {
  // Runs last (registration order): shuts down the server this file
  // started, so the suite never leaks a process. The harness runs every
  // case even after a failure, so this runs even when a test above fails.
  // With AGENTFLOW_WELCOME_TEST_URL there is nothing to stop.
  await ensureServer()
  await stopServer()
  assert.ok(true)
})

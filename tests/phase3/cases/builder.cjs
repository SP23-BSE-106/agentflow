/**
 * Builder end-to-end test (P3-2 addendum).
 *
 * Builds a workflow with one node of each of the 6 catalogue types
 * (Input, LLM, RAG, API, Condition, Output) and runs it through the single
 * execution entry point — POST /api/execute -> executeWorkflow — asserting
 * each node produced its real output:
 * - Input passes the question in.
 * - RAG retrieves a real chunk (real searchChunks over the fake DB, exact
 *   cosine on fixed vectors) and the chunk text reaches the LLM prompt.
 * - LLM is really called (test LLM stand-in records the call).
 * - API really fetches from a real local HTTP server (127.0.0.1, allowed
 *   outside production by the SSRF guard) through fetchPublicUrl; the
 *   fetched text flows downstream.
 * - Condition branches: the true branch reaches Output, the false branch
 *   reaches the false-branch node and never reaches Output.
 * - Output returns the final state.
 *
 * The Condition node is configured with a plain comparison expression
 * (`state.length > 0` / `state.length > 100000`). That is the expression
 * shape the base executor evaluates; if the P0-1 fix (Lane A) changes the
 * condition config shape, update the config here to the new shape — do not
 * weaken the branch assertions.
 *
 * The builder page's Run button calls this same path: it validates, saves
 * the canvas, then POSTs /api/execute and shows the per-node trace — so
 * the path proven here is the one the builder runs, not a parallel one.
 */
'use strict'

const crypto = require('crypto')
const { test, req, readJson, assert } = require('../harness.cjs')
const { ObjectId } = require('mongodb')
const dbFake = require('../fakes/db.cjs')
const jwtFake = require('../fakes/jwt.cjs')
const llmFake = require('../fakes/llm.cjs')
const embeddingsFake = require('../fakes/embeddings.cjs')

const executeRoute = require('@/app/api/execute/route')
const executor = require('@/lib/workflow/executor')

const API_TEXT = 'API-RESPONSE-TEXT-'.padEnd(120, 'x')

function sixNodeGraph(conditionExpression, apiUrl) {
  return {
    nodes: [
      { id: 'n-input', name: 'Input', type: 'trigger', description: 'entry point' },
      { id: 'n-rag', name: 'RAG', type: 'rag', description: 'retrieve' },
      { id: 'n-llm', name: 'LLM', type: 'llm', description: 'answer', config: { systemPrompt: 'Answer using the context.' } },
      { id: 'n-api', name: 'API', type: 'api', description: 'fetch', config: { url: apiUrl } },
      { id: 'n-cond', name: 'Condition', type: 'condition', description: 'branch', config: { expression: conditionExpression } },
      { id: 'n-output', name: 'Output', type: 'output', description: 'return' },
      { id: 'n-false', name: 'False branch', type: 'llm', description: 'false path' },
    ],
    edges: [
      { id: 'e1', source: 'n-input', target: 'n-rag' },
      { id: 'e2', source: 'n-rag', target: 'n-llm' },
      { id: 'e3', source: 'n-llm', target: 'n-api' },
      { id: 'e4', source: 'n-api', target: 'n-cond' },
      { id: 'e5', source: 'n-cond', target: 'n-output', label: 'true' },
      { id: 'e6', source: 'n-cond', target: 'n-false', label: 'false' },
    ],
  }
}

async function seedChunk() {
  await dbFake.__db.collection('rag_chunks').insertOne({
    userId: jwtFake.USER_A_ID,
    documentId: 'doc-1',
    text: 'The refund window is seven days.',
    chunkIndex: 0,
    embedding: embeddingsFake.__basisVector(0),
  })
}

// A real local HTTP server for the API node: the node fetches through
// fetchPublicUrl for real (SSRF guard + 1 MiB cap), so the test proves the
// API node performs a real fetch instead of a stubbed one.
const http = require('http')
async function withLocalServer() {
  const calls = []
  const server = http.createServer((req, res) => {
    calls.push(req.url)
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(API_TEXT)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    apiUrl: `http://127.0.0.1:${port}/data`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function traceTypes(trace) {
  return trace.map((step) => step.type)
}

test('builder: 6-node workflow executes for real, true branch reaches Output', async () => {
  await seedChunk()
  const apiServer = await withLocalServer()
  const API_URL = apiServer.apiUrl
  try {
    const result = await executor.executeWorkflow(
      sixNodeGraph('state.length > 0', API_URL),
      'What is the refund window?',
      jwtFake.USER_A_ID,
    )
    const types = traceTypes(result.trace)
    for (const type of ['trigger', 'rag', 'llm', 'api', 'condition', 'output']) {
      assert.ok(types.includes(type), `trace is missing a ${type} step: ${types.join(',')}`)
      const step = result.trace.find((item) => item.type === type)
      assert.strictEqual(step.ok, true, `${type} step failed: ${step.summary}`)
    }
    assert.ok(!result.trace.some((s) => s.name === 'False branch'), 'false branch ran on the true path')
    assert.ok(result.sources.length >= 1, 'RAG retrieved nothing')
    assert.ok(result.sources[0].text.includes('seven days'), 'retrieved chunk is not the seeded one')
    const llmCalls = llmFake.__calls()
    assert.ok(llmCalls.length >= 1, 'LLM was never called')
    assert.ok(llmCalls[0].prompt.includes('seven days'), 'retrieved context never reached the LLM')
    assert.ok(apiServer.calls.includes('/data'), `API node never fetched ${API_URL}`)
    // Merge decision (Lane B semantics win): a Condition verdict is control
    // flow only — the data state passes through unchanged, so the run output
    // is the API node's text, not the string 'true'. The old assertion
    // encoded the payload-loss bug Lane B fixed.
    assert.strictEqual(result.output, API_TEXT, `final output is ${JSON.stringify(result.output)}`)
  } finally {
    await apiServer.close()
  }
})

test('builder: Condition false branch runs the false node and never reaches Output', async () => {
  await seedChunk()
  const apiServer = await withLocalServer()
  const API_URL = apiServer.apiUrl
  try {
    const result = await executor.executeWorkflow(
      sixNodeGraph('state.length > 100000', API_URL),
      'What is the refund window?',
      jwtFake.USER_A_ID,
    )
    const names = result.trace.map((step) => step.name)
    assert.ok(names.includes('False branch'), `false branch did not run: ${names.join(',')}`)
    assert.ok(!names.includes('Output'), 'Output ran on the false path')
    assert.ok(result.output.includes('TEST-LLM-ANSWER'), `false-branch output missing: ${result.output}`)
  } finally {
    await apiServer.close()
  }
})

test('builder: POST /api/execute runs the 6-node workflow and records a real run', async () => {
  const db = dbFake.__db
  await seedChunk()
  const apiServer = await withLocalServer()
  const API_URL = apiServer.apiUrl
  const agentId = new ObjectId()
  await db.collection('agents').insertOne({
    _id: agentId,
    userId: jwtFake.USER_A_ID,
    name: 'Six node agent',
    workflow: sixNodeGraph('state.length > 0', API_URL),
    status: 'active',
    createdAt: new Date(),
  })
  const rawKey = 'test-api-key-phase3'
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
  await db.collection('personal_api_keys').insertOne({
    userId: jwtFake.USER_A_ID,
    keyHash,
    name: 'test key',
    createdAt: new Date(),
  })

  try {
    const res = await executeRoute.POST(
      req('http://localhost:3000/api/execute', {
        headers: {
          Authorization: `Bearer ${rawKey}`,
          'x-forwarded-for': '203.0.113.7',
        },
        body: { agentId: String(agentId), input: 'What is the refund window?' },
      }),
    )
    const body = await readJson(res)
    assert.strictEqual(res.status, 200, JSON.stringify(body))
    assert.strictEqual(body.executed, true)
    const types = traceTypes(body.trace)
    for (const type of ['trigger', 'rag', 'llm', 'api', 'condition', 'output']) {
      assert.ok(types.includes(type), `execute trace is missing a ${type} step: ${types.join(',')}`)
    }
    assert.ok(body.trace.every((step) => step.ok), 'a node step failed in the execute trace')
    assert.ok(body.sources.length >= 1, 'execute returned no RAG sources')
    // Same payload-preservation rule as above: the output is the API text.
    assert.strictEqual(body.output, API_TEXT)
    const recorded = dbFake.__dump('workflow_runs')
    assert.strictEqual(recorded.length, 1, 'execute did not record the run')
    assert.strictEqual(recorded[0].status, 'success')
    assert.strictEqual(recorded[0].kind, 'exec')
  } finally {
    await apiServer.close()
  }
})

/**
 * Guest runs (Lane C): a visitor with no account and no agentId POSTs the
 * workflow they hold in their browser. The run is stateless — the same
 * sandboxed engine, the same step-by-step trace — and nothing is recorded.
 * These tests prove the guest branch; they do not weaken the signed-in
 * test above, which still asserts its run is recorded.
 */

function guestGraph(extraNodes, extraEdges) {
  return {
    name: 'Guest workflow',
    nodes: [
      { id: 'g-input', name: 'Input', type: 'trigger', description: 'entry point' },
      { id: 'g-llm', name: 'LLM', type: 'llm', description: 'answer', config: { systemPrompt: 'Answer briefly.' } },
      { id: 'g-output', name: 'Output', type: 'output', description: 'return' },
      ...(extraNodes || []),
    ],
    edges: [
      { id: 'ge1', source: 'g-input', target: 'g-llm' },
      { id: 'ge2', source: 'g-llm', target: 'g-output' },
      ...(extraEdges || []),
    ],
  }
}

function guestReq(body) {
  // No Authorization header, no session cookie: a plain visitor.
  return req('http://localhost:3000/api/execute', {
    headers: { 'x-forwarded-for': '203.0.113.99' },
    body,
  })
}

test('guest: POST /api/execute with a browser-held workflow runs it with no account and records nothing', async () => {
  const res = await executeRoute.POST(guestReq({ workflow: guestGraph(), input: 'Hello, guest run.' }))
  const body = await readJson(res)
  assert.strictEqual(res.status, 200, JSON.stringify(body))
  assert.strictEqual(body.executed, true)
  assert.strictEqual(body.guest, true)
  assert.strictEqual(body.agentId, null)
  assert.strictEqual(body.agentName, 'Guest workflow')
  const types = traceTypes(body.trace)
  for (const type of ['trigger', 'llm', 'output']) {
    assert.ok(types.includes(type), `guest trace is missing a ${type} step: ${types.join(',')}`)
  }
  assert.ok(body.trace.every((step) => step.ok), 'a guest node step failed')
  assert.ok(body.output.includes('TEST-LLM-ANSWER'), `guest output missing LLM answer: ${body.output}`)
  assert.strictEqual(dbFake.__dump('workflow_runs').length, 0, 'guest run was recorded')
})

test('guest: a Code step is refused up front with a plain reason', async () => {
  const graph = guestGraph(
    [{ id: 'g-code', name: 'Code', type: 'code', description: 'run code' }],
    [{ id: 'ge3', source: 'g-llm', target: 'g-code' }],
  )
  const res = await executeRoute.POST(guestReq({ workflow: graph, input: 'Hello.' }))
  const body = await readJson(res)
  assert.strictEqual(res.status, 400, JSON.stringify(body))
  assert.ok(body.error.includes('Code'), `refusal does not name the step: ${body.error}`)
  assert.ok(body.error.includes('log in'), `refusal does not say login is the way: ${body.error}`)
  assert.strictEqual(dbFake.__dump('workflow_runs').length, 0, 'refused guest run was recorded')
})

test('guest: a file-search step fails honestly in the trace — guests have no files', async () => {
  const graph = {
    name: 'Guest workflow',
    nodes: [
      { id: 'g-input', name: 'Input', type: 'trigger', description: 'entry point' },
      { id: 'g-rag', name: 'RAG', type: 'rag', description: 'retrieve' },
      { id: 'g-output', name: 'Output', type: 'output', description: 'return' },
    ],
    edges: [
      { id: 'ge1', source: 'g-input', target: 'g-rag' },
      { id: 'ge2', source: 'g-rag', target: 'g-output' },
    ],
  }
  const res = await executeRoute.POST(guestReq({ workflow: graph, input: 'What is the refund window?' }))
  const body = await readJson(res)
  // The run still returns its step-by-step record, so the page can show
  // exactly which step failed and why — a failure, not a silent 200.
  assert.strictEqual(res.status, 502, JSON.stringify(body))
  assert.ok(Array.isArray(body.trace) && body.trace.length > 0, 'failed guest run returned no trace')
  const ragStep = body.trace.find((step) => step.type === 'rag')
  assert.ok(ragStep, 'guest trace has no file-search step')
  assert.strictEqual(ragStep.ok, false, 'file-search step passed for a guest with no files')
  assert.strictEqual(dbFake.__dump('workflow_runs').length, 0, 'guest run was recorded')
})

test('guest: an expired session is a 401, never a silent guest run', async () => {
  jwtFake.__setToken('bogus-expired-token')
  try {
    const res = await executeRoute.POST(guestReq({ workflow: guestGraph(), input: 'Hello.' }))
    const body = await readJson(res)
    assert.strictEqual(res.status, 401, JSON.stringify(body))
    assert.strictEqual(body.error, 'Log in to use this part.')
  } finally {
    jwtFake.__setToken(null)
  }
})

test('guest: a signed-in run without an agentId is still refused (no workflow, no agent)', async () => {
  const res = await executeRoute.POST(guestReq({ input: 'Hello.' }))
  const body = await readJson(res)
  assert.strictEqual(res.status, 401, JSON.stringify(body))
  assert.strictEqual(body.error, 'Log in to use this part.')
})

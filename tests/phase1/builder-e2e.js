/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS script, run by node. */

// The SSRF guard refuses loopback by default (Lane A3); the builder test
// fetches from a local server, so it opts in explicitly.
process.env.ALLOW_LOOPBACK_FETCH = 'true'

/**
 * Builder end-to-end check (Lane B addendum).
 *
 *   node tests/phase1/builder-e2e.js   (after `npm run test:phase1` compiles)
 *
 * Builds a workflow with one node of each of the 6 types — trigger, llm,
 * rag, api, condition, output — and runs it through `executeWorkflow`, the
 * same single engine `POST /api/execute` (via `runWorkflow`) and the
 * orchestrator's node dispatcher both call. Each node's output is asserted:
 *
 *   trigger  passes the input through
 *   llm      called with the node config's system prompt (boundary stub: no
 *            provider keys exist in this sandbox, so the LLM boundary is
 *            stubbed and the assertion is that the config reaches the call)
 *   rag      retrieves through the stubbed embedding/search boundary and
 *            only above-threshold chunks reach the context
 *   api      fetched for real from a local HTTP server on 127.0.0.1
 *   condition branches for real on the true/false edge labels
 *   output   returns the running state
 *
 * Two runs: one where the API text contains the condition's needle (true
 * branch) and one where it does not (false branch). The unchosen branch
 * node must not appear in the trace.
 *
 * Honest limit of this check: the LLM and RAG steps run against stubbed
 * boundaries here because this sandbox has no inference provider keys, no
 * MongoDB, and no embedding model weights. A live LLM call and a live
 * retrieval are NOT proven by this script; they are proven only by running
 * it against a configured environment. See lane-b-CHANGES.md.
 */
const http = require('http')
const Module = require('module')

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '@/lib/llm') {
    return {
      chatCompletion: async (opts) => {
        globalThis.__llmCalls = globalThis.__llmCalls || []
        globalThis.__llmCalls.push(opts)
        return { text: 'llm-summary: the document is about alpha.', model: opts.model || 'stub-model', provider: 'stub', ok: true }
      },
    }
  }
  if (request === '@/lib/mongo/mongo') return { getDb: async () => ({ collection: () => ({ countDocuments: async () => 5 }) }) }
  if (request === '@/lib/rag/embeddings') return { generateEmbedding: async () => Array(384).fill(0.1) }
  if (request === '@/lib/rag/vectorStore') {
    return {
      searchChunks: async () => ({
        hits: [
          { id: 'c1', documentId: 'd1', text: 'rag-doc-alpha: alpha is the subject.', chunkIndex: 0, similarity: 0.95 },
          { id: 'c2', documentId: 'd1', text: 'rag-doc-noise: unrelated.', chunkIndex: 1, similarity: 0.05 },
        ],
        engine: 'exact-cosine',
      }),
    }
  }
  if (request === '@/lib/rag/grounding') return require('./out/lib/rag/grounding.js')
  if (request === '@/lib/ssrf') return require('./out/lib/ssrf.js')
  if (request === '@/lib/expression/engine') return require('./out/lib/expression/engine.js')
  if (request === '@/lib/workflow/nodeRunner') return require('./out/lib/workflow/nodeRunner.js')
  if (request === '@/lib/workflow/branching') return require('./out/lib/workflow/branching.js')
  if (request === '@/lib/workflow/condition') return require('./out/lib/workflow/condition.js')
  // Lane OC: nodeRunner now delegates Code nodes to the sandboxed executor.
  if (request === '@/lib/nodes/executors/code') return require('./out/lib/nodes/executors/code.js')
  // MERGE FIX: lane D's nodeRunner also imports the Set and HTTP executors;
  // without these mappings the compiled nodeRunner fails to load
  // (MODULE_NOT_FOUND '@/lib/nodes/executors/set'). Same pattern as code.
  if (request === '@/lib/nodes/executors/set') return require('./out/lib/nodes/executors/set.js')
  if (request === '@/lib/nodes/executors/http') return require('./out/lib/nodes/executors/http.js')
  if (request === '@/lib/nodes/items') return require('./out/lib/nodes/items.js')
  return originalLoad.call(this, request, parent, isMain)
}

const { executeWorkflow } = require('./out/lib/workflow/executor.js')

let pass = 0
const failures = []
function check(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

function buildGraph(apiUrl) {
  return {
    nodes: [
      { id: 'n1', name: 'Input', type: 'trigger', description: 'entry' },
      { id: 'n2', name: 'Summarizer', type: 'llm', description: '', config: { systemPrompt: 'You are a test summarizer.', model: 'test-model-1' } },
      { id: 'n3', name: 'Retriever', type: 'rag', description: '', config: { topK: 3 } },
      { id: 'n4', name: 'Fetcher', type: 'api', description: '', config: { url: apiUrl } },
      { id: 'n5', name: 'Checker', type: 'condition', description: '', config: { expression: "state includes 'api-ok'" } },
      { id: 'n6a', name: 'True Out', type: 'output', description: 'true branch' },
      { id: 'n6b', name: 'False Out', type: 'output', description: 'false branch' },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6a', label: 'true' },
      { id: 'e6', source: 'n5', target: 'n6b', label: 'false' },
    ],
  }
}

;(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('api-ok: fresh data from the local server')
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('nothing relevant here')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  // ── Run 1: API text contains the needle → true branch ───────────────
  globalThis.__llmCalls = []
  const run1 = await executeWorkflow(buildGraph(`${base}/ok`), 'what is alpha?', 'user-1')
  const trace1 = Object.fromEntries(run1.trace.map((s) => [s.nodeId, s]))
  check('trigger passes the input through', trace1.n1 && trace1.n1.ok && trace1.n1.summary.includes('14 chars'), JSON.stringify(trace1.n1))
  check('llm node called with the node config system prompt', globalThis.__llmCalls.length === 1 && globalThis.__llmCalls[0].system === 'You are a test summarizer.', JSON.stringify(globalThis.__llmCalls))
  check('llm node produced output', trace1.n2 && trace1.n2.ok && run1.output.length > 0, JSON.stringify(trace1.n2))
  check('rag node retrieved grounded context only', trace1.n3 && trace1.n3.ok && run1.sources.length === 1 && run1.sources[0].text.includes('rag-doc-alpha'), JSON.stringify(run1.sources))
  check('api node fetched the local server for real', trace1.n4 && trace1.n4.ok, JSON.stringify(trace1.n4))
  check('condition evaluated true on the api text', trace1.n5 && trace1.n5.ok && trace1.n5.summary.includes('true'), JSON.stringify(trace1.n5))
  check('true-branch output ran', trace1.n6a && trace1.n6a.ok, JSON.stringify(trace1.n6a))
  check('false-branch output did NOT run', !trace1.n6b, `unexpected trace entry: ${JSON.stringify(trace1.n6b)}`)
  check('final output is the api text', run1.output.includes('api-ok'), run1.output.slice(0, 120))

  // ── Run 2: API text lacks the needle → false branch ─────────────────
  globalThis.__llmCalls = []
  const run2 = await executeWorkflow(buildGraph(`${base}/no`), 'what is alpha?', 'user-1')
  const trace2 = Object.fromEntries(run2.trace.map((s) => [s.nodeId, s]))
  check('condition evaluated false on other api text', trace2.n5 && trace2.n5.ok && trace2.n5.summary.includes('false'), JSON.stringify(trace2.n5))
  check('false-branch output ran', trace2.n6b && trace2.n6b.ok, JSON.stringify(trace2.n6b))
  check('true-branch output did NOT run', !trace2.n6a, `unexpected trace entry: ${JSON.stringify(trace2.n6a)}`)
  check('final output is the false-branch text', run2.output.includes('nothing relevant'), run2.output.slice(0, 120))

  server.close()
  console.log(`\nbuilder-e2e: ${pass} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    console.log(`failing: ${failures.join(', ')}`)
    process.exit(1)
  }
})().catch((err) => {
  console.error(err)
  process.exit(1)
})

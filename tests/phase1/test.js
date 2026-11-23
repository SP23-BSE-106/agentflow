/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS script, run by node. */

/**
 * Phase 1 unit suite (Lane B).
 *
 *   npm run test:phase1
 *
 * Covers the pure, DB/LLM-free logic: grounding threshold + topK, agent
 * field validation, the safe condition evaluator, per-node agent resolution,
 * condition branching, retry/review-cycle decisions, the LLM chain budget,
 * and the single-chain + upload-cap + reindex-job guards.
 *
 * Module-boundary stubs (LLM provider, Mongo, embedding model) are test
 * doubles only: they let the dispatch logic be exercised without a live
 * provider or database. The product itself never returns canned text.
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')

// ── Stub the @/ imports the compiled modules need, before requiring them ──
// Only the pure functions under test are exercised; the stubs exist so the
// modules load without a database or provider keys.
const originalLoad = Module._load
const llmCalls = []
Module._load = function (request, parent, isMain) {
  if (request === '@/lib/llm') {
    return {
      chatCompletion: async (opts) => {
        llmCalls.push(opts)
        return { text: 'stubbed-llm-output', model: opts.model || 'stub-model', provider: 'stub', ok: true }
      },
    }
  }
  if (request === '@/lib/mongo/mongo') return { getDb: async () => ({ collection: () => ({ countDocuments: async () => 5 }) }) }
  // The compiled modules keep their '@/...' requires; map them to the
  // compiled output tree so plain node can load them.
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
  if (request === '@/lib/rag/embeddings') return { generateEmbedding: async () => Array(384).fill(0.1) }
  if (request === '@/lib/rag/vectorStore') {
    return {
      searchChunks: async () => ({
        hits: [
          { id: 'c1', documentId: 'd1', text: 'rag-doc-alpha', chunkIndex: 0, similarity: 0.95 },
          { id: 'c2', documentId: 'd1', text: 'rag-doc-noise', chunkIndex: 1, similarity: 0.05 },
        ],
        engine: 'exact-cosine',
      }),
    }
  }
  if (request === '@/lib/mongo/indices') return {}
  if (request === '@/lib/mongo/agent') return {}
  if (request === '@/lib/mongo/workflow') return {}
  if (request === '@/lib/mongo/agentTasks') return {}
  if (request === '@/lib/mongo/sharedContexts') return {}
  if (request === '@/lib/mongo/agentMessages') return {}
  if (request === '@/lib/validation/orchestrationSchemas') return { supervisorPlanSchema: { safeParse: () => ({ success: true, data: {} }) } }
  if (request === '@/lib/permissions') return { getExecutionBudget: async () => ({ maxTasksPerRun: 50, maxRunDurationMs: 300000, maxMessagesPerRun: 500 }) }
  if (request === 'mongodb') return originalLoad.call(this, request, parent, isMain)
  return originalLoad.call(this, request, parent, isMain)
}

const grounding = require('./out/lib/rag/grounding.js')
const validation = require('./out/lib/agents/validation.js')
const condition = require('./out/lib/workflow/condition.js')
const branching = require('./out/lib/workflow/branching.js')
const resolveNodes = require('./out/lib/orchestration/resolveNodes.js')
const llm = require('./out/lib/llm.js')
const evaluator = require('./out/lib/orchestration/evaluator.js')
const nodeRunner = require('./out/lib/workflow/nodeRunner.js')
const guestWorkflow = require('./out/lib/guestWorkflow.js')

let pass = 0
const failures = []

function t(name, fn) {
  try {
    const out = fn()
    if (out && typeof out.then === 'function') {
      return out.then(
        () => { pass += 1; console.log(`  PASS  ${name}`) },
        (err) => { failures.push(name); console.log(`  FAIL  ${name}\n        ${err.message}`) },
      )
    }
    pass += 1
    console.log(`  PASS  ${name}`)
    return Promise.resolve()
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL  ${name}\n        ${err.message}`)
    return Promise.resolve()
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const tests = []

// ── Grounding: threshold + topK ──────────────────────────────────────────
tests.push(() => t('grounding threshold is 0.30 and filters below-threshold hits', () => {
  eq(grounding.SIMILARITY_THRESHOLD, 0.30, 'threshold')
  const hits = [{ similarity: 0.9 }, { similarity: 0.3 }, { similarity: 0.29 }, { similarity: -0.1 }]
  eq(grounding.filterGroundedHits(hits).map((h) => h.similarity), [0.9, 0.3], 'grounded hits')
  assert(!grounding.hasGrounding([{ similarity: 0.1 }]), 'no grounding below threshold')
  assert(grounding.hasGrounding([{ similarity: 0.31 }]), 'grounding above threshold')
}))

tests.push(() => t('parseTopK defaults non-numeric input to 3 and clamps', () => {
  eq(grounding.parseTopK('abc'), 3, 'abc -> 3')
  eq(grounding.parseTopK(undefined), 3, 'undefined -> 3')
  eq(grounding.parseTopK(null), 3, 'null -> 3')
  eq(grounding.parseTopK(NaN), 3, 'NaN -> 3')
  eq(grounding.parseTopK('7'), 7, "'7' -> 7")
  eq(grounding.parseTopK(0), 1, '0 -> 1')
  eq(grounding.parseTopK(99), 50, '99 -> 50')
}))

// ── Agent field validation (P1-1) ────────────────────────────────────────
tests.push(() => t('agent validation accepts a critic with bounded budgets', () => {
  const v = validation.validateAgentFields({
    role: 'critic',
    systemPrompt: 'Judge fairly.',
    maxTokenBudget: 2048,
    maxRetryCount: 2,
    humanApprovalRequired: true,
    fallbackAgentId: '507f1f77bcf86cd799439011',
  })
  assert(v.ok, `expected ok, got ${v.errors.join('; ')}`)
  eq(v.fields.role, 'critic', 'role')
  eq(v.fields.maxTokenBudget, 2048, 'budget')
}))

tests.push(() => t('agent validation rejects a bad role and out-of-bounds budgets', () => {
  const badRole = validation.validateAgentFields({ role: 'superuser' })
  assert(!badRole.ok && badRole.errors.some((e) => e.includes('role must be one of')), 'bad role rejected')
  const badBudget = validation.validateAgentFields({ maxTokenBudget: 99999 })
  assert(!badBudget.ok, 'oversized budget rejected')
  const badRetries = validation.validateAgentFields({ maxRetryCount: 6 })
  assert(!badRetries.ok, 'oversized retry count rejected')
  const badPrompt = validation.validateAgentFields({ systemPrompt: 'x'.repeat(8001) })
  assert(!badPrompt.ok, 'oversized system prompt rejected')
  assert(validation.AGENT_ROLES.includes('critic'), "'critic' is a valid role")
}))

tests.push(() => t('agent validation leaves absent fields untouched (PATCH-safe)', () => {
  const v = validation.validateAgentFields({ role: 'writer' })
  assert(v.ok, 'ok')
  eq(Object.keys(v.fields), ['role'], 'only role present')
}))

// ── Safe condition evaluator ─────────────────────────────────────────────
tests.push(() => t('condition evaluator handles the allowlisted language', () => {
  eq(condition.evaluateCondition('true', 'anything'), { ok: true, value: true }, 'true')
  eq(condition.evaluateCondition('false', 'anything'), { ok: true, value: false }, 'false')
  eq(condition.evaluateCondition("state includes 'hello'", 'say hello there'), { ok: true, value: true }, 'includes true')
  eq(condition.evaluateCondition("state includes 'hello'", 'nothing here'), { ok: true, value: false }, 'includes false')
  eq(condition.evaluateCondition('state.length > 3', 'abcd'), { ok: true, value: true }, 'length >')
  eq(condition.evaluateCondition("state === 'x'", 'x'), { ok: true, value: true }, 'equality')
  eq(condition.evaluateCondition("state includes 'a' && state.length > 2", 'abc'), { ok: true, value: true }, 'and-combo')
  eq(condition.evaluateCondition("state === 'a' || state === 'b'", 'b'), { ok: true, value: true }, 'or-combo')
}))

tests.push(() => t('condition evaluator rejects code execution attempts', () => {
  for (const expr of [
    'process.env.SECRET',
    "require('fs')",
    'state.constructor',
    'state.toString()',
    '1; process.exit()',
    'state.length > 3; evil()',
  ]) {
    const r = condition.evaluateCondition(expr, 'abcd')
    assert(!r.ok, `expected rejection for ${expr}, got ${JSON.stringify(r)}`)
  }
  assert(!condition.evaluateCondition('state.length > 3', 'ab').ok === false, 'valid expr still ok')
}))

// ── Per-node agent resolution (P1-2) ─────────────────────────────────────
tests.push(() => t('resolveNodes honours config.agentId and falls back to owner', () => {
  const owner = { _id: 'owner1', name: 'Owner' }
  const researcher = { _id: 'agent2', name: 'Researcher' }
  const nodes = [
    { id: 'n1', name: 'Research', type: 'llm', description: '', config: { agentId: 'agent2' } },
    { id: 'n2', name: 'Write', type: 'llm', description: '', config: {} },
    { id: 'n3', name: 'Plain', type: 'llm', description: '' },
  ]
  const resolved = resolveNodes.resolveNodeAgents(nodes, owner, new Map([['agent2', researcher]]))
  eq(resolved[0].agent._id, 'agent2', 'node 1 uses its agent')
  eq(resolved[1].agent._id, 'owner1', 'node 2 falls back to owner')
  eq(resolved[2].agent._id, 'owner1', 'node 3 falls back to owner')
}))

tests.push(() => t('resolveNodes throws honestly for an unknown or foreign agent', () => {
  const owner = { _id: 'owner1', name: 'Owner' }
  const nodes = [{ id: 'n1', name: 'Research', type: 'llm', description: '', config: { agentId: 'nope' } }]
  let threw = false
  try {
    resolveNodes.resolveNodeAgents(nodes, owner, new Map())
  } catch (err) {
    threw = true
    assert(err.message.includes('nope') && err.message.includes('not yours'), `honest error, got: ${err.message}`)
  }
  assert(threw, 'expected a throw for an unknown agent id')
}))

// ── Condition branching ──────────────────────────────────────────────────
tests.push(() => t('branching skips the unchosen side but keeps a join reachable', () => {
  const nodes = [
    { id: 't', name: 'T', type: 'trigger', description: '' },
    { id: 'c', name: 'C', type: 'condition', description: '' },
    { id: 'a', name: 'A', type: 'llm', description: '' },
    { id: 'b', name: 'B', type: 'llm', description: '' },
    { id: 'j', name: 'J', type: 'output', description: '' },
  ]
  const edges = [
    { id: 'e1', source: 't', target: 'c' },
    { id: 'e2', source: 'c', target: 'a', label: 'true' },
    { id: 'e3', source: 'c', target: 'b', label: 'false' },
    { id: 'e4', source: 'a', target: 'j' },
    { id: 'e5', source: 'b', target: 'j' },
  ]
  const skippedTrue = branching.skippedNodeIds(nodes, edges, new Map([['c', 'true']]))
  eq([...skippedTrue].sort(), ['b'], 'true branch skips b only')
  const skippedFalse = branching.skippedNodeIds(nodes, edges, new Map([['c', 'false']]))
  eq([...skippedFalse].sort(), ['a'], 'false branch skips a only')
}))

// ── Retry / review-cycle decisions (P1-3) ───────────────────────────────
tests.push(() => t('decideRecovery counts real retries and honours a fallback agent', () => {
  const base = { retryCount: 0, maxRetries: 3 }
  eq(evaluator.decideRecovery(base, 'No inference provider answered', evaluator.DEFAULT_RETRY_POLICY).action, 'retry', 'retryable -> retry')
  eq(evaluator.decideRecovery({ retryCount: 3, maxRetries: 3 }, 'No inference provider answered', evaluator.DEFAULT_RETRY_POLICY).action, 'stop', 'retries exhausted -> stop')
  eq(evaluator.decideRecovery(base, 'validation failed: bad input', evaluator.DEFAULT_RETRY_POLICY).action, 'stop', 'non-retryable -> stop')
  const withFallback = evaluator.decideRecovery(
    base,
    'timeout waiting for provider',
    { ...evaluator.DEFAULT_RETRY_POLICY, fallbackAgentId: 'fallback1' },
  )
  eq(withFallback.action, 'fallback', 'fallback configured -> fallback')
  eq(withFallback.fallbackAgentId, 'fallback1', 'fallback id carried')
  assert(evaluator.isReviewExhausted(3), '3 review cycles is exhausted')
  assert(!evaluator.isReviewExhausted(2), '2 review cycles is not exhausted')
}))

tests.push(() => t('retryTaskWithFeedback waits for backoff (source check)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/lib/orchestration/evaluator.ts'), 'utf8')
  assert(src.includes('await waitForBackoff(backoffMs)'), 'waitForBackoff is awaited in the retry path')
  assert(src.includes('reviewCycle,'), 'reviewCycle is persisted on the evaluation record')
}))

// ── LLM chain budget (P1-4) ─────────────────────────────────────────────
tests.push(() => t('LLM chain fits inside the 60s route budget', () => {
  eq(llm.CHAIN_DEADLINE_MS, 48000, 'chain deadline 48s')
  eq(llm.PER_PROVIDER_TIMEOUT_MS, 12000, 'per-provider timeout 12s')
  assert(llm.CHAIN_DEADLINE_MS < 60000, 'deadline under 60s')
  assert(4 * llm.PER_PROVIDER_TIMEOUT_MS <= llm.CHAIN_DEADLINE_MS, 'worst case fits the deadline')
}))

tests.push(() => t('generate handler uses the single shared chain (no duplicate list)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/app/api/agents/generate/handler.ts'), 'utf8')
  assert(src.includes("from '@/lib/llm'") && src.includes('chatCompletion('), 'generate calls the shared chatCompletion')
  assert(!src.includes('integrate.api.nvidia.com'), 'no inline NVIDIA endpoint list remains')
  assert(!src.includes('router.huggingface.co'), 'no inline HuggingFace endpoint list remains')
  assert(!src.includes('Kimi-K3:together'), 'drifted model string is gone')
}))

// ── Guest generation (lane A) ─────────────────────────────────────────────
// Guests with NO session cookie generate freely (rate-limited). A cookie
// that is PRESENT but does not verify (expired, tampered, or revoked by a
// password change) is a 401, never a silent downgrade to guest — Lane D
// revocation rule (ALL-GAPS contract §2). This test was updated for that
// rule: the old blanket "never answers 401" assertion is superseded.
tests.push(() => t('generate is open to guests with an honest source flag and a guest rate limit', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/app/api/agents/generate/handler.ts'), 'utf8')
  assert(!src.includes('GUEST_LOGIN_REQUIRED'), 'no login-required 401 for guests on generate')
  assert(src.includes('verifyJwtSession'), 'session check is revocation-aware')
  assert(src.includes('status: 401'), 'a present-but-invalid session answers 401, never a silent guest downgrade')
  assert(src.includes("source: 'ai'"), 'real LLM success is labelled source ai')
  assert(src.includes("source: 'template'"), 'template fallback is labelled source template')
  assert(src.includes('_mock: true'), '_mock is kept on template responses')
  assert(src.includes('MAX_PROMPT_CHARS') && src.includes('isTooLong(prompt'), 'guests keep the same prompt limit')
  assert(src.includes("from '@/lib/rateLimit'") && src.includes('guest:generate:'), 'guests are rate-limited per IP via the shared limiter')
  assert(src.includes('GUEST_GENERATE_MAX = 10') && src.includes('60 * 60 * 1000'), 'guest limit is 10 generations per hour')
  assert(src.includes('status: 429'), 'over-limit guests get a 429')
}))

// ── Upload caps + reindex job guards (P1-5) ─────────────────────────────
tests.push(() => t('upload caps are 20 MB and 500 chunks, enforced before insert', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/app/api/rag/upload/handler.ts'), 'utf8')
  assert(src.includes('MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024'), '20 MB cap defined')
  assert(src.includes('MAX_UPLOAD_CHUNKS = 500'), '500-chunk cap defined')
  assert(src.includes('status: 413'), 'oversize is a 413')
  assert(src.includes('generateEmbeddings(textChunks'), 'embeddings run batched')
  assert(src.includes('chunksInserted'), 'rollback tracks inserted chunks')
}))

tests.push(() => t('reindex is a background job returning 202 + jobId with a status read', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/app/api/rag/reindex/handler.ts'), 'utf8')
  assert(src.includes('startReindexJob(userId)'), 'POST starts a job')
  assert(src.includes('status: 202'), 'POST answers 202 immediately')
  assert(src.includes('jobId'), 'job id is returned')
  assert(src.includes('export async function GET'), 'status can be polled')
  assert(!src.includes('ensureVectorIndex()'), 'no 90s index await inside the route')
  const jobs = fs.readFileSync(path.join(__dirname, '../../src/lib/rag/reindexJobs.ts'), 'utf8')
  assert(jobs.includes('updateOne') && jobs.includes('reindexed'), 'job writes progress incrementally')
}))

// ── Single node dispatcher (addendum 1 + 2) ─────────────────────────────
tests.push(() => t('nodeRunner passes trigger/output through with no LLM call', async () => {
  llmCalls.length = 0
  const trig = await nodeRunner.runWorkflowNode({ node: { id: 't', name: 'T', type: 'trigger', description: '' }, userId: 'u1', input: 'hello' })
  eq(trig.ok, true, 'trigger ok')
  eq(trig.state, 'hello', 'trigger passes input through')
  const out = await nodeRunner.runWorkflowNode({ node: { id: 'o', name: 'O', type: 'output', description: '' }, userId: 'u1', input: 'done' })
  eq(out.ok, true, 'output ok')
  eq(out.state, 'done', 'output passes state through')
  eq(llmCalls.length, 0, 'no LLM call for trigger/output')
}))

tests.push(() => t('nodeRunner code node runs the sandboxed executor (orchestrate path)', async () => {
  // Lane OC: /api/orchestrate runs nodes through runWorkflowNode, which had
  // no 'code' case — Code steps failed with "not supported" there while the
  // item executor ran them fine. Same executor, string state <-> one item.
  const r = await nodeRunner.runWorkflowNode({
    node: { id: 'c', name: 'C', type: 'code', description: '', config: { code: "return items.map(i => ({ json: { input: 'CODE-RAN:' + i.json.input } }))" } },
    userId: 'u1', input: 'hello',
  })
  eq(r.ok, true, 'code ok')
  eq(r.state, 'CODE-RAN:hello', 'code output becomes the state')
  // Builder-saved jsCode alias (D-1) works through this path too.
  const alias = await nodeRunner.runWorkflowNode({
    node: { id: 'c', name: 'C', type: 'code', description: '', config: { jsCode: "return items.map(i => ({ json: { input: 'JSCODE-RAN:' + i.json.input } }))" } },
    userId: 'u1', input: 'hi',
  })
  eq(alias.ok, true, 'jsCode alias ok')
  eq(alias.state, 'JSCODE-RAN:hi', 'jsCode output becomes the state')
  // A JSON-object state becomes one JSON item, not { input: <string> }.
  const jsonIn = await nodeRunner.runWorkflowNode({
    node: { id: 'c', name: 'C', type: 'code', description: '', config: { code: 'return items.map(i => ({ json: { n: i.json.n * 2 } }))' } },
    userId: 'u1', input: '{"n": 21}',
  })
  eq(jsonIn.ok, true, 'json state ok')
  eq(jsonIn.state, '{"n":42}', 'json item round-trips as JSON text')
  // No code configured: honest failure, never a throw.
  const empty = await nodeRunner.runWorkflowNode({
    node: { id: 'c', name: 'C', type: 'code', description: '', config: {} },
    userId: 'u1', input: 'hello',
  })
  assert(!empty.ok && empty.error && empty.error.includes('Code node needs'), 'empty code fails honestly')
}))

tests.push(() => t('nodeRunner fails tool/memory nodes honestly instead of silent success', async () => {
  for (const type of ['tool', 'memory', 'mystery']) {
    const r = await nodeRunner.runWorkflowNode({ node: { id: 'x', name: 'X', type, description: '' }, userId: 'u1', input: 'in' })
    assert(!r.ok && r.error && r.error.includes('not supported'), `${type} must fail honestly, got ${JSON.stringify(r)}`)
  }
}))

tests.push(() => t('nodeRunner condition uses the node config expression, safely', async () => {
  const yes = await nodeRunner.runWorkflowNode({
    node: { id: 'c', name: 'C', type: 'condition', description: '', config: { expression: "state includes 'yes'" } },
    userId: 'u1', input: 'say yes please',
  })
  eq(yes.ok, true, 'condition ok')
  eq(yes.state, 'true', 'condition true')
  const hostile = await nodeRunner.runWorkflowNode({
    node: { id: 'c', name: 'C', type: 'condition', description: '', config: { expression: 'process.env.X' } },
    userId: 'u1', input: 'x',
  })
  assert(!hostile.ok, 'hostile expression fails the node')
}))

tests.push(() => t('nodeRunner LLM node uses the node config system prompt and model', async () => {
  llmCalls.length = 0
  const r = await nodeRunner.runWorkflowNode({
    node: { id: 'l', name: 'L', type: 'llm', description: '', config: { systemPrompt: 'You are a test summarizer.', model: 'test-model-1' } },
    agent: { systemPrompt: 'Agent prompt that must lose.' },
    userId: 'u1', input: 'summarize this',
  })
  eq(r.ok, true, 'llm ok')
  eq(llmCalls.length, 1, 'one LLM call')
  eq(llmCalls[0].system, 'You are a test summarizer.', 'node config system prompt wins')
  eq(llmCalls[0].model, 'test-model-1', 'node config model is passed')
}))

tests.push(() => t('nodeRunner RAG node keeps only above-threshold hits', async () => {
  const r = await nodeRunner.runWorkflowNode({
    node: { id: 'r', name: 'R', type: 'rag', description: '', config: { topK: 3 } },
    userId: 'u1', input: 'what is alpha?',
  })
  eq(r.ok, true, 'rag ok with a grounded hit')
  assert(r.state.includes('rag-doc-alpha'), 'grounded chunk in context')
  assert(!r.state.includes('rag-doc-noise'), 'below-threshold chunk excluded')
  eq(r.sources.length, 1, 'one grounded source')
}))

// ── Guest workflow storage (Lane B): browser-only handoff ───────────────
// Fake localStorage: a plain map with the same three methods.
function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, v) },
    removeItem: (k) => { map.delete(k) },
    _map: map,
  }
}
const sampleWorkflow = { name: 'Sample', nodes: [{ id: 'n1', name: 'Start', type: 'trigger', description: '' }], edges: [] }

tests.push(() => t('guestWorkflow round-trips through one versioned key', () => {
  const store = fakeStorage()
  eq(guestWorkflow.readGuestWorkflow(store), null, 'empty storage reads null')
  eq(guestWorkflow.saveGuestWorkflow({ workflow: sampleWorkflow, name: 'Sample', source: 'ai' }, store), true, 'save succeeds')
  eq(store._map.size, 1, 'exactly one key written')
  assert(store._map.has(guestWorkflow.GUEST_WORKFLOW_KEY), 'versioned key used')
  const back = guestWorkflow.readGuestWorkflow(store)
  eq(back.workflow.nodes.length, 1, 'nodes survive')
  eq(back.source, 'ai', 'source survives')
  assert(typeof back.savedAt === 'string', 'savedAt stamped')
  assert(guestWorkflow.hasGuestWorkflow(store), 'hasGuestWorkflow true after save')
  guestWorkflow.clearGuestWorkflow(store)
  eq(guestWorkflow.readGuestWorkflow(store), null, 'clear forgets the copy')
}))

tests.push(() => t('guestWorkflow damaged entries read null and are cleared', () => {
  const store = fakeStorage({ [guestWorkflow.GUEST_WORKFLOW_KEY]: '{not json' })
  eq(guestWorkflow.readGuestWorkflow(store), null, 'broken JSON reads null')
  eq(store._map.has(guestWorkflow.GUEST_WORKFLOW_KEY), false, 'broken entry cleared')
  const wrongShape = fakeStorage({ [guestWorkflow.GUEST_WORKFLOW_KEY]: JSON.stringify({ workflow: { nodes: 'nope' } }) })
  eq(guestWorkflow.readGuestWorkflow(wrongShape), null, 'wrong shape reads null')
  eq(guestWorkflow.saveGuestWorkflow({ workflow: { nodes: 'nope' } }, fakeStorage()), false, 'wrong shape refuses to save')
}))

tests.push(() => t('guestWorkflow works with no storage instead of throwing', () => {
  eq(guestWorkflow.readGuestWorkflow(null), null, 'null storage reads null')
  eq(guestWorkflow.saveGuestWorkflow({ workflow: sampleWorkflow }, null), false, 'null storage save returns false')
  guestWorkflow.clearGuestWorkflow(null) // must not throw
}))

tests.push(() => t('guestWorkflow source label follows Lane A source, _mock as fallback', () => {
  eq(guestWorkflow.workflowSourceFromResponse({ source: 'ai' }), 'ai', 'source ai kept')
  eq(guestWorkflow.workflowSourceFromResponse({ source: 'template' }), 'template', 'source template kept')
  eq(guestWorkflow.workflowSourceFromResponse({ _mock: true }), 'template', 'mock without source reads template')
  eq(guestWorkflow.workflowSourceFromResponse({}), 'ai', 'plain response reads ai')
  eq(guestWorkflow.workflowSourceLabel('ai', false), 'Built by the AI', 'ai label')
  eq(guestWorkflow.workflowSourceLabel('template', false), 'Suggested from a template', 'template label')
  eq(guestWorkflow.workflowSourceLabel(undefined, true), 'Suggested from a template', 'mock fallback label')
}))

;(async () => {
  for (const run of tests) await run()
  console.log(`\nphase1: ${pass} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    console.log(`failing: ${failures.join(', ')}`)
    process.exit(1)
  }
})()

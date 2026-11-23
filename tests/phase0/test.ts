/**
 * Phase 0 tests — run with `npm run test:phase0`.
 *
 * Pure checks, no database, no Stripe, no network:
 * - P0-1: the shared Condition comparator evaluates real branches and
 *   rejects code-execution payloads; the executor follows the labelled edge.
 * - P0-2/P0-3: the fixed Pro price and the session checks that gate Pro.
 * - P0-4: AES-256-GCM encrypt/decrypt round-trips, and a stored agent key
 *   resolves to the right inference endpoint.
 */
import {
  chooseBranchEdge,
  collectDownstreamIds,
  evaluateCondition,
  parseCondition,
  validateWorkflowGraph,
} from '../../src/lib/workflow/condition'
import { skippedNodeIds } from '../../src/lib/workflow/branching'
import { checkSessionGrantsPro, PRO_PRICE_CENTS, proLineItems } from '../../src/lib/payments'
import { endpointForAgentKey } from '../../src/lib/llm'
import { executeWorkflow } from '../../src/lib/workflow/executor'

let passed = 0
let failed = 0

function check(condition: boolean, message: string): void {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    console.error(`FAIL: ${message}`)
  }
}

function throwsWith(fn: () => unknown, message: string): void {
  try {
    fn()
    failed += 1
    console.error(`FAIL: ${message} (did not throw)`)
  } catch {
    passed += 1
  }
}

async function main(): Promise<void> {
  // ── P0-1: structured conditions branch for real ─────────────────────
  check(
    evaluateCondition({ condition: { field: 'state', operator: '==', value: 'yes' } }, 'yes') === true,
    'structured == matches',
  )
  check(
    evaluateCondition({ condition: { field: 'state', operator: '==', value: 'yes' } }, 'no') === false,
    'structured == does not match',
  )
  check(
    evaluateCondition({ field: 'state', operator: 'contains', value: 'error' }, 'an error happened') === true,
    'contains matches',
  )
  check(
    evaluateCondition({ field: 'state.length', operator: '>', value: 5 }, 'long enough') === true,
    'state.length > compares length',
  )
  check(
    evaluateCondition({ field: 'state.length', operator: '<=', value: 3 }, 'long enough') === false,
    'state.length <= rejects long state',
  )
  check(
    evaluateCondition({ field: 'state', operator: '==', value: true }, 'true') === true,
    'boolean value compares against literal true state',
  )

  // ── P0-1: string expressions in the fixed grammar ───────────────────
  check(evaluateCondition({ expression: 'state == "yes"' }, 'yes') === true, 'string == matches')
  check(evaluateCondition({ expression: 'state contains "err"' }, 'no error') === true, 'string contains matches')
  check(evaluateCondition({ expression: 'state.length > 5' }, '123456') === true, 'string length compares')
  check(evaluateCondition({ expression: 'true' }, 'anything') === true, 'bare true branches true')

  // ── P0-1: code-execution payloads are rejected, never run ───────────
  const attacks = [
    'process.env.JWT_SECRET',
    'process.env.JWT_SECRET[0]==="a"',
    'require("child_process")',
    'state.constructor',
    'eval("1")',
    'fetch("https://attacker.example")',
    'state == "x" || true',
    'state == "x"; process.exit()',
    'state.includes("x")',
    'globalThis.process',
    'state.length > 5 && true',
    '`${process.env.X}`',
    'state == "x" ? "y" : "z"',
  ]
  for (const expression of attacks) {
    throwsWith(
      () => evaluateCondition({ expression }, 'x'),
      `attack rejected: ${expression}`,
    )
    check(
      'error' in parseCondition({ expression }),
      `attack parses to error: ${expression}`,
    )
  }
  check(
    validateWorkflowGraph({
      nodes: [{ id: 'c1', type: 'condition', name: 'c', config: { expression: 'process.env.X' } }],
      edges: [],
    }) !== null,
    'workflow validation rejects an unsafe condition node',
  )
  check(
    validateWorkflowGraph({
      nodes: [{ id: 'c1', type: 'condition', name: 'c', config: { expression: 'state == "yes"' } }],
      edges: [],
    }) === null,
    'workflow validation accepts a safe condition node',
  )

  // ── Addendum: branch choice follows edge labels ─────────────────────
  const edges = [
    { source: 'c', target: 'yes-node', label: 'true' },
    { source: 'c', target: 'no-node', label: 'false' },
  ]
  check(chooseBranchEdge(edges, true)?.target === 'yes-node', 'true result follows the true-labelled edge')
  check(chooseBranchEdge(edges, false)?.target === 'no-node', 'false result follows the false-labelled edge')
  check(
    chooseBranchEdge(
      [
        { source: 'c', target: 'first' },
        { source: 'c', target: 'last' },
      ],
      false,
    )?.target === 'last',
    'no labels: false takes the last edge',
  )
  const downstream = collectDownstreamIds(
    [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'a', target: 'd' },
    ],
    ['b'],
  )
  check(downstream.has('b') && downstream.has('c') && !downstream.has('d'), 'downstream collection follows only the given branch')

  // ── Addendum: the executor really branches on the comparator ────────
  const graph = {
    nodes: [
      { id: 't', name: 'Start', type: 'trigger' as const, description: '', config: {} },
      { id: 'c', name: 'Check', type: 'condition' as const, description: '', config: { expression: 'state contains "error"' } },
      { id: 'y', name: 'Yes branch', type: 'output' as const, description: '', config: {} },
      { id: 'n', name: 'No branch', type: 'output' as const, description: '', config: {} },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'c' },
      { id: 'e2', source: 'c', target: 'y', label: 'true' },
      { id: 'e3', source: 'c', target: 'n', label: 'false' },
    ],
  }
  const trueRun = await executeWorkflow(graph, 'an error happened', 'user-1')
  // Merge decision (Lane B semantics win): a Condition verdict is control
  // flow only — the data state passes through unchanged, so the run output
  // is the original payload, not the string 'true'. The old assertion
  // encoded the payload-loss bug Lane B fixed.
  check(trueRun.output === 'an error happened', 'executor condition verdict does not overwrite the payload')
  check(
    trueRun.trace.some((step) => step.nodeId === 'y') && !trueRun.trace.some((step) => step.nodeId === 'n'),
    'executor runs only the true branch',
  )
  const falseRun = await executeWorkflow(graph, 'all good', 'user-1')
  check(falseRun.output === 'all good', 'executor false branch also preserves the payload')
  check(
    falseRun.trace.some((step) => step.nodeId === 'n') && !falseRun.trace.some((step) => step.nodeId === 'y'),
    'executor runs only the false branch',
  )
  const badGraph = {
    nodes: [
      { id: 't', name: 'Start', type: 'trigger' as const, description: '', config: {} },
      { id: 'c', name: 'Check', type: 'condition' as const, description: '', config: { expression: 'process.env.JWT_SECRET' } },
    ],
    edges: [{ id: 'e1', source: 't', target: 'c' }],
  }
  const badRun = await executeWorkflow(badGraph, 'input', 'user-1')
  check(
    badRun.trace.length === 1 && badRun.trace[0].ok === false,
    'executor refuses a workflow with an unsafe condition before running it',
  )

  // ── QA-fix C3: one shared branch rule, unlabeled + mixed labels ─────
  const unlabeledEdges = [
    { source: 'c', target: 'first' },
    { source: 'c', target: 'last' },
  ]
  check(chooseBranchEdge(unlabeledEdges, true)?.target === 'first', 'no labels: true takes the first edge')
  check(chooseBranchEdge(unlabeledEdges, false)?.target === 'last', 'no labels: false takes the last edge')
  check(
    chooseBranchEdge(
      [
        { source: 'c', target: 'no-node', label: 'false' },
        { source: 'c', target: 'other' },
      ],
      true,
    )?.target === 'other',
    'mixed labels: true takes the unlabeled edge, not the false-labelled first edge',
  )
  check(
    chooseBranchEdge(
      [
        { source: 'c', target: 'other' },
        { source: 'c', target: 'yes-node', label: 'true' },
      ],
      false,
    )?.target === 'other',
    'mixed labels: false takes the unlabeled edge, not the true-labelled last edge',
  )
  // QA-fix C3 (n8n legacy-condition): every edge labelled true/false and
  // none matching means NO branch — never follow a label that contradicts
  // the verdict (the old first/last fallback ran the wrong branch here).
  check(
    chooseBranchEdge([{ source: 'c', target: 'only', label: 'true' }], false) === undefined,
    'all labelled, none matching: single true edge + false takes no edge',
  )
  check(
    chooseBranchEdge([{ source: 'c', target: 'only', label: 'false' }], true) === undefined,
    'all labelled, none matching: single false edge + true takes no edge',
  )
  // The executor follows the same rule on unlabeled edges (FALSE used to
  // take the first edge here while orchestrate took the last).
  const unlabeledGraph = {
    nodes: [
      { id: 't', name: 'Start', type: 'trigger' as const, description: '', config: {} },
      { id: 'c', name: 'Check', type: 'condition' as const, description: '', config: { expression: 'state contains "apple"' } },
      { id: 'a', name: 'Out A first edge', type: 'output' as const, description: '', config: {} },
      { id: 'b', name: 'Out B second edge', type: 'output' as const, description: '', config: {} },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'c' },
      { id: 'e2', source: 'c', target: 'a' },
      { id: 'e3', source: 'c', target: 'b' },
    ],
  }
  const unlabeledFalse = await executeWorkflow(unlabeledGraph, 'banana', 'user-1')
  check(
    unlabeledFalse.trace.some((step) => step.nodeId === 'b') && !unlabeledFalse.trace.some((step) => step.nodeId === 'a'),
    'executor unlabeled FALSE runs only the second (last) edge',
  )
  const unlabeledTrue = await executeWorkflow(unlabeledGraph, 'apple pie', 'user-1')
  check(
    unlabeledTrue.trace.some((step) => step.nodeId === 'a') && !unlabeledTrue.trace.some((step) => step.nodeId === 'b'),
    'executor unlabeled TRUE runs only the first edge',
  )
  // The parallel path's skip set comes from the same rule: FALSE on
  // unlabeled edges skips the first branch only.
  const skipped = skippedNodeIds(
    unlabeledGraph.nodes as never,
    unlabeledGraph.edges as never,
    new Map([['c', 'false' as const]]),
  )
  check(skipped.has('a') && !skipped.has('b'), 'skippedNodeIds unlabeled FALSE skips only the first branch')

  // ── QA-fix H7: compound && / || conditions validate + evaluate ─────
  check(
    validateWorkflowGraph({
      nodes: [{ id: 'c1', type: 'condition', name: 'c', config: { expression: "state includes 'apple' && state includes 'pie'" } }],
      edges: [],
    }) === null,
    'workflow validation accepts a compound && condition',
  )
  check(
    validateWorkflowGraph({
      nodes: [{ id: 'c1', type: 'condition', name: 'c', config: { expression: "state includes 'apple' || state includes 'pie'" } }],
      edges: [],
    }) === null,
    'workflow validation accepts a compound || condition',
  )
  check(
    evaluateCondition({ expression: "state includes 'apple' && state includes 'pie'" }, 'apple pie') === true,
    'compound && evaluates true when both atoms hold',
  )
  check(
    evaluateCondition({ expression: "state includes 'apple' && state includes 'pie'" }, 'apple tart') === false,
    'compound && evaluates false when one atom fails',
  )
  check(
    evaluateCondition({ expression: "state includes 'apple' || state includes 'pie'" }, 'cherry pie') === true,
    'compound || evaluates true when one atom holds',
  )
  check(
    evaluateCondition({ expression: "state includes 'apple' || state includes 'pie'" }, 'banana') === false,
    'compound || evaluates false when no atom holds',
  )
  check(
    evaluateCondition({ expression: "state == 'a && b' || state == 'c'" }, 'a && b') === true,
    'quoted && inside a value is not split as an operator',
  )
  check(
    evaluateCondition({ expression: "state includes 'important'" }, 'this is important') === true,
    'quoted value containing a forbidden substring evaluates as data',
  )
  // The raw-string evaluator (node runner path) follows the same rule as
  // the config parser: bare true/false inside a compound is rejected,
  // while a whole "true" still evaluates true.
  check(
    evaluateCondition("state includes 'apple' || true", 'x').ok === false,
    'string form rejects a bare true inside a compound',
  )
  check(
    evaluateCondition('true', 'x').ok === true && evaluateCondition('true', 'x').value === true,
    'string form still evaluates a whole "true" condition',
  )
  const compoundFalseRun = await executeWorkflow(
    {
      nodes: [
        { id: 't', name: 'Start', type: 'trigger' as const, description: '', config: {} },
        { id: 'c', name: 'Check', type: 'condition' as const, description: '', config: { expression: "state includes 'apple' && state includes 'pie'" } },
        { id: 'a', name: 'Out A first edge', type: 'output' as const, description: '', config: {} },
        { id: 'b', name: 'Out B second edge', type: 'output' as const, description: '', config: {} },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'c' },
        { id: 'e2', source: 'c', target: 'a' },
        { id: 'e3', source: 'c', target: 'b' },
      ],
    },
    'apple tart',
    'user-1',
  )
  check(
    compoundFalseRun.trace.some((step) => step.nodeId === 'b') && !compoundFalseRun.trace.some((step) => step.nodeId === 'a'),
    'executor compound && FALSE runs only the last (unlabeled) edge',
  )

  // ── P0-2/P0-3: fixed Pro price and session checks ───────────────────
  check(PRO_PRICE_CENTS === 1900, 'Pro price is 1900 cents')
  const items = proLineItems()
  check(
    items.length === 1 &&
      (items[0].price_data as { unit_amount: number }).unit_amount === 1900 &&
      (items[0].price_data as { currency: string }).currency === 'usd',
    'server line items are the fixed $19 Pro price',
  )
  const paidSession = {
    amount_total: 1900,
    currency: 'usd',
    payment_status: 'paid',
    status: 'complete',
    metadata: { userId: 'user-1' },
  }
  check(checkSessionGrantsPro(paidSession, 'user-1') === null, 'paid $19 session for the caller grants Pro')
  check(
    checkSessionGrantsPro({ ...paidSession, amount_total: 1 }, 'user-1') !== null,
    '$0.01 session does not grant Pro',
  )
  check(
    checkSessionGrantsPro({ ...paidSession, currency: 'eur' }, 'user-1') !== null,
    'wrong currency does not grant Pro',
  )
  check(
    checkSessionGrantsPro(paidSession, 'user-2') !== null,
    'replaying another account session does not grant Pro',
  )
  check(
    checkSessionGrantsPro({ ...paidSession, payment_status: 'unpaid', status: 'open' }, 'user-1') !== null,
    'unpaid session does not grant Pro',
  )

  // ── P0-4: encryption round-trip + agent key routing ─────────────────
  process.env.ENCRYPTION_KEY = 'phase0-test-key-that-is-long-enough'
  const crypto = await import('../../src/lib/crypto')
  const encrypted = crypto.encrypt('sk-test-key-value')
  check(encrypted !== 'sk-test-key-value' && encrypted.split(':').length === 3, 'encrypt returns iv:authTag:ciphertext, not plaintext')
  check(crypto.decrypt(encrypted) === 'sk-test-key-value', 'decrypt returns the original key')
  const nvidiaEndpoint = endpointForAgentKey({ provider: 'nvidia', key: 'nv-key' })
  check(
    nvidiaEndpoint !== null && nvidiaEndpoint.url.includes('nvidia.com') && nvidiaEndpoint.key === 'nv-key',
    'stored NVIDIA agent key resolves to the NVIDIA endpoint',
  )
  // 'anthropic' used to be the unknown-provider case; it is a supported
  // BYOK preset now, so the unknown case needs a genuinely unknown id.
  check(endpointForAgentKey({ provider: 'definitely-not-a-provider', key: 'x' }) === null, 'unknown provider has no endpoint for a stored key')
  const anthropicEndpoint = endpointForAgentKey({ provider: 'anthropic', key: 'sk-ant-x' })
  check(
    anthropicEndpoint !== null && anthropicEndpoint.url.includes('anthropic.com') && anthropicEndpoint.kind === 'anthropic',
    'stored Anthropic agent key resolves to the native Messages endpoint',
  )
  const googleEndpoint = endpointForAgentKey({ provider: 'google', key: 'AIza-x' })
  check(
    googleEndpoint !== null && googleEndpoint.url.includes('generativelanguage.googleapis.com'),
    'stored Google agent key resolves to the Gemini OpenAI-compatible endpoint',
  )
  // Error parsing: Google wraps the rejection in a one-element array;
  // the message string must come out, not the raw "[{...}]" blob.
  const { parseErrorMessage } = await import('../../src/lib/llm')
  const fakeResponse = { statusText: 'Bad Request' } as Response
  check(
    parseErrorMessage(
      '[{"error":{"code":400,"message":"Please pass a valid API key","status":"INVALID_ARGUMENT"}}]',
      fakeResponse,
    ) === 'Please pass a valid API key',
    'array-wrapped provider error parses to its message',
  )
  check(
    parseErrorMessage('{"error":{"message":"Insufficient credits","code":402}}', fakeResponse) ===
      'Insufficient credits',
    'object provider error parses to its message',
  )
  // Affordable-token parsing: a 402 that says what the key can still afford
  // yields that number; anything else yields null, so callers never guess.
  const { parseAffordableTokens } = await import('../../src/lib/llm')
  check(
    parseAffordableTokens(
      "This request requires more credits, or fewer max_tokens. You requested up to 1200 tokens, but can only afford 1042.",
    ) === 1042,
    'OpenRouter 402 message parses to the affordable token count',
  )
  check(
    parseAffordableTokens('You requested up to 1200 tokens, but can only afford ~1,042.') === 1042,
    'affordable count parses with a tilde and a thousands separator',
  )
  check(
    parseAffordableTokens('Insufficient credits') === null,
    'a 402 without an affordable count parses to null',
  )
  check(parseAffordableTokens('') === null, 'an empty message parses to null')

  console.log(`Phase 0 tests: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

/**
 * AI-generate contract tests (H11 / GAP-3).
 *
 * Fixed behaviour under test:
 * - The generation call asks for GENERATE_MAX_TOKENS (256), not 1200, so
 *   the workflow JSON fits inside the ~300 tokens the shared OpenRouter
 *   key could still afford at QA-sweep end.
 * - The system prompt requires a `rag` node for document questions, and
 *   the generate-time validation enforces it: an AI workflow without a
 *   rag node for a document question falls back to the template with the
 *   reason as warning — it never ships as source 'ai'.
 * - The compact schema (short ids, edges as [source, target] pairs) is
 *   expanded into the full node/edge shape before it is returned.
 * - The honest template fallback is unchanged: provider failure and
 *   unparseable AI output still return source 'template' with a reason.
 */
'use strict'

const { test, req, readJson, assert } = require('../harness.cjs')
const jwtFake = require('../fakes/jwt.cjs')
const llmFake = require('../fakes/llm.cjs')

const generate = require('@/app/api/agents/generate/handler')
const { isDocumentQuestion, expandCompactWorkflow, GENERATE_MAX_TOKENS } = require('@/lib/workflow/generate')

const DOC_PROMPT = 'Answer questions from my uploaded documents about our refund policy.'
const DOC_WORKFLOW_COMPACT = JSON.stringify({
  workflow: {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'r', type: 'rag', config: { topK: 3 } },
      { id: 'l', type: 'llm', config: { systemPrompt: 'Answer only from retrieved context.' } },
      { id: 'o', type: 'output' },
    ],
    edges: [['t', 'r'], ['r', 'l'], ['l', 'o']],
  },
})
const DOC_WORKFLOW_NO_RAG = JSON.stringify({
  workflow: {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'l', type: 'llm', config: { systemPrompt: 'Answer the question.' } },
      { id: 'o', type: 'output' },
    ],
    edges: [['t', 'l'], ['l', 'o']],
  },
})

async function postGenerate(prompt) {
  jwtFake.__setToken('tok-user-a')
  const res = await generate.POST(req('http://localhost:3000/api/agents/generate', { body: { prompt } }))
  return { res, body: await readJson(res) }
}

test('generate: asks for the compact 256-token budget and the rag rule', async () => {
  llmFake.__setText(DOC_WORKFLOW_COMPACT)
  const { res, body } = await postGenerate(DOC_PROMPT)
  assert.strictEqual(res.status, 200, JSON.stringify(body))
  assert.strictEqual(body.source, 'ai', JSON.stringify(body))
  const call = llmFake.__calls()[0]
  assert.strictEqual(call.maxTokens, GENERATE_MAX_TOKENS, JSON.stringify(call))
  assert.strictEqual(call.maxTokens, 256, JSON.stringify(call))
  assert.ok(call.system.includes('DOCUMENT RULE'), 'system prompt lacks the rag requirement')
  assert.ok(call.system.includes('rag'), 'system prompt never mentions rag')
})

test('generate: compact AI workflow with rag ships as source ai, expanded', async () => {
  llmFake.__setText(DOC_WORKFLOW_COMPACT)
  const { body } = await postGenerate(DOC_PROMPT)
  assert.strictEqual(body.source, 'ai', JSON.stringify(body))
  const types = body.workflow.nodes.map((n) => n.type)
  assert.deepStrictEqual(types, ['trigger', 'rag', 'llm', 'output'])
  // Expansion filled in names and turned edge pairs into edge objects.
  assert.strictEqual(body.workflow.nodes[1].name, 'Rag')
  assert.deepStrictEqual(
    body.workflow.edges.map((e) => [e.source, e.target]),
    [['t', 'r'], ['r', 'l'], ['l', 'o']],
  )
  assert.ok(body.workflow.edges.every((e) => typeof e.id === 'string' && e.id.length > 0))
  assert.strictEqual(body.workflow.nodes[1].config.topK, 3)
})

test('generate: document question without a rag node falls back to template', async () => {
  llmFake.__setText(DOC_WORKFLOW_NO_RAG)
  const { body } = await postGenerate(DOC_PROMPT)
  assert.strictEqual(body.source, 'template', JSON.stringify(body))
  assert.strictEqual(body._mock, true)
  assert.ok(String(body.warning).includes('no rag node'), JSON.stringify(body))
  // The fallback template for a document prompt carries a rag node.
  assert.ok(body.workflow.nodes.some((n) => n.type === 'rag'), JSON.stringify(body.workflow.nodes))
})

test('generate: non-document prompt without a rag node still ships as ai', async () => {
  llmFake.__setText(DOC_WORKFLOW_NO_RAG)
  const { body } = await postGenerate('Greet the user warmly and chat with them.')
  assert.strictEqual(body.source, 'ai', JSON.stringify(body))
})

test('generate: unknown node type falls back to template with the reason', async () => {
  llmFake.__setText(
    JSON.stringify({
      workflow: {
        nodes: [
          { id: 't', type: 'trigger' },
          { id: 'x', type: 'teleport' },
          { id: 'o', type: 'output' },
        ],
        edges: [['t', 'x'], ['x', 'o']],
      },
    }),
  )
  const { body } = await postGenerate('Do something odd.')
  assert.strictEqual(body.source, 'template', JSON.stringify(body))
  assert.ok(String(body.warning).includes('unknown type'), JSON.stringify(body))
})

test('generate: dangling edge falls back to template with the reason', async () => {
  llmFake.__setText(
    JSON.stringify({
      workflow: {
        nodes: [
          { id: 't', type: 'trigger' },
          { id: 'o', type: 'output' },
        ],
        edges: [['t', 'ghost']],
      },
    }),
  )
  const { body } = await postGenerate('Do something odd.')
  assert.strictEqual(body.source, 'template', JSON.stringify(body))
  assert.ok(String(body.warning).includes('missing node'), JSON.stringify(body))
})

test('generate: provider failure still falls back honestly to template', async () => {
  llmFake.__setOk(false)
  const { body } = await postGenerate(DOC_PROMPT)
  assert.strictEqual(body.source, 'template', JSON.stringify(body))
  assert.ok(String(body.warning).includes('API key is not configured'), JSON.stringify(body))
})

test('generate: unparseable AI output falls back to template', async () => {
  llmFake.__setText('{"workflow": {"nodes": [{"id": "t", "type": "trig')
  const { body } = await postGenerate(DOC_PROMPT)
  assert.strictEqual(body.source, 'template', JSON.stringify(body))
  assert.strictEqual(body.warning, 'invalid response payload')
})

test('generate: isDocumentQuestion matches document prompts only', async () => {
  assert.strictEqual(isDocumentQuestion('Answer questions from my uploaded documents'), true)
  assert.strictEqual(isDocumentQuestion('What does the employee manual say about leave?'), true)
  assert.strictEqual(isDocumentQuestion('Search the knowledge base for the refund policy'), true)
  assert.strictEqual(isDocumentQuestion('Greet the user warmly and chat with them.'), false)
  assert.strictEqual(isDocumentQuestion('Send an email when a message says urgent'), false)
})

test('generate: expandCompactWorkflow accepts the old verbose shape too', async () => {
  const expanded = expandCompactWorkflow({
    workflow: {
      name: 'Verbose',
      nodes: [
        { id: 'node_1', name: 'Start', type: 'trigger', description: 'Go.', config: {} },
        { id: 'node_2', name: 'Answer', type: 'llm', description: 'Answer.', config: { systemPrompt: 'Answer.' } },
        { id: 'node_3', name: 'End', type: 'output', description: 'Done.', config: {} },
      ],
      edges: [
        { id: 'edge_1', source: 'node_1', target: 'node_2' },
        { id: 'edge_2', source: 'node_2', target: 'node_3' },
      ],
    },
  })
  assert.ok(!('error' in expanded), JSON.stringify(expanded))
  assert.strictEqual(expanded.workflow.nodes[0].name, 'Start')
  assert.strictEqual(expanded.workflow.edges[0].id, 'edge_1')
})

/**
 * Gate end-to-end case (Lane H): a workflow with a Webhook trigger, an
 * If node with a real {{ }} expression, and a Set node runs end to end
 * with real per-node outputs. Every node's real output and latency are
 * asserted — nothing here is stubbed.
 */
'use strict'

const { test, assert, dbFake } = require('../harness.cjs')
const { ObjectId } = require('mongodb')
const { executeWorkflowItems } = require('@/lib/workflow/itemExecutor')
const { itemFromJson } = require('@/lib/nodes/items')
const { runWorkflow } = require('@/lib/workflow/runWorkflow')

function node(id, name, type, config) {
  return { id, name, type, description: name, config }
}

function edge(id, source, target, label) {
  return label === undefined ? { id, source, target } : { id, source, target, label }
}

const GRAPH = {
  nodes: [
    node('w', 'Webhook', 'webhook'),
    node('i', 'If', 'if', { expression: '{{ $json.score }} >= 10' }),
    node('s', 'Set', 'set', {
      assignments: [
        { name: 'verdict', value: 'high' },
        { name: 'doubled', value: '{{ $json.score * 2 }}' },
      ],
    }),
  ],
  edges: [edge('e1', 'w', 'i'), edge('e2', 'i', 's', 'true')],
}

test('gate e2e: webhook -> if ({{ }} expression) -> set runs end to end', async () => {
  const result = await executeWorkflowItems(GRAPH, [itemFromJson({ score: 21, name: 'alpha' })], {
    userId: 'user-a',
    workflowId: 'wf-gate',
  })

  assert.strictEqual(result.status, 'success')
  assert.strictEqual(result.nodeResults.length, 3)

  // Every node produced a real output, with a measured latency.
  for (const nodeResult of result.nodeResults) {
    assert.strictEqual(nodeResult.ok, true, `${nodeResult.name} failed: ${nodeResult.error}`)
    assert.strictEqual(typeof nodeResult.durationMs, 'number')
    assert.ok(nodeResult.durationMs >= 0, `${nodeResult.name} has no latency`)
    assert.ok(Array.isArray(nodeResult.items), `${nodeResult.name} has no items`)
  }

  const webhook = result.nodeResults.find((r) => r.name === 'Webhook')
  assert.strictEqual(webhook.items[0].json.score, 21)
  assert.strictEqual(webhook.items[0].json.name, 'alpha')

  const iff = result.nodeResults.find((r) => r.name === 'If')
  assert.strictEqual(iff.items.length, 1)
  assert.strictEqual(iff.items[0].json.score, 21)

  const set = result.nodeResults.find((r) => r.name === 'Set')
  assert.strictEqual(set.items[0].json.verdict, 'high')
  assert.strictEqual(set.items[0].json.doubled, 42)
  assert.strictEqual(set.items[0].json.score, 21)
  assert.strictEqual(set.items[0].json.name, 'alpha')

  assert.strictEqual(result.output.length, 1)
  assert.strictEqual(result.output[0].json.verdict, 'high')
  assert.strictEqual(result.output[0].json.doubled, 42)
})

test('gate e2e: the false branch skips the Set node', async () => {
  const result = await executeWorkflowItems(GRAPH, [itemFromJson({ score: 5, name: 'beta' })], {
    userId: 'user-a',
    workflowId: 'wf-gate',
  })

  assert.strictEqual(result.status, 'success')
  assert.strictEqual(result.nodeResults.some((r) => r.name === 'Set'), false)
  const iff = result.nodeResults.find((r) => r.name === 'If')
  assert.strictEqual(iff.ok, true)
  assert.strictEqual(iff.items.length, 0)
  assert.strictEqual(typeof iff.durationMs, 'number')
})

test('gate e2e: runWorkflow routes an n8n graph to the item executor', async () => {
  // The single run entry point (POST /api/execute, webhook, form, schedule)
  // must serve registry graphs through the item executor — the string
  // executor fails honestly on those node types, so without routing the
  // nodes could never run in production.
  const db = await dbFake.getDb()
  const agent = {
    _id: new ObjectId(),
    userId: 'user-a',
    name: 'Gate agent',
    status: 'draft',
    workflow: GRAPH,
    createdAt: new Date(),
  }
  await dbFake.__db.collection('agents').insertOne(agent)

  const result = await runWorkflow({
    db,
    userId: 'user-a',
    agentId: String(agent._id),
    input: JSON.stringify({ score: 21, name: 'alpha' }),
  })

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(result.deployed, false)
  // The JSON input became the item's json, so $json.score reached the If.
  const output = JSON.parse(result.output)
  assert.strictEqual(output.verdict, 'high')
  assert.strictEqual(output.doubled, 42)
  assert.strictEqual(output.score, 21)
  assert.strictEqual(output.name, 'alpha')
  // Real per-node trace: all three nodes ran, with measured latency.
  assert.ok(Array.isArray(result.trace))
  assert.strictEqual(result.trace.length, 3)
  for (const step of result.trace) {
    assert.strictEqual(step.ok, true, `${step.name} failed`)
    assert.strictEqual(typeof step.durationMs, 'number')
  }
  assert.strictEqual(result.trace[2].name, 'Set')
  // No RAG node, so no sources and no grounding claim.
  assert.deepStrictEqual(result.sources, [])
  assert.strictEqual(result.grounded, false)
  // The item executor records the run itself: exactly one row, not two.
  const runs = dbFake.__dump('workflow_runs')
  assert.strictEqual(runs.length, 1)
  assert.strictEqual(runs[0].status, 'success')
})

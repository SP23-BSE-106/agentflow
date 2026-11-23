/**
 * Execution cases (Lane H): statuses + crash marking, wait store,
 * error handling / retry, pinning, $vars, merge, split-in-batches,
 * switch, code sandbox, legacy delegation, sub-workflows, and the
 * wait pause + resume round-trip (executor and HTTP route).
 */
'use strict'

const http = require('node:http')
const { test, assert, dbFake, req, readJson } = require('../harness.cjs')
const { executeWorkflowItems } = require('@/lib/workflow/itemExecutor')
const { itemFromJson, itemFromText } = require('@/lib/nodes/items')
const { markStaleRunsCrashed } = require('@/lib/execution/statuses')
const {
  saveWaitingExecution,
  getWaitingExecution,
  deleteWaitingExecution,
  listDueWaitingExecutions,
} = require('@/lib/execution/waitStore')
const { getDb } = require('@/lib/mongo/mongo')

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function node(id, name, type, config, extra = {}) {
  return { id, name, type, description: name, config, ...extra }
}

function edge(id, source, target, label) {
  return label === undefined ? { id, source, target } : { id, source, target, label }
}

test('markStaleRunsCrashed marks only old running runs crashed', async () => {
  const db = await getDb()
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  const fresh = new Date()
  await db.collection('workflow_runs').insertOne({ userId: 'user-a', status: 'running', createdAt: old })
  await db.collection('workflow_runs').insertOne({ userId: 'user-a', status: 'running', createdAt: fresh })
  await db.collection('workflow_runs').insertOne({ userId: 'user-a', status: 'success', createdAt: old })
  await db.collection('workflow_runs').insertOne({ userId: 'user-a', status: 'new', createdAt: old })
  const marked = await markStaleRunsCrashed(db)
  assert.strictEqual(marked, 2)
  const rows = dbFake.__dump('workflow_runs')
  const statuses = rows.map((r) => r.status).sort()
  assert.deepStrictEqual(statuses, ['crashed', 'crashed', 'running', 'success'])
})

test('wait store saves, reads, lists due rows, and deletes', async () => {
  const past = new Date(Date.now() - 1000)
  const future = new Date(Date.now() + 60_000)
  const graph = { nodes: [], edges: [] }
  await saveWaitingExecution({
    executionId: 'exec-past',
    workflowId: 'wf-1',
    userId: 'user-a',
    nodeId: 'wait-1',
    resumeAt: past,
    resumeKind: 'time',
    state: { graph, items: [], nodeResults: [], vars: {} },
  })
  await saveWaitingExecution({
    executionId: 'exec-future',
    workflowId: 'wf-1',
    userId: 'user-a',
    nodeId: 'wait-1',
    resumeAt: future,
    resumeKind: 'time',
    state: { graph, items: [], nodeResults: [], vars: {} },
  })
  const loaded = await getWaitingExecution('exec-past')
  assert.ok(loaded)
  assert.strictEqual(loaded.resumeKind, 'time')
  const due = await listDueWaitingExecutions()
  assert.strictEqual(due.length, 1)
  assert.strictEqual(due[0].executionId, 'exec-past')
  assert.strictEqual(await deleteWaitingExecution('exec-past'), true)
  assert.strictEqual(await getWaitingExecution('exec-past'), null)
})

test('pinData is used instead of executing the node', async () => {
  const graph = {
    nodes: [
      node('w', 'Webhook', 'webhook'),
      node('s', 'Set', 'set', { assignments: [{ name: 'x', value: 1 }] }),
    ],
    edges: [edge('e1', 'w', 's')],
    pinData: { s: [itemFromJson({ x: 99, pinned: true })] },
  }
  const result = await executeWorkflowItems(graph, [itemFromJson({})], { userId: 'user-a' })
  assert.strictEqual(result.status, 'success')
  assert.strictEqual(result.output[0].json.x, 99)
  assert.strictEqual(result.output[0].json.pinned, true)
})

test('$vars resolve into {{ }} templates in node config', async () => {
  const graph = {
    nodes: [
      node('w', 'Webhook', 'webhook'),
      node('s', 'Set', 'set', { assignments: [{ name: 'greeting', value: '{{ $vars.greeting }}' }] }),
    ],
    edges: [edge('e1', 'w', 's')],
    variables: { greeting: 'hello there' },
  }
  const result = await executeWorkflowItems(graph, [itemFromJson({})], { userId: 'user-a' })
  assert.strictEqual(result.status, 'success')
  assert.strictEqual(result.output[0].json.greeting, 'hello there')
})

test('onError stop halts the run and dispatches the error workflow', async () => {
  const dispatched = []
  const graph = {
    nodes: [
      node('w', 'Webhook', 'webhook'),
      node('s', 'Set', 'set', {}), // no assignments: fails honestly
      node('o', 'Set After', 'set', { assignments: [{ name: 'after', value: 'yes' }] }),
    ],
    edges: [edge('e1', 'w', 's'), edge('e2', 's', 'o')],
    errorWorkflowId: 'agent-err',
  }
  const result = await executeWorkflowItems(graph, [itemFromJson({})], {
    userId: 'user-a',
    dispatchErrorWorkflow: async (dispatch) => {
      dispatched.push(dispatch)
      return { ok: true, message: 'ran' }
    },
  })
  assert.strictEqual(result.status, 'error')
  assert.strictEqual(result.nodeResults.some((r) => r.name === 'Set After'), false)
  assert.strictEqual(result.nodeResults.find((r) => r.name === 'Set').ok, false)
  assert.strictEqual(dispatched.length, 1)
  assert.strictEqual(dispatched[0].errorWorkflowId, 'agent-err')
  assert.match(dispatched[0].error, /Set node needs/)
})

test('onError continueRegularOutput sends error items downstream', async () => {
  const graph = {
    nodes: [
      node('w', 'Webhook', 'webhook'),
      node('s', 'Set', 'set', { onError: 'continueRegularOutput' }),
      node('o', 'Set After', 'set', { assignments: [{ name: 'after', value: 'yes' }] }),
    ],
    edges: [edge('e1', 'w', 's'), edge('e2', 's', 'o')],
  }
  const result = await executeWorkflowItems(graph, [itemFromJson({ v: 1 })], { userId: 'user-a' })
  assert.strictEqual(result.status, 'success')
  assert.strictEqual(result.output[0].json.after, 'yes')
  assert.strictEqual(result.output[0].error.message, 'Set node needs at least one assignment (config.assignments or config.values).')
  assert.strictEqual(result.nodeResults.find((r) => r.name === 'Set').ok, false)
  assert.strictEqual(result.nodeResults.find((r) => r.name === 'Set After').ok, true)
})

test('maxTries retries a failing HTTP node for real', async () => {
  let calls = 0
  const server = await startServer((_req, res) => {
    calls += 1
    if (calls === 1) {
      res.writeHead(500)
      res.end('boom')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    const { port } = server.address()
    const graph = {
      nodes: [
        node('w', 'Webhook', 'webhook'),
        node('h', 'HTTP', 'http', {
          url: `http://127.0.0.1:${port}/data`,
          method: 'GET',
          maxTries: 2,
          waitBetweenTries: 0,
        }),
      ],
      edges: [edge('e1', 'w', 'h')],
    }
    const result = await executeWorkflowItems(graph, [itemFromJson({})], { userId: 'user-a' })
    assert.strictEqual(calls, 2)
    assert.strictEqual(result.status, 'success')
    assert.strictEqual(result.output[0].json.status, 200)
    assert.deepStrictEqual(result.output[0].json.body, { ok: true })
  } finally {
    server.close()
  }
})

test('merge append concatenates branches and combine merges by position', async () => {
  const appendGraph = {
    nodes: [
      node('a', 'Branch A', 'set', { assignments: [{ name: 'branch', value: 'a' }] }),
      node('b', 'Branch B', 'set', { assignments: [{ name: 'branch', value: 'b' }] }),
      node('m', 'Merge', 'merge', { mode: 'append' }),
    ],
    edges: [edge('e1', 'a', 'm'), edge('e2', 'b', 'm')],
  }
  const appended = await executeWorkflowItems(appendGraph, [itemFromJson({ v: 1 })], { userId: 'user-a' })
  assert.strictEqual(appended.status, 'success')
  assert.strictEqual(appended.output.length, 2)
  assert.deepStrictEqual(appended.output.map((i) => i.json.branch).sort(), ['a', 'b'])

  const combineGraph = {
    nodes: [
      node('a', 'Branch A', 'set', { assignments: [{ name: 'branch', value: 'a' }] }),
      node('b', 'Branch B', 'set', { assignments: [{ name: 'branch', value: 'b' }] }),
      node('m', 'Merge', 'merge', { mode: 'combine' }),
    ],
    edges: [edge('e1', 'a', 'm'), edge('e2', 'b', 'm')],
  }
  const combined = await executeWorkflowItems(combineGraph, [itemFromJson({ v: 1 })], { userId: 'user-a' })
  assert.strictEqual(combined.status, 'success')
  assert.strictEqual(combined.output.length, 1)
  assert.strictEqual(combined.output[0].json.branch, 'b')
})

test('splitInBatches sends every item downstream across batches', async () => {
  const graph = {
    nodes: [
      node('w', 'Webhook', 'webhook'),
      node('s', 'Split', 'splitInBatches', { batchSize: 2 }),
      node('t', 'Tag', 'set', { assignments: [{ name: 'seen', value: true }] }),
    ],
    edges: [edge('e1', 'w', 's'), edge('e2', 's', 't')],
  }
  const items = [1, 2, 3, 4, 5].map((n) => itemFromJson({ n }))
  const result = await executeWorkflowItems(graph, items, { userId: 'user-a' })
  assert.strictEqual(result.status, 'success')
  assert.strictEqual(result.output.length, 5)
  assert.deepStrictEqual(result.output.map((i) => i.json.n), [1, 2, 3, 4, 5])
  assert.ok(result.output.every((i) => i.json.seen === true))
})

test('switch routes each item to its matching output', async () => {
  const graph = {
    nodes: [
      node('w', 'Webhook', 'webhook'),
      node('sw', 'Switch', 'switch', {
        rules: [
          { field: 'kind', operator: '==', value: 'a', output: 'alpha' },
          { field: 'kind', operator: '==', value: 'b', output: 'beta' },
        ],
      }),
      node('sa', 'Alpha', 'set', { assignments: [{ name: 'route', value: 'alpha' }] }),
      node('sb', 'Beta', 'set', { assignments: [{ name: 'route', value: 'beta' }] }),
    ],
    edges: [
      edge('e1', 'w', 'sw'),
      edge('e2', 'sw', 'sa', 'alpha'),
      edge('e3', 'sw', 'sb', 'beta'),
    ],
  }
  const result = await executeWorkflowItems(graph, [itemFromJson({ kind: 'b' })], { userId: 'user-a' })
  assert.strictEqual(result.status, 'success')
  assert.strictEqual(result.output[0].json.route, 'beta')
  assert.strictEqual(result.nodeResults.some((r) => r.name === 'Alpha'), false)
  assert.strictEqual(result.nodeResults.some((r) => r.name === 'Beta'), true)
})

test('code node transforms items and cannot reach process', async () => {
  const graph = {
    nodes: [
      node('w', 'Webhook', 'webhook'),
      node('c', 'Code', 'code', {
        code: 'return items.map(i => ({ json: { ...i.json, doubled: i.json.n * 2 } }))',
      }),
    ],
    edges: [edge('e1', 'w', 'c')],
  }
  const ok = await executeWorkflowItems(graph, [itemFromJson({ n: 21 })], { userId: 'user-a' })
  assert.strictEqual(ok.status, 'success')
  assert.strictEqual(ok.output[0].json.doubled, 42)

  const badGraph = {
    nodes: [
      node('w', 'Webhook', 'webhook'),
      node('c', 'Code', 'code', { code: 'process.exit(1)' }),
    ],
    edges: [edge('e1', 'w', 'c')],
  }
  const bad = await executeWorkflowItems(badGraph, [itemFromJson({})], { userId: 'user-a' })
  assert.strictEqual(bad.status, 'error')
  assert.match(bad.nodeResults.find((r) => r.name === 'Code').error, /process/)
})

test('if expression rejects blocked identifiers instead of evaluating them', async () => {
  const graph = {
    nodes: [
      node('w', 'Webhook', 'webhook'),
      node('i', 'If', 'if', { expression: '{{ $json.x }}; process.env.SECRET' }),
      node('s', 'Set', 'set', { assignments: [{ name: 'hit', value: true }] }),
    ],
    edges: [edge('e1', 'w', 'i'), edge('e2', 'i', 's', 'true')],
  }
  const result = await executeWorkflowItems(graph, [itemFromJson({ x: 1 })], { userId: 'user-a' })
  assert.strictEqual(result.status, 'error')
  assert.strictEqual(result.nodeResults.some((r) => r.name === 'Set'), false)
})

test('legacy condition node branches for real via the single dispatcher', async () => {
  const graph = {
    nodes: [
      node('t', 'Trigger', 'trigger'),
      node('c', 'Condition', 'condition', { expression: "state contains 'hello'" }),
      node('o', 'Output', 'output'),
    ],
    edges: [edge('e1', 't', 'c'), edge('e2', 'c', 'o', 'true')],
  }
  const yes = await executeWorkflowItems(graph, [itemFromText('say hello there')], { userId: 'user-a' })
  assert.strictEqual(yes.status, 'success')
  assert.strictEqual(yes.output[0].json.input, 'say hello there')
  assert.strictEqual(yes.nodeResults.find((r) => r.name === 'Condition').ok, true)

  const no = await executeWorkflowItems(graph, [itemFromText('goodbye')], { userId: 'user-a' })
  assert.strictEqual(no.status, 'success')
  assert.strictEqual(no.nodeResults.some((r) => r.name === 'Output'), false)
})

test('executeWorkflow node runs the sub-workflow and links the execution', async () => {
  const seen = []
  const graph = {
    nodes: [
      node('w', 'Webhook', 'webhook'),
      node('x', 'Run Child', 'executeWorkflow', { workflowId: 'agent-child' }),
    ],
    edges: [edge('e1', 'w', 'x')],
  }
  const result = await executeWorkflowItems(graph, [itemFromJson({ q: 1 })], {
    userId: 'user-a',
    runSubWorkflow: async (workflowId, items) => {
      seen.push({ workflowId, items })
      return [itemFromJson({ sub: 'done' })]
    },
  })
  assert.strictEqual(result.status, 'success')
  assert.strictEqual(seen.length, 1)
  assert.strictEqual(seen[0].workflowId, 'agent-child')
  assert.strictEqual(result.output[0].json.sub, 'done')
  assert.deepStrictEqual(result.output[0].metadata.subExecution, { workflowId: 'agent-child' })
})

test('wait pauses the run and resume continues it after the wait node', async () => {
  const graph = {
    nodes: [
      node('w', 'Webhook', 'webhook'),
      node('wait', 'Wait', 'wait', { amount: 3600, unit: 'seconds' }),
      node('s', 'Set', 'set', { assignments: [{ name: 'resumed', value: true }] }),
    ],
    edges: [edge('e1', 'w', 'wait'), edge('e2', 'wait', 's')],
  }
  const paused = await executeWorkflowItems(graph, [itemFromJson({ n: 1 })], {
    userId: 'user-a',
    workflowId: 'wf-wait',
  })
  assert.strictEqual(paused.status, 'waiting')
  assert.strictEqual(paused.nodeResults.some((r) => r.name === 'Set'), false)
  const rows = dbFake.__dump('waiting_executions')
  assert.strictEqual(rows.length, 1)
  assert.ok(new Date(rows[0].resumeAt).getTime() > Date.now())
  assert.strictEqual(rows[0].resumeKind, 'time')

  const resumed = await executeWorkflowItems(graph, rows[0].state.items, {
    userId: 'user-a',
    workflowId: 'wf-wait',
    resume: {
      executionId: rows[0].executionId,
      nodeId: 'wait',
      items: rows[0].state.items,
      nodeResults: rows[0].state.nodeResults,
    },
  })
  assert.strictEqual(resumed.status, 'success')
  assert.strictEqual(resumed.output[0].json.resumed, true)
  assert.strictEqual(resumed.output[0].json.n, 1)
})

test('POST /api/executions/[id]/resume resumes a waiting run for its owner', async () => {
  // The resume handler lives in src/lib/execution/executionsRoute.ts; the
  // public URL is served from the /api/runs catch-all via next.config.ts.
  const { executionsResumePost } = require('@/lib/execution/executionsRoute')
  const graph = {
    nodes: [
      node('w', 'Webhook', 'webhook'),
      node('wait', 'Wait', 'wait', { amount: 3600, unit: 'seconds' }),
      node('s', 'Set', 'set', { assignments: [{ name: 'resumed', value: true }] }),
    ],
    edges: [edge('e1', 'w', 'wait'), edge('e2', 'wait', 's')],
  }
  await executeWorkflowItems(graph, [itemFromJson({ n: 7 })], { userId: 'user-a', workflowId: 'wf-wait' })
  const rows = dbFake.__dump('waiting_executions')
  assert.strictEqual(rows.length, 1)
  const id = rows[0].executionId

  const res = await executionsResumePost(req(`http://localhost/api/executions/${id}/resume`, { body: {} }), id)
  assert.strictEqual(res.status, 200)
  const body = await readJson(res)
  assert.strictEqual(body.status, 'success')
  assert.strictEqual(body.output[0].json.resumed, true)
  assert.strictEqual(body.output[0].json.n, 7)
  assert.strictEqual(dbFake.__dump('waiting_executions').length, 0)

  const missing = await executionsResumePost(req('http://localhost/api/executions/nope/resume', { body: {} }), 'nope')
  assert.strictEqual(missing.status, 404)
})

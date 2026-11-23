/**
 * String-dispatcher cases (lane D, H5 + H6).
 *
 * `runWorkflowNode` is the single dispatcher both the string executor and
 * the orchestrator call. Before this lane it only knew the legacy types, so
 * a Set / HTTP / HTTP-Request node failed in orchestrate as "not supported"
 * while /api/execute ran it fine through the item executor. These cases run
 * the same item executors through the dispatcher and check the values flow
 * through the string state. HTTP cases fetch from a local listener;
 * run.cjs sets ALLOW_LOOPBACK_FETCH=true for the suite.
 */
'use strict'

const http = require('node:http')
const { test, assert } = require('../harness.cjs')
const { runWorkflowNode } = require('@/lib/workflow/nodeRunner')

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function node(id, name, type, config) {
  return { id, name, type, description: name, config }
}

test('dispatcher runs a set node and the values flow through the state', async () => {
  const result = await runWorkflowNode({
    node: node('s', 'Set values', 'set', {
      assignments: [{ name: 'greeting', value: 'hello-set' }, { name: 'n', value: 41 }],
    }),
    userId: 'user-a',
    input: 'go',
  })
  assert.strictEqual(result.ok, true, result.error || result.summary)
  const parsed = JSON.parse(result.state)
  assert.strictEqual(parsed.input, 'go')
  assert.strictEqual(parsed.greeting, 'hello-set')
  assert.strictEqual(parsed.n, 41)
})

test('dispatcher runs a set node whose value is a {{ }} template', async () => {
  const result = await runWorkflowNode({
    node: node('s', 'Set values', 'set', {
      assignments: [{ name: 'echo', value: '{{ $json.input }}-done' }],
    }),
    userId: 'user-a',
    input: 'go',
  })
  assert.strictEqual(result.ok, true, result.error || result.summary)
  assert.strictEqual(JSON.parse(result.state).echo, 'go-done')
})

test('dispatcher fails a set node with no assignments honestly', async () => {
  const result = await runWorkflowNode({
    node: node('s', 'Set values', 'set', {}),
    userId: 'user-a',
    input: 'go',
  })
  assert.strictEqual(result.ok, false)
  assert.ok(result.error.includes('at least one assignment'), result.error)
})

test('dispatcher runs an httpRequest node against a local listener', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ hello: 'from-listener' }))
  })
  try {
    const { port } = server.address()
    const result = await runWorkflowNode({
      node: node('h', 'HTTP', 'httpRequest', { url: `http://127.0.0.1:${port}/data`, method: 'GET' }),
      userId: 'user-a',
      input: 'go',
    })
    assert.strictEqual(result.ok, true, result.error || result.summary)
    const parsed = JSON.parse(result.state)
    assert.strictEqual(parsed.status, 200)
    assert.deepStrictEqual(parsed.body, { hello: 'from-listener' })
  } finally {
    server.close()
  }
})

test("dispatcher runs an 'http' node (alias) against a local listener", async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ hello: 'from-listener' }))
  })
  try {
    const { port } = server.address()
    const result = await runWorkflowNode({
      node: node('h', 'HTTP', 'http', { url: `http://127.0.0.1:${port}/data`, method: 'GET' }),
      userId: 'user-a',
      input: 'go',
    })
    assert.strictEqual(result.ok, true, result.error || result.summary)
    const parsed = JSON.parse(result.state)
    assert.strictEqual(parsed.status, 200)
    assert.deepStrictEqual(parsed.body, { hello: 'from-listener' })
  } finally {
    server.close()
  }
})

test('dispatcher fails an http node with no URL honestly', async () => {
  const result = await runWorkflowNode({
    node: node('h', 'HTTP', 'httpRequest', { method: 'GET' }),
    userId: 'user-a',
    input: 'go',
  })
  assert.strictEqual(result.ok, false)
  assert.ok(result.error.includes('needs config.url'), result.error)
})

test('dispatcher still fails an unknown node type honestly', async () => {
  const result = await runWorkflowNode({
    node: node('t', 'Tool', 'tool', {}),
    userId: 'user-a',
    input: 'go',
  })
  assert.strictEqual(result.ok, false)
  assert.ok(result.error.includes('not supported'), result.error)
})

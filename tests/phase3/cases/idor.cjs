/**
 * Run-write IDOR contract tests (P3-2).
 *
 * Fixed behaviour under test (P2-4, owned by Lane B):
 * - Run-write endpoints reject another user's run: cancel/resume/get and
 *   task retry on a run owned by user A answer 404 to user B.
 * - Recording a run against an agent owned by another user is rejected.
 *
 * The run read/write scoping already exists in the base copy for
 * /api/runs/:runId, so those cases pass on base and guard against
 * regression. Recording a run against someone else's agent is NOT checked
 * in the base copy (POST /api/agents/runs trusts any agentId string), so
 * that case fails on base.
 */
'use strict'

const { test, req, readJson, assert } = require('../harness.cjs')
const { ObjectId } = require('mongodb')
const dbFake = require('../fakes/db.cjs')
const jwtFake = require('../fakes/jwt.cjs')

const runs = require('@/app/api/runs/[[...path]]/handler')
const agentRuns = require('@/app/api/agents/runs/handler')

async function seedRun() {
  const db = dbFake.__db
  const runId = new ObjectId()
  const taskId = new ObjectId()
  await db.collection('workflow_runs').insertOne({
    _id: runId,
    userId: jwtFake.USER_A_ID,
    agentId: null,
    status: 'running',
    createdAt: new Date(),
  })
  await db.collection('agent_tasks').insertOne({
    _id: taskId,
    userId: jwtFake.USER_A_ID,
    workflowRunId: String(runId),
    title: 'Step one',
    status: 'failed',
    retryCount: 0,
    maxRetries: 3,
    createdAt: new Date(),
  })
  return { runId, taskId }
}

test('idor: another user cannot cancel a run', async () => {
  const { runId } = await seedRun()
  jwtFake.__setToken('tok-user-b')
  const res = await runs.handle(
    req(`http://localhost:3000/api/runs/${runId}`, { body: { action: 'cancel' } }),
    'POST',
    [String(runId)],
  )
  assert.strictEqual(res.status, 404)
  const run = await dbFake.__db.collection('workflow_runs').findOne({ _id: runId })
  assert.strictEqual(run.status, 'running')
})

test('idor: another user cannot read a run', async () => {
  const { runId } = await seedRun()
  jwtFake.__setToken('tok-user-b')
  const res = await runs.handle(
    req(`http://localhost:3000/api/runs/${runId}`, { method: 'GET' }),
    'GET',
    [String(runId)],
  )
  assert.strictEqual(res.status, 404)
})

test('idor: another user cannot retry a task on the run', async () => {
  const { runId, taskId } = await seedRun()
  jwtFake.__setToken('tok-user-b')
  const res = await runs.handle(
    req(`http://localhost:3000/api/runs/${runId}/tasks/${taskId}/retry`, { body: {} }),
    'POST',
    [String(runId), 'tasks', String(taskId), 'retry'],
  )
  assert.strictEqual(res.status, 404)
})

test('idor: recording a run against another user agent is rejected', async () => {
  const db = dbFake.__db
  const agentId = new ObjectId()
  await db.collection('agents').insertOne({
    _id: agentId,
    userId: jwtFake.USER_A_ID,
    name: 'Not yours',
    status: 'active',
    createdAt: new Date(),
  })
  jwtFake.__setToken('tok-user-b')
  const res = await agentRuns.POST(
    req('http://localhost:3000/api/agents/runs', {
      body: { agentId: String(agentId), input: 'hi', output: 'hello', status: 'success' },
    }),
  )
  assert.ok(res.status === 403 || res.status === 404, `run recorded against another user agent: ${res.status}`)
  assert.strictEqual(dbFake.__dump('workflow_runs').length, 0)
})

test('idor: the owner can cancel their own run', async () => {
  const { runId } = await seedRun()
  jwtFake.__setToken('tok-user-a')
  const res = await runs.handle(
    req(`http://localhost:3000/api/runs/${runId}`, { body: { action: 'cancel' } }),
    'POST',
    [String(runId)],
  )
  assert.strictEqual(res.status, 200, JSON.stringify(await readJson(res)))
  const run = await dbFake.__db.collection('workflow_runs').findOne({ _id: runId })
  assert.strictEqual(run.status, 'cancelled')
})

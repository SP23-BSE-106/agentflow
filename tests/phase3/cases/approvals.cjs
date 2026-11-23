/**
 * Approval contract tests (P3-2).
 *
 * Fixed behaviour under test (P0-6, owned by Lane A):
 * - POST /api/approvals/:id/approve|reject|edit routes correctly
 *   (2-segment path); approve marks the approval approved and the run
 *   running, reject leaves the run paused, edit stores the edited payload.
 * - Approving then resuming re-executes the remaining tasks: a task that
 *   was already completed is skipped, a pending task runs to completion
 *   (with the test LLM stand-in answering), and the run finishes.
 *
 * On the base copy the 2-segment calls 404 (the handler only accepts
 * path.length === 1 and then reads the action from the id segment), and
 * resume only flips a status string, so the pending task never runs.
 */
'use strict'

const { test, req, readJson, assert } = require('../harness.cjs')
const { ObjectId } = require('mongodb')
const dbFake = require('../fakes/db.cjs')
const jwtFake = require('../fakes/jwt.cjs')
const llmFake = require('../fakes/llm.cjs')

const approvals = require('@/app/api/approvals/[[...path]]/handler')
const runs = require('@/app/api/runs/[[...path]]/handler')

const EVAL_JSON = JSON.stringify({
  accuracy: 0.9,
  relevance: 0.9,
  completeness: 0.9,
  groundedness: 0.9,
  feedback: ['looks good'],
})

async function seedPausedRun() {
  const db = dbFake.__db
  const runId = new ObjectId()
  await db.collection('workflow_runs').insertOne({
    _id: runId,
    userId: jwtFake.USER_A_ID,
    agentId: null,
    status: 'paused',
    createdAt: new Date(),
  })
  return runId
}

async function seedApproval(runId) {
  const db = dbFake.__db
  const approvalId = new ObjectId()
  await db.collection('approval_requests').insertOne({
    _id: approvalId,
    userId: jwtFake.USER_A_ID,
    workflowRunId: String(runId),
    taskId: 'task-1',
    requestedByAgentId: 'agent-1',
    title: 'Approve output',
    description: 'Human approval required.',
    payload: { draft: 'original' },
    status: 'pending',
    createdAt: new Date(),
  })
  return approvalId
}

test('approvals: POST /:id/approve routes and approves', async () => {
  const runId = await seedPausedRun()
  const approvalId = await seedApproval(runId)
  jwtFake.__setToken('tok-user-a')
  const res = await approvals.handle(
    req(`http://localhost:3000/api/approvals/${approvalId}/approve`, {
      body: { response: 'yes, go ahead' },
    }),
    'POST',
    [String(approvalId), 'approve'],
  )
  const body = await readJson(res)
  assert.strictEqual(res.status, 200, JSON.stringify(body))
  assert.strictEqual(body.status, 'approved')
  const approval = await dbFake.__db.collection('approval_requests').findOne({ _id: approvalId })
  assert.strictEqual(approval.status, 'approved')
  const run = await dbFake.__db.collection('workflow_runs').findOne({ _id: runId })
  assert.strictEqual(run.status, 'running')
})

test('approvals: POST /:id/reject routes and leaves the run paused', async () => {
  const runId = await seedPausedRun()
  const approvalId = await seedApproval(runId)
  jwtFake.__setToken('tok-user-a')
  const res = await approvals.handle(
    req(`http://localhost:3000/api/approvals/${approvalId}/reject`, {
      body: { response: 'not good enough' },
    }),
    'POST',
    [String(approvalId), 'reject'],
  )
  const body = await readJson(res)
  assert.strictEqual(res.status, 200, JSON.stringify(body))
  assert.strictEqual(body.status, 'rejected')
  const run = await dbFake.__db.collection('workflow_runs').findOne({ _id: runId })
  assert.strictEqual(run.status, 'paused')
})

test('approvals: POST /:id/edit stores the edited payload', async () => {
  const runId = await seedPausedRun()
  const approvalId = await seedApproval(runId)
  jwtFake.__setToken('tok-user-a')
  const res = await approvals.handle(
    req(`http://localhost:3000/api/approvals/${approvalId}/edit`, {
      body: { response: 'edited', editedPayload: { draft: 'edited by human' } },
    }),
    'POST',
    [String(approvalId), 'edit'],
  )
  const body = await readJson(res)
  assert.strictEqual(res.status, 200, JSON.stringify(body))
  assert.strictEqual(body.status, 'edited')
  const approval = await dbFake.__db.collection('approval_requests').findOne({ _id: approvalId })
  assert.deepStrictEqual(approval.payload, { draft: 'edited by human' })
})

test('approvals: another user cannot approve', async () => {
  const runId = await seedPausedRun()
  const approvalId = await seedApproval(runId)
  jwtFake.__setToken('tok-user-b')
  const res = await approvals.handle(
    req(`http://localhost:3000/api/approvals/${approvalId}/approve`, {
      body: { response: 'yes' },
    }),
    'POST',
    [String(approvalId), 'approve'],
  )
  assert.strictEqual(res.status, 404)
  const approval = await dbFake.__db.collection('approval_requests').findOne({ _id: approvalId })
  assert.strictEqual(approval.status, 'pending')
})

test('approvals: approve then resume re-executes the remaining tasks', async () => {
  const db = dbFake.__db
  llmFake.__setText(EVAL_JSON)
  jwtFake.__setToken('tok-user-a')

  const agentId = new ObjectId()
  const graph = {
    nodes: [
      { id: 'n1', name: 'Step one', type: 'llm', description: 'first step' },
      { id: 'n2', name: 'Step two', type: 'llm', description: 'second step' },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  }
  await db.collection('agents').insertOne({
    _id: agentId,
    userId: jwtFake.USER_A_ID,
    name: 'Worker',
    role: 'researcher',
    workflow: graph,
    status: 'active',
    createdAt: new Date(),
  })

  const runId = new ObjectId()
  await db.collection('workflow_runs').insertOne({
    _id: runId,
    userId: jwtFake.USER_A_ID,
    agentId: String(agentId),
    workflow: graph,
    input: { text: 'resume me' },
    status: 'paused',
    mode: 'sequential',
    startedAt: new Date(),
    createdAt: new Date(),
    metadata: { mode: 'sequential' },
  })
  await db.collection('agent_tasks').insertOne({
    _id: new ObjectId(),
    userId: jwtFake.USER_A_ID,
    workflowRunId: String(runId),
    title: 'Step one',
    status: 'completed',
    output: 'step-one-output',
    createdAt: new Date(),
  })
  await db.collection('agent_tasks').insertOne({
    _id: new ObjectId(),
    userId: jwtFake.USER_A_ID,
    workflowRunId: String(runId),
    title: 'Step two',
    status: 'pending',
    createdAt: new Date(),
  })
  const approvalId = await seedApproval(runId)

  const approved = await approvals.handle(
    req(`http://localhost:3000/api/approvals/${approvalId}/approve`, {
      body: { response: 'go ahead' },
    }),
    'POST',
    [String(approvalId), 'approve'],
  )
  assert.strictEqual(approved.status, 200, JSON.stringify(await readJson(approved)))

  const resumed = await runs.handle(
    req(`http://localhost:3000/api/runs/${runId}`, { body: { action: 'resume' } }),
    'POST',
    [String(runId)],
  )
  const resumedBody = await readJson(resumed)
  assert.strictEqual(resumed.status, 200, JSON.stringify(resumedBody))

  const run = await db.collection('workflow_runs').findOne({ _id: runId })
  assert.ok(
    run.status === 'running' || run.status === 'completed',
    `run status is ${run.status}, expected running or completed`,
  )
  // The completed step must not run again, and the pending step must have
  // been executed to completion (as a task row for this run).
  const stepOneDone = await db
    .collection('agent_tasks')
    .find({ userId: jwtFake.USER_A_ID, workflowRunId: String(runId), title: 'Step one', status: 'completed' })
    .toArray()
  assert.strictEqual(stepOneDone.length, 1, 'the completed step ran again instead of being skipped')
  const stepTwoDone = await db
    .collection('agent_tasks')
    .find({ userId: jwtFake.USER_A_ID, workflowRunId: String(runId), title: 'Step two', status: 'completed' })
    .toArray()
  assert.ok(stepTwoDone.length >= 1, 'the pending step was not re-executed to completion')
  assert.ok(stepTwoDone[0].output, 're-executed task has no output')
})

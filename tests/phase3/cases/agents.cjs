/**
 * Agent creation contract tests (P3-2).
 *
 * Fixed behaviour under test (P1-1, owned by Lane A):
 * - POST /api/agents writes role, systemPrompt, maxTokenBudget,
 *   maxRetryCount and humanApprovalRequired onto the stored agent.
 * - An agent created with role 'critic' is discoverable: it shows up in
 *   the agent list with its role, and the orchestrator's critic discovery
 *   (role 'critic' / 'fact_checker') picks it up for evaluation.
 *
 * On the base copy POST drops all five fields, so a critic-role agent
 * cannot be created through the API at all.
 */
'use strict'

const { test, req, readJson, assert } = require('../harness.cjs')
const { ObjectId } = require('mongodb')
const dbFake = require('../fakes/db.cjs')
const jwtFake = require('../fakes/jwt.cjs')
const llmFake = require('../fakes/llm.cjs')

const agents = require('@/app/api/agents/handler')
const orchestrator = require('@/lib/orchestration/orchestrator')

test('agents: POST writes role, systemPrompt, budgets and approval flag', async () => {
  jwtFake.__setToken('tok-user-a')
  // The C1 creation gate reads the caller's subscription: seed a live trial
  // user so this contract test exercises the allowed path.
  await dbFake.__db.collection('users').insertOne({
    _id: new ObjectId(jwtFake.USER_A_ID),
    email: 'a@example.com',
    subscriptionPlan: 'free_trial',
    subscriptionStatus: 'trialing',
    trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
  })
  const res = await agents.POST(
    req('http://localhost:3000/api/agents', {
      body: {
        name: 'Critic One',
        description: 'Checks facts.',
        role: 'critic',
        systemPrompt: 'You check every claim against the sources.',
        maxTokenBudget: 2000,
        maxRetryCount: 2,
        humanApprovalRequired: true,
      },
    }),
  )
  const body = await readJson(res)
  assert.strictEqual(res.status, 201, JSON.stringify(body))
  const stored = dbFake.__dump('agents')[0]
  assert.strictEqual(stored.role, 'critic')
  assert.strictEqual(stored.systemPrompt, 'You check every claim against the sources.')
  assert.strictEqual(stored.maxTokenBudget, 2000)
  assert.strictEqual(stored.maxRetryCount, 2)
  assert.strictEqual(stored.humanApprovalRequired, true)
})

test('agents: critic-role agent is discoverable for evaluation', async () => {
  const db = dbFake.__db
  jwtFake.__setToken('tok-user-a')
  await db.collection('users').insertOne({
    _id: new ObjectId(jwtFake.USER_A_ID),
    email: 'a@example.com',
    subscriptionPlan: 'free_trial',
    subscriptionStatus: 'trialing',
    trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
  })
  llmFake.__setText(
    JSON.stringify({
      accuracy: 0.9,
      relevance: 0.9,
      completeness: 0.9,
      groundedness: 0.9,
      feedback: ['looks good'],
    }),
  )

  const create = await agents.POST(
    req('http://localhost:3000/api/agents', {
      body: {
        name: 'Critic One',
        role: 'critic',
        systemPrompt: 'You check every claim.',
        maxTokenBudget: 1000,
        maxRetryCount: 1,
        humanApprovalRequired: false,
      },
    }),
  )
  assert.strictEqual(create.status, 201, JSON.stringify(await readJson(create)))

  const list = await agents.GET()
  const listed = await readJson(list)
  const critic = listed.find((agent) => agent.name === 'Critic One')
  assert.ok(critic, 'critic agent missing from the agent list')
  assert.strictEqual(critic.role, 'critic')

  // A worker whose workflow runs while the critic exists must be evaluated
  // by that critic: the orchestrator records the evaluation with the
  // critic's id as evaluatorAgentId.
  const workerId = new ObjectId()
  await db.collection('agents').insertOne({
    _id: workerId,
    userId: jwtFake.USER_A_ID,
    name: 'Worker',
    role: 'researcher',
    workflow: {
      nodes: [{ id: 'n1', name: 'Do work', type: 'llm', description: 'work' }],
      edges: [],
    },
    status: 'active',
    createdAt: new Date(),
  })
  const result = await orchestrator.orchestrate({
    agentId: String(workerId),
    input: 'do the work',
    userId: jwtFake.USER_A_ID,
    mode: 'sequential',
  })
  assert.strictEqual(result.status, 'completed', JSON.stringify(result))
  const evaluations = dbFake.__dump('agent_evaluations')
  assert.ok(evaluations.length >= 1, 'no evaluation was recorded')
  assert.strictEqual(evaluations[0].evaluatorAgentId, String(critic._id))
  assert.strictEqual(evaluations[0].passed, true)
})

/**
 * Supervisor request plumbing tests (Lane D2, multi-agent team).
 *
 * Behaviour under test:
 * - `orchestrationRequestSchema` accepts `conversational: true/false`, ignores
 *   a missing flag (undefined — the old fixed-plan path stays default), and
 *   rejects non-boolean values.
 * - POST /api/runs/:runId/messages accepts the new 'question' message type
 *   (201, persisted) and lists it back; the pre-existing types still work
 *   and an unknown type is still rejected (400).
 *
 * These are UNIT tests: direct calls to the schema and to the runs handler
 * through the phase-3 harness/fakes (no live LLM, no server). The flag's
 * onward journey into generateSupervisorPlan/executeSupervisorPlan lives in
 * the orchestrator patch file (tmp-d2/) for the merge lane — this lane does
 * not edit orchestrator.ts.
 *
 * Standalone run (after the phase-3 compile step):
 *   npx tsc -p tests/phase3/tsconfig.json
 *   node tests/phase3/cases/team-supervisor-plumbing.cjs
 * Wiring into the full suite is a merge-lane step: add
 *   require('./cases/team-supervisor-plumbing.cjs')
 * to tests/phase3/run.cjs (out of this lane's file scope).
 */
'use strict'

// Install the require hook first when run standalone; run.cjs already
// installs it before loading cases, and re-requiring it is a no-op wrap.
require('../hooks.cjs')

const { test, req, readJson, assert, run } = require('../harness.cjs')
const { ObjectId } = require('mongodb')
const dbFake = require('../fakes/db.cjs')
const jwtFake = require('../fakes/jwt.cjs')

const runs = require('@/app/api/runs/[[...path]]/handler')
const { orchestrationRequestSchema } = require('@/lib/validation/orchestrationSchemas')

const BASE_BODY = { agentId: 'agent-1', input: 'do the job', mode: 'supervisor' }

async function seedRun() {
  const db = dbFake.__db
  const runId = new ObjectId()
  await db.collection('workflow_runs').insertOne({
    _id: runId,
    userId: jwtFake.USER_A_ID,
    agentId: null,
    status: 'running',
    createdAt: new Date(),
  })
  return runId
}

function postMessage(runId, body) {
  jwtFake.__setToken('tok-user-a')
  return runs.handle(
    req(`http://localhost:3000/api/runs/${runId}/messages`, { body }),
    'POST',
    [String(runId), 'messages'],
  )
}

// ── Schema: conversational flag ────────────────────────────────────────

test('plumbing: schema accepts conversational: true', async () => {
  const parsed = orchestrationRequestSchema.safeParse({ ...BASE_BODY, conversational: true })
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  assert.strictEqual(parsed.data.conversational, true)
})

test('plumbing: schema accepts conversational: false', async () => {
  const parsed = orchestrationRequestSchema.safeParse({ ...BASE_BODY, conversational: false })
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  assert.strictEqual(parsed.data.conversational, false)
})

test('plumbing: schema leaves a missing flag undefined (old path default)', async () => {
  const parsed = orchestrationRequestSchema.safeParse({ ...BASE_BODY })
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  assert.strictEqual(parsed.data.conversational, undefined)
})

test('plumbing: schema rejects non-boolean conversational values', async () => {
  for (const bad of ['yes', 1, 0, null, ['true'], { value: true }]) {
    const parsed = orchestrationRequestSchema.safeParse({ ...BASE_BODY, conversational: bad })
    assert.strictEqual(parsed.success, false, `accepted conversational=${JSON.stringify(bad)}`)
  }
})

// ── Runs API: 'question' message type ──────────────────────────────────

test('plumbing: POST question message is accepted (201) and persisted', async () => {
  const runId = await seedRun()
  const res = await postMessage(runId, {
    fromAgentId: 'agent-supervisor',
    toAgentId: 'agent-researcher',
    type: 'question',
    text: 'What are the 2026 figures?',
    requiresResponse: true,
  })
  assert.strictEqual(res.status, 201, JSON.stringify(await readJson(res)))
  const saved = await readJson(
    await runs.handle(
      req(`http://localhost:3000/api/runs/${runId}/messages`, { method: 'GET' }),
      'GET',
      [String(runId), 'messages'],
    ),
  )
  assert.ok(Array.isArray(saved), `list did not return an array: ${JSON.stringify(saved)}`)
  const question = saved.find((m) => m.type === 'question')
  assert.ok(question, 'question message not listed back')
  assert.strictEqual(question.text, 'What are the 2026 figures?')
  assert.strictEqual(question.toAgentId, 'agent-researcher')
  assert.strictEqual(question.requiresResponse, true)
})

test('plumbing: regression — pre-existing types still accepted, unknown type rejected', async () => {
  const runId = await seedRun()
  const ok = await postMessage(runId, {
    fromAgentId: 'agent-a',
    type: 'status',
    text: 'working',
  })
  assert.strictEqual(ok.status, 201, JSON.stringify(await readJson(ok)))

  const bad = await postMessage(runId, {
    fromAgentId: 'agent-a',
    type: 'telepathy',
    text: 'not a real type',
  })
  assert.strictEqual(bad.status, 400, JSON.stringify(await readJson(bad)))
})

if (require.main === module) {
  run()
}

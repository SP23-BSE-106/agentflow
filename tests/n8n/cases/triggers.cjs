/**
 * Lane G trigger cases (tests/n8n/cases/triggers.cjs).
 *
 * Covers the frozen contract's trigger behaviour:
 *   - test vs production webhook split (test needs a registration,
 *     production needs an active workflow)
 *   - schedule cron parsing, isDue and nextRun
 *   - form submission runs the workflow for real
 *   - Respond To Webhook shaping, trigger node descriptions
 *
 * Runs against the real compiled product code (no mocks in the code under
 * test). The database, NextResponse and LLM are the Phase 3 test fakes;
 * the workflows under test use trigger -> output nodes only, so no
 * provider is called and the run path (runWorkflow -> executeWorkflow ->
 * runWorkflowNode) is the real one.
 *
 * Runs under tests/n8n/run.cjs (npm run test:n8n): the require hook
 * maps '@/...' to the compiled tree, and the shared harness runs every
 * case file in cases/ under one count.
 */
'use strict'

const { test, beforeEach, assert, dbFake } = require('../harness.cjs')
const { ObjectId } = require('mongodb')

const { parseCron, validateCron, isDue, nextRun } = require('@/lib/triggers/schedule')
const {
  registerWebhook,
  getWebhookRegistration,
  listWebhookRegistrations,
  deleteWebhookRegistration,
  webhookPath,
} = require('@/lib/triggers/webhooks')
const {
  shapeRespondResponse,
  resolveWebhookResponse,
  findRespondNode,
} = require('@/lib/triggers/respond')
const {
  getFormDefinition,
  runFormSubmission,
} = require('@/lib/triggers/forms')
// Trigger descriptions are canonical in Lane E's registry — importing
// the aggregate registers all 17 core descriptions (see registry.cjs).
require('@/lib/nodes/index')
const {
  getNodeType,
  listNodeTypes,
  defaultVersion,
} = require('@/lib/nodes/registry')

// The handlers live in src/lib/triggers/*Route.ts; the public URLs are
// served from the /api/orchestrate catch-all via next.config.ts rewrites.
const { webhookPost } = require('@/lib/triggers/webhookRoute')
const { triggersCheckPost } = require('@/lib/triggers/checkRoute')
const { formsGet, formsPost } = require('@/lib/triggers/formsRoute')

const USER_A = 'user-a'

function echoGraph() {
  return {
    nodes: [
      { id: 'n1', name: 'Trigger', type: 'trigger', description: '', config: {} },
      { id: 'n2', name: 'Output', type: 'output', description: '', config: {} },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  }
}

function formGraph() {
  // The Form Trigger node is the form's definition, but it sits off the
  // string executor's path: the string executor (runWorkflow) only knows
  // the legacy node types, so a formTrigger node on the execution path
  // would fail the run. Lane H's item executor executes trigger nodes
  // natively; until it lands, the entry node is the legacy trigger and the
  // run (trigger -> output) is real. The form definition still comes from
  // the formTrigger node, which is what the form page renders.
  return {
    nodes: [
      { id: 'n1', name: 'Trigger', type: 'trigger', description: '', config: {} },
      {
        id: 'f1',
        name: 'Contact form',
        type: 'formTrigger',
        description: '',
        config: {
          formTitle: 'Contact us',
          formDescription: 'Tell us what you need.',
          formFields: [
            { name: 'name', label: 'Your name', type: 'text', required: true },
            { name: 'message', label: 'Message', type: 'textarea', required: true },
            { name: 'topic', label: 'Topic', type: 'select', options: ['sales', 'support'] },
          ],
        },
      },
      { id: 'n2', name: 'Output', type: 'output', description: '', config: {} },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  }
}

async function seedAgent(overrides = {}) {
  const agent = {
    _id: new ObjectId(),
    userId: USER_A,
    name: 'Echo agent',
    status: 'draft',
    workflow: echoGraph(),
    createdAt: new Date(),
    ...overrides,
  }
  await dbFake.__db.collection('agents').insertOne(agent)
  return agent
}

function postRequest(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function readJson(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { __raw: text }
  }
}

beforeEach(() => {
  dbFake.__reset()
  delete process.env.CRON_SECRET
})

// ── Cron parser ────────────────────────────────────────────────────────

test('schedule: every-minute cron is due now', () => {
  const cron = parseCron('* * * * *')
  assert.equal(isDue(cron, new Date()), true)
})

test('schedule: fixed time matches only at that time (UTC)', () => {
  const cron = parseCron('0 9 * * *')
  assert.equal(isDue(cron, new Date('2026-11-18T09:00:00Z')), true)
  assert.equal(isDue(cron, new Date('2026-11-18T10:00:00Z')), false)
  assert.equal(isDue(cron, new Date('2026-11-18T09:01:00Z')), false)
})

test('schedule: steps, lists and ranges', () => {
  const every15 = parseCron('*/15 * * * *')
  assert.equal(isDue(every15, new Date('2026-11-18T09:15:00Z')), true)
  assert.equal(isDue(every15, new Date('2026-11-18T09:07:00Z')), false)
  const mornings = parseCron('0 9,12 * * 1-5')
  assert.equal(isDue(mornings, new Date('2026-11-16T09:00:00Z')), true) // Monday
  assert.equal(isDue(mornings, new Date('2026-11-16T12:00:00Z')), true)
  assert.equal(isDue(mornings, new Date('2026-11-16T10:00:00Z')), false)
  assert.equal(isDue(mornings, new Date('2026-11-21T09:00:00Z')), false) // Saturday
})

test('schedule: aliases and month/weekday names', () => {
  assert.deepEqual(parseCron('@daily').raw, '@daily')
  assert.equal(isDue(parseCron('@daily'), new Date('2026-11-18T00:00:00Z')), true)
  assert.equal(isDue(parseCron('@daily'), new Date('2026-11-18T00:01:00Z')), false)
  assert.equal(isDue(parseCron('0 0 1 jan *'), new Date('2026-01-01T00:00:00Z')), true)
  assert.equal(isDue(parseCron('0 0 1 jan *'), new Date('2026-02-01T00:00:00Z')), false)
  assert.equal(isDue(parseCron('0 0 * * mon'), new Date('2026-11-16T00:00:00Z')), true) // Monday
  assert.equal(isDue(parseCron('0 0 * * mon'), new Date('2026-11-17T00:00:00Z')), false) // Tuesday
  assert.equal(isDue(parseCron('0 0 * * 7'), new Date('2026-11-15T00:00:00Z')), true) // 7 = Sunday
})

test('schedule: day-of-month OR day-of-week when both are restricted', () => {
  const cron = parseCron('0 0 1 * 0') // 1st of the month OR Sunday
  assert.equal(isDue(cron, new Date('2026-11-08T00:00:00Z')), true) // Sunday, 8th
  assert.equal(isDue(cron, new Date('2026-12-01T00:00:00Z')), true) // Tuesday, 1st
  assert.equal(isDue(cron, new Date('2026-11-04T00:00:00Z')), false) // Wednesday, 4th
})

test('schedule: timezone shifts the wall-clock match', () => {
  const cron = parseCron('0 9 * * *')
  assert.equal(isDue(cron, new Date('2026-11-18T09:00:00Z')), true)
  assert.equal(isDue(cron, new Date('2026-11-18T09:00:00Z'), 'Asia/Karachi'), false) // 14:00 in Karachi
  assert.equal(isDue(cron, new Date('2026-11-18T04:00:00Z'), 'Asia/Karachi'), true) // 09:00 in Karachi
})

test('schedule: nextRun finds the next matching minute', () => {
  assert.equal(
    nextRun(parseCron('0 9 * * *'), new Date('2026-11-18T08:00:00Z')).toISOString(),
    '2026-11-18T09:00:00.000Z',
  )
  assert.equal(
    nextRun(parseCron('0 9 * * *'), new Date('2026-11-18T10:00:00Z')).toISOString(),
    '2026-11-19T09:00:00.000Z',
  )
  assert.equal(
    nextRun(parseCron('*/15 * * * *'), new Date('2026-11-18T08:07:00Z')).toISOString(),
    '2026-11-18T08:15:00.000Z',
  )
})

test('schedule: invalid expressions fail honestly', () => {
  assert.throws(() => parseCron('61 * * * *'), /out of range/)
  assert.throws(() => parseCron('0 0 * *'), /exactly 5 fields/)
  assert.throws(() => parseCron('foo * * * *'), /Bad value/)
  assert.throws(() => parseCron(''), /empty/)
  assert.equal(validateCron('61 * * * *').ok, false)
  assert.equal(validateCron('0 9 * * *').ok, true)
})

// ── Webhook registration store ─────────────────────────────────────────

test('webhooks: register/get/list/delete round-trip, test and production stay apart', async () => {
  const db = await dbFake.getDb()
  const agent = await seedAgent()
  const workflowId = String(agent._id)

  const reg = await registerWebhook(db, { workflowId, userId: USER_A, mode: 'test' })
  assert.equal(reg.workflowId, workflowId)
  assert.equal(reg.mode, 'test')
  assert.equal(reg.path, webhookPath(workflowId, 'test'))
  assert.equal(webhookPath(workflowId, 'test'), `/api/webhooks/${workflowId}/test`)

  const found = await getWebhookRegistration(db, workflowId, 'test')
  assert.equal(found.userId, USER_A)
  assert.equal(await getWebhookRegistration(db, workflowId, 'production'), null)

  // Re-registering the same mode refreshes the row instead of duplicating it.
  await registerWebhook(db, { workflowId, userId: USER_A, mode: 'test' })
  assert.equal((await listWebhookRegistrations(db, workflowId)).length, 1)

  assert.equal(await deleteWebhookRegistration(db, workflowId, 'test'), true)
  assert.equal(await getWebhookRegistration(db, workflowId, 'test'), null)
  assert.equal(await deleteWebhookRegistration(db, workflowId, 'test'), false)
})

test('webhooks: production registrations are refused (production fires on active status, not a row)', async () => {
  const db = await dbFake.getDb()
  const agent = await seedAgent()
  await assert.rejects(
    registerWebhook(db, { workflowId: String(agent._id), userId: USER_A, mode: 'production' }),
    /Only test webhooks are registered/,
  )
})

// ── Webhook route: test vs production split ────────────────────────────

test('webhook route: test URL without a registration is refused', async () => {
  const agent = await seedAgent()
  const res = await webhookPost(postRequest('http://localhost/api/webhooks/x/test', { hello: 'world' }), String(agent._id), 'test')
  assert.equal(res.status, 404)
  const body = await readJson(res)
  assert.match(body.error, /No test webhook is listening/)
})

test('webhook route: test URL with a registration runs the workflow for real', async () => {
  const db = await dbFake.getDb()
  const agent = await seedAgent()
  const workflowId = String(agent._id)
  // C-6: the test URL must carry the registration's secret as ?token=
  // (the register route returns the URL with the token; here the test
  // registered directly, so it takes the secret from the returned row).
  const reg = await registerWebhook(db, { workflowId, userId: USER_A, mode: 'test' })

  const res = await webhookPost(
    postRequest(`http://localhost/api/webhooks/x/test?token=${reg.secret}`, { hello: 'world' }),
    workflowId,
    'test',
  )
  assert.equal(res.status, 200)
  const body = await readJson(res)
  assert.equal(body.executed, true)
  // The real run path: trigger -> output passes the input through.
  assert.equal(body.output, JSON.stringify({ hello: 'world' }))
  assert.equal(body.agentId, workflowId)
  const runs = dbFake.__dump('workflow_runs')
  assert.equal(runs.length, 1)
  assert.equal(runs[0].agentId, workflowId)
})

test('webhook route: production URL refuses a draft workflow', async () => {
  const agent = await seedAgent({ status: 'draft' })
  const res = await webhookPost(postRequest('http://localhost/api/webhooks/x/production', { hello: 'world' }), String(agent._id), 'production')
  assert.equal(res.status, 403)
  const body = await readJson(res)
  assert.match(body.error, /not active/)
})

test('webhook route: production URL runs an active workflow with no registration', async () => {
  const agent = await seedAgent({ status: 'active' })
  const res = await webhookPost(postRequest('http://localhost/api/webhooks/x/production', { hello: 'world' }), String(agent._id), 'production')
  assert.equal(res.status, 200)
  const body = await readJson(res)
  assert.equal(body.executed, true)
  assert.equal(body.output, JSON.stringify({ hello: 'world' }))
})

test('webhook route: unknown mode and bad id are rejected', async () => {
  const agent = await seedAgent()
  const badMode = await webhookPost(postRequest('http://localhost/api/webhooks/x/live', {}), String(agent._id), 'live')
  assert.equal(badMode.status, 400)
  const badId = await webhookPost(postRequest('http://localhost/api/webhooks/x/test', {}), 'not-an-id', 'test')
  assert.equal(badId.status, 400)
})

test('webhook route: a Respond To Webhook node shapes the reply', async () => {
  // The respond node sits in the graph but off the string executor's path:
  // the string executor (runWorkflow) cannot execute it — Lane H wires the
  // node into the item executor. The route reads its config from the graph
  // and shapes the reply from it, which is Lane G's half of the contract.
  const agent = await seedAgent({
    status: 'active',
    workflow: {
      nodes: [
        { id: 'n1', name: 'Trigger', type: 'trigger', description: '', config: {} },
        {
          id: 'n3',
          name: 'Reply',
          type: 'respondToWebhook',
          description: '',
          config: { statusCode: 201, body: 'got it', headers: { 'X-Test': 'yes' } },
        },
        { id: 'n2', name: 'Output', type: 'output', description: '', config: {} },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    },
  })
  const res = await webhookPost(postRequest('http://localhost/api/webhooks/x/production', { hello: 'world' }), String(agent._id), 'production')
  assert.equal(res.status, 201)
  assert.equal(res.headers.get('X-Test'), 'yes')
  assert.equal(await res.text(), 'got it')
})

// ── Schedule check route ───────────────────────────────────────────────

test('triggers/check: fires a due schedule for an active agent, skips the rest', async () => {
  const now = new Date()
  const notDueMinute = (now.getUTCMinutes() + 30) % 60
  const due = await seedAgent({ status: 'active', schedule: { cron: '* * * * *', timezone: 'UTC' } })
  const notDue = await seedAgent({
    status: 'active',
    schedule: { cron: `${notDueMinute} * * * *`, timezone: 'UTC' },
  })
  const draft = await seedAgent({ status: 'draft', schedule: { cron: '* * * * *', timezone: 'UTC' } })
  const broken = await seedAgent({ status: 'active', schedule: { cron: '99 * * * *', timezone: 'UTC' } })

  const res = await triggersCheckPost(new Request('http://localhost/api/triggers/check', { method: 'POST' }))
  assert.equal(res.status, 200)
  const body = await readJson(res)
  assert.equal(body.checked, 4)
  assert.equal(body.fired.length, 1)
  assert.equal(body.fired[0].agentId, String(due._id))
  assert.equal(body.fired[0].ok, true)
  assert.match(body.fired[0].output, /Scheduled run at/)
  assert.equal(body.errors.length, 1)
  assert.equal(body.errors[0].agentId, String(broken._id))
  const skippedIds = body.skipped.map((s) => s.agentId)
  assert.ok(skippedIds.includes(String(notDue._id)))
  assert.ok(skippedIds.includes(String(draft._id)))
  const runs = dbFake.__dump('workflow_runs')
  assert.equal(runs.filter((r) => r.agentId === String(due._id)).length, 1)
})

test('triggers/check: a workflow already fired this minute is not fired twice', async () => {
  const agent = await seedAgent({ status: 'active', schedule: { cron: '* * * * *', timezone: 'UTC', lastFiredAt: new Date() } })
  const res = await triggersCheckPost(new Request('http://localhost/api/triggers/check', { method: 'POST' }))
  const body = await readJson(res)
  assert.equal(body.fired.length, 0)
  assert.equal(body.skipped[0].agentId, String(agent._id))
  assert.match(body.skipped[0].reason, /Already fired this minute/)
})

test('triggers/check: CRON_SECRET is enforced when set', async () => {
  process.env.CRON_SECRET = 'test-secret'
  const noAuth = await triggersCheckPost(new Request('http://localhost/api/triggers/check', { method: 'POST' }))
  assert.equal(noAuth.status, 401)
  const wrongAuth = await triggersCheckPost(
    new Request('http://localhost/api/triggers/check', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' },
    }),
  )
  assert.equal(wrongAuth.status, 401)
  const goodAuth = await triggersCheckPost(
    new Request('http://localhost/api/triggers/check', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-secret' },
    }),
  )
  assert.equal(goodAuth.status, 200)
})

test('triggers/check: a due time-based Wait is resumed by the sweep', async () => {
  const { saveWaitingExecution } = require('@/lib/execution/waitStore')
  const { itemFromJson } = require('@/lib/nodes/items')
  const graph = {
    nodes: [
      { id: 'w', name: 'Webhook', type: 'webhook', description: '', config: {} },
      { id: 'wait', name: 'Wait', type: 'wait', description: '', config: { amount: 3600, unit: 'seconds' } },
      { id: 's', name: 'Set', type: 'set', description: '', config: { assignments: [{ name: 'resumed', value: true }] } },
    ],
    edges: [
      { id: 'e1', source: 'w', target: 'wait' },
      { id: 'e2', source: 'wait', target: 's' },
    ],
  }
  const executionId = await saveWaitingExecution({
    executionId: new ObjectId().toHexString(),
    workflowId: 'wf-wait',
    userId: USER_A,
    nodeId: 'wait',
    resumeAt: new Date(Date.now() - 60_000),
    resumeKind: 'time',
    state: { graph, items: [itemFromJson({ n: 7 })], nodeResults: [], vars: {} },
  })
  // What a real pause leaves behind: the run row, still 'waiting'. The
  // resume updates this row to 'success' instead of inserting a second.
  const db = await dbFake.getDb()
  await db.collection('workflow_runs').insertOne({
    _id: new ObjectId(executionId),
    userId: USER_A,
    workflowId: 'wf-wait',
    status: 'waiting',
    input: '{"n":7}',
    createdAt: new Date(),
  })
  const res = await triggersCheckPost(new Request('http://localhost/api/triggers/check', { method: 'POST' }))
  assert.equal(res.status, 200)
  const body = await readJson(res)
  assert.equal(body.resumed.length, 1)
  assert.equal(body.resumed[0].executionId, executionId)
  assert.equal(body.resumed[0].status, 'success')
  assert.match(body.resumed[0].output, /"resumed":true/)
  assert.match(body.resumed[0].output, /"n":7/)
  // The waiting row is gone (deleted before the resume ran, so it runs once).
  assert.equal(dbFake.__dump('waiting_executions').length, 0)
  // One workflow_runs row for the resumed run, now success.
  const runs = dbFake.__dump('workflow_runs')
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'success')
})

// ── Form Trigger ───────────────────────────────────────────────────────

test('form: definition comes from the Form Trigger node config', async () => {
  const agent = await seedAgent({ workflow: formGraph() })
  const definition = getFormDefinition(agent)
  assert.equal(definition.title, 'Contact us')
  assert.equal(definition.description, 'Tell us what you need.')
  assert.equal(definition.fields.length, 3)
  assert.equal(definition.fields[0].name, 'name')
  assert.equal(definition.fields[2].type, 'select')
  assert.deepEqual(definition.fields[2].options, ['sales', 'support'])
})

test('form: no Form Trigger node means no form', async () => {
  const agent = await seedAgent()
  assert.equal(getFormDefinition(agent), null)
})

test('form: submission runs the workflow for real', async () => {
  const db = await dbFake.getDb()
  const agent = await seedAgent({ workflow: formGraph() })
  const result = await runFormSubmission(db, String(agent._id), { name: 'Zohaib', message: 'hi' })
  assert.equal(result.ok, true)
  assert.equal(result.output, JSON.stringify({ name: 'Zohaib', message: 'hi' }))
  const runs = dbFake.__dump('workflow_runs')
  assert.equal(runs.length, 1)
})

test('form: submission without a Form Trigger node fails honestly', async () => {
  const db = await dbFake.getDb()
  const agent = await seedAgent()
  await assert.rejects(
    runFormSubmission(db, String(agent._id), { input: 'hi' }),
    /no Form Trigger/,
  )
})

test('form route: JSON POST runs the workflow and returns the output', async () => {
  const agent = await seedAgent({ workflow: formGraph() })
  const res = await formsPost(postRequest('http://localhost/api/forms/x', { name: 'Zohaib', message: 'hi' }), String(agent._id) )
  assert.equal(res.status, 200)
  const body = await readJson(res)
  assert.equal(body.executed, true)
  assert.equal(body.output, JSON.stringify({ name: 'Zohaib', message: 'hi' }))
})

test('form route: GET returns the definition, 404 without a Form Trigger', async () => {
  const withForm = await seedAgent({ workflow: formGraph() })
  const res = await formsGet(String(withForm._id) )
  assert.equal(res.status, 200)
  const body = await readJson(res)
  assert.equal(body.title, 'Contact us')

  const withoutForm = await seedAgent()
  const missing = await formsGet(String(withoutForm._id) )
  assert.equal(missing.status, 404)
})

// ── Respond To Webhook shaping ─────────────────────────────────────────

test('respond: shaping honours status, body and headers; bad status falls back to 200', () => {
  const shaped = shapeRespondResponse(
    { statusCode: 201, body: 'done', headers: { 'X-A': 'b' } },
    'fallback',
  )
  assert.equal(shaped.status, 201)
  assert.equal(shaped.body, 'done')
  assert.equal(shaped.headers['X-A'], 'b')
  assert.equal(shaped.headers['content-type'], 'text/plain; charset=utf-8')

  const fallback = shapeRespondResponse({}, '{"ok":true}')
  assert.equal(fallback.status, 200)
  assert.equal(fallback.body, '{"ok":true}')
  assert.equal(fallback.headers['content-type'], 'application/json; charset=utf-8')

  assert.equal(shapeRespondResponse({ statusCode: 99 }, 'x').status, 200)
  assert.equal(shapeRespondResponse({ statusCode: 'nope' }, 'x').status, 200)
})

test('respond: no respond node means the route returns the run output', () => {
  assert.equal(resolveWebhookResponse(echoGraph(), 'hello'), null)
  const graph = {
    nodes: [
      { id: 'n1', name: 'Trigger', type: 'trigger', description: '', config: {} },
      { id: 'n3', name: 'Reply', type: 'respondToWebhook', description: '', config: { statusCode: 202, body: 'accepted' } },
    ],
    edges: [],
  }
  const shaped = resolveWebhookResponse(graph, 'hello')
  assert.equal(shaped.status, 202)
  assert.equal(shaped.body, 'accepted')
  assert.equal(findRespondNode(echoGraph()), null)
  assert.equal(findRespondNode(graph).name, 'Reply')
})

// ── Trigger node descriptions ──────────────────────────────────────────

test('descriptions: the registry holds the trigger types (canonical, Lane E)', () => {
  for (const name of ['webhook', 'schedule', 'manualTrigger', 'formTrigger', 'respondToWebhook']) {
    const desc = getNodeType(name)
    assert.ok(desc, `${name} should be registered`)
    assert.equal(desc.version, 1)
    assert.ok(desc.group.includes('trigger') || name === 'respondToWebhook')
  }
  assert.equal(getNodeType('webhook').webhooks, true)
  assert.equal(defaultVersion('webhook'), 1)
  const triggers = listNodeTypes('trigger').map((d) => d.name)
  for (const name of ['webhook', 'schedule', 'manualTrigger', 'errorTrigger', 'formTrigger', 'executeWorkflowTrigger']) {
    assert.ok(triggers.includes(name), `${name} should list under trigger`)
  }
  assert.equal(triggers.length, 6)
  const webhook = getNodeType('webhook')
  assert.ok(webhook.properties.some((p) => p.name === 'httpMethod'))
  const schedule = getNodeType('schedule')
  assert.ok(schedule.properties.some((p) => p.name === 'cronExpression'))
  const form = getNodeType('formTrigger')
  assert.ok(form.properties.some((p) => p.name === 'formFields'))
  const respond = getNodeType('respondToWebhook')
  assert.ok(respond.properties.some((p) => p.name === 'responseCode'))
})

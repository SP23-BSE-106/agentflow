/**
 * Conversational supervisor unit tests (Lane D1).
 *
 * Direct-call unit tests for the supervisor-as-team-lead behaviour:
 * - frozen turn-format parsing (parseSupervisorTurn)
 * - turn recipient resolution (resolveTurnRecipient)
 * - supervisor decision parsing (parseSupervisorDecision)
 * - re-plan validation: cycle detection + dropped-task rule +
 *   executed-task preservation (validateReplan, validateSupervisorPlan)
 * - conversational wave levels (conversationWaveLevels)
 * - generateSupervisorPlan accepts {conversational} (flag accepted, plan
 *   shape identical either way) — via the canned LLM fake
 * - executeSupervisorPlan fixed path (no flag) still completes and
 *   returns no conversation summary — via fake DB + canned LLM fake
 * - executeSupervisorPlan conversational path with an LLM that never asks
 *   ends cleanly as done, with a conversation summary and the same results
 *   as the fixed path — via fake DB + canned LLM fake
 *
 * NOTE (scope): this file is not yet required by tests/phase3/run.cjs —
 * that file belongs to the merge lane. Run this file standalone:
 *   TMPDIR=<disk-backed> npx tsc -p tests/phase3/tsconfig.json
 *   node -e "require('./tests/phase3/hooks.cjs'); require('./tests/phase3/cases/team-supervisor-lead.cjs'); require('./tests/phase3/harness.cjs').run()"
 */
'use strict'

const { test, assert } = require('../harness.cjs')
const dbFake = require('../fakes/db.cjs')
const llmFake = require('../fakes/llm.cjs')

const supervisor = require('@/lib/orchestration/supervisor')

const AGENTS = [
  { id: 'agent-1', name: 'Researcher', role: 'researcher', capabilities: ['research'] },
  { id: 'agent-2', name: 'Writer', role: 'writer', capabilities: ['writing'] },
  { id: 'agent-3', name: 'Critic', role: 'critic', capabilities: ['review'] },
]

function planWith(tasks, objective = 'Test objective') {
  return { objective, tasks, completionCriteria: ['done'] }
}

function task(temporaryId, agentId, dependsOn = []) {
  return {
    temporaryId,
    agentId,
    description: `Task ${temporaryId}`,
    dependsOn,
    expectedOutput: `Output ${temporaryId}`,
  }
}

/* ── parseSupervisorTurn ─────────────────────────────────────────── */

test('supervisor-turn: final JSON parses to a final turn', async () => {
  const turn = supervisor.parseSupervisorTurn('{"kind":"final","text":"The answer is 42."}')
  assert.strictEqual(turn.kind, 'final')
  assert.strictEqual(turn.text, 'The answer is 42.')
})

test('supervisor-turn: message JSON parses with requiresResponse', async () => {
  const turn = supervisor.parseSupervisorTurn(
    '{"kind":"message","to":"researcher","text":"What are the 2026 figures?","requiresResponse":true}',
  )
  assert.strictEqual(turn.kind, 'message')
  assert.strictEqual(turn.to, 'researcher')
  assert.strictEqual(turn.text, 'What are the 2026 figures?')
  assert.strictEqual(turn.requiresResponse, true)
})

test('supervisor-turn: message without requiresResponse defaults to false', async () => {
  const turn = supervisor.parseSupervisorTurn(
    '{"kind":"message","to":"Writer","text":"Heads up."}',
  )
  assert.strictEqual(turn.kind, 'message')
  assert.strictEqual(turn.requiresResponse, false)
})

test('supervisor-turn: fenced JSON parses', async () => {
  const turn = supervisor.parseSupervisorTurn(
    '```json\n{"kind":"final","text":"Done."}\n```',
  )
  assert.strictEqual(turn.kind, 'final')
  assert.strictEqual(turn.text, 'Done.')
})

test('supervisor-turn: unparsable output is a final turn carrying the raw text', async () => {
  const raw = 'Just a plain answer, no JSON at all.'
  const turn = supervisor.parseSupervisorTurn(raw)
  assert.strictEqual(turn.kind, 'final')
  assert.strictEqual(turn.text, raw)
})

test('supervisor-turn: JSON without a kind is a final turn carrying the raw text', async () => {
  const raw = '{"summary":"not a turn"}'
  const turn = supervisor.parseSupervisorTurn(raw)
  assert.strictEqual(turn.kind, 'final')
  assert.strictEqual(turn.text, raw)
})

/* ── resolveTurnRecipient ────────────────────────────────────────── */

test('supervisor-turn: recipient resolves by id, then role, then name', async () => {
  assert.strictEqual(supervisor.resolveTurnRecipient('agent-2', AGENTS).id, 'agent-2')
  assert.strictEqual(supervisor.resolveTurnRecipient('RESEARCHER', AGENTS).id, 'agent-1')
  assert.strictEqual(supervisor.resolveTurnRecipient('writer', AGENTS).id, 'agent-2')
  assert.strictEqual(supervisor.resolveTurnRecipient('Critic', AGENTS).id, 'agent-3')
})

test('supervisor-turn: unknown recipient throws an honest error', async () => {
  assert.throws(
    () => supervisor.resolveTurnRecipient('nobody', AGENTS),
    /unknown agent "nobody"/,
  )
  assert.throws(
    () => supervisor.resolveTurnRecipient('   ', AGENTS),
    /no recipient/,
  )
})

/* ── parseSupervisorDecision ─────────────────────────────────────── */

test('supervisor-decision: done JSON parses to done', async () => {
  const d = supervisor.parseSupervisorDecision('{"decision":"done","reason":"All criteria met."}')
  assert.strictEqual(d.decision, 'done')
  assert.strictEqual(d.reason, 'All criteria met.')
})

test('supervisor-decision: ask JSON parses with recipient and question', async () => {
  const d = supervisor.parseSupervisorDecision(
    '{"decision":"ask","to":"researcher","question":"What are the 2026 figures?"}',
  )
  assert.strictEqual(d.decision, 'ask')
  assert.strictEqual(d.to, 'researcher')
  assert.strictEqual(d.question, 'What are the 2026 figures?')
})

test('supervisor-decision: unparsable output is done, never a guessed question', async () => {
  const d = supervisor.parseSupervisorDecision('I think we should ask someone something.')
  assert.strictEqual(d.decision, 'done')
})

test('supervisor-decision: ask without a question is done', async () => {
  const d = supervisor.parseSupervisorDecision('{"decision":"ask","to":"researcher"}')
  assert.strictEqual(d.decision, 'done')
})

/* ── validateReplan ──────────────────────────────────────────────── */

test('replan: resurrecting a dropped task is invalid', async () => {
  const previous = planWith([task('t1', 'agent-1'), task('t2', 'agent-2', ['t1'])])
  const revised = planWith([task('t1', 'agent-1'), task('t2', 'agent-2', ['t1'])])
  const result = supervisor.validateReplan({
    previousPlan: previous,
    revisedPlan: revised,
    droppedTaskIds: ['t2'],
    executedTaskIds: ['t1'],
    agents: AGENTS,
  })
  assert.strictEqual(result.valid, false)
  assert.ok(result.errors.some((e) => /resurrects dropped task "t2"/.test(e)))
})

test('replan: dropping an already-executed task is invalid', async () => {
  const previous = planWith([task('t1', 'agent-1'), task('t2', 'agent-2', ['t1'])])
  // The revised plan drops executed t1 and keeps only t2 (with its
  // dependency on t1 removed, so the only error is the dropped-executed
  // one — the scenario the test name describes).
  const revised = planWith([task('t2', 'agent-2')])
  const result = supervisor.validateReplan({
    previousPlan: previous,
    revisedPlan: revised,
    droppedTaskIds: [],
    executedTaskIds: ['t1'],
    agents: AGENTS,
  })
  assert.strictEqual(result.valid, false)
  assert.ok(result.errors.some((e) => /drops already-executed task "t1"/.test(e)))
})

test('replan: modifying an already-executed task is invalid', async () => {
  const previous = planWith([task('t1', 'agent-1'), task('t2', 'agent-2', ['t1'])])
  const modified = task('t1', 'agent-1')
  modified.description = 'Task t1 rewritten'
  const revised = planWith([modified, task('t2', 'agent-2', ['t1'])])
  const result = supervisor.validateReplan({
    previousPlan: previous,
    revisedPlan: revised,
    droppedTaskIds: [],
    executedTaskIds: ['t1'],
    agents: AGENTS,
  })
  assert.strictEqual(result.valid, false)
  assert.ok(result.errors.some((e) => /modifies already-executed task "t1"/.test(e)))
})

test('replan: dropping a pending task and adding a follow-up is valid', async () => {
  const previous = planWith([
    task('t1', 'agent-1'),
    task('t2', 'agent-2', ['t1']),
    task('t3', 'agent-3', ['t1']),
  ])
  const revised = planWith([
    task('t1', 'agent-1'),
    task('t3', 'agent-3', ['t1']),
    task('t-new-1', 'agent-2', ['t3']),
  ])
  const result = supervisor.validateReplan({
    previousPlan: previous,
    revisedPlan: revised,
    droppedTaskIds: [],
    executedTaskIds: ['t1'],
    agents: AGENTS,
  })
  assert.strictEqual(result.valid, true, `expected valid, got: ${result.errors.join('; ')}`)
  assert.deepStrictEqual(result.newlyDropped, ['t2'])
})

test('replan: a dependency cycle in the revised plan is invalid', async () => {
  const previous = planWith([task('t1', 'agent-1'), task('t2', 'agent-2')])
  const revised = planWith([
    task('t1', 'agent-1', ['t2']),
    task('t2', 'agent-2', ['t1']),
  ])
  const result = supervisor.validateReplan({
    previousPlan: previous,
    revisedPlan: revised,
    droppedTaskIds: [],
    executedTaskIds: [],
    agents: AGENTS,
  })
  assert.strictEqual(result.valid, false)
  assert.ok(result.errors.some((e) => /cycle/i.test(e)))
})

test('replan: a revised plan referencing an unknown agent is invalid', async () => {
  const previous = planWith([task('t1', 'agent-1')])
  const revised = planWith([task('t1', 'agent-1'), task('t-new-1', 'agent-9', ['t1'])])
  const result = supervisor.validateReplan({
    previousPlan: previous,
    revisedPlan: revised,
    droppedTaskIds: [],
    executedTaskIds: ['t1'],
    agents: AGENTS,
  })
  assert.strictEqual(result.valid, false)
  assert.ok(result.errors.some((e) => /unknown agent "agent-9"/.test(e)))
})

/* ── validateSupervisorPlan cycle detection ──────────────────────── */

test('plan-validation: a two-task dependency cycle is invalid', async () => {
  const plan = planWith([
    task('t1', 'agent-1', ['t2']),
    task('t2', 'agent-2', ['t1']),
  ])
  const result = supervisor.validateSupervisorPlan(plan, AGENTS)
  assert.strictEqual(result.valid, false)
  assert.ok(result.errors.some((e) => /cycle/i.test(e)))
})

test('plan-validation: a self-dependency is invalid', async () => {
  const plan = planWith([task('t1', 'agent-1', ['t1'])])
  const result = supervisor.validateSupervisorPlan(plan, AGENTS)
  assert.strictEqual(result.valid, false)
})

/* ── conversationWaveLevels ──────────────────────────────────────── */

test('supervisor-waves: independent tasks share a wave, dependents go later', async () => {
  const waves = supervisor.conversationWaveLevels([
    task('t1', 'agent-1'),
    task('t2', 'agent-2'),
    task('t3', 'agent-3', ['t1', 't2']),
    task('t4', 'agent-1', ['t3']),
  ])
  assert.strictEqual(waves.length, 3)
  assert.deepStrictEqual(waves[0].map((t) => t.temporaryId).sort(), ['t1', 't2'])
  assert.deepStrictEqual(waves[1].map((t) => t.temporaryId), ['t3'])
  assert.deepStrictEqual(waves[2].map((t) => t.temporaryId), ['t4'])
})

test('supervisor-waves: a chain of three is three waves in order', async () => {
  const waves = supervisor.conversationWaveLevels([
    task('t1', 'agent-1'),
    task('t2', 'agent-2', ['t1']),
    task('t3', 'agent-3', ['t2']),
  ])
  assert.deepStrictEqual(waves.map((w) => w.map((t) => t.temporaryId)), [['t1'], ['t2'], ['t3']])
})

/* ── generateSupervisorPlan accepts {conversational} ─────────────── */

test('supervisor-plan: generateSupervisorPlan accepts conversational flag, same plan shape', async () => {
  const planJson = JSON.stringify(
    planWith([task('t1', 'agent-1'), task('t2', 'agent-2', ['t1'])]),
  )
  llmFake.__setText(planJson)
  const plain = await supervisor.generateSupervisorPlan('user-a', 'Do the job', AGENTS)
  const conversational = await supervisor.generateSupervisorPlan('user-a', 'Do the job', AGENTS, {
    conversational: true,
  })
  assert.deepStrictEqual(conversational, plain)
  assert.strictEqual(conversational.tasks.length, 2)
  assert.strictEqual(llmFake.__calls().length, 2)
})

/* ── executeSupervisorPlan: fixed vs conversational (fake DB + LLM) ─ */

function fullAgents() {
  return AGENTS.map((a) => ({
    _id: a.id,
    name: a.name,
    role: a.role,
    capabilities: a.capabilities.map((name) => ({ name })),
    systemPrompt: '',
    maxTokenBudget: 512,
  }))
}

test('supervisor-execute: fixed path (no flag) completes with no conversation summary', async () => {
  llmFake.__setText('TEST-LLM-ANSWER')
  const plan = planWith([task('t1', 'agent-1'), task('t2', 'agent-2', ['t1'])])
  const result = await supervisor.executeSupervisorPlan(
    'user-a',
    'run-fixed-1',
    plan,
    fullAgents(),
    { originalInput: 'Do the job' },
  )
  assert.strictEqual(result.completed, 2, `expected 2 completed, got ${result.completed}`)
  assert.strictEqual(result.failed, 0)
  assert.strictEqual(result.conversation, undefined)
  assert.strictEqual(result.finalOutput.t1, 'TEST-LLM-ANSWER')
  assert.strictEqual(result.finalOutput.t2, 'TEST-LLM-ANSWER')
  // No conversation messages: only the two task result messages exist.
  const messages = await dbFake.__db.collection('agent_messages').find({}).toArray()
  assert.ok(
    messages.every((m) => m.type === 'result'),
    `expected only result messages, got: ${messages.map((m) => m.type).join(',')}`,
  )
})

test('supervisor-execute: conversational path with an LLM that never asks ends done, same results', async () => {
  // The canned LLM answers every call with plain text, which the decision
  // parser treats as done — so the run ends after the waves with a summary
  // and the same task results as the fixed path.
  llmFake.__setText('TEST-LLM-ANSWER')
  const plan = planWith([task('t1', 'agent-1'), task('t2', 'agent-2', ['t1'])])
  const result = await supervisor.executeSupervisorPlan(
    'user-a',
    'run-conv-1',
    plan,
    fullAgents(),
    { originalInput: 'Do the job', conversational: true },
  )
  assert.strictEqual(result.completed, 2, `expected 2 completed, got ${result.completed}`)
  assert.strictEqual(result.failed, 0)
  assert.strictEqual(result.finalOutput.t1, 'TEST-LLM-ANSWER')
  assert.strictEqual(result.finalOutput.t2, 'TEST-LLM-ANSWER')
  assert.ok(result.conversation, 'expected a conversation summary')
  assert.strictEqual(result.conversation.exchanges, 0)
  assert.strictEqual(result.conversation.questionsAsked, 0)
  assert.strictEqual(result.conversation.planRevisions, 0)
  assert.strictEqual(result.conversation.endedBecause, 'final')
  assert.deepStrictEqual(result.conversation.pendingTaskIds, [])
  // The summary is also persisted to shared context.
  const shared = await dbFake.__db.collection('shared_contexts').findOne({ workflowRunId: 'run-conv-1' })
  assert.ok(shared, 'expected a shared context record')
  assert.strictEqual(shared.variables.supervisorConversation.endedBecause, 'final')
})

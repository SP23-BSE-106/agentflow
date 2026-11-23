/**
 * Team blackboard context — unit tests (multi-agent team, lane C2).
 *
 * Direct calls against the real `contextManager` reader, with the
 * in-memory fake DB standing in for Mongo (same harness as the other
 * Phase 3 cases). No LLM is involved: these tests prove the context
 * mechanics — assembly, gating, rendering, truncation.
 *
 * Run standalone (after the Phase 3 compile, which emits
 * `contextManager`/`messageBus` into `out/` via the orchestrator import):
 *   npx tsc -p tests/phase3/tsconfig.json
 *   node tests/phase3/cases/team-blackboard-context.cjs
 *
 * Standalone by design: `tests/phase3/run.cjs` does not load this file,
 * so the lane's file scope stays at exactly two files.
 */
'use strict'

require('../hooks.cjs')

const { test, assert } = require('../harness.cjs')
const dbFake = require('../fakes/db.cjs')

const {
  getTeamTurnContext,
  getSharedContextForTeamTurn,
  renderBlackboardText,
  isTeamRun,
  TEAM_BLACKBOARD_MAX_CHARS,
} = require('@/lib/orchestration/contextManager')
const { createMessage } = require('@/lib/orchestration/messageBus')
const { updateSharedContext } = require('@/lib/orchestration/contextManager')

const USER = 'user-team-test'
const RUN = 'run-team-test'

function blankContext(overrides = {}) {
  return {
    userId: USER,
    workflowRunId: RUN,
    variables: {},
    documents: [],
    intermediateResults: {},
    decisions: [],
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function message(from, to, text, type = 'task') {
  return {
    userId: USER,
    workflowId: RUN,
    workflowRunId: RUN,
    fromAgentId: from,
    toAgentId: to,
    type,
    status: 'delivered',
    text,
    priority: 'normal',
    requiresResponse: false,
    retryCount: 0,
    createdAt: new Date(),
  }
}

async function seedExchange() {
  await createMessage({
    userId: USER,
    workflowId: RUN,
    workflowRunId: RUN,
    fromAgentId: 'agent-researcher',
    toAgentId: 'agent-writer',
    type: 'task',
    text: 'What are the 2026 figures for the launch?',
    requiresResponse: true,
  })
  await createMessage({
    userId: USER,
    workflowId: RUN,
    workflowRunId: RUN,
    fromAgentId: 'agent-writer',
    toAgentId: 'agent-researcher',
    type: 'result',
    text: 'The 2026 figures are 42,000 units in Q1.',
    requiresResponse: false,
  })
}

test('team gate: >=2 distinct agents is a team run; one, duplicates, blanks are not', () => {
  assert.strictEqual(isTeamRun(['a', 'b']), true)
  assert.strictEqual(isTeamRun(['a', 'b', 'c']), true)
  assert.strictEqual(isTeamRun(['a']), false)
  assert.strictEqual(isTeamRun([]), false)
  assert.strictEqual(isTeamRun(['a', 'a']), false)
  assert.strictEqual(isTeamRun(['a', 'a', 'b', 'b']), true)
  assert.strictEqual(isTeamRun(['a', ' ', '', null, undefined]), false)
  assert.strictEqual(isTeamRun([' a ', 'a']), false)
})

test('render: variables + intermediate results + full conversation, oldest first', () => {
  const text = renderBlackboardText(
    blankContext({
      variables: { topic: 'launch' },
      intermediateResults: { 'node-1': 'draft done' },
    }),
    [
      message('agent-researcher', 'agent-writer', 'What are the 2026 figures?'),
      message('agent-writer', 'agent-researcher', 'The 2026 figures are 42,000 units in Q1.', 'result'),
    ],
  )
  assert.ok(text.includes('launch'), text)
  assert.ok(text.includes('draft done'), text)
  assert.ok(text.includes('What are the 2026 figures?'), text)
  assert.ok(text.includes('42,000 units'), text)
  assert.ok(
    text.indexOf('What are the 2026 figures?') < text.indexOf('42,000 units'),
    'conversation is oldest first',
  )
  assert.ok(text.includes('2 messages'), text)
})

test('render: empty conversation renders without messages', () => {
  const text = renderBlackboardText(blankContext({ variables: { topic: 'launch' } }), [])
  assert.ok(text.includes('(no messages yet)'), text)
  assert.ok(text.includes('launch'), text)
})

test('render: conversation cap drops the oldest messages first and reports the count', () => {
  const conversation = Array.from({ length: 6 }, (_, i) =>
    message(`agent-${i % 2}`, undefined, `message number ${i} with some padding text to fill the cap`),
  )
  const text = renderBlackboardText(blankContext(), conversation, { maxChars: 120 })
  assert.ok(!text.includes('message number 0'), 'oldest message dropped: ' + text)
  assert.ok(text.includes('message number 5'), 'newest message kept: ' + text)
  assert.ok(/earlier messages? omitted/.test(text), 'omission reported: ' + text)
  const conversationPart = text.slice(text.indexOf('Team conversation'))
  assert.ok(conversationPart.length <= 120 + 80, `capped, got ${conversationPart.length}`)
})

test('render: default cap is 6000 chars', () => {
  assert.strictEqual(TEAM_BLACKBOARD_MAX_CHARS, 6000)
})

test('reader: a third agent sees the first two agents\' question + answer', async () => {
  await seedExchange()
  const result = await getTeamTurnContext(USER, RUN, [
    'agent-researcher',
    'agent-writer',
    'agent-editor',
  ])
  assert.strictEqual(result.isTeamRun, true)
  assert.strictEqual(result.conversation.length, 2)
  assert.ok(result.blackboardText.includes('What are the 2026 figures for the launch?'))
  assert.ok(result.blackboardText.includes('The 2026 figures are 42,000 units in Q1.'))
  assert.ok(
    result.blackboardText.indexOf('What are the 2026 figures') <
      result.blackboardText.indexOf('42,000 units'),
    'third agent sees the exchange in order',
  )
})

test('reader: variables + intermediate results from SharedContext appear in the blackboard', async () => {
  await seedExchange()
  await updateSharedContext(USER, RUN, {
    variables: { region: 'Karachi' },
    intermediateResults: { 'node-research': 'figures gathered' },
  })
  const result = await getTeamTurnContext(USER, RUN, ['agent-researcher', 'agent-writer'])
  assert.ok(result.blackboardText.includes('Karachi'), result.blackboardText)
  assert.ok(result.blackboardText.includes('figures gathered'), result.blackboardText)
  assert.strictEqual(result.sharedContext.variables.region, 'Karachi')
  assert.strictEqual(result.sharedContext.intermediateResults['node-research'], 'figures gathered')
})

test('reader: single-agent run is a no-op — empty text and no database writes', async () => {
  const result = await getTeamTurnContext(USER, RUN, ['agent-only'])
  assert.strictEqual(result.isTeamRun, false)
  assert.strictEqual(result.blackboardText, '')
  assert.strictEqual(result.sharedContext, null)
  assert.deepStrictEqual(result.conversation, [])
  // The no-op path must not create a shared-context doc or touch messages.
  assert.deepStrictEqual(dbFake.__dump('shared_contexts'), [])
  assert.deepStrictEqual(dbFake.__dump('agent_messages'), [])
})

test('reader: getSharedContextForTeamTurn returns shared context + full conversation', async () => {
  await seedExchange()
  await updateSharedContext(USER, RUN, { variables: { topic: 'launch' } })
  const { sharedContext, conversation } = await getSharedContextForTeamTurn(USER, RUN)
  assert.strictEqual(sharedContext.variables.topic, 'launch')
  assert.strictEqual(conversation.length, 2)
  assert.strictEqual(conversation[0].fromAgentId, 'agent-researcher')
  assert.strictEqual(conversation[1].fromAgentId, 'agent-writer')
})

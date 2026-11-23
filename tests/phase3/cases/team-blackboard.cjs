/**
 * Shared-blackboard unit tests (multi-agent team, lane C1).
 *
 * The blackboard is the one file this lane owns
 * (src/lib/orchestration/blackboard.ts): the team conversation lives in
 * the existing agent_messages bus, variables / intermediate results in
 * the existing shared_contexts record — no new store, no wiring in this
 * file. These tests call the module directly against the phase-3 fake
 * DB (labelled unit tests in the lane report); the live proof against
 * real mongod is a separate script, not this file.
 *
 * NOTE (merge lane): this case file is not yet required from
 * tests/phase3/run.cjs and blackboard.ts is not yet in
 * tests/phase3/tsconfig.json — both one-line additions live as a patch
 * in ~/workspace/fypagentflow-audit/multi-agent-team/tmp-c1/.
 * Until then, run this file standalone with the tmp-c1 runner
 * (see lane-c1.md).
 */
'use strict'

const { test, assert } = require('../harness.cjs')
const { ObjectId } = require('mongodb')
const dbFake = require('../fakes/db.cjs')

const blackboard = require('@/lib/orchestration/blackboard')

// Fixed user id (the auth tree's jwt fake uses this same value as
// USER_A_ID). The test must not require the jwt fake: the no-auth tree
// deleted it with the login system, and the blackboard never touches auth.
const USER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const RUN_ID = 'run-blackboard-1'
const WORKFLOW_ID = 'wf-blackboard-1'

async function seedAgents() {
  const db = dbFake.__db
  const researcherId = new ObjectId()
  const writerId = new ObjectId()
  const reviewerId = new ObjectId()
  await db.collection('agents').insertOne({
    _id: researcherId,
    userId: USER_ID,
    name: 'Rae Researcher',
    role: 'researcher',
    status: 'active',
    createdAt: new Date(),
  })
  await db.collection('agents').insertOne({
    _id: writerId,
    userId: USER_ID,
    name: 'Walt Writer',
    role: 'writer',
    status: 'active',
    createdAt: new Date(),
  })
  await db.collection('agents').insertOne({
    _id: reviewerId,
    userId: USER_ID,
    name: 'Rita Reviewer',
    role: 'reviewer',
    status: 'active',
    createdAt: new Date(),
  })
  return {
    researcherId: String(researcherId),
    writerId: String(writerId),
    reviewerId: String(reviewerId),
  }
}

test('blackboard: question + answer between two agents are visible to a third', async () => {
  const { researcherId, writerId } = await seedAgents()

  const question = await blackboard.appendToBlackboard({
    userId: USER_ID,
    workflowId: WORKFLOW_ID,
    workflowRunId: RUN_ID,
    fromAgentId: writerId,
    toAgentId: researcherId,
    kind: 'question',
    text: 'What are the 2026 launch figures?',
  })
  assert.strictEqual(question.type, 'task')
  assert.strictEqual(question.requiresResponse, true)

  const answer = await blackboard.appendToBlackboard({
    userId: USER_ID,
    workflowId: WORKFLOW_ID,
    workflowRunId: RUN_ID,
    fromAgentId: researcherId,
    toAgentId: writerId,
    parentMessageId: String(question._id),
    kind: 'answer',
    text: 'The 2026 launch figures are 42,000 units.',
  })
  assert.strictEqual(answer.type, 'result')
  assert.strictEqual(answer.parentMessageId, String(question._id))

  // The third agent (reviewer) reads the same blackboard.
  const board = await blackboard.readBlackboard(RUN_ID, USER_ID)
  assert.strictEqual(board.conversation.length, 2)
  assert.strictEqual(board.conversation[0].fromName, 'Walt Writer')
  assert.strictEqual(board.conversation[0].fromRole, 'writer')
  assert.strictEqual(board.conversation[0].toName, 'Rae Researcher')
  assert.strictEqual(board.conversation[0].text, 'What are the 2026 launch figures?')
  assert.strictEqual(board.conversation[1].fromName, 'Rae Researcher')
  assert.strictEqual(board.conversation[1].text, 'The 2026 launch figures are 42,000 units.')

  const rendered = blackboard.renderBlackboardText(board)
  assert.ok(rendered.includes('What are the 2026 launch figures?'), 'rendered text misses the question')
  assert.ok(rendered.includes('42,000 units'), 'rendered text misses the answer')
  assert.ok(rendered.includes('Walt Writer (writer)'), 'rendered text misses name/role')
  assert.ok(rendered.includes('Rae Researcher (researcher)'), 'rendered text misses name/role')
})

test('blackboard: a variable set via the blackboard is visible in the next read', async () => {
  await seedAgents()
  const before = await blackboard.getBlackboardVariables(RUN_ID, USER_ID)
  assert.deepStrictEqual(before, {})

  const vars = await blackboard.setBlackboardVariable(RUN_ID, USER_ID, 'launchFigures', 42000)
  assert.strictEqual(vars.launchFigures, 42000)

  const after = await blackboard.getBlackboardVariables(RUN_ID, USER_ID)
  assert.strictEqual(after.launchFigures, 42000)

  const board = await blackboard.readBlackboard(RUN_ID, USER_ID)
  assert.strictEqual(board.variables.launchFigures, 42000)
  const rendered = blackboard.renderBlackboardText(board)
  assert.ok(rendered.includes('launchFigures'), 'rendered text misses the variable')
  assert.ok(rendered.includes('42000'), 'rendered text misses the variable value')
})

test('blackboard: empty run renders an empty conversation, not a crash', async () => {
  const board = await blackboard.readBlackboard(RUN_ID, USER_ID)
  assert.deepStrictEqual(board.conversation, [])
  assert.deepStrictEqual(board.variables, {})
  assert.deepStrictEqual(board.intermediateResults, {})
  const rendered = blackboard.renderBlackboardText(board)
  assert.ok(rendered.includes('no teammate messages yet'))
})

test('blackboard: render truncates oldest-first and says how many were omitted', async () => {
  const { researcherId, writerId } = await seedAgents()
  for (let i = 1; i <= 5; i++) {
    await blackboard.appendToBlackboard({
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      workflowRunId: RUN_ID,
      fromAgentId: i % 2 === 0 ? researcherId : writerId,
      kind: 'note',
      text: `note number ${i} with some padding text to use up budget`,
    })
  }
  const board = await blackboard.readBlackboard(RUN_ID, USER_ID)
  assert.strictEqual(board.conversation.length, 5)

  const rendered = blackboard.renderBlackboardText(board, { maxConversationChars: 120 })
  assert.ok(!rendered.includes('note number 1'), 'oldest message should be omitted')
  assert.ok(rendered.includes('note number 5'), 'newest message should be kept')
  assert.ok(/(\d+) earlier message\(s\) omitted/.test(rendered), 'omission count not stated')
  const omitted = Number(rendered.match(/(\d+) earlier message\(s\) omitted/)[1])
  assert.ok(omitted >= 1 && omitted <= 4, `omitted count ${omitted} out of range`)
})

test('blackboard: a message from an unknown agent id is still shown, as its id', async () => {
  const ghostId = String(new ObjectId())
  await blackboard.appendToBlackboard({
    userId: USER_ID,
    workflowId: WORKFLOW_ID,
    workflowRunId: RUN_ID,
    fromAgentId: ghostId,
    kind: 'note',
    text: 'ghost note',
  })
  const board = await blackboard.readBlackboard(RUN_ID, USER_ID)
  assert.strictEqual(board.conversation.length, 1)
  assert.strictEqual(board.conversation[0].fromName, ghostId)
  assert.ok(blackboard.renderBlackboardText(board).includes('ghost note'))
})

test('blackboard: parseTurnOutput handles final, message, fenced and unparsable output', async () => {
  const final = blackboard.parseTurnOutput(JSON.stringify({ kind: 'final', text: 'done here' }))
  assert.deepStrictEqual(final, { kind: 'final', text: 'done here' })

  const message = blackboard.parseTurnOutput(
    JSON.stringify({
      kind: 'message',
      to: 'researcher',
      text: 'What are the figures?',
      requiresResponse: true,
    }),
  )
  assert.deepStrictEqual(message, {
    kind: 'message',
    to: 'researcher',
    text: 'What are the figures?',
    requiresResponse: true,
  })

  const fenced = blackboard.parseTurnOutput(
    '```json\n' + JSON.stringify({ kind: 'final', text: 'fenced answer' }) + '\n```',
  )
  assert.deepStrictEqual(fenced, { kind: 'final', text: 'fenced answer' })

  const plain = blackboard.parseTurnOutput('just a plain answer, no JSON at all')
  assert.deepStrictEqual(plain, { kind: 'final', text: 'just a plain answer, no JSON at all' })

  const malformed = blackboard.parseTurnOutput(
    JSON.stringify({ kind: 'message', text: 'no recipient here' }),
  )
  assert.strictEqual(malformed.kind, 'final')
  assert.ok(malformed.text.includes('no recipient here'))

  const noResponseFlag = blackboard.parseTurnOutput(
    JSON.stringify({ kind: 'message', to: 'writer', text: 'fyi' }),
  )
  assert.strictEqual(noResponseFlag.kind, 'message')
  assert.strictEqual(noResponseFlag.requiresResponse, false)

  // Draft-name aliases behave identically.
  assert.deepStrictEqual(
    blackboard.parseAgentTurn(JSON.stringify({ kind: 'final', text: 'x' })),
    { kind: 'final', text: 'x' },
  )
  assert.strictEqual(blackboard.renderBlackboard, blackboard.renderBlackboardText)
})

test('blackboard: notes default to no reply required; explicit override respected', async () => {
  const { writerId } = await seedAgents()
  const note = await blackboard.appendToBlackboard({
    userId: USER_ID,
    workflowId: WORKFLOW_ID,
    workflowRunId: RUN_ID,
    fromAgentId: writerId,
    kind: 'note',
    text: ' FYI for the team',
  })
  assert.strictEqual(note.type, 'feedback')
  assert.strictEqual(note.requiresResponse, false)

  const urgent = await blackboard.appendToBlackboard({
    userId: USER_ID,
    workflowId: WORKFLOW_ID,
    workflowRunId: RUN_ID,
    fromAgentId: writerId,
    kind: 'note',
    text: 'please confirm',
    requiresResponse: true,
  })
  assert.strictEqual(urgent.requiresResponse, true)
})

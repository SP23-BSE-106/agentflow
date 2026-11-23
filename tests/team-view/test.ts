/* Team-view unit checks: the rendering rules in src/lib/teamConversation.
 *   npm run test:teamview   (tsc -p tests/team-view/tsconfig.json && node tests/team-view/out/tests/team-view/test.js)
 * Pure functions only — no database, no network, no secrets.
 */
import {
  distinctAgentIds,
  extractTurnText,
  formatMessageTime,
  isAwaitingReply,
  isLiveRunStatus,
  isSystemMessage,
  messageId,
  type TeamMessage,
} from '../../src/lib/teamConversation'

let pass = 0
const failures: string[] = []

function t(name: string, fn: () => void) {
  try {
    fn()
    pass += 1
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : String(err)}`)
  }
}

function eq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}

const msg = (over: Partial<TeamMessage>): TeamMessage => ({
  _id: 'm1',
  fromAgentId: 'agent-researcher',
  toAgentId: 'agent-writer',
  type: 'result',
  status: 'delivered',
  requiresResponse: false,
  createdAt: new Date('2026-11-21T10:00:00+05:00'),
  ...over,
})

// extractTurnText — frozen turn format renders its text, never raw JSON
t('turn: plain text passes through', () => {
  eq(extractTurnText(msg({ text: 'Here are the 2026 figures.' })), 'Here are the 2026 figures.', 'plain')
})
t('turn: final JSON renders its text field', () => {
  eq(
    extractTurnText(msg({ text: JSON.stringify({ kind: 'final', text: 'Done — figures attached.' }) })),
    'Done — figures attached.',
    'final',
  )
})
t('turn: message JSON renders its text field', () => {
  eq(
    extractTurnText(
      msg({ text: JSON.stringify({ kind: 'message', to: 'writer', text: 'What is the deadline?', requiresResponse: true }) }),
    ),
    'What is the deadline?',
    'message',
  )
})
t('turn: payload object with text is used when text is empty', () => {
  eq(extractTurnText(msg({ text: undefined, payload: { kind: 'final', text: 'From the payload.' } })), 'From the payload.', 'payload')
})
t('turn: non-JSON text that starts with { is left alone', () => {
  eq(extractTurnText(msg({ text: '{not json' })), '{not json', 'broken json')
})
t('turn: no text and no payload is empty, never raw JSON', () => {
  eq(extractTurnText(msg({ text: undefined, payload: undefined })), '', 'empty')
})

// isSystemMessage — approvals/evaluation/status render distinctly
t('system: approval_request is system', () => {
  eq(isSystemMessage(msg({ type: 'approval_request' })), true, 'approval_request')
})
t('system: approval_response is system', () => {
  eq(isSystemMessage(msg({ type: 'approval_response' })), true, 'approval_response')
})
t('system: status is system', () => {
  eq(isSystemMessage(msg({ type: 'status' })), true, 'status')
})
t('system: agent result is not system', () => {
  eq(isSystemMessage(msg({ type: 'result' })), false, 'result')
})
t('system: a message with no sender is system', () => {
  eq(isSystemMessage(msg({ fromAgentId: undefined, type: 'result' })), true, 'no sender')
})

// isAwaitingReply — requiresResponse + still unanswered
t('awaiting: unanswered question awaits', () => {
  eq(isAwaitingReply(msg({ requiresResponse: true, status: 'delivered' }), [msg({})]), true, 'unanswered')
})
t('awaiting: reply threaded via parentMessageId clears it', () => {
  const question = msg({ _id: 'q1', requiresResponse: true })
  const reply = msg({ _id: 'r1', fromAgentId: 'agent-writer', toAgentId: 'agent-researcher', parentMessageId: 'q1' })
  eq(isAwaitingReply(question, [question, reply]), false, 'answered')
})
t('awaiting: completed message does not await', () => {
  eq(isAwaitingReply(msg({ requiresResponse: true, status: 'completed' }), [msg({})]), false, 'completed')
})
t('awaiting: no requiresResponse never awaits', () => {
  eq(isAwaitingReply(msg({ requiresResponse: false }), [msg({})]), false, 'no flag')
})

// distinctAgentIds — team detection for the run view
t('agents: senders and recipients deduped', () => {
  eq(
    distinctAgentIds(
      [msg({}), msg({ fromAgentId: 'agent-writer', toAgentId: 'agent-researcher' })],
      ['agent-researcher'],
    ),
    ['agent-researcher', 'agent-writer'],
    'dedup',
  )
})
t('agents: empty run has no agents', () => {
  eq(distinctAgentIds([]), [], 'empty')
})

// isLiveRunStatus — polling stops on terminal statuses
t('live: running/paused/queued poll', () => {
  eq(isLiveRunStatus('running'), true, 'running')
  eq(isLiveRunStatus('paused'), true, 'paused')
  eq(isLiveRunStatus('queued'), true, 'queued')
})
t('live: completed/failed/cancelled stop', () => {
  eq(isLiveRunStatus('completed'), false, 'completed')
  eq(isLiveRunStatus('failed'), false, 'failed')
  eq(isLiveRunStatus('cancelled'), false, 'cancelled')
})

// formatMessageTime + messageId
t('time: valid date renders, invalid renders a dash', () => {
  const rendered = formatMessageTime(new Date('2026-11-21T10:00:00+05:00'))
  if (rendered === '—' || !rendered.includes('2026')) throw new Error(`bad render: ${rendered}`)
  eq(formatMessageTime('not a date'), '—', 'invalid')
  eq(formatMessageTime(undefined), '—', 'missing')
})
t('id: _id wins, id is the fallback', () => {
  eq(messageId(msg({ _id: 'a', id: 'b' })), 'a', '_id')
  eq(messageId(msg({ _id: undefined, id: 'b' })), 'b', 'id')
})

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(`failures: ${failures.join(', ')}`)
  process.exit(1)
}

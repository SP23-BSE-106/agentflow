/* Lane B unit tests: resolveTeammate / pickTeammate / parseTeamTurn /
 * askTeammate (DB-backed, direct calls) + the runWorkflowNode 'ask' case.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DB=ma-b-test \
 *     npx tsc -p tests/multi-agent-team/tsconfig.json && \
 *     node tests/multi-agent-team/out/tests/multi-agent-team/test.js
 *
 * Direct calls against local mongod only. No network, no provider keys:
 * the LLM path is exercised only by lane-b-live.ts (live proof, separate).
 * The ask-node cases that need an LLM are covered by honest-error paths
 * here (unknown teammate, no run id); a live reply is NOT_TESTED here.
 */
import { ObjectId } from 'mongodb'
import { getDb } from '../../src/lib/mongo/mongo'
import {
  pickTeammate,
  resolveTeammate,
} from '../../src/lib/orchestration/resolveTeammate'
import { parseTeamTurn, askTeammate } from '../../src/lib/workflow/teamAsk'
import { runWorkflowNode } from '../../src/lib/workflow/nodeRunner'
import type { Agent } from '../../src/lib/mongo/agent'
import type { WorkflowNode } from '../../src/lib/mongo/workflow'

let pass = 0
const failures: string[] = []

async function t(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    pass += 1
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(
      `  FAIL  ${name}\n        ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function eq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}

function throws(
  fn: () => unknown,
  match: RegExp,
  what: string,
) {
  try {
    fn()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!match.test(message)) {
      throw new Error(`${what}: error "${message}" does not match ${match}`)
    }
    return
  }
  throw new Error(`${what}: expected an error matching ${match}`)
}

async function throwsAsync(
  fn: () => Promise<unknown>,
  match: RegExp,
  what: string,
) {
  try {
    await fn()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!match.test(message)) {
      throw new Error(`${what}: error "${message}" does not match ${match}`)
    }
    return
  }
  throw new Error(`${what}: expected an error matching ${match}`)
}

function agentDoc(over: Partial<Agent> & { _id: string }): Agent {
  return {
    userId: 'lane-b-user',
    name: 'Unnamed',
    capabilities: [],
    ragAccess: false,
    availableTools: [],
    humanApprovalRequired: false,
    canDelegate: true,
    maxRetryCount: 0,
    createdAt: new Date(),
    ...over,
  } as Agent
}

async function main() {
  const db = await getDb()
  await db.collection('agents').deleteMany({ userId: { $in: ['lane-b-user', 'someone-else'] } })
  await db.collection('agent_messages').deleteMany({ userId: 'lane-b-user' })

  const researcherId = new ObjectId().toHexString()
  const writerId = new ObjectId().toHexString()
  const otherId = new ObjectId().toHexString()
  const agents: Agent[] = [
    agentDoc({ _id: researcherId, name: 'Rana Researcher', role: 'researcher' }),
    agentDoc({ _id: writerId, name: 'Wanda Writer', role: 'writer' }),
    agentDoc({ _id: otherId, name: 'Rana Researcher', role: 'researcher' }),
  ]
  // The third agent belongs to someone else — it must never resolve.
  agents[2].userId = 'someone-else'
  await db.collection('agents').insertMany(
    agents as unknown as Record<string, unknown>[],
  )
  const mine = agents.slice(0, 2)

  // ── pickTeammate (pure) ────────────────────────────────────────────
  await t('pickTeammate: id hit', () => {
    eq(pickTeammate(mine, researcherId)?.name, 'Rana Researcher', 'id hit')
  })
  await t('pickTeammate: role hit', () => {
    eq(pickTeammate(mine, 'researcher')?.name, 'Rana Researcher', 'role hit')
    eq(pickTeammate(mine, 'writer')?.name, 'Wanda Writer', 'role hit 2')
  })
  await t('pickTeammate: name exact, then case-insensitive', () => {
    eq(pickTeammate(mine, 'Wanda Writer')?.role, 'writer', 'exact name')
    eq(pickTeammate(mine, 'wanda writer')?.role, 'writer', 'ci name')
    eq(pickTeammate(mine, 'RANA RESEARCHER')?.role, 'researcher', 'ci name 2')
  })
  await t('pickTeammate: misses return null', () => {
    eq(pickTeammate(mine, 'planner'), null, 'unknown role')
    eq(pickTeammate(mine, 'Nobody Here'), null, 'unknown name')
    eq(pickTeammate(mine, new ObjectId().toHexString()), null, 'unknown id')
    eq(pickTeammate(mine, ''), null, 'empty ref')
    eq(pickTeammate(mine, '   '), null, 'blank ref')
  })

  // ── resolveTeammate (DB, direct calls) ─────────────────────────────
  await t('resolveTeammate: id hit', async () => {
    const found = await resolveTeammate(db, 'lane-b-user', writerId)
    eq(found.name, 'Wanda Writer', 'db id hit')
  })
  await t('resolveTeammate: role hit', async () => {
    const found = await resolveTeammate(db, 'lane-b-user', 'researcher')
    eq(found.name, 'Rana Researcher', 'db role hit')
  })
  await t('resolveTeammate: name hit (exact + ci)', async () => {
    eq((await resolveTeammate(db, 'lane-b-user', 'Wanda Writer')).role, 'writer', 'db name')
    eq((await resolveTeammate(db, 'lane-b-user', 'wanda writer')).role, 'writer', 'db ci name')
  })
  await t('resolveTeammate: unknown teammate throws honestly', async () => {
    await throwsAsync(
      () => resolveTeammate(db, 'lane-b-user', 'Ghost Agent'),
      /does not exist or is not yours/,
      'unknown teammate',
    )
  })
  await t('resolveTeammate: another user\u2019s agent never resolves', async () => {
    await throwsAsync(
      () => resolveTeammate(db, 'lane-b-user', otherId),
      /does not exist or is not yours/,
      'other user id',
    )
    await throwsAsync(
      () => resolveTeammate(db, 'lane-b-user', 'Other Ollie'),
      /does not exist or is not yours/,
      'other user name',
    )
  })
  await t('resolveTeammate: empty ref throws', async () => {
    await throwsAsync(
      () => resolveTeammate(db, 'lane-b-user', '  '),
      /empty/,
      'empty ref',
    )
  })

  // ── parseTeamTurn (frozen format) ──────────────────────────────────
  await t('parseTeamTurn: final JSON', () => {
    eq(
      parseTeamTurn('{"kind":"final","text":"42"}'),
      { kind: 'final', text: '42' },
      'final',
    )
  })
  await t('parseTeamTurn: message JSON keeps requiresResponse', () => {
    eq(
      parseTeamTurn(
        '{"kind":"message","to":"researcher","text":"What year?","requiresResponse":false}',
      ),
      { kind: 'message', to: 'researcher', text: 'What year?', requiresResponse: false },
      'message false',
    )
    const msgTurn = parseTeamTurn('{"kind":"message","to":"r","text":"hi"}')
    eq(msgTurn.kind, 'message', 'message kind')
    if (msgTurn.kind === 'message') eq(msgTurn.requiresResponse, true, 'message default true')
  })
  await t('parseTeamTurn: unparsable output is a final answer', () => {
    eq(
      parseTeamTurn('Just answer in plain words.'),
      { kind: 'final', text: 'Just answer in plain words.' },
      'plain text',
    )
    eq(
      parseTeamTurn('{"kind":"mystery","text":"x"}'),
      { kind: 'final', text: '{"kind":"mystery","text":"x"}' },
      'unknown kind',
    )
  })
  await t('parseTeamTurn: JSON embedded in prose', () => {
    eq(
      parseTeamTurn('Here it is:\n{"kind":"final","text":"done"}'),
      { kind: 'final', text: 'done' },
      'embedded',
    )
  })

  // ── askTeammate (DB-backed, no LLM) ────────────────────────────────
  const runId = new ObjectId().toHexString()
  const asker = mine[1] // Wanda Writer asks Rana Researcher
  await t('askTeammate: unknown teammate throws, nothing persisted', async () => {
    const before = await db
      .collection('agent_messages')
      .countDocuments({ userId: 'lane-b-user', workflowRunId: runId })
    await throwsAsync(
      () =>
        askTeammate({
          userId: 'lane-b-user',
          workflowId: runId,
          workflowRunId: runId,
          fromAgent: asker,
          toRef: 'Ghost Agent',
          text: 'Hello?',
        }),
      /does not exist or is not yours/,
      'ask unknown',
    )
    const after = await db
      .collection('agent_messages')
      .countDocuments({ userId: 'lane-b-user', workflowRunId: runId })
    eq(after, before, 'no message persisted for unknown teammate')
  })
  await t('askTeammate: requiresResponse=false records + returns, no LLM', async () => {
    const result = await askTeammate({
      userId: 'lane-b-user',
      workflowId: runId,
      workflowRunId: runId,
      fromAgent: asker,
      toRef: 'researcher',
      text: 'Heads up: figures land tomorrow.',
      requiresResponse: false,
    })
    eq(result.reply, null, 'no reply')
    eq(result.toAgent.name, 'Rana Researcher', 'resolved teammate')
    const stored = await db
      .collection('agent_messages')
      .findOne({ _id: new ObjectId(result.questionMessageId) })
    if (!stored) throw new Error('question message was not persisted')
    eq(stored.type, 'task', 'question type')
    eq(stored.requiresResponse, false, 'question requiresResponse')
    eq(stored.fromAgentId, writerId, 'question sender')
    eq(stored.toAgentId, researcherId, 'question recipient')
    eq(stored.text, 'Heads up: figures land tomorrow.', 'question text')
    if (!stored.createdAt) throw new Error('question has no timestamp')
  })
  await t('askTeammate: empty question throws', async () => {
    await throwsAsync(
      () =>
        askTeammate({
          userId: 'lane-b-user',
          workflowId: runId,
          workflowRunId: runId,
          fromAgent: asker,
          toRef: 'researcher',
          text: '   ',
          requiresResponse: false,
        }),
      /needs a question/,
      'empty question',
    )
  })

  // ── runWorkflowNode 'ask' case ─────────────────────────────────────
  const askNode = (config: Record<string, unknown>): WorkflowNode =>
    ({
      id: 'n-ask',
      name: 'Ask Teammate',
      type: 'ask',
      description: 'test',
      config,
    }) as unknown as WorkflowNode
  await t('ask node: no run id fails honestly', async () => {
    const result = await runWorkflowNode({
      node: askNode({ to: 'researcher', text: 'Hi?' }),
      agent: asker,
      userId: 'lane-b-user',
      input: 'Hi?',
    })
    eq(result.ok, false, 'ok false without run id')
    if (!/workflow run/.test(result.error ?? '')) {
      throw new Error(`error does not name the missing run: ${result.error}`)
    }
  })
  await t('ask node: no teammate configured fails honestly', async () => {
    const result = await runWorkflowNode({
      node: askNode({ text: 'Hi?' }),
      agent: asker,
      userId: 'lane-b-user',
      input: 'Hi?',
      workflowRunId: runId,
    })
    eq(result.ok, false, 'ok false without teammate')
  })
  await t('ask node: unknown teammate fails honestly, no fake reply', async () => {
    const result = await runWorkflowNode({
      node: askNode({ to: 'Ghost Agent', text: 'Hi?' }),
      agent: asker,
      userId: 'lane-b-user',
      input: 'Hi?',
      workflowId: runId,
      workflowRunId: runId,
    })
    eq(result.ok, false, 'ok false for unknown teammate')
    if (!/does not exist or is not yours/.test(result.error ?? '')) {
      throw new Error(`error is not the honest one: ${result.error}`)
    }
    eq(result.state, 'Hi?', 'state unchanged on failure')
  })
  await t('ask node: requiresResponse=false records + passes state through', async () => {
    const result = await runWorkflowNode({
      node: askNode({ to: 'researcher', text: 'Ping.', requiresResponse: false }),
      agent: asker,
      userId: 'lane-b-user',
      input: 'carry-me',
      workflowId: runId,
      workflowRunId: runId,
    })
    eq(result.ok, true, 'ok true for fire-and-forget ask')
    eq(result.state, 'carry-me', 'state passes through when no reply requested')
    if (!/no reply requested/.test(result.summary)) {
      throw new Error(`summary does not say so: ${result.summary}`)
    }
  })

  // ── cleanup ────────────────────────────────────────────────────────
  await db.collection('agents').deleteMany({ userId: { $in: ['lane-b-user', 'someone-else'] } })
  await db.collection('agent_messages').deleteMany({ userId: 'lane-b-user' })

  console.log(`\nLane B unit tests: ${pass} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    console.log(`FAILED: ${failures.join(', ')}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('Lane B unit tests crashed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})

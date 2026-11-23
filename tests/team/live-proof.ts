/* Lane A live proof (NOT a unit test): a real team run through the real
 * `orchestrate()` engine and the real provider chain, with the
 * conversation read back from `agent_messages`.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27017/ma-a MONGODB_DB=ma-a \
 *     <provider keys via exec env only> \
 *     node tests/team/out/tests/team/live-proof.js
 *
 * Seeds a proof user + 3 agents (Lead / Researcher / Writer) with a
 * 2-node graph naming the researcher and writer, runs mode 'team' on:
 * "Ask the researcher for two 2026 figures, then summarise them in one
 * sentence.", and asserts the run completes with at least one
 * question-and-answer exchange persisted in agent_messages.
 *
 * Exit 0 = live proof passed. Exit 1 = ran but the conversation did not
 * prove out (assertion failure — see output). Exit 2 = no provider
 * answered (NOT_TESTED, e.g. exhausted credits) — the run is recorded
 * honestly, never faked.
 */
import { MongoClient, ObjectId } from 'mongodb'
import { orchestrate } from '../../src/lib/orchestration/orchestrator'

const USER_ID = 'lane-a-proof-user'
const TASK = 'Ask the researcher for two 2026 figures, then summarise them in one sentence.'

async function main() {
  const uri = process.env.MONGODB_URI
  const dbName = process.env.MONGODB_DB || 'ma-a'
  if (!uri) {
    console.error('LIVE PROOF: MONGODB_URI is not set.')
    process.exit(2)
  }
  const client = new MongoClient(uri)
  await client.connect()
  const db = client.db(dbName)
  try {
    // Clean slate for this proof user only.
    for (const coll of ['agents', 'workflow_runs', 'agent_messages', 'agent_tasks', 'shared_contexts', 'execution_events']) {
      await db.collection(coll).deleteMany({ userId: USER_ID })
    }

    const leadId = new ObjectId()
    const researcherId = new ObjectId()
    const writerId = new ObjectId()
    const now = new Date()
    const baseAgent = {
      userId: USER_ID,
      capabilities: [],
      ragAccess: false,
      availableTools: [],
      humanApprovalRequired: false,
      canDelegate: true,
      maxRetryCount: 1,
      createdAt: now,
    }
    await db.collection('agents').insertMany([
      {
        ...baseAgent,
        _id: leadId,
        name: 'Lead',
        role: 'planner',
        systemPrompt: 'You lead this team. Get what you need from teammates, then give the final summary.',
        workflow: {
          nodes: [
            { id: 'n1', name: 'Research', type: 'llm', description: 'Research step', config: { agentId: researcherId.toHexString() } },
            { id: 'n2', name: 'Write', type: 'llm', description: 'Write step', config: { agentId: writerId.toHexString() } },
          ],
          edges: [],
        },
      },
      {
        ...baseAgent,
        _id: researcherId,
        name: 'Researcher',
        role: 'researcher',
        systemPrompt: 'You are the researcher. Answer questions with concrete figures.',
      },
      {
        ...baseAgent,
        _id: writerId,
        name: 'Writer',
        role: 'writer',
        systemPrompt: 'You are the writer. Turn findings into one clear sentence.',
      },
    ])

    console.log(`LIVE PROOF: seeded Lead=${leadId.toHexString()} Researcher=${researcherId.toHexString()} Writer=${writerId.toHexString()} in db ${dbName}`)
    const result = await orchestrate({
      agentId: leadId.toHexString(),
      input: TASK,
      userId: USER_ID,
      mode: 'team' as never,
    })
    console.log('LIVE PROOF: orchestrate result:', JSON.stringify({ runId: result.runId, status: result.status, tasksCompleted: result.tasksCompleted, tasksFailed: result.tasksFailed, messagesCreated: result.messagesCreated, durationMs: result.durationMs }, null, 2))
    console.log('LIVE PROOF: output:', JSON.stringify(result.output, null, 2))

    const messages = await db
      .collection('agent_messages')
      .find({ userId: USER_ID, workflowRunId: result.runId })
      .sort({ createdAt: 1 })
      .toArray()
    console.log(`LIVE PROOF: ${messages.length} persisted agent_messages:`)
    const names: Record<string, string> = { [leadId.toHexString()]: 'Lead', [researcherId.toHexString()]: 'Researcher', [writerId.toHexString()]: 'Writer' }
    for (const m of messages) {
      const from = names[String(m.fromAgentId)] ?? String(m.fromAgentId)
      const to = m.toAgentId ? ` -> ${names[String(m.toAgentId)] ?? String(m.toAgentId)}` : ''
      console.log(`  [${m.type}] ${from}${to} requiresResponse=${m.requiresResponse} parent=${String(m.parentMessageId ?? '')} :: ${(String(m.text ?? '')).slice(0, 300)}`)
    }

    // Assertions: a real two-agent exchange, persisted.
    const questions = messages.filter((m) => m.type === 'task' && m.requiresResponse)
    const replies = messages.filter(
      (m) => m.type === 'result' && m.parentMessageId && questions.some((q) => String(q._id) === String(m.parentMessageId)),
    )
    const providerDead =
      result.status === 'failed' &&
      JSON.stringify(result.output ?? '').includes('no inference provider answered')
    if (providerDead) {
      console.log('LIVE PROOF: NOT_TESTED — no provider answered (see output above).')
      process.exit(2)
    }
    const problems: string[] = []
    if (result.status !== 'completed') problems.push(`run status is ${result.status}, not completed`)
    if (questions.length < 1) problems.push('no question message (type task, requiresResponse) persisted')
    if (replies.length < 1) problems.push('no reply threaded under a question persisted')
    if (messages.length < 3) problems.push(`only ${messages.length} messages persisted, expected >= 3`)
    if (problems.length > 0) {
      console.log(`LIVE PROOF: FAILED — ${problems.join('; ')}`)
      process.exit(1)
    }
    console.log('LIVE PROOF: PASSED — two agents exchanged a question and answer and the job completed with both contributions in agent_messages.')
    process.exit(0)
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error('LIVE PROOF: harness error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})

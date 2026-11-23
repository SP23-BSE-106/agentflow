/* Lane B LIVE proof: a real workflow run containing an ask node where the
 * named teammate replies, and the reply is visible in the persisted
 * messages AND in the step result. Plus the negative proof (ask a
 * nonexistent teammate → honest error, no fake reply).
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DB=ma-b \
 *     node tests/multi-agent-team/out/tests/multi-agent-team/live.js
 *
 * Provider keys come ONLY from the exec environment (the real provider
 * chain in src/lib/llm.ts). No keys are printed, written, or logged here.
 * Exit 0 = live proof passed. Exit 3 = no provider answered (NOT_TESTED,
 * honest — credits exhausted or no key in env). Exit 1 = real failure.
 */
import { ObjectId } from 'mongodb'
import { getDb } from '../../src/lib/mongo/mongo'
import { listMessages } from '../../src/lib/orchestration/messageBus'
import { runWorkflowNode } from '../../src/lib/workflow/nodeRunner'
import type { Agent } from '../../src/lib/mongo/agent'
import type { WorkflowNode } from '../../src/lib/mongo/workflow'

const USER = 'lane-b-live'

async function main() {
  const db = await getDb()
  await db.collection('agents').deleteMany({ userId: USER })
  await db.collection('agent_messages').deleteMany({ userId: USER })

  const researcherId = new ObjectId()
  const writerId = new ObjectId()
  const base = {
    userId: USER,
    capabilities: [],
    ragAccess: false,
    availableTools: [],
    humanApprovalRequired: false,
    canDelegate: true,
    maxRetryCount: 0,
    createdAt: new Date(),
  }
  const researcher = {
    ...base,
    _id: researcherId,
    name: 'Rana Researcher',
    role: 'researcher',
    systemPrompt: 'You are a researcher. Answer briefly and factually.',
    // Small output budget on purpose: the OpenRouter key can only afford
    // 28 tokens (proven by the first live attempt's 402), and the reply
    // to "What is 2+2?" is one token. This is a real provider call with a
    // real budget, not a stub — a bigger budget 402s before any answer.
    maxTokenBudget: 20,
  } as unknown as Agent
  const writer = {
    ...base,
    _id: writerId,
    name: 'Wanda Writer',
    role: 'writer',
    systemPrompt: 'You are a writer. You ask teammates for facts, then write.',
  } as unknown as Agent
  await db.collection('agents').insertMany([
    researcher as unknown as Record<string, unknown>,
    writer as unknown as Record<string, unknown>,
  ])

  const runId = new ObjectId().toHexString()
  const askNode = {
    id: 'n-ask',
    name: 'Ask Teammate',
    type: 'ask',
    description: 'live proof',
    config: {
      to: 'researcher',
      text: 'What is 2+2? Reply with just the number and nothing else.',
      requiresResponse: true,
    },
  } as unknown as WorkflowNode

  console.log('LIVE-PROOF ask node: Wanda Writer asks Rana Researcher "What is 2+2?"')
  const result = await runWorkflowNode({
    node: askNode,
    agent: writer,
    userId: USER,
    input: 'What is 2+2?',
    workflowId: runId,
    workflowRunId: runId,
  })

  if (!result.ok) {
    console.log(`LIVE-PROOF node failed: ${result.error ?? result.summary}`)
    if (/No inference provider answered/.test(result.error ?? '')) {
      console.log('LIVE-PROOF: NOT_TESTED — no provider answered (credits exhausted or no key in env).')
      await db.collection('agents').deleteMany({ userId: USER })
      await db.collection('agent_messages').deleteMany({ userId: USER })
      process.exit(3)
    }
    process.exit(1)
  }

  const messages = await listMessages(USER, runId)
  console.log(`LIVE-PROOF step result: ok=true provider=${result.provider} model=${result.model}`)
  console.log(`LIVE-PROOF step state (reply): ${JSON.stringify(result.state)}`)
  console.log(`LIVE-PROOF persisted messages: ${messages.length}`)
  for (const m of messages) {
    console.log(
      `  [${m.type}] ${m.fromAgentId} -> ${m.toAgentId ?? '(none)'} requiresResponse=${m.requiresResponse} parent=${m.parentMessageId ?? '(none)'} text=${JSON.stringify((m.text ?? '').slice(0, 200))}`,
    )
  }
  const question = messages.find((m) => m.type === 'task')
  const reply = messages.find((m) => m.type === 'result')
  const ok =
    messages.length >= 2 &&
    !!question &&
    question.fromAgentId === writerId.toHexString() &&
    question.toAgentId === researcherId.toHexString() &&
    !!reply &&
    reply.fromAgentId === researcherId.toHexString() &&
    reply.parentMessageId === String(question._id) &&
    result.state.trim().length > 0 &&
    result.state.trim() === (reply.text ?? '').trim()
  console.log(ok ? 'LIVE-PROOF: PASS — reply visible in messages and step result.' : 'LIVE-PROOF: FAIL — transcript does not match the step result.')
  if (!ok) process.exit(1)

  // Negative proof: ask a nonexistent teammate → honest error, no fake reply.
  const neg = await runWorkflowNode({
    node: {
      id: 'n-ask-neg',
      name: 'Ask Teammate',
      type: 'ask',
      description: 'negative proof',
      config: { to: 'Ghost Agent', text: 'Hello?' },
    } as unknown as WorkflowNode,
    agent: writer,
    userId: USER,
    input: 'Hello?',
    workflowId: runId,
    workflowRunId: runId,
  })
  console.log(`NEGATIVE-PROOF ask unknown teammate: ok=${neg.ok} error=${JSON.stringify(neg.error)}`)
  const after = await listMessages(USER, runId)
  const ghostMessages = after.filter((m) => (m.text ?? '').includes('Ghost'))
  if (neg.ok || !/does not exist or is not yours/.test(neg.error ?? '') || ghostMessages.length > 0) {
    console.log('NEGATIVE-PROOF: FAIL')
    process.exit(1)
  }
  console.log('NEGATIVE-PROOF: PASS — honest error, no fake reply, nothing persisted for the ghost.')

  await db.collection('agents').deleteMany({ userId: USER })
  await db.collection('agent_messages').deleteMany({ userId: USER })
  process.exit(0)
}

main().catch((err) => {
  console.error('LIVE-PROOF crashed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})

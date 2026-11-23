/**
 * THE single run entry point (addendum 5).
 *
 * Production `POST /api/execute` and the builder's Run path both run through
 * `runWorkflow` — one function loads the graph, runs it through the one
 * shared engine, and records the run. There is no second execution path to
 * drift from this one.
 *
 * Which graph runs (addendum 4): an agent that has been deployed runs its
 * deployed snapshot (`deployedWorkflow`, taken when it was last deployed),
 * never the draft. An agent that has never been deployed runs its saved
 * workflow (the sandbox/draft path). The result says which one it was.
 *
 * Grounding (P1-4): a grounded question with no documents, or with documents
 * that do not contain an answer, is refused in plain language — the LLM is
 * never asked to answer from general knowledge.
 */

import { ObjectId, type Db } from 'mongodb'
import { getDb } from '@/lib/mongo/mongo'
import { chatCompletion, type AgentKey } from '@/lib/llm'
import { loadStoredAgentKey } from '@/lib/storedProviderKey'
import { decrypt } from '@/lib/crypto'
import { generateEmbedding } from '@/lib/rag/embeddings'
import { searchChunks } from '@/lib/rag/vectorStore'
import { executeWorkflow, type ExecutionResult } from '@/lib/workflow/executor'
import { executeWorkflowItems } from '@/lib/workflow/itemExecutor'
import { itemFromJson, itemFromText, itemsToText } from '@/lib/nodes/items'
import { getNodeType } from '@/lib/nodes/registry'
// Side effect: registers the 17 core node descriptions, so getNodeType
// resolves the registry names the routing check below looks for.
import '@/lib/nodes/index'
import {
  filterGroundedHits,
  NO_DOCUMENTS_MESSAGE,
  NO_RELEVANT_DOCUMENTS_MESSAGE,
  parseTopK,
} from '@/lib/rag/grounding'
import type { WorkflowGraph } from '@/lib/mongo/workflow'

export type RunWorkflowInput = {
  db: Db
  userId: string
  agentId: string
  input: string
  topK?: number
}

export type RunWorkflowResult = {
  ok: boolean
  agentId: string
  agentName: string
  output: string
  model: string | null
  provider: string | null
  sources: Array<{ text: string; similarity: number }>
  trace?: ExecutionResult['trace']
  /** True when the deployed snapshot ran (false = draft/saved workflow). */
  deployed: boolean
  /** True when the answer was grounded in retrieved documents. */
  grounded: boolean
  error?: string
  failures?: Array<{ provider: string; status?: number; message: string }>
}

/** Load the agent and pick the graph /api/execute must serve. */
export async function loadRunnableAgent(db: Db, userId: string, agentId: string): Promise<{
  agent: { _id: unknown; name: string; status?: string; prompt?: string; workflow?: WorkflowGraph; deployedWorkflow?: WorkflowGraph }
  graph: WorkflowGraph | null
  deployed: boolean
} | { error: string; status: number }> {
  if (!ObjectId.isValid(agentId)) {
    return { error: 'agentId must be a valid agent id', status: 400 }
  }
  const agent = await db.collection('agents').findOne({ _id: new ObjectId(agentId), userId })
  if (!agent) return { error: 'Agent not found', status: 404 }

  const deployed =
    agent.status === 'active' &&
    Array.isArray(agent.deployedWorkflow?.nodes) &&
    agent.deployedWorkflow.nodes.length > 0
  const graph = deployed
    ? (agent.deployedWorkflow as WorkflowGraph)
    : (Array.isArray(agent.workflow?.nodes) && agent.workflow.nodes.length > 0
      ? (agent.workflow as WorkflowGraph)
      : null)
  return { agent: agent as never, graph, deployed }
}

export async function runWorkflow(input: RunWorkflowInput): Promise<RunWorkflowResult> {
  const { db, userId, agentId } = input
  const effectiveTopK = parseTopK(input.topK, 3)
  const question = input.input.trim()

  const loaded = await loadRunnableAgent(db, userId, agentId)
  if ('error' in loaded) {
    throw Object.assign(new Error(loaded.error), { status: loaded.status })
  }
  const { agent, graph, deployed } = loaded

  // A key saved on the agent is decrypted here, at the moment it is used,
  // and tried before the shared environment keys. The plaintext key lives
  // only in this call and is never stored or logged.
  let agentKey: AgentKey | undefined
  const storedKey = (agent as { userApiKey?: unknown }).userApiKey
  if (typeof storedKey === 'string' && storedKey.trim()) {
    try {
      // Read through the optional cast once: casting the agent object to a
      // type with a *required* llmProvider does not overlap enough for
      // TypeScript, so narrow the unknown value with typeof instead.
      const llmProvider = (agent as { llmProvider?: unknown }).llmProvider
      agentKey = {
        provider: typeof llmProvider === 'string' ? llmProvider : '',
        key: decrypt(storedKey.trim()),
      }
    } catch {
      throw Object.assign(
        new Error('The API key saved on this agent could not be decrypted. Re-enter the key on the agent.'),
        { status: 502 },
      )
    }
  }

  // Stored provider key (BYOK): when neither the caller nor the agent
  // supplied a key, fall back to the key the user stored for this agent's
  // provider. Guests never have stored keys. A missing or corrupt row
  // leaves agentKey unset and the chain falls through to the env keys.
  if (!agentKey && userId !== 'guest') {
    const llmProvider = (agent as { llmProvider?: unknown }).llmProvider
    if (typeof llmProvider === 'string' && llmProvider) {
      agentKey = (await loadStoredAgentKey(userId, llmProvider)) ?? undefined
    }
  }

  // ── The agent carries a saved workflow graph: run that graph ────────
  if (graph) {
    // A graph with any registry (n8n) node runs through the item executor,
    // which executes those types natively and delegates legacy nodes to the
    // same single dispatcher — the string executor fails honestly on
    // registry types, so routing here is what makes them run at all. The
    // item executor records the run in workflow_runs itself, so this
    // branch records no second row (analytics would double-count it).
    if (graph.nodes.some((node) => getNodeType(node.type) !== undefined)) {
      // Seed items: a JSON-object input (a webhook POST body, a form
      // submission) becomes the item's json, so $json.score reads the
      // body's fields. Anything else stays plain text under $json.input.
      // Arrays are not split into items — they stay one text item.
      let seedItems = [itemFromText(question)]
      try {
        const parsed: unknown = JSON.parse(question)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          seedItems = [itemFromJson(parsed as Record<string, unknown>)]
        }
      } catch {
        // Not JSON: the text item above stands.
      }
      const itemResult = await executeWorkflowItems(graph, seedItems, {
        userId,
        agentId,
        workflowId: agentId,
        agentKey,
        topK: effectiveTopK,
      })
      const trace: ExecutionResult['trace'] = itemResult.nodeResults.map((step) => ({
        nodeId: step.nodeId,
        name: step.name,
        type: step.type,
        ok: step.ok,
        durationMs: step.durationMs,
        summary: step.error ?? itemsToText(step.items).slice(0, 500),
      }))
      const ok = itemResult.status === 'success'
      const firstError = itemResult.nodeResults.find((step) => !step.ok)?.error
      return {
        ok,
        agentId,
        agentName: agent.name,
        output: itemsToText(itemResult.output),
        // An item run has no single model: each LLM node may use its own.
        model: null,
        provider: null,
        sources: itemResult.sources,
        trace,
        deployed,
        grounded: itemResult.sources.length > 0,
        error: ok
          ? undefined
          : itemResult.status === 'waiting'
            ? 'Workflow paused at a Wait node — resume it from the executions list.'
            : (firstError ?? 'Workflow run failed'),
      }
    }
    const startedAt = Date.now()
    // H17: the server owns the run record. If the engine throws, the run
    // still happened (and failed) — record it once here instead of leaving
    // the executions list silent, and let the error propagate.
    let result
    try {
      result = await executeWorkflow(graph, question, userId, { topK: effectiveTopK, agentKey })
    } catch (error) {
      await db
        .collection('workflow_runs')
        .insertOne({
          userId,
          kind: 'exec',
          agentId,
          agentName: agent.name,
          status: 'failed',
          input: question.slice(0, 2000),
          output: '',
          sourceCount: 0,
          durationMs: Date.now() - startedAt,
          provider: null,
          model: null,
          deployed,
          error: error instanceof Error ? error.message : 'Execution failed',
          createdAt: new Date(),
        })
        .catch(() => undefined)
      throw error
    }
    const durationMs = Date.now() - startedAt
    const allOk = result.trace.every((step) => step.ok)

    await db.collection('workflow_runs').insertOne({
      userId,
      kind: 'exec',
      agentId,
      agentName: agent.name,
      status: allOk ? 'success' : 'failed',
      input: question.slice(0, 2000),
      output: result.output.slice(0, 4000),
      sourceCount: result.sources.length,
      durationMs,
      provider: result.provider,
      model: result.model,
      deployed,
      error: allOk ? null : 'one or more nodes failed',
      createdAt: new Date(),
    }).catch(() => undefined)

    return {
      ok: allOk,
      agentId,
      agentName: agent.name,
      output: result.output,
      model: result.model,
      provider: result.provider,
      sources: result.sources,
      trace: result.trace,
      deployed,
      grounded: result.sources.length > 0,
      error: allOk ? undefined : 'one or more nodes failed',
    }
  }

  // ── No graph: single-turn grounded answer ────────────────────────────
  // H17: the server owns the run record. This path previously recorded
  // nothing — the only row came from the client's recordRun POST, which
  // the builder/sandbox also sent after graph runs (double-counting
  // those). Every outcome below goes through `record`, so exactly one
  // row is written per execution, whatever the outcome.
  const noGraphStartedAt = Date.now()
  const record = async (result: RunWorkflowResult): Promise<RunWorkflowResult> => {
    await db
      .collection('workflow_runs')
      .insertOne({
        userId,
        kind: 'exec',
        agentId,
        agentName: agent.name,
        status: result.ok ? 'success' : 'failed',
        input: question.slice(0, 2000),
        output: (result.output ?? '').slice(0, 4000),
        sourceCount: result.sources.length,
        durationMs: Date.now() - noGraphStartedAt,
        provider: result.provider,
        model: result.model,
        deployed,
        error: result.ok ? null : (result.error ?? 'Execution failed'),
        createdAt: new Date(),
      })
      .catch(() => undefined)
    return result
  }

  const chunkCount = await db.collection('rag_chunks').countDocuments({ userId })
  if (chunkCount === 0) {
    return record({
      ok: true,
      agentId,
      agentName: agent.name,
      output: NO_DOCUMENTS_MESSAGE,
      model: null,
      provider: null,
      sources: [],
      deployed,
      grounded: false,
    })
  }

  const sources: Array<{ text: string; similarity: number }> = []
  let context = ''
  try {
    const queryVector = await generateEmbedding(question)
    const { hits } = await searchChunks({ userId, queryVector, topK: effectiveTopK })
    const grounded = filterGroundedHits(hits)
    if (grounded.length === 0) {
      return record({
        ok: true,
        agentId,
        agentName: agent.name,
        output: NO_RELEVANT_DOCUMENTS_MESSAGE,
        model: null,
        provider: null,
        sources: [],
        deployed,
        grounded: false,
      })
    }
    for (const hit of grounded) {
      sources.push({ text: hit.text.slice(0, 300), similarity: hit.similarity })
    }
    context = grounded.map((hit, index) => `[Chunk ${index + 1}]\n${hit.text}`).join('\n\n')
  } catch {
    return record({
      ok: false,
      agentId,
      agentName: agent.name,
      output: '',
      model: null,
      provider: null,
      sources: [],
      deployed,
      grounded: false,
      error: 'Retrieval failed. The knowledge base could not be searched.',
    })
  }

  const instruction = typeof agent.prompt === 'string' ? agent.prompt.trim() : ''
  const system = [
    instruction || `You are "${agent.name}", an AI agent configured in the agentflow workspace.`,
    'Write answers in a natural, human-friendly, conversational tone. Avoid robotic phrasing.',
    `Answer using ONLY this retrieved context where it is relevant; if it does not cover the question, say so.\n\n--- CONTEXT ---\n${context}\n--- END CONTEXT ---`,
  ].join('\n\n')

  const completion = await chatCompletion({ system, prompt: question, agentKey })

  if (!completion.ok) {
    return record({
      ok: false,
      agentId,
      agentName: agent.name,
      output: '',
      model: null,
      provider: null,
      sources,
      deployed,
      grounded: true,
      error: 'No inference provider accepted the request.',
      failures: completion.failures,
    })
  }

  return record({
    ok: true,
    agentId,
    agentName: agent.name,
    output: completion.text,
    model: completion.model,
    provider: completion.provider,
    sources,
    deployed,
    grounded: true,
  })
}

/** Convenience for callers that already have a user id and no Db handle. */
export async function runWorkflowForUser(userId: string, agentId: string, input: string, topK?: number): Promise<RunWorkflowResult> {
  const db = await getDb()
  return runWorkflow({ db, userId, agentId, input, topK })
}

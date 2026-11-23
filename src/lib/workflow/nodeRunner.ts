/**
 * THE single node dispatcher (addendum 1 + 2).
 *
 * Both execution paths — the single-agent graph run in `executor.ts` and the
 * multi-agent modes in `orchestrator.ts` — run every node through
 * `runWorkflowNode`. One node type, one behaviour, wherever the graph runs.
 *
 * Node config drives the run (addendum 2):
 *   - llm:       node.config.systemPrompt (else the agent's), node.config.model,
 *                node.config.maxTokens (else the agent's maxTokenBudget)
 *   - rag:       node.config.topK, node.config.documentId / node.config.ragIndex
 *                (scope retrieval to one document; 'all' or absent = whole base)
 *   - api:       node.config.url
 *   - condition: node.config.expression (safe allowlisted evaluator, never
 *                dynamic code execution — see src/lib/workflow/condition.ts)
 *   - trigger / output: pass the state through, no LLM call
 *   - code: the sandboxed vm executor from the item executor
 *     (src/lib/nodes/executors/code.ts) — the string state becomes one
 *     item, the snippet runs, the output items become the state again
 *   - set: the item executor's set handler (src/lib/nodes/executors/set.ts)
 *     — same bridge as code: the string state becomes one item, the
 *     assignments run, the merged item becomes the state again. This is
 *     what lets the orchestrator run Set nodes: it calls this dispatcher
 *     for every non-condition node, and before this case existed a Set
 *     node failed there as "not supported" while /api/execute ran it fine.
 *   - http / httpRequest: the item executor's HTTP handler
 *     (src/lib/nodes/executors/http.ts) — same bridge. Canonical name is
 *     'httpRequest' (registry/builder); 'http' is its alias for saved
 *     workflows (see src/lib/mongo/workflow.ts). Both spellings run here.
 *   - tool / memory / unknown: fail honestly — never a silent success
 *
 * RAG grounding (P1-4): only hits at or above SIMILARITY_THRESHOLD count.
 * Zero grounded hits fails the node with a plain message instead of letting a
 * downstream LLM answer from general knowledge.
 */

import { chatCompletion, type AgentKey } from '@/lib/llm'
import { generateEmbedding } from '@/lib/rag/embeddings'
import { searchChunks } from '@/lib/rag/vectorStore'
import {
  filterGroundedHits,
  NO_DOCUMENTS_MESSAGE,
  NO_RELEVANT_DOCUMENTS_MESSAGE,
  parseTopK,
  SIMILARITY_THRESHOLD,
} from '@/lib/rag/grounding'
import { evaluateCondition } from './condition'
import { makeScope, resolveConfigTemplates } from '@/lib/expression/engine'

// Re-exported so the item executor (Lane H) can resolve templates with a
// fuller item-based scope using the same helper this runner uses.
export { resolveConfigTemplates } from '@/lib/expression/engine'
import { fetchPublicUrl, SsrfError } from '@/lib/ssrf'
// Lane OC (FIX-EVERYTHING follow-up): the orchestrator (/api/orchestrate)
// runs every node through this dispatcher, but the switch below only knew
// the legacy string types — so a Code step failed honestly with
// `Node type "code" is not supported`, while the builder Run path
// (/api/execute, item executor) ran it fine via this same executor. Wire
// the existing sandboxed executor in here; no new executor, no new sandbox.
import { executeCodeNode } from '@/lib/nodes/executors/code'
import { executeSetNode } from '@/lib/nodes/executors/set'
import { executeHttpNode } from '@/lib/nodes/executors/http'
import { askTeammate } from './teamAsk'
import { itemFromJson, itemFromText, itemsToText, type WorkflowItem } from '@/lib/nodes/items'
import type { Agent } from '@/lib/mongo/agent'
import type { WorkflowNode } from '@/lib/mongo/workflow'
import { getDb } from '@/lib/mongo/mongo'

export type NodeRunResult = {
  /** The state carried to the next node. */
  state: string
  ok: boolean
  summary: string
  /** Plain-language failure reason when ok is false. */
  error?: string
  provider?: string | null
  model?: string | null
  /** Grounded sources, for RAG nodes. */
  sources?: Array<{ text: string; similarity: number }>
}

export type NodeRunInput = {
  node: WorkflowNode
  /** Agent running the node (owner or per-node agent); null for plain graph runs. */
  agent?: Agent | null
  userId: string
  /** Text this node works on (the running state). */
  input: string
  /** The original user request, for prompts that need it. */
  originalInput?: string
  topK?: number
  /** A caller-decrypted key saved on the agent, tried before shared keys. */
  agentKey?: AgentKey
  /**
   * Ask-node run context (Lane B only — every field optional, so the
   * other node kinds are unaffected). The orchestrator / item executor
   * passes these in; without a workflowRunId an 'ask' node fails
   * honestly, because there is nowhere to record the conversation.
   */
  workflowId?: string
  workflowRunId?: string
  /** Id of the agent asking, when no agent document is passed. */
  fromAgentId?: string
  /** Conversation so far, oldest first ({ from, text }). */
  conversation?: Array<{ from: string; text: string }>
  /** Shared run context (variables, intermediate results). */
  sharedContext?: unknown
}

function configString(node: WorkflowNode, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = node.config?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function configNumber(node: WorkflowNode, key: string): number | undefined {
  const value = node.config?.[key]
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

async function runApiNode(node: WorkflowNode, state: string): Promise<NodeRunResult> {
  const url = configString(node, 'url')
  if (!url) {
    return { state, ok: true, summary: 'No API URL configured on this node; input passed through unchanged.' }
  }
  // SSRF guard (P2-7): only public http/https targets, no redirects to
  // private IPs, 10 s timeout, 1 MiB cap. A blocked URL fails the node
  // honestly instead of fetching an internal address.
  try {
    const text = await fetchPublicUrl(url)
    return { state: text.slice(0, 4000), ok: true, summary: 'API node called.' }
  } catch (error) {
    const message = error instanceof SsrfError
      ? error.message
      : error instanceof Error ? error.message : 'API node failed.'
    return { state, ok: false, summary: message, error: message }
  }
}

/**
 * String state → one item, the same mapping the item executor's legacy
 * delegation uses in reverse: a JSON-object state becomes one JSON item,
 * anything else becomes `{ input: state }`.
 */
function stateToItems(state: string): WorkflowItem[] {
  const trimmed = state.trim()
  if (trimmed.startsWith('{')) {
    try {
      return [itemFromJson(JSON.parse(trimmed) as Record<string, unknown>, 0)]
    } catch {
      return [itemFromText(state)]
    }
  }
  return [itemFromText(state)]
}

async function runSetNode(originalNode: WorkflowNode, state: string, userId: string): Promise<NodeRunResult> {
  // Raw (unresolved) node: assignment values may be `{{ }}` templates over
  // the item's own `$json` — the item executor resolves them per item, so
  // this bridge must not pre-resolve them against the string scope first
  // (same reason runCodeNode below uses the raw node).
  const config = (originalNode.config ?? {}) as Record<string, unknown>
  try {
    const result = await executeSetNode({
      node: originalNode,
      config,
      items: stateToItems(state),
      ctx: { userId, vars: {}, nodeOutputs: {} },
    })
    const json = result.items[0]?.json ?? {}
    // Values must survive the string boundary: itemsToText returns
    // `json.input` first, which would mask every value the Set node just
    // wrote (the run output would look like a no-op). When the merged item
    // carries anything beyond the input text, the state is the merged JSON
    // itself — downstream nodes that parse JSON (Code, the item executor's
    // legacy delegation) see the full item, and the run output shows it.
    const hasExtra = Object.keys(json).some((key) => key !== 'input')
    return {
      state: hasExtra ? JSON.stringify(json) : itemsToText(result.items),
      ok: true,
      summary: 'Set node ran.',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Set node failed.'
    return { state, ok: false, summary: message, error: message }
  }
}

async function runHttpNode(originalNode: WorkflowNode, state: string, userId: string): Promise<NodeRunResult> {
  // Raw (unresolved) node: the URL may be a `{{ }}` template over the
  // item's `$json` — resolved per item by the HTTP executor, not here.
  const config = (originalNode.config ?? {}) as Record<string, unknown>
  try {
    const result = await executeHttpNode({
      node: originalNode,
      config,
      items: stateToItems(state),
      ctx: { userId, vars: {}, nodeOutputs: {} },
    })
    // HTTP items carry { status, headers, body } and no `input` field, so
    // itemsToText renders the whole item as JSON — the fetched body flows
    // downstream as the state.
    return { state: itemsToText(result.items), ok: true, summary: 'HTTP node called.' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'HTTP node failed.'
    return { state, ok: false, summary: message, error: message }
  }
}

async function runCodeNode(originalNode: WorkflowNode, state: string, userId: string): Promise<NodeRunResult> {
  // The snippet is JavaScript, not a template: use the node's RAW config,
  // not the template-resolved copy the switch works with — the item executor
  // never resolves `{{ }}` inside Code either, so both paths see the same
  // snippet (the caller passes input.node, the unresolved original).
  const config = (originalNode.config ?? {}) as Record<string, unknown>
  // Mirror the item executor's legacy delegation in reverse: a JSON-object
  // state becomes one JSON item, anything else becomes `{ input: state }`.
  const trimmed = state.trim()
  let items: WorkflowItem[]
  if (trimmed.startsWith('{')) {
    try {
      items = [itemFromJson(JSON.parse(trimmed) as Record<string, unknown>, 0)]
    } catch {
      items = [itemFromText(state)]
    }
  } else {
    items = [itemFromText(state)]
  }
  try {
    const result = await executeCodeNode({
      node: originalNode,
      config,
      items,
      ctx: { userId, vars: {}, nodeOutputs: {} },
    })
    return { state: itemsToText(result.items), ok: true, summary: 'Code node ran.' }
  } catch (error) {
    // The dispatcher never throws for a bad node — it returns ok:false.
    const message = error instanceof Error ? error.message : 'Code node failed.'
    return { state, ok: false, summary: message, error: message }
  }
}

async function runRagNode(node: WorkflowNode, userId: string, query: string, topK: number): Promise<NodeRunResult> {
  const effectiveTopK = parseTopK(configNumber(node, 'topK') ?? topK)
  const documentId = configString(node, 'documentId', 'ragIndex')
  const scope = documentId && documentId.toLowerCase() !== 'all' ? documentId : undefined
  const queryVector = await generateEmbedding(query)
  const { hits } = await searchChunks({ userId, queryVector, topK: effectiveTopK, documentId: scope })
  const grounded = filterGroundedHits(hits)
  if (grounded.length === 0) {
    let emptyBase = false
    try {
      const db = await getDb()
      emptyBase = (await db.collection('rag_chunks').countDocuments({ userId })) === 0
    } catch {
      emptyBase = false
    }
    const message = emptyBase ? NO_DOCUMENTS_MESSAGE : NO_RELEVANT_DOCUMENTS_MESSAGE
    return {
      state: query,
      ok: false,
      summary: `Retrieved 0 grounded chunk(s) (similarity threshold ${SIMILARITY_THRESHOLD}).`,
      error: message,
    }
  }
  const sources = grounded.map((hit) => ({ text: hit.text.slice(0, 300), similarity: hit.similarity }))
  const context = grounded.map((hit, i) => `[Chunk ${i + 1}]\n${hit.text}`).join('\n\n')
  return {
    state: context,
    ok: true,
    summary: `Retrieved ${grounded.length} grounded chunk(s).`,
    sources,
  }
}

async function runLlmNode(node: WorkflowNode, agent: Agent | null | undefined, input: string, originalInput: string, agentKey?: AgentKey): Promise<NodeRunResult> {
  const system =
    configString(node, 'systemPrompt') ??
    (agent?.systemPrompt?.trim() ? agent.systemPrompt.trim() : undefined) ??
    `You are the "${node.name || 'Agent'}" node in an AgentFlow workflow. Answer naturally and helpfully, like a human assistant.`
  // Default cap 1200 (not 2048): node answers fit comfortably, and a 2048
  // cap pushes the request over the remaining credit on a nearly-empty
  // provider key (OpenRouter 402s it). A node or agent can still raise it.
  const maxTokens = configNumber(node, 'maxTokens') ?? configNumber(node, 'maxTokenBudget') ?? agent?.maxTokenBudget ?? 1200
  const model = configString(node, 'model')
  const prompt =
    input && input !== originalInput
      ? `Original question: ${originalInput}\n\nRetrieved context:\n${input}`
      : originalInput
  const completion = await chatCompletion({ system, prompt, maxTokens, model, temperature: 0.4, agentKey })
  if (!completion.ok) {
    return {
      state: input,
      ok: false,
      summary: 'No inference provider answered.',
      error: `No inference provider answered: ${completion.failures?.map((f) => f.message).join('; ') || 'unknown'}`,
      provider: null,
      model: null,
    }
  }
  return {
    state: completion.text,
    ok: true,
    summary: `LLM answered via ${completion.provider || 'provider'}.`,
    provider: completion.provider,
    model: completion.model,
  }
}

/**
 * Ask-a-teammate node (Lane B). Config: { to, text, requiresResponse }.
 * `to` names the teammate by agent id, role, or name; `text` is the
 * question (the running state when unset). The reply becomes the state.
 * Honest failures, never a fake reply: unknown teammate, no run to
 * record the conversation in, or no provider answering all fail the node.
 */
async function runAskNode(
  node: WorkflowNode,
  agent: Agent | null | undefined,
  userId: string,
  state: string,
  input: NodeRunInput,
): Promise<NodeRunResult> {
  const to = configString(node, 'to', 'toAgent', 'teammate')
  const text = configString(node, 'text', 'question') ?? state
  const requiresResponse = node.config?.requiresResponse !== false
  if (!to) {
    return {
      state,
      ok: false,
      summary: 'Ask node needs a teammate to ask (config "to": agent id, role, or name).',
      error: 'Ask node needs a teammate to ask (config "to": agent id, role, or name).',
    }
  }
  const workflowRunId = input.workflowRunId
  if (!workflowRunId) {
    return {
      state,
      ok: false,
      summary: 'Ask node needs a workflow run to record the conversation.',
      error:
        'Ask steps only run inside a workflow run (orchestrator or builder Run) — a bare graph run has nowhere to record the question and reply.',
    }
  }
  try {
    const result = await askTeammate({
      userId,
      workflowId: input.workflowId ?? workflowRunId,
      workflowRunId,
      fromAgent: agent ?? { _id: input.fromAgentId ?? 'system' },
      toRef: to,
      text,
      requiresResponse,
      conversation: input.conversation,
      sharedContext: input.sharedContext,
    })
    if (result.reply === null) {
      return {
        state,
        ok: true,
        summary: `Asked ${result.toAgent.name}; no reply requested.`,
      }
    }
    return {
      state: result.reply,
      ok: true,
      summary: `${result.toAgent.name} replied via ${result.provider ?? 'provider'}.`,
      provider: result.provider,
      model: result.model,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ask-a-teammate failed.'
    return { state, ok: false, summary: message, error: message }
  }
}

/**
 * Run one node. Never throws for a bad node type or a failed provider — it
 * returns ok:false with a plain error so the caller can record the failure.
 */
export async function runWorkflowNode(input: NodeRunInput): Promise<NodeRunResult> {
  const { agent = null, userId } = input
  const state = input.input
  const originalInput = input.originalInput ?? state
  const topK = input.topK ?? 3

  // Resolve `{{ }}` templates in node config string values before the node
  // uses them (n8n addendum, Lane F). The scope for the legacy string path
  // carries the running state as $json.input / $input; the item executor
  // (Lane H) builds a fuller scope from real items. A bad template fails
  // the node honestly instead of running with an unresolved value.
  let node = input.node
  if (node.config) {
    try {
      const scope = makeScope({
        json: { input: state },
        input: { all: [state], first: state, last: state },
      })
      node = { ...node, config: resolveConfigTemplates(node.config, scope) }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Node config templates could not be resolved.'
      return { state, ok: false, summary: 'Node config templates could not be resolved.', error: message }
    }
  }

  // 'ask' is dispatched before the switch (it is in the NodeType union —
  // src/lib/mongo/workflow.ts — but this pre-switch dispatch keeps the ask
  // node runnable wherever runWorkflowNode is called with a workflowRunId).
  if ((node.type as string) === 'ask') {
    return runAskNode(node, agent, userId, state, input)
  }

  switch (node.type) {
    case 'trigger':
      return { state, ok: true, summary: `Received input (${state.length} chars).` }
    case 'output':
      return { state, ok: true, summary: `Output ready (${state.length} chars).` }
    case 'llm':
      return runLlmNode(node, agent, state, originalInput, input.agentKey)
    case 'rag':
      return runRagNode(node, userId, state, topK)
    case 'api':
      return runApiNode(node, state)
    case 'code':
      // Raw (unresolved) node: the snippet is JavaScript, not a template.
      return runCodeNode(input.node, state, userId)
    case 'set':
      // Raw (unresolved) node: assignment values may be {{ }} templates.
      return runSetNode(input.node, state, userId)
    case 'http':
    case 'httpRequest':
      // Raw (unresolved) node: the URL may be a {{ }} template.
      return runHttpNode(input.node, state, userId)
    case 'condition': {
      const expression = configString(node, 'expression')
      if (expression !== undefined) {
        const result = evaluateCondition(expression, state)
        if (!result.ok) {
          return { state, ok: false, summary: 'Condition could not be evaluated.', error: result.error }
        }
        return {
          state: result.value ? 'true' : 'false',
          ok: true,
          summary: `Condition evaluated to ${result.value}.`,
        }
      }
      // No expression string: the structured config form
      // ({ field, operator, value } or a fixed-grammar condition string)
      // that save-time validation accepts. It throws on anything outside
      // the grammar, so a bad node fails honestly instead of guessing.
      try {
        const value = evaluateCondition(node.config as Record<string, unknown> | undefined, state)
        return {
          state: value ? 'true' : 'false',
          ok: true,
          summary: `Condition evaluated to ${value}.`,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid condition.'
        return { state, ok: false, summary: 'Condition could not be evaluated.', error: message }
      }
    }
    default:
      return {
        state,
        ok: false,
        summary: `Node type "${node.type}" is not supported by the execution engine. Configure the node as trigger, llm, rag, api, code, set, http, httpRequest, condition, or output.`,
        error: `Node type "${node.type}" is not supported by the execution engine. Configure the node as trigger, llm, rag, api, code, set, http, httpRequest, condition, or output.`,
      }
  }
}

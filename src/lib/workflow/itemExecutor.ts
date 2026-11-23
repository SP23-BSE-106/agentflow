/**
 * Item executor (n8n §4/§6/§7 of the feature map).
 *
 * Runs a workflow graph item-by-item: every node receives an array of
 * `WorkflowItem`s and returns an array of items, with `pairedItem`
 * lineage carried through. This is the n8n-shaped execution path; the
 * existing string executor (`executeWorkflow`, used by legacy
 * `/api/execute` runs) is untouched.
 *
 * ONE-ENGINE RULE: legacy node types (`trigger`, `llm`, `rag`, `api`,
 * `condition`, `output`) run by delegating to the existing single
 * dispatcher `runWorkflowNode` (`src/lib/workflow/nodeRunner.ts`),
 * converting the running item's `json` to/from the string state. New
 * n8n node types (`set`, `code`, `if`, `switch`, `merge`,
 * `splitInBatches`, `wait`, `executeWorkflow`, `errorTrigger`,
 * `formTrigger`, `respondToWebhook`, `http`, `webhook`, `schedule`,
 * `manual`) execute natively in the executors under
 * `src/lib/nodes/executors/`.
 *
 * Behaviour:
 * - Pinning: `graph.pinData[nodeId]` is used instead of executing the node.
 * - Version: nodes carry `version` (from `defaultVersion` at creation);
 *   new node types only ship version 1 in this pass — any other version
 *   fails honestly instead of running the wrong behaviour.
 * - `$vars`: `graph.variables` merged with `ctx.vars`, resolved into
 *   `{{ }}` templates in node config by the executors, per item.
 * - Error handling: per-node `config.onError` (`continueErrorOutput` |
 *   `continueRegularOutput` | `stop`, default `stop`),
 *   `config.maxTries` (default 1), `config.waitBetweenTries` (ms, default 0).
 * - Wait: a Wait node persists the run in `waiting_executions` and the
 *   run returns status `waiting`; resume via
 *   `POST /api/executions/[id]/resume`.
 * - Error workflows: an unhandled error runs `graph.errorWorkflowId`
 *   with one error item (best effort; its failure never replaces the
 *   original error).
 * - Statuses: the run is recorded in `workflow_runs` as
 *   running → success | error | waiting, and stale runs are marked
 *   crashed at run start (`markStaleRunsCrashed`).
 * - Split In Batches: after each batch's downstream wave finishes, the
 *   downstream subgraph re-runs with the next batch (bounded to 100
 *   passes). A downstream join with a parent outside the loop cannot be
 *   re-run honestly and fails the run instead of silently dropping data.
 *
 * The executor never executes user text as code. `{{ }}` expressions are
 * evaluated by the sandboxed engine in `src/lib/expression/engine.ts`
 * (one engine for every `{{ }}` template in the app); Code nodes run in
 * a `node:vm` context (see `executors/code.ts`).
 */

import { ObjectId } from 'mongodb'
import { getDb } from '@/lib/mongo/mongo'
import { runWorkflow } from '@/lib/workflow/runWorkflow'
import { runWorkflowNode } from '@/lib/workflow/nodeRunner'
import { chooseBranchEdge } from '@/lib/workflow/branching'
import type { AgentKey } from '@/lib/llm'
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from '@/lib/mongo/workflow'
import {
  itemFromJson,
  itemFromText,
  itemsToText,
  type WorkflowItem,
} from '@/lib/nodes/items'
import { executeSetNode } from '@/lib/nodes/executors/set'
import { executeCodeNode } from '@/lib/nodes/executors/code'
import { executeIfNode } from '@/lib/nodes/executors/if'
import { executeSwitchNode } from '@/lib/nodes/executors/switch'
import { executeMergeNode } from '@/lib/nodes/executors/merge'
import { executeSplitInBatchesNode } from '@/lib/nodes/executors/splitInBatches'
import { executeWaitNode } from '@/lib/nodes/executors/wait'
import { executeExecuteWorkflowNode } from '@/lib/nodes/executors/executeWorkflow'
import { executeRespondToWebhookNode } from '@/lib/nodes/executors/respondToWebhook'
import { executeHttpNode } from '@/lib/nodes/executors/http'
import {
  executeErrorTriggerNode,
  executeFormTriggerNode,
  executeManualNode,
  executeScheduleNode,
  executeWebhookNode,
} from '@/lib/nodes/executors/triggers'
import type { ExecutorContext, ExecutorResult, NodeExecutor } from '@/lib/nodes/executors/context'
import { markStaleRunsCrashed } from '@/lib/execution/statuses'
import { saveWaitingExecution } from '@/lib/execution/waitStore'
import { dispatchErrorWorkflow } from '@/lib/execution/errorWorkflow'

export type NodeItemResult = {
  nodeId: string
  name: string
  type: string
  ok: boolean
  durationMs: number
  items: WorkflowItem[]
  error?: string
}

export type ItemRunResult = {
  output: WorkflowItem[]
  nodeResults: NodeItemResult[]
  status: 'success' | 'error' | 'waiting'
  /** Grounded sources from RAG nodes (legacy delegation), as the string
   * executor collects them. Empty when no RAG node retrieved anything. */
  sources: Array<{ text: string; similarity: number }>
}

export type ItemRunResume = {
  /** The waiting execution id to resume. */
  executionId: string
  /** The Wait node the run paused at. */
  nodeId: string
  /** Items the Wait node received (resume with these, or with `items` below). */
  items: WorkflowItem[]
  /** Node results recorded before the pause. */
  nodeResults: NodeItemResult[]
  /** Items to resume with instead of the paused items, when supplied. */
  resumeItems?: WorkflowItem[]
}

export type ItemRunContext = {
  userId: string
  agentId?: string
  workflowId?: string
  /** The agent's decrypted API key, tried before env keys by legacy LLM
   * nodes — the same key the string executor threads through. */
  agentKey?: AgentKey
  /** Retrieval depth for legacy RAG nodes (default 3, as elsewhere). */
  topK?: number
  vars?: Record<string, unknown>
  credentials?: Map<string, Record<string, unknown>>
  onNodeDone?: (r: NodeItemResult) => void
  /** Resume a paused run (used by the resume route). */
  resume?: ItemRunResume
  /** Sub-workflow runner seam; defaults to the real `runWorkflow`. */
  runSubWorkflow?: (workflowId: string, inputItems: WorkflowItem[]) => Promise<WorkflowItem[]>
  /** Error-workflow dispatch seam; defaults to the real dispatcher. */
  dispatchErrorWorkflow?: (dispatch: {
    userId: string
    errorWorkflowId: string
    error: string
    workflowId?: string
    workflowName?: string
    executionId?: string
  }) => Promise<{ ok: boolean; message: string }>
}

const LEGACY_TYPES = new Set(['trigger', 'llm', 'rag', 'api', 'condition', 'output', 'ask'])

const TRIGGER_TYPES = new Set([
  'trigger',
  'webhook',
  'manual',
  'schedule',
  'formTrigger',
  'errorTrigger',
])

const NEW_EXECUTORS: Record<string, NodeExecutor> = {
  set: executeSetNode,
  code: executeCodeNode,
  if: executeIfNode,
  switch: executeSwitchNode,
  merge: executeMergeNode,
  splitInBatches: executeSplitInBatchesNode,
  wait: executeWaitNode,
  executeWorkflow: executeExecuteWorkflowNode,
  respondToWebhook: executeRespondToWebhookNode,
  http: executeHttpNode,
  // Canonical name is 'httpRequest' (registry/builder: descriptions/core.ts);
  // 'http' is its alias for workflows saved under that name (NodeType union,
  // registry alias). Both keys run the same executor, so a workflow saved
  // under either spelling executes — the registry alias is what routes an
  // 'http'-only graph here instead of the string executor.
  httpRequest: executeHttpNode,
  webhook: executeWebhookNode,
  manual: executeManualNode,
  schedule: executeScheduleNode,
  formTrigger: executeFormTriggerNode,
  errorTrigger: executeErrorTriggerNode,
}

const MAX_JOBS = 10_000
const MAX_LOOP_PASSES = 100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nodeConfig(node: WorkflowNode): Record<string, unknown> {
  return (node.config ?? {}) as Record<string, unknown>
}

function errorItems(items: WorkflowItem[], message: string, nodeName: string): WorkflowItem[] {
  if (items.length === 0) {
    return [itemFromJson({ error: message }, 0)]
  }
  return items.map((item, index) => ({
    ...item,
    error: { message, node: nodeName },
    pairedItem: item.pairedItem ?? index,
  }))
}

type Job = {
  nodeId: string
  items: WorkflowItem[]
  sourceId: string | null
  outputName: string | null
  /** True when this job only settles a parent (no items from it). */
  settledOnly?: boolean
  /** True for a Split In Batches reseed: bypass the join barrier. */
  reseed?: boolean
}

export async function executeWorkflowItems(
  graph: WorkflowGraph,
  inputItems: WorkflowItem[],
  ctx: ItemRunContext,
): Promise<ItemRunResult> {
  // Crash recovery at run start: runs left `new`/`running` by a dead
  // process are marked `crashed`. Best effort — never fatal to this run.
  try {
    await markStaleRunsCrashed(undefined, { userId: ctx.userId })
  } catch {
    // Ignore: stale-marking must never stop a run from starting.
  }

  const executionId = ctx.resume?.executionId ?? new ObjectId().toHexString()
  const nodes = graph?.nodes ?? []
  const edges = graph?.edges ?? []
  const vars = { ...(graph.variables ?? {}), ...(ctx.vars ?? {}) }
  const nodeResults: NodeItemResult[] = []
  const sources: Array<{ text: string; similarity: number }> = []
  // Live map of prior node outputs, shared with executors so `$node`
  // references resolve against nodes that already ran.
  const nodeOutputs: Record<string, { json: Record<string, unknown> }> = {}
  const startedAt = Date.now()

  // Record the run so the executions list and crash recovery can see it.
  try {
    const db = await getDb()
    if (ctx.resume) {
      await db.collection('workflow_runs').updateOne(
        { _id: new ObjectId(executionId) },
        { $set: { status: 'running' }, $unset: { finishedAt: '' } },
      )
    } else {
      await db.collection('workflow_runs').insertOne({
        _id: new ObjectId(executionId),
        userId: ctx.userId,
        agentId: ctx.agentId,
        workflowId: ctx.workflowId,
        status: 'running',
        input: itemsToText(inputItems).slice(0, 2000),
        createdAt: new Date(),
      })
    }
  } catch {
    // Recording must never stop a run.
  }

  const finishRun = async (status: 'success' | 'error' | 'waiting', output: WorkflowItem[]) => {
    try {
      const db = await getDb()
      await db.collection('workflow_runs').updateOne(
        { _id: new ObjectId(executionId) },
        {
          $set: {
            status,
            output: itemsToText(output).slice(0, 4000),
            durationMs: Date.now() - startedAt,
            finishedAt: new Date(),
          },
        },
      )
    } catch {
      // Ignore.
    }
  }

  if (nodes.length === 0) {
    await finishRun('success', inputItems)
    return { output: inputItems, nodeResults, status: 'success', sources }
  }

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const outgoing = new Map<string, WorkflowEdge[]>()
  const parents = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue
    const list = outgoing.get(edge.source) ?? []
    list.push(edge)
    outgoing.set(edge.source, list)
    const set = parents.get(edge.target) ?? new Set<string>()
    set.add(edge.source)
    parents.set(edge.target, set)
  }

  const queue: Job[] = []
  const completed = new Set<string>()
  const settled = new Set<string>()
  const arrived = new Map<string, Map<string, WorkflowItem[]>>()
  const arrivedSources = new Map<string, Set<string>>()
  const takenEdges = new Set<string>()
  const pendingLoops: Array<{ nodeId: string; items: WorkflowItem[] }> = []
  const loopPasses = new Map<string, number>()
  const terminalOutput: WorkflowItem[] = []
  let jobsProcessed = 0
  let runStatus: ItemRunResult['status'] = 'success'
  let stopped = false

  const notifyChildrenSettled = (nodeId: string) => {
    for (const edge of outgoing.get(nodeId) ?? []) {
      queue.push({ nodeId: edge.target, items: [], sourceId: nodeId, outputName: null, settledOnly: true })
    }
  }

  const markSettled = (nodeId: string) => {
    if (settled.has(nodeId)) return
    settled.add(nodeId)
    completed.add(nodeId)
    notifyChildrenSettled(nodeId)
  }

  /** Nodes that can no longer be reached, given the edges actually taken. */
  const settleUnreachable = () => {
    const reachable = new Set<string>()
    const entryIds = nodes
      .filter((n) => TRIGGER_TYPES.has(n.type) || !(parents.get(n.id)?.size ?? 0))
      .map((n) => n.id)
    const walk: string[] = entryIds.length > 0 ? entryIds : [nodes[0].id]
    while (walk.length > 0) {
      const id = walk.shift()!
      if (reachable.has(id)) continue
      reachable.add(id)
      for (const edge of outgoing.get(id) ?? []) {
        // A branching node that ran only follows its taken edges.
        if (completed.has(edge.source) && !takenEdges.has(edge.id)) continue
        if (!reachable.has(edge.target)) walk.push(edge.target)
      }
    }
    for (const node of nodes) {
      if (!reachable.has(node.id) && !settled.has(node.id) && !completed.has(node.id)) {
        markSettled(node.id)
      }
    }
  }

  /** Nodes reachable downstream of `nodeId` (excluding `nodeId` itself). */
  const downstreamOf = (nodeId: string): Set<string> => {
    const found = new Set<string>()
    const walk = [...(outgoing.get(nodeId) ?? []).map((edge) => edge.target)]
    while (walk.length > 0) {
      const id = walk.shift()!
      if (found.has(id)) continue
      found.add(id)
      for (const edge of outgoing.get(id) ?? []) {
        if (!found.has(edge.target)) walk.push(edge.target)
      }
    }
    return found
  }

  const seedItems = (items: WorkflowItem[]): WorkflowItem[] =>
    items.length > 0 ? items : [itemFromJson({})]

  // ── Resume: prior nodes are done; continue after the Wait node. ────
  const resume = ctx.resume
  if (resume) {
    for (const prior of resume.nodeResults) {
      nodeResults.push(prior)
      completed.add(prior.nodeId)
      settled.add(prior.nodeId)
      if (prior.items.length > 0) {
        nodeOutputs[prior.name] = { json: prior.items[0].json }
      }
    }
    const waitNode = byId.get(resume.nodeId)
    const resumeItems = seedItems(resume.resumeItems ?? resume.items)
    if (waitNode) {
      completed.add(waitNode.id)
      settled.add(waitNode.id)
      nodeOutputs[waitNode.name] = { json: resumeItems[0].json }
      for (const edge of outgoing.get(waitNode.id) ?? []) {
        takenEdges.add(edge.id)
        queue.push({ nodeId: edge.target, items: resumeItems, sourceId: waitNode.id, outputName: null })
      }
      // Parents of downstream nodes that already ran must not block the
      // join barrier: settle them (they send no further items).
      for (const node of nodes) {
        if (!completed.has(node.id)) continue
        for (const edge of outgoing.get(node.id) ?? []) {
          if (!arrivedSources.get(edge.target)?.has(node.id)) {
            queue.push({ nodeId: edge.target, items: [], sourceId: node.id, outputName: null, settledOnly: true })
          }
        }
      }
    }
  } else {
    const entries = nodes.filter(
      (node) => TRIGGER_TYPES.has(node.type) || !(parents.get(node.id)?.size ?? 0),
    )
    const seeds = entries.length > 0 ? entries : [nodes[0]]
    for (const node of seeds) {
      queue.push({ nodeId: node.id, items: seedItems(inputItems), sourceId: null, outputName: null })
    }
  }

  const defaultSubWorkflowRunner = async (
    workflowId: string,
    items: WorkflowItem[],
  ): Promise<WorkflowItem[]> => {
    const db = await getDb()
    const result = await runWorkflow({ db, userId: ctx.userId, agentId: workflowId, input: itemsToText(items) })
    if (!result.ok) {
      throw new Error(result.error ?? 'Sub-workflow run failed.')
    }
    return [itemFromText(result.output)]
  }

  const runNodeOnce = async (
    node: WorkflowNode,
    items: WorkflowItem[],
    inputGroups?: Map<string, WorkflowItem[]>,
  ): Promise<ExecutorResult> => {
    const version = node.version ?? 1
    if (LEGACY_TYPES.has(node.type)) {
      const state = itemsToText(items)
      const result = await runWorkflowNode({
        node,
        userId: ctx.userId,
        input: state,
        originalInput: state,
        agentKey: ctx.agentKey,
        topK: ctx.topK,
        // Builder runs own their executionId — pass it as the workflow
        // run id so an 'ask' node can record its question + reply.
        // Other legacy node types ignore it.
        workflowRunId: executionId,
      })
      if (!result.ok) {
        throw new Error(result.error ?? result.summary)
      }
      // A RAG node's grounded sources ride along, exactly as the string
      // executor collects them, so the caller can report grounding.
      if (result.sources) sources.push(...result.sources)
      // A Condition node's verdict is control flow, not data: downstream
      // keeps the original items, and the edge label picks the branch.
      if (node.type === 'condition') {
        const verdict = result.state === 'true'
        return {
          items,
          outputs: { [verdict ? 'true' : 'false']: items, [verdict ? 'false' : 'true']: [] },
        }
      }
      const trimmed = result.state.trim()
      let outItems: WorkflowItem[]
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>
          outItems = [itemFromJson(parsed, 0)]
        } catch {
          outItems = [itemFromText(result.state)]
        }
      } else {
        outItems = [itemFromText(result.state)]
      }
      return { items: outItems }
    }

    if (version !== 1) {
      throw new Error(
        `Node type "${node.type}" version ${version} is not supported (this build ships version 1).`,
      )
    }
    const executor = NEW_EXECUTORS[node.type]
    if (!executor) {
      throw new Error(`Node type "${node.type}" is not supported by the item executor.`)
    }
    const executorCtx: ExecutorContext = {
      userId: ctx.userId,
      workflowId: ctx.workflowId,
      vars,
      credentials: ctx.credentials,
      nodeOutputs,
      runSubWorkflow: ctx.runSubWorkflow ?? defaultSubWorkflowRunner,
    }
    if (node.type === 'merge' && inputGroups) {
      ;(executorCtx as ExecutorContext & { inputGroups?: Map<string, WorkflowItem[]> }).inputGroups =
        inputGroups
    }
    return executor({ node, config: nodeConfig(node), items, ctx: executorCtx })
  }

  const routeOutputs = (node: WorkflowNode, outputs: Record<string, WorkflowItem[]>) => {
    const edges = outgoing.get(node.id) ?? []
    // A Condition node emits { true: items, false: [] } (or the reverse),
    // so the taken branch is decided by the one shared rule in
    // branching.ts — never by the generic label routing below, which
    // would follow every unlabeled edge and run both branches.
    if (node.type === 'condition' && 'true' in outputs && 'false' in outputs) {
      const verdict = (outputs['true']?.length ?? 0) > 0
      const chosen = chooseBranchEdge(edges, verdict)
      if (chosen) {
        const outputName = verdict ? 'true' : 'false'
        takenEdges.add(chosen.id)
        queue.push({
          nodeId: chosen.target,
          items: outputs[outputName] ?? [],
          sourceId: node.id,
          outputName,
        })
      }
      return
    }
    const outputNames = Object.keys(outputs)
    for (const edge of edges) {
      const label = String(edge.label ?? '').trim().toLowerCase()
      let outputName: string | null = null
      if (!label || label === 'main') {
        outputName = outputNames.includes('main') ? 'main' : outputNames[0]
      } else if (outputNames.includes(label)) {
        outputName = label
      } else if (outputNames.includes(edge.label ?? '')) {
        outputName = edge.label as string
      } else {
        // No matching named output: this edge belongs to another branch.
        continue
      }
      takenEdges.add(edge.id)
      queue.push({
        nodeId: edge.target,
        items: outputs[outputName] ?? [],
        sourceId: node.id,
        outputName,
      })
    }
  }

  while ((queue.length > 0 || pendingLoops.length > 0) && !stopped) {
    // A batch wave finished: re-run the split node's downstream subgraph
    // with the next batch.
    if (queue.length === 0 && pendingLoops.length > 0) {
      const pending = pendingLoops.shift()!
      const downstream = downstreamOf(pending.nodeId)
      const reset = new Set([pending.nodeId, ...downstream])
      for (const id of reset) {
        completed.delete(id)
        settled.delete(id)
        arrived.delete(id)
        arrivedSources.delete(id)
      }
      queue.push({ nodeId: pending.nodeId, items: seedItems(pending.items), sourceId: null, outputName: null, reseed: true })
      continue
    }
    if (++jobsProcessed > MAX_JOBS) {
      runStatus = 'error'
      break
    }
    const job = queue.shift()!
    const node = byId.get(job.nodeId)
    if (!node) continue
    if (completed.has(job.nodeId)) continue

    // Accumulate inputs; a node with several parents runs once every
    // parent has delivered (items) or settled (nothing more coming).
    // A Split In Batches reseed bypasses the barrier: its parents
    // already delivered in an earlier pass.
    const nodeParents = parents.get(job.nodeId) ?? new Set<string>()
    if (job.sourceId) {
      const bySource = arrived.get(job.nodeId) ?? new Map<string, WorkflowItem[]>()
      bySource.set(job.sourceId, job.items)
      arrived.set(job.nodeId, bySource)
      const sources = arrivedSources.get(job.nodeId) ?? new Set<string>()
      sources.add(job.sourceId)
      arrivedSources.set(job.nodeId, sources)
    }
    if (!job.reseed) {
      const allParentsAccounted = [...nodeParents].every((parentId) =>
        arrivedSources.get(job.nodeId)?.has(parentId),
      )
      if (nodeParents.size > 0 && !allParentsAccounted) continue
    }

    const inputGroups = job.reseed ? undefined : arrived.get(job.nodeId)
    const mergedInput: WorkflowItem[] =
      inputGroups && inputGroups.size > 0 ? [...inputGroups.values()].flat() : seedItems(job.items)

    // A node whose parents all settled without sending it any items has
    // nothing to work on — settle it without running, so its children
    // are not left waiting.
    if (nodeParents.size > 0 && mergedInput.length === 0) {
      markSettled(node.id)
      settleUnreachable()
      continue
    }

    // ── Pinning: frozen output instead of executing the node. ────────
    const pinned = graph.pinData?.[node.id]
    const started = Date.now()
    let result: ExecutorResult
    let nodeError: string | undefined
    if (pinned) {
      result = { items: pinned }
    } else {
      const config = nodeConfig(node)
      const maxTries = Math.max(1, Math.floor(Number(config.maxTries ?? 1)) || 1)
      const waitBetweenTries = Math.max(0, Number(config.waitBetweenTries ?? 0) || 0)
      let lastError = ''
      let attemptResult: ExecutorResult | undefined
      for (let attempt = 0; attempt < maxTries; attempt++) {
        if (attempt > 0 && waitBetweenTries > 0) await sleep(waitBetweenTries)
        try {
          attemptResult = await runNodeOnce(node, mergedInput, inputGroups)
          break
        } catch (error) {
          lastError = error instanceof Error ? error.message : 'Node failed.'
          attemptResult = undefined
        }
      }
      if (!attemptResult) {
        nodeError = lastError || 'Node failed.'
        result = { items: [] }
      } else {
        result = attemptResult
      }
    }

    const durationMs = Date.now() - started

    // ── Wait: persist the run and pause. ─────────────────────────────
    if (!nodeError && result.wait) {
      const waitResult: NodeItemResult = {
        nodeId: node.id,
        name: node.name,
        type: node.type,
        ok: true,
        durationMs,
        items: mergedInput,
      }
      nodeResults.push(waitResult)
      ctx.onNodeDone?.(waitResult)
      try {
        await saveWaitingExecution({
          executionId,
          workflowId: ctx.workflowId ?? '',
          userId: ctx.userId,
          nodeId: node.id,
          resumeAt: result.wait.resumeAt,
          resumeKind: result.wait.resumeKind,
          state: {
            graph,
            items: mergedInput,
            nodeResults: [...nodeResults],
            vars,
          },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Wait state could not be saved.'
        await finishRun('error', [])
        return {
          output: [],
          nodeResults: [
            ...nodeResults,
            {
              nodeId: node.id,
              name: node.name,
              type: node.type,
              ok: false,
              durationMs,
              items: [],
              error: message,
            },
          ],
          status: 'error',
          sources,
        }
      }
      await finishRun('waiting', [])
      return { output: [], nodeResults, status: 'waiting', sources }
    }

    // ── Split In Batches loop guard: a downstream join with a parent
    // outside the loop cannot be re-run honestly. ────────────────────
    if (!nodeError && result.loopItems && result.loopItems.length > 0) {
      const downstream = downstreamOf(node.id)
      const badJoin = [...downstream].find((id) =>
        [...(parents.get(id) ?? [])].some((parentId) => parentId !== node.id && !downstream.has(parentId)),
      )
      if (badJoin) {
        nodeError =
          `Split In Batches cannot loop: node "${byId.get(badJoin)?.name ?? badJoin}" joins ` +
          'a branch from outside the loop, so its other input would be lost on the next batch.'
      }
    }

    // ── Error handling per node config. ──────────────────────────────
    const config = nodeConfig(node)
    const onError =
      config.onError === 'continueErrorOutput' || config.onError === 'continueRegularOutput'
        ? config.onError
        : 'stop'
    if (nodeError) {
      const failedResult: NodeItemResult = {
        nodeId: node.id,
        name: node.name,
        type: node.type,
        ok: false,
        durationMs,
        items: [],
        error: nodeError,
      }
      nodeResults.push(failedResult)
      ctx.onNodeDone?.(failedResult)
      completed.add(node.id)
      settled.add(node.id)
      if (onError === 'stop') {
        runStatus = 'error'
        if (graph.errorWorkflowId) {
          const dispatch = ctx.dispatchErrorWorkflow ?? dispatchErrorWorkflow
          try {
            await dispatch({
              userId: ctx.userId,
              errorWorkflowId: graph.errorWorkflowId,
              error: nodeError,
              workflowId: ctx.workflowId,
              executionId,
            })
          } catch {
            // Dispatch failure never replaces the original error.
          }
        }
        stopped = true
        break
      }
      const errItems = errorItems(mergedInput, nodeError, node.name)
      const errorEdges = (outgoing.get(node.id) ?? []).filter(
        (edge) => String(edge.label ?? '').trim().toLowerCase() === 'error',
      )
      if (onError === 'continueErrorOutput' && errorEdges.length > 0) {
        for (const edge of errorEdges) {
          takenEdges.add(edge.id)
          queue.push({ nodeId: edge.target, items: errItems, sourceId: node.id, outputName: 'error' })
        }
      } else if (onError === 'continueRegularOutput') {
        for (const edge of outgoing.get(node.id) ?? []) {
          takenEdges.add(edge.id)
          queue.push({ nodeId: edge.target, items: errItems, sourceId: node.id, outputName: null })
        }
      }
      notifyChildrenSettled(node.id)
      settleUnreachable()
      continue
    }

    // ── Success: record, then route outputs along edges. ────────────
    const outputs: Record<string, WorkflowItem[]> = result.outputs ?? { main: result.items }
    const primaryItems = result.items
    const nodeResult: NodeItemResult = {
      nodeId: node.id,
      name: node.name,
      type: node.type,
      ok: true,
      durationMs,
      items: primaryItems,
    }
    nodeResults.push(nodeResult)
    ctx.onNodeDone?.(nodeResult)
    if (primaryItems.length > 0) {
      nodeOutputs[node.name] = { json: primaryItems[0].json }
    }

    // Split In Batches: this batch flows downstream now; the remainder
    // is queued and runs after the current wave drains.
    if (result.loopItems && result.loopItems.length > 0) {
      const passes = (loopPasses.get(node.id) ?? 0) + 1
      loopPasses.set(node.id, passes)
      if (passes < MAX_LOOP_PASSES) {
        pendingLoops.push({ nodeId: node.id, items: result.loopItems })
      } else {
        runStatus = 'error'
        nodeResults.push({
          nodeId: node.id,
          name: node.name,
          type: node.type,
          ok: false,
          durationMs: 0,
          items: [],
          error: `Split In Batches exceeded ${MAX_LOOP_PASSES} passes.`,
        })
        stopped = true
        break
      }
    }

    completed.add(node.id)
    settled.add(node.id)
    routeOutputs(node, outputs)
    // H2: entry/trigger nodes pass the seed input through unchanged, and an
    // unconnected trigger (the formTrigger that only *defines* a form) is
    // itself terminal — so its untouched input items used to land first in
    // terminalOutput and shadow the workflow's real result (a form
    // submission returned the raw input, never the computed output).
    // Trigger-type nodes never contribute terminal output; the real
    // terminal nodes (output/code/llm/…) win. A graph whose only terminal
    // node is a trigger still falls back to the last node result below.
    if ((outgoing.get(node.id) ?? []).length === 0 && !TRIGGER_TYPES.has(node.type)) {
      terminalOutput.push(...primaryItems)
    }
    settleUnreachable()
  }

  const output =
    terminalOutput.length > 0
      ? terminalOutput
      : nodeResults.length > 0
        ? nodeResults[nodeResults.length - 1].items
        : inputItems
  await finishRun(runStatus, output)
  return { output, nodeResults, status: runStatus, sources }
}

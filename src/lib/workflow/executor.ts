import type { WorkflowGraph } from '@/lib/mongo/workflow'
import type { AgentKey } from '@/lib/llm'
import { runWorkflowNode } from '@/lib/workflow/nodeRunner'
import { chooseBranchEdge } from '@/lib/workflow/branching'
import { parseTopK } from '@/lib/rag/grounding'
import { validateWorkflowGraph } from '@/lib/workflow/condition'

export type TraceStep = {
  nodeId: string
  name: string
  type: string
  ok: boolean
  durationMs: number
  summary: string
  /** The failing step's own detail (e.g. the provider's rejection), when it has one — the summary stays short for the log, the detail is what a caller shows. */
  error?: string
}

export type ExecutionResult = {
  output: string
  trace: TraceStep[]
  sources: Array<{ text: string; similarity: number }>
  provider: string | null
  model: string | null
}

/**
 * Single-agent graph run. Node behaviour lives in exactly one place —
 * src/lib/workflow/nodeRunner.ts — which the multi-agent orchestrator also
 * calls, so the same graph cannot mean two different things depending on
 * which endpoint ran it.
 *
 * Traversal is breadth-first from the trigger node. A Condition node follows
 * only the outgoing edge the one shared branch-selection rule picks
 * (`chooseBranchEdge` in `src/lib/workflow/branching.ts` — label match
 * wins; unlabeled → first edge true / last edge false), the same rule the
 * orchestrator uses, so the same graph + input branches identically on
 * every execution path.
 */
export async function executeWorkflow(graph: WorkflowGraph, input: string, userId: string, options?: { topK?: number; agentKey?: AgentKey }): Promise<ExecutionResult> {
  const nodes = graph?.nodes || []
  const edges = graph?.edges || []
  const trace: TraceStep[] = []
  const sources: Array<{ text: string; similarity: number }> = []
  let provider: string | null = null
  let model: string | null = null

  // A workflow with an unsafe Condition node is refused before anything runs.
  const graphError = validateWorkflowGraph(graph)
  if (graphError) {
    trace.push({ nodeId: '', name: 'workflow', type: 'validation', ok: false, durationMs: 0, summary: graphError })
    return { output: input, trace, sources, provider, model }
  }

  if (!nodes.length) {
    return { output: input, trace, sources, provider, model }
  }

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const outgoing = new Map<string, typeof edges>()
  for (const edge of edges) {
    const list = outgoing.get(edge.source) || []
    list.push(edge)
    outgoing.set(edge.source, list)
  }

  const trigger = nodes.find((node) => node.type === 'trigger') || nodes[0]
  const queue: string[] = [trigger.id]
  const visited = new Set<string>()
  let state = input
  const topK = parseTopK(options?.topK, 3)
  // A Condition node's verdict is control flow, not data: it decides which
  // edge is followed, but the data state passing downstream is unchanged.
  // (The old code replaced the state with 'true'/'false', so everything
  // after a condition only ever saw the verdict and the payload was lost.)
  const verdicts = new Map<string, 'true' | 'false'>()

  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    const node = byId.get(id)
    if (!node) continue

    const start = Date.now()
    const result = await runWorkflowNode({ node, userId, input: state, originalInput: input, topK, agentKey: options?.agentKey })
    trace.push({ nodeId: node.id, name: node.name, type: node.type, ok: result.ok, durationMs: Date.now() - start, summary: result.summary, error: result.error })
    if (result.provider) provider = result.provider
    if (result.model) model = result.model
    if (result.sources) sources.push(...result.sources)
    if (node.type === 'condition' && result.ok) {
      verdicts.set(node.id, result.state === 'true' ? 'true' : 'false')
    } else {
      state = result.state
    }

    const nextEdges = outgoing.get(id) || []
    if (node.type === 'condition' && nextEdges.length > 1) {
      const chosen = chooseBranchEdge(nextEdges, verdicts.get(id) === 'true')
      if (chosen) queue.push(chosen.target)
    } else {
      for (const edge of nextEdges) queue.push(edge.target)
    }
  }

  return { output: state, trace, sources, provider, model }
}

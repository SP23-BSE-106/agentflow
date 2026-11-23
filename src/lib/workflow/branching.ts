/**
 * Condition branching for workflow graphs (addendum 3).
 *
 * ONE SHARED BRANCH-SELECTION RULE — every execution path in the codebase
 * routes its Condition branching through `chooseBranchEdge` here, so the
 * same graph + input can never take a different branch depending on which
 * API ran it:
 *   - `src/lib/workflow/executor.ts` (`/api/execute`, string executor)
 *   - `src/lib/workflow/itemExecutor.ts` (`/api/execute`, item executor)
 *   - `src/lib/orchestration/orchestrator.ts` (sequential AND parallel
 *     modes; sequential prunes with the chosen edge, parallel skips any
 *     task whose incoming edge is not the chosen one)
 * `src/lib/workflow/condition.ts` re-exports `chooseBranchEdge` so existing
 * imports keep working; the implementation lives here and nowhere else.
 *
 * The rule: a label match wins — an edge whose label contains "true" is the
 * true branch, one whose label contains "false" is the false branch. With
 * no matching label, the unlabeled edges decide: the FIRST unlabeled edge
 * is the true branch and the LAST unlabeled edge is the false branch. When
 * every edge is labelled true/false and none matches the outcome, NO edge
 * is followed: the labels explicitly assign every edge to an outcome, and
 * following one would run the branch the outcome did NOT select (a single
 * 'true'-labelled edge on a false verdict must run nothing — the n8n
 * legacy-condition test pins this). An unlabeled edge is therefore NOT
 * "always followed": on the outcome it does not select, the nodes
 * downstream of it are skipped, never run, and do not count as
 * failed.
 *
 * `reachableNodeIds` walks the graph from its entry points (nodes with no
 * incoming edge, or the trigger node) following only the edges the rule
 * keeps. Any node it cannot reach is skipped. A node stays reachable when
 * any of its incoming edges is still followed, so a join after the two
 * branches is not wrongly skipped.
 */

import type { WorkflowEdge, WorkflowNode } from '@/lib/mongo/workflow'

export type ConditionOutcomes = Map<string, 'true' | 'false'>

/** The branch an edge label selects, or null when the edge is unlabeled. */
export function branchLabelOf(edge: { label?: string }): 'true' | 'false' | null {
  const label = String(edge.label ?? '').trim().toLowerCase()
  if (!label) return null
  const hasTrue = label.includes('true')
  const hasFalse = label.includes('false')
  if (hasTrue && hasFalse) return null
  if (hasTrue) return 'true'
  if (hasFalse) return 'false'
  return null
}

/** The minimum edge shape branch selection needs. The constraint must
 * carry `source`/`target` (not just `label`): callers pass inline edge
 * literals, and TypeScript contextually types those literals against the
 * constraint — a `{ label?: string }` constraint rejects `source`/`target`
 * as excess properties (phase0 tsc proved it). */
export type BranchEdgeLike = { source: string; target: string; label?: string }

/**
 * Pick the outgoing edge a Condition node follows for a result, using the
 * one shared rule (see the module header): a label match wins; with no
 * matching label the first unlabeled edge is the true branch and the last
 * unlabeled edge is the false branch.
 */
export function chooseBranchEdge<T extends BranchEdgeLike>(
  edges: T[],
  result: boolean,
): T | undefined {
  if (edges.length === 0) return undefined
  const wanted: 'true' | 'false' = result ? 'true' : 'false'
  const labelled = edges.find((edge) => branchLabelOf(edge) === wanted)
  if (labelled) return labelled
  const unlabeled = edges.filter((edge) => branchLabelOf(edge) === null)
  // No label matches and no unlabeled edge exists: every edge is labelled
  // true/false for the OTHER outcome, so no branch is taken. (Falling
  // back to first/last here would follow an edge whose label explicitly
  // contradicts the verdict — the n8n legacy-condition failure: a single
  // 'true' edge on a false verdict ran the Output node with real items.)
  if (unlabeled.length === 0) return undefined
  return result ? unlabeled[0] : unlabeled[unlabeled.length - 1]
}

/** Nodes reachable from the graph entries following only kept edges. */
export function reachableNodeIds(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  outcomes: ConditionOutcomes,
): Set<string> {
  const ids = new Set(nodes.map((n) => n.id))
  const outgoingBySource = new Map<string, WorkflowEdge[]>()
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue
    const list = outgoingBySource.get(edge.source) ?? []
    list.push(edge)
    outgoingBySource.set(edge.source, list)
  }
  // An edge is kept when its source has no recorded outcome (not a
  // Condition, or not decided yet — keep everything), or when it is the
  // one edge the shared rule picks for that outcome.
  const isKept = (edge: WorkflowEdge): boolean => {
    const outcome = outcomes.get(edge.source)
    if (!outcome) return true
    const chosen = chooseBranchEdge(outgoingBySource.get(edge.source) ?? [], outcome === 'true')
    return chosen === edge
  }
  const incoming = new Map<string, number>()
  for (const node of nodes) incoming.set(node.id, 0)
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue
    if (!isKept(edge)) continue
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
  }
  const outgoing = new Map<string, WorkflowEdge[]>()
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue
    if (!isKept(edge)) continue
    const list = outgoing.get(edge.source) ?? []
    list.push(edge)
    outgoing.set(edge.source, list)
  }
  // Entry points: the trigger node first, otherwise every node with no
  // incoming kept edge.
  const trigger = nodes.find((n) => n.type === 'trigger')
  const entries = trigger ? [trigger.id] : nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id)
  const reachable = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const edge of outgoing.get(id) ?? []) {
      if (!reachable.has(edge.target)) queue.push(edge.target)
    }
  }
  return reachable
}

/** Nodes that must be skipped given the condition outcomes so far. */
export function skippedNodeIds(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  outcomes: ConditionOutcomes,
): Set<string> {
  const reachable = reachableNodeIds(nodes, edges, outcomes)
  return new Set(nodes.map((n) => n.id).filter((id) => !reachable.has(id)))
}

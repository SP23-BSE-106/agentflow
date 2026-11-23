/**
 * Dependency resolution for workflow graphs (implementation plan Phase 5).
 *
 * Provides a topological ordering of nodes and cycle detection. Used by the
 * orchestrator to decide execution order, and by the scheduler for parallel
 * branches in a later milestone.
 */

import type { WorkflowEdge, WorkflowNode } from '@/lib/mongo/workflow'

/**
 * Returns node ids in topological order (dependencies before dependents).
 *
 * Uses Kahn's algorithm. Nodes with no incoming edges are emitted first.
 * Ties are broken by the node's position in the input array for deterministic
 * output.
 *
 * Throws if the graph contains a cycle.
 */
export function topologicalSort(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, string[]>()

  for (const node of nodes) {
    incoming.set(node.id, 0)
    outgoing.set(node.id, [])
  }

  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue
    incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1)
    outgoing.get(edge.source)!.push(edge.target)
  }

  // Start with nodes that have no dependencies, in input order.
  const queue: string[] = []
  for (const node of nodes) {
    if ((incoming.get(node.id) || 0) === 0) queue.push(node.id)
  }

  const result: string[] = []
  while (queue.length) {
    // Deterministic: always pick the earliest remaining node in input order.
    queue.sort((a, b) => nodes.findIndex((n) => n.id === a) - nodes.findIndex((n) => n.id === b))
    const id = queue.shift()!
    result.push(id)

    for (const target of outgoing.get(id) || []) {
      const remaining = (incoming.get(target) || 1) - 1
      incoming.set(target, remaining)
      if (remaining === 0) queue.push(target)
    }
  }

  if (result.length !== nodes.length) {
    const remaining = nodes.filter((n) => !result.includes(n.id))
    throw new Error(
      `Workflow contains a cycle or unresolved dependencies involving: ${remaining
        .map((n) => n.name)
        .join(', ')}`,
    )
  }

  return result
}

/** Returns true if the graph contains a cycle. */
export function hasCycle(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  try {
    topologicalSort(nodes, edges)
    return false
  } catch {
    return true
  }
}

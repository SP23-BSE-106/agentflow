/**
 * Per-node agent resolution for the orchestrator (P1-2).
 *
 * Pure function, no database access: the caller loads the referenced agents
 * (checking ownership) and hands them in as a map. The rule is plain:
 *   - node.config.agentId set → that agent runs the node; if the id is not
 *     in the map (does not exist, or is not the caller's) this throws an
 *     honest error instead of silently falling back to the owner agent.
 *   - no agentId → the owner agent runs the node.
 */

import type { Agent } from '@/lib/mongo/agent'
import type { WorkflowNode } from '@/lib/mongo/workflow'
import type { ResolvedNode } from './types'

export function resolveNodeAgents(
  nodes: WorkflowNode[],
  ownerAgent: Agent,
  agentsById: Map<string, Agent>,
): ResolvedNode[] {
  return nodes.map((node) => {
    const agentId = node.config?.agentId
    if (typeof agentId === 'string' && agentId.trim()) {
      const agent = agentsById.get(agentId.trim())
      if (!agent) {
        throw new Error(
          `Node "${node.name}" references agent "${agentId}" which does not exist or is not yours.`,
        )
      }
      return { node, agent }
    }
    return { node, agent: ownerAgent }
  })
}

/** Collect the distinct agent ids referenced by a graph's node configs. */
export function referencedAgentIds(nodes: WorkflowNode[]): string[] {
  const ids = new Set<string>()
  for (const node of nodes) {
    const agentId = node.config?.agentId
    if (typeof agentId === 'string' && agentId.trim()) ids.add(agentId.trim())
  }
  return [...ids]
}

/**
 * Teammate resolution for ask-a-teammate (multi-agent team, Lane B).
 *
 * The same ownership rule as `resolveNodes` (orchestrator.ts:1268,
 * resolveNodes.ts): a reference to an agent that does not exist or is not
 * the caller's throws an honest error — it never silently falls back to
 * another agent. A reference is resolved in this order:
 *   1. agent id — an exact ObjectId match;
 *   2. role — the first agent with that role;
 *   3. name — exact match first, then case-insensitive.
 */

import { ObjectId, type Db } from 'mongodb'
import type { Agent, AgentRole } from '@/lib/mongo/agent'

const AGENT_ROLES: AgentRole[] = [
  'supervisor',
  'planner',
  'researcher',
  'writer',
  'reviewer',
  'critic',
  'fact_checker',
  'analyst',
  'custom',
]

function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as string[]).includes(value)
}

/**
 * Pure match over an already-loaded list of the caller's agents.
 * Returns null when nothing matches; the caller turns that into the
 * honest error. Kept pure so unit tests can exercise every branch
 * without a database.
 */
export function pickTeammate(agents: Agent[], ref: string): Agent | null {
  const trimmed = ref.trim()
  if (!trimmed) return null
  if (ObjectId.isValid(trimmed)) {
    const byId = agents.find((agent) => String(agent._id) === trimmed)
    if (byId) return byId
  }
  if (isAgentRole(trimmed)) {
    const byRole = agents.find((agent) => agent.role === trimmed)
    if (byRole) return byRole
  }
  const byName = agents.find((agent) => agent.name === trimmed)
  if (byName) return byName
  const lower = trimmed.toLowerCase()
  return agents.find((agent) => agent.name.toLowerCase() === lower) ?? null
}

/**
 * Resolve a teammate reference (agent id, role, or name) to an agent the
 * caller owns. Throws when the reference names no agent of theirs.
 */
export async function resolveTeammate(
  db: Db,
  userId: string,
  ref: string,
): Promise<Agent> {
  const trimmed = (ref ?? '').trim()
  if (!trimmed) {
    throw new Error(
      'Teammate reference is empty: name an agent by id, role, or name.',
    )
  }
  const agents = (await db
    .collection('agents')
    .find({ userId }, { projection: { userApiKey: 0 } })
    .toArray()) as unknown as Agent[]
  const agent = pickTeammate(agents, trimmed)
  if (!agent) {
    throw new Error(
      `Teammate "${trimmed}" does not exist or is not yours. Name one of your agents by id, role, or name.`,
    )
  }
  return agent
}

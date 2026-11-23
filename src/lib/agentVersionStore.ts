import type { Db } from 'mongodb'
import type { AgentVersion } from '@/lib/mongo/agentVersion'

export async function saveAgentVersion(
  db: Db,
  input: Omit<AgentVersion, '_id' | 'createdAt'>,
): Promise<void> {
  await db.collection<AgentVersion>('agent_versions').insertOne({
    ...input,
    createdAt: new Date(),
  })
}

export async function ensureAgentVersionsIndex(db: Db): Promise<void> {
  await db
    .collection('agent_versions')
    .createIndex({ userId: 1, agentId: 1, version: -1 })
    .catch(() => undefined)
}

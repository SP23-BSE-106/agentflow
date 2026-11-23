/**
 * Stored provider keys (BYOK).
 *
 * A user may store one encrypted API key per provider in the `api_keys`
 * collection (written by POST /api/keys). These helpers load a stored key
 * back as an AgentKey so a workflow run can use it when no caller key and
 * no agent-saved key exist. Precedence: caller key > agent's saved key >
 * user's stored provider key > env keys — this file only supplies the
 * third layer; the chain already falls back to env keys on its own.
 *
 * Key material is never logged and never re-thrown: a corrupt stored row
 * behaves as if no key were stored.
 */

import { getDb } from '@/lib/mongo/mongo'
import { decrypt } from '@/lib/crypto'
import { PRESET_ORDER } from '@/lib/llmProviders'
import type { AgentKey } from '@/lib/llm'

/** Load the user's stored key for one provider, or null when absent. */
export async function loadStoredAgentKey(userId: string, provider: string): Promise<AgentKey | null> {
  try {
    const db = await getDb()
    const row = await db.collection('api_keys').findOne({ userId, provider })
    if (!row || typeof row.encryptedKey !== 'string') return null
    return { provider, key: decrypt(row.encryptedKey) }
  } catch {
    // A corrupt row, a decrypt failure, or a DB error all behave as
    // "no stored key" — the caller falls through to the env keys.
    return null
  }
}

/** Load the first stored key in preset order, or null when none is stored. */
export async function loadFirstStoredAgentKey(userId: string): Promise<AgentKey | null> {
  for (const provider of PRESET_ORDER) {
    // 'custom' has no stored shape — it is keyed per-agent, not per-provider.
    if (provider === 'custom') continue
    const key = await loadStoredAgentKey(userId, provider)
    if (key) return key
  }
  return null
}

'use server'

import { rateLimit } from '@/lib/rateLimit'
import { getDb } from '@/lib/mongo/mongo'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { encrypt } from '@/lib/crypto'

export async function saveApiKey(provider: string, key: string) {
  const rlKey = `saveApiKey:${provider}`
  const rl = await rateLimit(rlKey, { windowMs: 60_000, max: 5 })
  if (!rl.ok) {
    throw new Error(`Too many requests. Retry after ${rl.retryAfterMs}ms`)
  }

  const token = await getSessionTokenFromCookies()
  if (!token) throw new Error('Not logged in')

  const payload = await verifyJwtSession(token)
  const userId = payload.sub

  const db = await getDb()

  await db.collection('api_keys').updateOne(
    { userId, provider },
    { $set: { encryptedKey: encrypt(key), createdAt: new Date() } },
    { upsert: true },
  )

  return { success: true }
}



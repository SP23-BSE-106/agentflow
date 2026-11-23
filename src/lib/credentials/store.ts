/**
 * Credential store (n8n §5 of the feature map).
 *
 * Credentials live in the Mongo `credentials` collection. The whole fields
 * object is encrypted with the existing AES-256-GCM helper
 * (`src/lib/crypto.ts` `encrypt()`/`decrypt()`) before it is stored — a
 * credential is never written in plaintext, and `listCredentials` never
 * returns secret fields (it returns id/type/name only).
 *
 * `testCredential` validates the required fields for the type and, when
 * the fields carry a base URL (`baseUrl`), performs a real GET to that URL
 * and reports the status it got. It never reports a fake pass.
 */

import { ObjectId } from 'mongodb'
import { getDb } from '@/lib/mongo/mongo'
import { decrypt, encrypt } from '@/lib/crypto'
import { fetchPublicUrl, SsrfError } from '@/lib/ssrf'
import { validateCredentialFields } from './types'

export type CredentialRecord = {
  _id: unknown
  userId: string
  type: string
  name: string
  /** AES-256-GCM encrypted JSON of the fields object. Never plaintext. */
  data: string
  createdAt: Date
  updatedAt: Date
}

/** Save (insert or replace-by-name) a credential; returns its id. */
export async function saveCredential(
  userId: string,
  type: string,
  name: string,
  fields: Record<string, unknown>,
): Promise<string> {
  if (!userId) throw new Error('saveCredential needs a userId.')
  if (!type) throw new Error('saveCredential needs a credential type.')
  if (!name.trim()) throw new Error('saveCredential needs a credential name.')
  const validation = validateCredentialFields(type, fields)
  if (!validation.ok) {
    throw new Error(`Missing required field(s) for ${type}: ${validation.missing.join(', ')}.`)
  }
  const db = await getDb()
  const now = new Date()
  const existing = await db
    .collection('credentials')
    .findOne({ userId, type, name: name.trim() })
  if (existing) {
    await db
      .collection('credentials')
      .updateOne(
        { _id: existing._id },
        { $set: { data: encrypt(JSON.stringify(fields)), updatedAt: now } },
      )
    return String(existing._id)
  }
  const result = await db.collection('credentials').insertOne({
    userId,
    type,
    name: name.trim(),
    data: encrypt(JSON.stringify(fields)),
    createdAt: now,
    updatedAt: now,
  } satisfies Omit<CredentialRecord, '_id'>)
  return String(result.insertedId)
}

/** Load one credential with its fields decrypted, or null. */
export async function getCredential(
  userId: string,
  id: string,
): Promise<{ type: string; name: string; fields: Record<string, unknown> } | null> {
  if (!ObjectId.isValid(id)) return null
  const db = await getDb()
  const record = await db
    .collection('credentials')
    .findOne({ _id: new ObjectId(id), userId })
  if (!record) return null
  let fields: Record<string, unknown>
  try {
    fields = JSON.parse(decrypt(String(record.data)))
  } catch {
    throw new Error('The credential could not be decrypted. Re-enter it.')
  }
  return { type: String(record.type), name: String(record.name), fields }
}

/**
 * List the user's credentials. Returns id/type/name only — secret fields
 * are never included.
 */
export async function listCredentials(
  userId: string,
): Promise<Array<{ id: string; type: string; name: string }>> {
  const db = await getDb()
  const records = await db
    .collection('credentials')
    .find({ userId })
    .sort({ createdAt: -1 })
    .toArray()
  return records.map((record) => ({
    id: String(record._id),
    type: String(record.type),
    name: String(record.name),
  }))
}

export async function deleteCredential(userId: string, id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false
  const db = await getDb()
  const result = await db
    .collection('credentials')
    .deleteOne({ _id: new ObjectId(id), userId })
  return result.deletedCount > 0
}

/**
 * Test a credential for real: required fields must be present, and for
 * HTTP-based types with a `baseUrl` a real request is made to that URL
 * and the status is reported. No fake "test passed".
 */
export async function testCredential(
  type: string,
  fields: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  const validation = validateCredentialFields(type, fields)
  if (!validation.ok) {
    return {
      ok: false,
      message: `Missing required field(s) for ${type}: ${validation.missing.join(', ')}.`,
    }
  }
  const baseUrl = typeof fields.baseUrl === 'string' ? fields.baseUrl.trim() : ''
  if (baseUrl) {
    try {
      await fetchPublicUrl(baseUrl)
      return { ok: true, message: `Reached ${baseUrl} successfully.` }
    } catch (error) {
      const message =
        error instanceof SsrfError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Request failed.'
      return { ok: false, message: `Could not reach ${baseUrl}: ${message}` }
    }
  }
  return { ok: true, message: `Required fields for ${type} are present (no base URL to check).` }
}

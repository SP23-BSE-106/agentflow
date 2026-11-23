import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { ObjectId } from 'mongodb'

import { getDb } from '@/lib/mongo/mongo'
import { rateLimit } from '@/lib/rateLimit'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { errorResponse } from '@/lib/api/errors'
import { GUEST_LOGIN_REQUIRED, getOptionalAuth, loginRequiredResponse } from '@/lib/auth/session'

export async function GET() {
  try {
    const auth = await getOptionalAuth()
    if (auth === 'invalid') return loginRequiredResponse()
    // Guest mode: a guest has no API keys — empty list, never another
    // user's keys.
    if (auth === 'guest') return NextResponse.json({ keys: [] })

    const userId = auth.userId

    const db = await getDb()
    const keys = await db
      .collection('personal_api_keys')
      .find({ userId: new ObjectId(userId) })
      .sort({ createdAt: -1 })
      .toArray()

    const formattedKeys = keys.map(k => ({
      id: k._id.toString(),
      name: k.name || 'Untitled Key',
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt || null,
      prefix: k.prefix || 'sk-...',
    }))

    return NextResponse.json({ keys: formattedKeys })
  } catch (e: unknown) {
    console.error('[settings/api-keys] Error:', e)
    return errorResponse(e)
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = await getSessionTokenFromCookies()
    if (!token) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

    let payload
    try {
      payload = await verifyJwtSession(token)
    } catch {
      return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })
    }
    const userId = payload.sub

    const db = await getDb()
    const workspaceSettings = await db.collection('workspace_settings').findOne({ userId })
    if (workspaceSettings?.permissions?.canManageKeys === false) {
      return NextResponse.json({ error: 'API key management is disabled for this workspace.' }, { status: 403 })
    }

    const rl = await rateLimit(`settings:api-keys:${userId}`, { windowMs: 60_000, max: 10 })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many requests', retryAfterMs: rl.retryAfterMs },
        { status: 429 },
      )
    }

    const body = await request.json().catch(() => ({}))
    const name = body.name || 'Untitled Key'

    const keysCollection = db.collection('personal_api_keys')

    // BR-20: Maximum 5 active API keys per user account
    const count = await keysCollection.countDocuments({ userId: new ObjectId(userId) })
    if (count >= 5) {
      return NextResponse.json(
        { error: 'API key limit reached. Maximum of 5 active keys allowed per user.' },
        { status: 403 }
      )
    }

    // Generate token
    const rawKey = `sk_live_${crypto.randomBytes(32).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')

    const newKey = {
      userId: new ObjectId(userId),
      name,
      keyHash,
      prefix: rawKey.substring(0, 12) + '...',
      createdAt: new Date(),
      lastUsedAt: null,
    }

    const result = await keysCollection.insertOne(newKey)

    return NextResponse.json({
      success: true,
      key: rawKey, // Show only once
      keyRecord: {
        id: result.insertedId.toString(),
        name: newKey.name,
        prefix: newKey.prefix,
        createdAt: newKey.createdAt,
        lastUsedAt: newKey.lastUsedAt,
      }
    })
  } catch (e: unknown) {
    console.error('[settings/api-keys] Error:', e)
    return errorResponse(e)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const token = await getSessionTokenFromCookies()
    if (!token) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

    let payload
    try {
      payload = await verifyJwtSession(token)
    } catch {
      return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })
    }
    const userId = payload.sub

    const { searchParams } = new URL(request.url)
    const keyId = searchParams.get('id')

    if (!keyId) {
      return NextResponse.json({ error: 'Missing key ID' }, { status: 400 })
    }

    const db = await getDb()
    const workspaceSettings = await db.collection('workspace_settings').findOne({ userId })
    if (workspaceSettings?.permissions?.canManageKeys === false) {
      return NextResponse.json({ error: 'API key management is disabled for this workspace.' }, { status: 403 })
    }

    const keysCollection = db.collection('personal_api_keys')

    const result = await keysCollection.deleteOne({
      _id: new ObjectId(keyId),
      userId: new ObjectId(userId),
    })

    if (result.deletedCount === 0) {
      return NextResponse.json({ error: 'Key not found or not authorized' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (e: unknown) {
    console.error('[settings/api-keys] Error:', e)
    return errorResponse(e)
  }
}

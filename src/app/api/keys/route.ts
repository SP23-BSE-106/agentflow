import { NextRequest, NextResponse } from 'next/server'

import { getDb } from '@/lib/mongo/mongo'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { encrypt } from '@/lib/crypto'
import { GUEST_LOGIN_REQUIRED } from '@/lib/auth/session'

export async function GET() {
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
    const rows = await db
      .collection('api_keys')
      .find({ userId }, { projection: { provider: 1, _id: 0 } })
      .toArray()

    // Provider ids only — never key material, prefixes, or timestamps.
    const providers = rows
      .map((row) => (typeof row.provider === 'string' ? row.provider : ''))
      .filter((provider) => provider.length > 0)
    return NextResponse.json({ providers })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed'
    return NextResponse.json({ error: message }, { status: 500 })
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

    const provider = request.nextUrl.searchParams.get('provider')?.trim() ?? ''
    if (!provider || provider.length > 64) {
      return NextResponse.json({ error: 'provider is required' }, { status: 400 })
    }

    const db = await getDb()
    // Idempotent: success even when nothing was stored for this provider.
    await db.collection('api_keys').deleteOne({ userId, provider })

    return NextResponse.json({ success: true })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed'
    return NextResponse.json({ error: message }, { status: 500 })
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

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (!provider || provider.length > 64) {
      return NextResponse.json({ error: 'provider is required' }, { status: 400 })
    }
    if (!key || key.length > 4096) {
      return NextResponse.json({ error: 'key is required' }, { status: 400 })
    }

    const db = await getDb()

    // The key is encrypted with AES-256-GCM before it is stored. The field
    // is named encryptedKey and the value really is encrypted.
    await db.collection('api_keys').updateOne(
      { userId, provider },
      { $set: { encryptedKey: encrypt(key), createdAt: new Date() } },
      { upsert: true },
    )

    return NextResponse.json({ success: true })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

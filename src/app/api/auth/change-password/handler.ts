import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { ObjectId } from 'mongodb'

import { getDb } from '@/lib/mongo/mongo'
import { rateLimit } from '@/lib/rateLimit'
import { getSessionTokenFromCookies, verifyJwtSession, type JwtPayload } from '@/lib/auth/jwt'

function isStrongPassword(password: string) {
  // Match the signup/reset policy in this codebase
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  )
}

export async function POST(request: NextRequest) {
  const token = await getSessionTokenFromCookies()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Revocation-aware check (tokenVersion + passwordChangedAt), like every
  // other login-only handler: a session revoked by a password reset or an
  // earlier change must not be usable to change the password again.
  let payload: JwtPayload
  try {
    payload = await verifyJwtSession(token)
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = await getDb()
  const users = db.collection('users')
  const userId = payload.sub

  const body = (await request.json().catch(() => ({}))) as {
    currentPassword?: string
    newPassword?: string
  }

  const currentPassword = body.currentPassword || ''
  const newPassword = body.newPassword || ''

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: 'Missing current or new password' }, { status: 400 })
  }

  if (!isStrongPassword(newPassword)) {
    return NextResponse.json(
      {
        error:
          'Password must be at least 8 characters and include an uppercase letter, a number, and a special character',
      },
      { status: 400 },
    )
  }

  const rl = await rateLimit(`auth:change-password:${userId}`, { windowMs: 60_000, max: 5 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfterMs: rl.retryAfterMs },
      { status: 429 },
    )
  }

  const user = await users.findOne<{ _id: ObjectId; passwordHash?: string } & Record<string, unknown>>(
    { _id: new ObjectId(userId) },
  )
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // H13: an OAuth-only account has no password hash — comparing against
  // `undefined` throws and the request 500s. No stored password means
  // there is no current password that can match: same answer as a wrong
  // current password (400), never a 500.
  if (!user.passwordHash) {
    return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 })
  }

  const ok = await bcrypt.compare(currentPassword, user.passwordHash)
  if (!ok) return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 })

  const newHash = await bcrypt.hash(newPassword, 10)
  // Bumping tokenVersion revokes every session issued before this change.
  await users.updateOne(
    { _id: new ObjectId(userId) },
    {
      $set: { passwordHash: newHash, passwordChangedAt: new Date() },
      $inc: { tokenVersion: 1 },
    },
  )

  return NextResponse.json({ success: true })
}


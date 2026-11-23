import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'

import { getDb } from '@/lib/mongo/mongo'
import { rateLimit } from '@/lib/rateLimit'
import { hashToken } from '@/lib/auth/tokens'

function isStrongPassword(password: string) {
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  )
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    token?: string
    password?: string
  }

  const token = (body.token || '').trim()
  const password = body.password || ''

  if (!token || !password) {
    return NextResponse.json({ error: 'Missing token or password' }, { status: 400 })
  }

  if (!isStrongPassword(password)) {
    return NextResponse.json(
      {
        error:
          'Password must be at least 8 characters and include an uppercase letter, a number, and a special character',
      },
      { status: 400 },
    )
  }

  const rl = await rateLimit(`auth:reset-password:${hashToken(token)}`, { windowMs: 60_000, max: 5 })
  if (!rl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, { status: 429 })
  }

  const db = await getDb()
  const users = db.collection('users')

  const passwordHash = await bcrypt.hash(password, 10)

  // Consume atomically: the token is unset and the session version bumped
  // in the same update, so a concurrent second use finds nothing and every
  // session issued before the reset stops working.
  const result = await users.findOneAndUpdate(
    {
      passwordResetTokenHash: hashToken(token),
      passwordResetTokenExpiresAt: { $gt: new Date() },
    },
    {
      $set: { passwordHash, passwordChangedAt: new Date() },
      $unset: { passwordResetTokenHash: '', passwordResetTokenExpiresAt: '' },
      $inc: { tokenVersion: 1 },
    },
    { returnDocument: 'after' },
  )

  if (!result) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 })
  }

  return NextResponse.json({ success: true, message: 'Password reset successfully' })
}

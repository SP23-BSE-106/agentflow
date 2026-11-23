import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/mongo/mongo'
import { hashToken } from '@/lib/auth/tokens'
import { ensureUsersEmailUniqueIndex } from '@/lib/mongo/indices'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const token = (searchParams.get('token') || '').trim()

  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 })
  }

  const db = await getDb()
  await ensureUsersEmailUniqueIndex(db)
  const tokenHash = hashToken(token)

  // Consume atomically: find-and-delete in one step, so a second click on
  // the same link finds nothing instead of creating a second account.
  const pendingUsers = db.collection('email_verifications')
  const pending = await pendingUsers.findOneAndDelete({
    verificationTokenHash: tokenHash,
    verificationTokenExpiresAt: { $gt: new Date() },
  })
  if (!pending) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 })
  }

  const users = db.collection('users')

  // Email-change verification: the pending record carries the user id, so
  // update that user instead of creating a second account.
  if (pending.userId) {
    const existing = await users.findOne({ email: pending.email })
    if (existing && String(existing._id) !== String(pending.userId)) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
    }
    const { ObjectId } = await import('mongodb')
    const id = ObjectId.isValid(String(pending.userId)) ? new ObjectId(String(pending.userId)) : pending.userId
    await users.updateOne(
      { _id: id as never },
      { $set: { email: pending.email, emailVerified: true, updatedAt: new Date() } },
    )
    return NextResponse.redirect(new URL('/login?verified=1', request.url))
  }

  // Signup verification: refuse if the email already has an account.
  const already = await users.findOne({ email: pending.email })
  if (already) {
    return NextResponse.redirect(new URL('/login?verified=1', request.url))
  }

  await users.insertOne({
    email: pending.email,
    passwordHash: pending.passwordHash,
    fullName: pending.fullName || undefined,
    createdAt: new Date(),
    emailVerified: true,
    tokenVersion: 0,
    trialEndsAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days from signup
    subscriptionPlan: 'free_trial',
    subscriptionStatus: 'trialing',
  })

  return NextResponse.redirect(new URL('/login?verified=1', request.url))
}

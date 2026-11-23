import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'

import { getDb } from '@/lib/mongo/mongo'
import { rateLimit } from '@/lib/rateLimit'
import { hashToken, newToken } from '@/lib/auth/tokens'
import { ensureUsersEmailUniqueIndex } from '@/lib/mongo/indices'
import { sendEmail } from '@/utils/mailer'

function isStrongPassword(password: string) {
  // Requirement: 8+ chars, at least 1 uppercase, 1 number, and 1 special character
  return password.length >= 8 && /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password)
}

function getAppOrigin(request: NextRequest) {
  const forwardedProto = request.headers.get('x-forwarded-proto')
  const forwardedHost = request.headers.get('x-forwarded-host')
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto.split(',')[0].trim()}://${forwardedHost.split(',')[0].trim()}`
  }
  return new URL(request.url).origin
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    email?: string
    password?: string
    fullName?: string
    name?: string
  }

  const email = (body.email || '').trim().toLowerCase()
  const password = body.password || ''
  const fullName = (body.fullName || body.name || '').trim()

  if (!email || !password) {
    return NextResponse.json({ error: 'Missing email or password' }, { status: 400 })
  }
  if (!fullName) {
    return NextResponse.json({ error: 'Missing full name' }, { status: 400 })
  }
  if (!/^[A-Za-z\s]+$/.test(fullName)) {
    return NextResponse.json({ error: 'Full name must contain alphabets and spaces only' }, { status: 400 })
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

  const rl = await rateLimit(`auth:signup:${email}`, { windowMs: 60_000, max: 5 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfterMs: rl.retryAfterMs },
      { status: 429 },
    )
  }

  const db = await getDb()
  await ensureUsersEmailUniqueIndex(db)
  const users = db.collection('users')

  const existing = await users.findOne({ email })
  if (existing) {
    return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
  }

  const passwordHash = await bcrypt.hash(password, 10)
  const verificationToken = newToken()
  const verificationTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

  // One pending record per email: a second signup replaces the first token
  // instead of leaving two live tokens for the same address. Only the
  // SHA-256 hash of the token is stored — a database read never yields a
  // working verification link.
  const pendingUsers = db.collection('email_verifications')
  await pendingUsers.updateOne(
    { email },
    {
      $set: {
        email,
        passwordHash,
        fullName: fullName || undefined,
        createdAt: new Date(),
        verificationTokenHash: hashToken(verificationToken),
        verificationTokenExpiresAt,
      },
    },
    { upsert: true },
  )

  const origin = getAppOrigin(request)
  const verifyUrl = `${origin}/api/auth/verify-email?token=${verificationToken}`

  try {
    await sendEmail({
      to: email,
      subject: 'Verify your email for AgentFlow',
      text: `Welcome to AgentFlow!\n\nPlease verify your email by visiting: ${verifyUrl}\n\nThis link expires in 1 hour.`,
      html: `
        <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;">
          <h2>Verify your email for AgentFlow</h2>
          <p>Welcome! Click the button below to verify your email address.</p>
          <p><a href="${verifyUrl}" style="display:inline-block;padding:10px 14px;background:#111827;color:#fff;text-decoration:none;border-radius:8px;">Verify Email</a></p>
          <p style="color:#6b7280;font-size:12px;">This link expires in 1 hour.</p>
        </div>
      `,
    })
  } catch (err) {
    // A failed verification email is a failed signup step, not a success:
    // the account cannot be used until the link arrives. The pending record
    // stays so the user can resend instead of signing up again.
    const message = err instanceof Error ? err.message : 'Failed to send verification email'
    return NextResponse.json(
      {
        error: 'We could not send the verification email. Your account is not active yet — try resending it.',
        emailSendError: message,
        mailFailed: true,
        email,
      },
      { status: 502 },
    )
  }

  return NextResponse.json({ success: true, emailVerificationRequired: true })
}

import { NextRequest, NextResponse } from 'next/server'

import { getDb } from '@/lib/mongo/mongo'
import { rateLimit } from '@/lib/rateLimit'
import { hashToken, newToken } from '@/lib/auth/tokens'
import { sendEmail } from '@/utils/mailer'

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { email?: string }
  const email = (body.email || '').trim().toLowerCase()

  if (!email) {
    return NextResponse.json({ error: 'Missing email' }, { status: 400 })
  }

  const rl = await rateLimit(`auth:forgot-password:${email}`, { windowMs: 60_000, max: 5 })
  if (!rl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, { status: 429 })
  }

  const db = await getDb()
  const users = db.collection('users')

  const user = await users.findOne<{ _id: string; email: string } | null>({ email })

  // Always return the same response to avoid account enumeration.
  if (!user) {
    return NextResponse.json({ success: true })
  }

  const passwordResetToken = newToken()
  const passwordResetTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

  // Only the hash is stored: a database read never yields a working reset link.
  await users.updateOne(
    ({ _id: user._id } as never),
    {
      $set: {
        passwordResetTokenHash: hashToken(passwordResetToken),
        passwordResetTokenExpiresAt,
      },
    },
  )

  const forwardedProto = request.headers.get('x-forwarded-proto')
  const forwardedHost = request.headers.get('x-forwarded-host')
  const origin =
    forwardedProto && forwardedHost
      ? `${forwardedProto.split(',')[0].trim()}://${forwardedHost.split(',')[0].trim()}`
      : new URL(request.url).origin

  const resetUrl = `${origin}/reset-password?token=${passwordResetToken}`

  try {
    await sendEmail({
      to: email,
      subject: 'Reset your AgentFlow password',
      text: `We received a request to reset your AgentFlow password.\n\nReset link: ${resetUrl}\n\nThis link expires in 1 hour.`,
      html: `
      <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;">
        <h2>Reset your AgentFlow password</h2>
        <p>Click the button below to reset your password.</p>
        <p><a href="${resetUrl}" style="display:inline-block;padding:10px 14px;background:#111827;color:#fff;text-decoration:none;border-radius:8px;">Reset Password</a></p>
        <p style="color:#6b7280;font-size:12px;">This link expires in 1 hour.</p>
      </div>
    `,
    })
  } catch (error) {
    // Mail failure must not leak whether the account exists (a 500 for a
    // real user and a 200 for an unknown one would do exactly that), so the
    // response stays the generic success. The token stays valid for retry.
    console.error('[forgot-password] could not send reset email:', error)
  }

  return NextResponse.json({ success: true })
}

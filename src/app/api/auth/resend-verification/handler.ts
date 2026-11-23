import { NextRequest, NextResponse } from 'next/server'

import { getDb } from '@/lib/mongo/mongo'
import { rateLimit } from '@/lib/rateLimit'
import { hashToken, newToken } from '@/lib/auth/tokens'
import { sendEmail } from '@/utils/mailer'

function getAppOrigin(request: NextRequest) {
  const forwardedProto = request.headers.get('x-forwarded-proto')
  const forwardedHost = request.headers.get('x-forwarded-host')
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto.split(',')[0].trim()}://${forwardedHost.split(',')[0].trim()}`
  }
  return new URL(request.url).origin
}

/**
 * POST /api/auth/resend-verification { email }
 * Re-issues a verification link for a pending signup. Returns the same
 * generic success whether or not a pending record exists, so the endpoint
 * does not reveal which emails have signed up.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { email?: string }
  const email = (body.email || '').trim().toLowerCase()
  if (!email) return NextResponse.json({ error: 'Missing email' }, { status: 400 })

  const rl = await rateLimit(`auth:resend-verification:${email}`, { windowMs: 60_000, max: 3 })
  if (!rl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, { status: 429 })
  }

  const db = await getDb()
  const pending = await db.collection('email_verifications').findOne({ email })
  if (!pending) return NextResponse.json({ success: true })

  const verificationToken = newToken()
  await db.collection('email_verifications').updateOne(
    { email },
    {
      $set: {
        verificationTokenHash: hashToken(verificationToken),
        verificationTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    },
  )

  const origin = getAppOrigin(request)
  const verifyUrl = `${origin}/api/auth/verify-email?token=${verificationToken}`
  try {
    await sendEmail({
      to: email,
      subject: 'Verify your email for AgentFlow',
      text: `Please verify your email by visiting: ${verifyUrl}\n\nThis link expires in 1 hour.`,
      html: `<div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;"><h2>Verify your email for AgentFlow</h2><p><a href="${verifyUrl}" style="display:inline-block;padding:10px 14px;background:#111827;color:#fff;text-decoration:none;border-radius:8px;">Verify Email</a></p><p style="color:#6b7280;font-size:12px;">This link expires in 1 hour.</p></div>`,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send verification email'
    return NextResponse.json({ error: 'We could not send the verification email. Try again shortly.', emailSendError: message }, { status: 502 })
  }
  return NextResponse.json({ success: true })
}

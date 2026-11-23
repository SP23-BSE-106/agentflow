import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'


import { getDb } from '@/lib/mongo/mongo'
import { rateLimit } from '@/lib/rateLimit'
import { effectiveSubscriptionStatus } from '@/lib/payments'
import { getSessionTokenFromCookies, verifyJwtSession, type JwtPayload } from '@/lib/auth/jwt'
import { hashToken, newToken } from '@/lib/auth/tokens'
import { sendEmail } from '@/utils/mailer'

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function base64ToBuffer(base64: string) {

  // Accept either raw base64 or data URL.
  const cleaned = base64.includes(',') ? base64.split(',')[1] : base64
  return Buffer.from(cleaned, 'base64')
}

function guessMimeFromDataUrl(base64OrDataUrl: string): string | null {
  if (!base64OrDataUrl.includes('data:')) return null
  const match = base64OrDataUrl.match(/^data:([^;]+);base64,/)
  return match?.[1] ?? null
}

function guessExtensionFromMime(mime: string) {
  const m = mime.toLowerCase()
  if (m === 'image/png') return 'png'
  if (m === 'image/jpeg') return 'jpg'
  if (m === 'image/jpg') return 'jpg'
  return null
}

function getAppOrigin(request: NextRequest) {
  const forwardedProto = request.headers.get('x-forwarded-proto')
  const forwardedHost = request.headers.get('x-forwarded-host')
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto.split(',')[0].trim()}://${forwardedHost.split(',')[0].trim()}`
  }
  return new URL(request.url).origin
}


export async function GET() {
  const token = await getSessionTokenFromCookies()
  if (!token) return NextResponse.json({ user: null }, { status: 200 })


  try {
    const payload = await verifyJwtSession(token)
    const db = await getDb()

    const user = await db
      .collection('users')
      .findOne<{ _id: ObjectId; email?: string; fullName?: string; avatarUrl?: string; preferences?: Record<string, unknown>; emailVerified?: boolean; createdAt?: string | Date; trialEndsAt?: string | Date; subscriptionPlan?: string; subscriptionStatus?: string; subscriptionEndsAt?: string | Date } & Record<string, unknown>>({ _id: new ObjectId(payload.sub) })


    if (!user) return NextResponse.json({ user: null }, { status: 200 })

    return NextResponse.json({
      user: {
        id: user._id,
        email: user.email,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl ?? null,
        preferences: user.preferences ?? {},
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
        trialEndsAt: user.trialEndsAt ?? (user.createdAt ? new Date(new Date(user.createdAt).getTime() + 90 * 24 * 60 * 60 * 1000) : null),
        subscriptionPlan: user.subscriptionPlan ?? 'free_trial',
        // C1: the stored status is not trusted on its own — a Pro record
        // whose paid term has passed reports `expired` here, and the raw
        // endsAt is exposed so the UI can tell a paid-up cancellation
        // (still Pro until the period end) from a lapsed one.
        subscriptionStatus: effectiveSubscriptionStatus(user),
        subscriptionEndsAt: user.subscriptionEndsAt ?? null,
      },
    })
  } catch {
    // A session cookie is present but does not verify (expired, tampered, or
    // revoked by a password change): 401, never a silent downgrade to
    // { user: null }. No cookie at all still answers { user: null } above.
    return NextResponse.json(
      { error: 'Session expired or revoked — log in again.' },
      { status: 401 },
    )
  }
}

export async function POST(request: NextRequest) {
  const token = await getSessionTokenFromCookies()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
    action?: 'updateProfile' | 'changePassword'
    fullName?: string
    email?: string
    avatarBase64?: string // base64 or data URL
    preferences?: Record<string, unknown>


  }

  const action = body.action ?? 'updateProfile'

  if (action !== 'updateProfile') {
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 })
  }

  // updateProfile

  const fullName = (body.fullName ?? '').trim()
  const email = (body.email ?? '').trim().toLowerCase()
  const passedPreferences = body.preferences && typeof body.preferences === 'object' ? body.preferences : {}

  // avatar validation
  const avatarBase64 = body.avatarBase64
  let avatarUrl: string | null | undefined = undefined

  if (typeof avatarBase64 === 'string' && avatarBase64.length > 0) {
    const buf = base64ToBuffer(avatarBase64)
    const sizeBytes = buf.byteLength
    const maxBytes = 2 * 1024 * 1024

    if (sizeBytes > maxBytes) {
      return NextResponse.json({ error: 'Avatar must be under 2MB' }, { status: 400 })
    }

    const mimeFromUrl = guessMimeFromDataUrl(avatarBase64)
    const ext = mimeFromUrl ? guessExtensionFromMime(mimeFromUrl) : null

    if (!mimeFromUrl || !ext) {
      return NextResponse.json({ error: 'Avatar must be JPG or PNG' }, { status: 400 })
    }

    // This app currently does not have a file storage service; store as data URL.
    avatarUrl = `data:${mimeFromUrl};base64,${avatarBase64.includes(',') ? avatarBase64.split(',')[1] : avatarBase64}`
  }

  const rl = await rateLimit(`auth:update-profile:${userId}`, { windowMs: 60_000, max: 5 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfterMs: rl.retryAfterMs },
      { status: 429 },
    )
  }

  const currentUser = await users.findOne<{ _id: ObjectId; email: string; emailVerified: boolean; fullName?: string; preferences?: Record<string, unknown> } & Record<string, unknown>>({ _id: new ObjectId(userId) })
  if (!currentUser) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const preferences = { ...(currentUser.preferences || {}), ...passedPreferences }

  // Always validate if email is provided.
  if (email && !isValidEmail(email)) {
    return NextResponse.json({ error: 'Invalid email format' }, { status: 400 })
  }

  const emailChanged = email && email !== currentUser.email

  if (emailChanged) {
    const existing = await users.findOne({ email })
    if (existing) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
    }
    // BR-5: Email changes require re-verification.
    // The pending record carries the user id so verify-email updates this
    // account instead of creating a second one, and only the token hash —
    // never the password hash.
    const verificationToken = newToken()
    const verificationTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000)

    const pendingUsers = db.collection('email_verifications')

    await pendingUsers.updateOne(
      { email },
      {
        $set: {
          email,
          userId,
          fullName: fullName || currentUser.fullName || undefined,
          avatarUrl: avatarUrl ?? currentUser.avatarUrl ?? undefined,
          preferences,
          createdAt: new Date(),
          verificationTokenHash: hashToken(verificationToken),
          verificationTokenExpiresAt,
        },
      },
      { upsert: true },
    )

    // send verification email for the new email
    const origin = getAppOrigin(request)
    const verifyUrl = `${origin}/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}`

    await sendEmail({
      to: email,
      subject: 'Verify your email for AgentFlow',
      text: `Please verify your email address by visiting: ${verifyUrl}`,
      html: `
        <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;">
          <h2>Verify your email for AgentFlow</h2>
          <p>Click the button below to verify your email address.</p>
          <p><a href="${verifyUrl}" style="display:inline-block;padding:10px 14px;background:#111827;color:#fff;text-decoration:none;border-radius:8px;">Verify Email</a></p>
          <p style="color:#6b7280;font-size:12px;">This link expires in 1 hour.</p>
        </div>
      `,
    })

    // Apply non-email changes immediately; keep email as-is until verification.
    const update: Record<string, unknown> = {
      ...(fullName ? { fullName } : {}),
      ...(avatarUrl !== undefined ? { avatarUrl: avatarUrl } : {}),
      preferences,
    }

    await users.updateOne({ _id: new ObjectId(userId) }, { $set: update })

    return NextResponse.json({
      success: true,
      emailChangePendingVerification: true,
      message: 'Email changed. Please verify your new email address.',
    })
  }

  // Not changing email: update directly.
  const update: Record<string, unknown> = {
    ...(fullName ? { fullName } : {}),
    ...(email ? { email } : {}),
    preferences,
  }

  if (avatarUrl !== undefined) update.avatarUrl = avatarUrl

  await users.updateOne({ _id: new ObjectId(userId) }, { $set: update })

  return NextResponse.json({ success: true })
}


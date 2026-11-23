import { NextRequest, NextResponse } from 'next/server'

import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'

export async function GET(_request: NextRequest) {
  const token = await getSessionTokenFromCookies()
  if (!token) return NextResponse.json({ user: null }, { status: 200 })

  try {
    const payload = await verifyJwtSession(token)
    return NextResponse.json({
      user: {
        id: payload.sub,
        email: payload.email,
        fullName: payload.fullName,
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


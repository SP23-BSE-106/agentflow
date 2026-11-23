import { NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { getStripe } from '@/lib/stripe'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { isMockPaymentsEnabled, proLineItems } from '@/lib/payments'
import { randomUUID } from 'node:crypto'

export async function POST(req: Request) {
  try {
    if (isMockPaymentsEnabled()) {
      const token = await getSessionTokenFromCookies()
      if (!token) {
        return NextResponse.json({ error: 'Log in to activate mock Pro.' }, { status: 401 })
      }
      try {
        await verifyJwtSession(token)
      } catch {
        return NextResponse.json(
          { error: 'Session expired or revoked — log in again.' },
          { status: 401 },
        )
      }
      const sessionId = `mock_${randomUUID().replace(/-/g, '')}`
      return NextResponse.json({
        url: `/dashboard/payment?session_id=${encodeURIComponent(sessionId)}&success=true`,
        sessionId,
        mock: true,
      })
    }

    const token = await getSessionTokenFromCookies()
    let userEmail: string | undefined = undefined
    let userId: string | undefined = undefined

    if (token) {
      try {
        const payload = await verifyJwtSession(token)
        userEmail = payload.email
        userId = payload.sub
      } catch {
        // A session cookie is present but does not verify (expired, tampered,
        // or revoked by a password change): 401, never a silent downgrade to
        // an anonymous checkout carrying a dead identity. No cookie at all
        // still checks out as a guest.
        return NextResponse.json(
          { error: 'Session expired or revoked — log in again.' },
          { status: 401 },
        )
      }
    }

    const body = await req.json().catch(() => ({}))
    const mode = body.mode || 'subscription'

    // DOMAIN is required: a localhost fallback would send a paying user to
    // http://localhost:3000 after checkout, where the app does not exist.
    const domain = process.env.DOMAIN
    if (!domain) {
      return NextResponse.json(
        { error: 'DOMAIN is not set on the server, so the checkout return URL cannot be built. Set DOMAIN to the deployed app URL.' },
        { status: 500 },
      )
    }

    // The price is fixed on the server. Client-supplied line items are
    // ignored entirely — a caller cannot check out for less than $19.
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      ui_mode: 'hosted_page',
      billing_address_collection: 'auto',
      phone_number_collection: {
        enabled: false,
      },
      automatic_tax: {
        enabled: false,
      },
      allow_promotion_codes: false,
      submit_type: 'auto',
      integration_identifier: 'hosted_web_0001',
      origin_context: 'web',
      mode,
      customer_email: userEmail || undefined,
      metadata: {
        userId: userId || '',
        userEmail: userEmail || '',
      },
      success_url: `${domain}/dashboard/payment?session_id={CHECKOUT_SESSION_ID}&success=true`,
      cancel_url: `${domain}/dashboard/payment?canceled=true`,
      line_items: proLineItems(),
    }

    if (mode === 'subscription') {
      sessionParams.payment_method_collection = 'always'
    }

    const session = await getStripe().checkout.sessions.create(sessionParams)

    return NextResponse.json({ url: session.url, sessionId: session.id })
  } catch (error: unknown) {
    console.error('Error creating Stripe checkout session:', error)
    // Never echo the raw error: Stripe internals are server-side.
    return NextResponse.json(
      { error: 'Could not start checkout. Please try again.' },
      { status: 500 }
    )
  }
}

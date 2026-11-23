import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDb } from '@/lib/mongo/mongo'
import { getStripe } from '@/lib/stripe'
import { requireAuth } from '@/lib/auth/session'
import { checkSessionGrantsPro, isMockPaymentsEnabled, proSubscriptionEndsAt, type ProcessedStripeEvent } from '@/lib/payments'

/**
 * POST /api/payments/verify-session — grant Pro for a paid checkout session.
 *
 * Grants nothing unless Stripe says the session is paid AND the amount and
 * currency match the fixed Pro price AND the session's metadata.userId is
 * the caller. Replaying another account's session id grants nothing, and
 * re-verifying a session that already granted Pro does not extend the
 * subscription a second time.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth()
    if (auth instanceof NextResponse) return auth
    const payload = auth.payload
    const body = await req.json().catch(() => ({}))
    const { sessionId } = body

    if (!sessionId) {
      return NextResponse.json({ error: 'Session ID is required' }, { status: 400 })
    }

    if (isMockPaymentsEnabled()) {
      if (!/^mock_[A-Za-z0-9_-]+$/.test(sessionId)) {
        return NextResponse.json({ error: 'Invalid mock payment session.' }, { status: 400 })
      }

      const db = await getDb()
      const grantKey = `verify-session:${sessionId}`
      try {
        await db.collection<ProcessedStripeEvent>('processed_stripe_events').insertOne({
          _id: grantKey,
          type: 'mock-payment',
          userId: payload.sub,
          receivedAt: new Date(),
        })
      } catch (err: unknown) {
        if ((err as { code?: number })?.code === 11000) {
          const existing = await db.collection<ProcessedStripeEvent>('processed_stripe_events').findOne({
            _id: grantKey,
          })
          if (existing?.userId === payload.sub) {
            return NextResponse.json({
              success: true,
              mock: true,
              message: 'Mock payment successful! Your account has been upgraded to Pro for 30 days.',
            })
          }
          return NextResponse.json(
            { error: 'This mock payment belongs to a different account.', success: false },
            { status: 403 },
          )
        }
        throw err
      }

      await db.collection('users').updateOne(
        { _id: new ObjectId(payload.sub) },
        {
          $set: {
            subscriptionStatus: 'active',
            subscriptionPlan: 'pro',
            subscriptionEndsAt: proSubscriptionEndsAt(),
            stripeCustomerId: `mock_customer_${payload.sub}`,
            stripeSubscriptionId: `mock_subscription_${sessionId}`,
            updatedAt: new Date(),
          },
        },
      )

      return NextResponse.json({
        success: true,
        mock: true,
        message: 'Mock payment successful! Your account has been upgraded to Pro for 30 days.',
      })
    }

    // Verify session status with Stripe
    const session = await getStripe().checkout.sessions.retrieve(sessionId)

    const grantError = checkSessionGrantsPro(session, payload.sub)
    if (grantError) {
      const status = grantError === 'This checkout session belongs to a different account.' ? 403 : 400
      return NextResponse.json({ error: grantError }, { status })
    }

    const db = await getDb()

    // One grant per session id. A replay of an already-used session returns
    // success without extending the subscription again.
    const grantKey = `verify-session:${sessionId}`
    try {
      await db.collection<ProcessedStripeEvent>('processed_stripe_events').insertOne({
        _id: grantKey,
        type: 'verify-session',
        userId: payload.sub,
        receivedAt: new Date(),
      })
    } catch (err: unknown) {
      if ((err as { code?: number })?.code === 11000) {
        // A replay is not a second grant: reject it so a stolen session id
        // cannot be re-presented as a fresh payment.
        return NextResponse.json(
          {
            error: 'Payment already verified for this checkout session.',
          },
          { status: 409 },
        )
      }
      throw err
    }

    const users = db.collection('users')
    const oneMonthFromNow = proSubscriptionEndsAt()

    await users.updateOne(
      { _id: new ObjectId(payload.sub) },
      {
        $set: {
          subscriptionStatus: 'active',
          subscriptionPlan: 'pro',
          subscriptionEndsAt: oneMonthFromNow,
          stripeCustomerId: (session.customer as string) || undefined,
          stripeSubscriptionId: (session.subscription as string) || undefined,
          updatedAt: new Date(),
        },
      },
    )

    return NextResponse.json({
      success: true,
      message: 'Payment verified! Your account has been upgraded to Pro for 30 days.',
    })
  } catch (error: unknown) {
    console.error('Verify checkout session error:', error)
    // Never echo the raw error: Stripe/provider internals are server-side.
    return NextResponse.json({ error: 'Payment verification failed. Please try again.' }, { status: 500 })

  }
}

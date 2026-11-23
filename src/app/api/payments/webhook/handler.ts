import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDb } from '@/lib/mongo/mongo'
import { getStripe } from '@/lib/stripe'
import {
  PRO_PRICE_CENTS,
  PRO_PRICE_CURRENCY,
  checkSessionGrantsPro,
  isMockPaymentsEnabled,
  proSubscriptionEndsAt,
  subscriptionEndsAtOf,
  type ProcessedStripeEvent,
  type SubscriptionLike,
} from '@/lib/payments'

/** A user row as the lifecycle handlers read it. */
type StripeUser = { _id: ObjectId } & SubscriptionLike & Record<string, unknown>

/**
 * POST /api/payments/webhook — Stripe webhook, fail-closed.
 *
 * The webhook secret must be set AND the request must carry a valid
 * `stripe-signature` header. Anything else is refused with 400 and grants
 * nothing — there is no unsigned fallback. Each Stripe event id is recorded
 * in `processed_stripe_events` before anything is granted, so replaying an
 * event cannot extend a subscription twice. Pro is granted only when the
 * session actually paid the fixed Pro price.
 *
 * Lifecycle events handled (C1/H19 — previously only
 * `checkout.session.completed` was handled and everything else was silently
 * swallowed):
 * - `checkout.session.completed` /
 *   `checkout.session.async_payment_succeeded` — grant Pro for 30 days.
 * - `invoice.payment_succeeded` — renewal: extend the paid term to the
 *   invoice's period end (never shorten it).
 * - `customer.subscription.deleted` — Pro ends at the subscription's period
 *   end; status becomes `canceled` (a paid-up cancellation keeps Pro until
 *   that date, then the C1 expiry gate removes it).
 * - `customer.subscription.updated` — status sync: `active` restores /
 *   extends Pro to the current period end, `canceled` ends it at the period
 *   end, `past_due` / `unpaid` / `incomplete*` record the failure state.
 * - `invoice.payment_failed` — status becomes `past_due` (the paid term
 *   itself is left untouched; the Pro gate denies while `past_due`).
 * - `checkout.session.async_payment_failed` — nothing was paid, no state
 *   change.
 * Any other event type is acknowledged with `{ received: true }` and no
 * state change, as before.
 */
export async function POST(req: NextRequest) {
  if (isMockPaymentsEnabled()) {
    return NextResponse.json({ received: true, mock: true })
  }

  const bodyText = await req.text()
  const sig = req.headers.get('stripe-signature')
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  if (!webhookSecret) {
    console.error('Stripe webhook secret is not configured; refusing webhook.')
    return NextResponse.json({ error: 'Webhook secret is not configured.' }, { status: 400 })
  }
  if (!sig) {
    return NextResponse.json({ error: 'Missing Stripe signature.' }, { status: 400 })
  }

  let event: { id: string; type: string; data: { object: Record<string, unknown> } }
  try {
    event = getStripe().webhooks.constructEvent(bodyText, sig, webhookSecret) as unknown as typeof event
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid signature.'
    console.error('Webhook signature verification failed:', message)
    return NextResponse.json({ error: `Webhook Error: ${message}` }, { status: 400 })
  }

  const db = await getDb()

  // Deduplicate by Stripe event id before granting anything. The event id
  // is the document _id, so a replay hits a duplicate-key error.
  try {
    await db.collection<ProcessedStripeEvent>('processed_stripe_events').insertOne({
      _id: event.id,
      type: event.type,
      receivedAt: new Date(),
    })
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code
    if (code === 11000) {
      return NextResponse.json({ received: true, duplicate: true })
    }
    throw err
  }

  const users = db.collection('users')

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object as {
      amount_total?: number | null
      currency?: string | null
      payment_status?: string | null
      status?: string | null
      metadata?: Record<string, string | undefined | null> | null
      customer_details?: { email?: string | null } | null
      customer_email?: string | null
      customer?: string | null
      subscription?: string | null
    }
    // The session must have paid the Pro price. The caller here is Stripe
    // itself (signature verified), so no caller-user check applies; the
    // session's own metadata still has to name a real user.
    const grantError = checkSessionGrantsPro(session)
    if (grantError) {
      console.error('Webhook session did not pay the Pro price; granting nothing.', grantError)
      return NextResponse.json({ error: grantError }, { status: 400 })
    }

    const customerEmail =
      session.customer_details?.email || session.customer_email || session.metadata?.userEmail
    const userId = session.metadata?.userId

    const oneMonthFromNow = proSubscriptionEndsAt()
    const updateQuery = {
      $set: {
        subscriptionStatus: 'active',
        subscriptionPlan: 'pro',
        subscriptionEndsAt: oneMonthFromNow,
        stripeCustomerId: session.customer || undefined,
        stripeSubscriptionId: session.subscription || undefined,
        updatedAt: new Date(),
      },
    }

    let granted = false
    if (userId) {
      if (!ObjectId.isValid(userId)) {
        return NextResponse.json({ error: 'Session names an invalid user.' }, { status: 400 })
      }
      const result = await users.updateOne({ _id: new ObjectId(userId) }, updateQuery)
      granted = result.matchedCount > 0
    }
    if (!granted && customerEmail) {
      const result = await users.updateOne({ email: customerEmail.toLowerCase() }, updateQuery)
      granted = result.matchedCount > 0
    }
    if (!granted) {
      console.error('Webhook session paid but matched no user; granting nothing.')
      return NextResponse.json({ error: 'Session matched no user.' }, { status: 400 })
    }
    return NextResponse.json({ received: true })
  }

  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object as {
      amount_paid?: number | null
      currency?: string | null
      customer?: string | Record<string, unknown> | null
      customer_email?: string | null
      subscription?: string | Record<string, unknown> | null
      period_end?: number | null
      lines?: { data?: Array<{ period?: { end?: number | null } | null }> | null } | null
    }
    if (typeof invoice.amount_paid !== 'number' || invoice.amount_paid < PRO_PRICE_CENTS) {
      return NextResponse.json({ error: 'Invoice did not record a Pro payment.' }, { status: 400 })
    }
    if ((invoice.currency || '').toLowerCase() !== PRO_PRICE_CURRENCY) {
      return NextResponse.json({ error: 'Invoice currency does not match the Pro price.' }, { status: 400 })
    }
    const user = await findUserForStripeIds(db, {
      subscriptionId: stripeId(invoice.subscription),
      customerId: stripeId(invoice.customer),
      email: invoice.customer_email,
    })
    if (!user) {
      return NextResponse.json({ error: 'Invoice matched no user.' }, { status: 400 })
    }
    // The paid-through date is the invoice period end; fall back to a fresh
    // 30 days when Stripe did not send one. A renewal never shortens the
    // term a user already has (e.g. a late duplicate invoice).
    const periodEnd =
      unixSecondsToDate(invoice.period_end) ??
      unixSecondsToDate(invoice.lines?.data?.[0]?.period?.end ?? null)
    const freshEndsAt = periodEnd && periodEnd.getTime() > Date.now() ? periodEnd : proSubscriptionEndsAt()
    const currentEndsAt = subscriptionEndsAtOf(user)
    const endsAt =
      currentEndsAt && currentEndsAt.getTime() > freshEndsAt.getTime() ? currentEndsAt : freshEndsAt
    await users.updateOne(
      { _id: user._id },
      {
        $set: {
          subscriptionStatus: 'active',
          subscriptionPlan: 'pro',
          subscriptionEndsAt: endsAt,
          stripeCustomerId: stripeId(invoice.customer) || undefined,
          stripeSubscriptionId: stripeId(invoice.subscription) || undefined,
          updatedAt: new Date(),
        },
      },
    )
    return NextResponse.json({ received: true })
  }

  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object as {
      customer?: string | Record<string, unknown> | null
      customer_email?: string | null
      subscription?: string | Record<string, unknown> | null
    }
    const user = await findUserForStripeIds(db, {
      subscriptionId: stripeId(invoice.subscription),
      customerId: stripeId(invoice.customer),
      email: invoice.customer_email,
    })
    if (!user) {
      return NextResponse.json({ error: 'Invoice matched no user.' }, { status: 400 })
    }
    // Recorded exactly as: status `past_due`, paid term untouched. The Pro
    // gate denies while `past_due` (it requires status `active` or a paid-up
    // `canceled`), so a failed renewal stops Pro even if the old endsAt has
    // not passed yet; paying again (invoice.payment_succeeded) restores it.
    await users.updateOne(
      { _id: user._id },
      { $set: { subscriptionStatus: 'past_due', updatedAt: new Date() } },
    )
    return NextResponse.json({ received: true })
  }

  if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
    const sub = event.data.object as {
      id?: string | null
      customer?: string | Record<string, unknown> | null
      status?: string | null
      current_period_end?: number | null
    }
    const user = await findUserForStripeIds(db, {
      subscriptionId: sub.id ?? null,
      customerId: stripeId(sub.customer),
      email: null,
    })
    if (!user) {
      return NextResponse.json({ error: 'Subscription matched no user.' }, { status: 400 })
    }
    const periodEnd = unixSecondsToDate(sub.current_period_end)
    if (sub.status === 'active') {
      // Renewal / recovery via an update: restore Pro and extend the term
      // to the current period end when that is later than what is stored.
      const currentEndsAt = subscriptionEndsAtOf(user)
      const endsAt =
        periodEnd && (!currentEndsAt || periodEnd.getTime() > currentEndsAt.getTime())
          ? periodEnd
          : currentEndsAt
      await users.updateOne(
        { _id: user._id },
        {
          $set: {
            subscriptionStatus: 'active',
            subscriptionPlan: 'pro',
            ...(endsAt ? { subscriptionEndsAt: endsAt } : {}),
            stripeSubscriptionId: sub.id || undefined,
            stripeCustomerId: stripeId(sub.customer) || undefined,
            updatedAt: new Date(),
          },
        },
      )
      return NextResponse.json({ received: true })
    }
    if (sub.status === 'canceled') {
      // Pro runs until the paid period end, then the C1 expiry gate removes
      // it. When Stripe sends no period end, the term ends now.
      await users.updateOne(
        { _id: user._id },
        {
          $set: {
            subscriptionStatus: 'canceled',
            subscriptionEndsAt: periodEnd ?? new Date(),
            updatedAt: new Date(),
          },
        },
      )
      return NextResponse.json({ received: true })
    }
    if (
      sub.status === 'past_due' ||
      sub.status === 'unpaid' ||
      sub.status === 'incomplete' ||
      sub.status === 'incomplete_expired'
    ) {
      await users.updateOne(
        { _id: user._id },
        { $set: { subscriptionStatus: sub.status, updatedAt: new Date() } },
      )
      return NextResponse.json({ received: true })
    }
    // `trialing`, `paused`, or an unknown status: no Pro state change.
    return NextResponse.json({ received: true })
  }

  // `checkout.session.async_payment_failed` and every other event type:
  // nothing was paid and no subscription state changes.
  return NextResponse.json({ received: true })
}

/** A Stripe id field is a string id, or an expanded object carrying one. */
function stripeId(value: string | Record<string, unknown> | null | undefined): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id
  return null
}

/** Stripe unix-seconds timestamps to Date, or null when absent/invalid. */
function unixSecondsToDate(value: number | null | undefined): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const d = new Date(value * 1000)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Find the user a lifecycle event belongs to: by the stored Stripe
 * subscription id first, then the Stripe customer id, then the payer email.
 */
async function findUserForStripeIds(
  db: Awaited<ReturnType<typeof getDb>>,
  ids: { subscriptionId?: string | null; customerId?: string | null; email?: string | null },
): Promise<StripeUser | null> {
  const users = db.collection('users')
  if (ids.subscriptionId) {
    const bySub = await users.findOne({ stripeSubscriptionId: ids.subscriptionId })
    if (bySub) return bySub as StripeUser
  }
  if (ids.customerId) {
    const byCustomer = await users.findOne({ stripeCustomerId: ids.customerId })
    if (byCustomer) return byCustomer as StripeUser
  }
  if (ids.email) {
    const byEmail = await users.findOne({ email: ids.email.toLowerCase() })
    if (byEmail) return byEmail as StripeUser
  }
  return null
}

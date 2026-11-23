/**
 * The one place that defines what Pro costs. The price is fixed here on the
 * server — no handler ever takes a price, amount, or line item from the
 * client. Checkout builds its line items from these constants, and both
 * verify-session and the webhook refuse to grant Pro unless the Stripe
 * session actually paid this amount in this currency.
 */

export const PRO_PRICE_CENTS = 1900 // $19.00
export const PRO_PRICE_CURRENCY = 'usd'
export const PRO_PLAN_DAYS = 30

export function isMockPaymentsEnabled(): boolean {
  // Mock mode is the safe default. Set MOCK_PAYMENTS=false explicitly only
  // when this deployment is intentionally configured for real Stripe.
  return process.env.MOCK_PAYMENTS !== 'false'
}

/** One row per Stripe event id (or verify-session grant) that already ran. */
export type ProcessedStripeEvent = {
  _id: string
  type: string
  userId?: string
  receivedAt: Date
}

export function proSubscriptionEndsAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + PRO_PLAN_DAYS * 24 * 60 * 60 * 1000)
}

/**
 * The stored subscription fields the Pro gate reads. `subscriptionEndsAt`
 * is written by every Pro grant (verify-session and the webhook) and — since
 * the C1 fix — is the thing that decides whether a Pro record is still
 * live. Nothing else in the codebase may treat `subscriptionStatus ===
 * 'active'` as Pro without going through these helpers.
 */
export type SubscriptionLike = {
  subscriptionPlan?: string | null
  subscriptionStatus?: string | null
  subscriptionEndsAt?: Date | string | null
  trialEndsAt?: Date | string | null
  createdAt?: Date | string | null
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** The paid-term end of a subscription record, or null when it has none. */
export function subscriptionEndsAtOf(user: SubscriptionLike): Date | null {
  return toDate(user.subscriptionEndsAt)
}

/**
 * Trial end with the same createdAt + 90d fallback the profile endpoint
 * uses, so a user whose row predates `trialEndsAt` is judged by the same
 * date the UI shows.
 */
export function effectiveTrialEndsAt(user: SubscriptionLike): Date | null {
  const explicit = toDate(user.trialEndsAt)
  if (explicit) return explicit
  const created = toDate(user.createdAt)
  if (!created) return null
  return new Date(created.getTime() + 90 * 24 * 60 * 60 * 1000)
}

/**
 * True while the paid Pro term is live: plan `pro`, status `active` — or
 * `canceled` but still paid up through the period end — and
 * `subscriptionEndsAt` in the future. A missing or past endsAt is never
 * Pro: every grant writes an endsAt, so its absence means no live paid
 * term. This is the C1 fix — the date is now read, not just written.
 */
export function isProActive(user: SubscriptionLike, now: Date = new Date()): boolean {
  if (user.subscriptionPlan !== 'pro') return false
  if (user.subscriptionStatus !== 'active' && user.subscriptionStatus !== 'canceled') return false
  const endsAt = toDate(user.subscriptionEndsAt)
  if (!endsAt) return false
  return endsAt.getTime() > now.getTime()
}

/**
 * The status the profile endpoint (and therefore the UI) reports. A Pro
 * record whose paid term has ended reports `expired` even though the stored
 * status still says `active` — the stored row is only ever flipped by a
 * webhook event, and expiry is a function of the date, not of an event
 * arriving.
 */
export function effectiveSubscriptionStatus(user: SubscriptionLike, now: Date = new Date()): string {
  const stored = user.subscriptionStatus ?? (user.subscriptionPlan === 'pro' ? 'active' : 'trialing')
  if (user.subscriptionPlan === 'pro' && (stored === 'active' || stored === 'canceled')) {
    if (!isProActive(user, now)) return 'expired'
    return stored
  }
  return stored
}

/**
 * True while the user may create agents: a live Pro term, or a live trial.
 * A user whose only record is an expired Pro term (plan `pro`, not active)
 * has no trial to fall back on. A user with no dates at all (legacy rows)
 * is not locked out on missing data.
 */
export function hasActiveAccess(user: SubscriptionLike, now: Date = new Date()): boolean {
  if (isProActive(user, now)) return true
  if (user.subscriptionPlan === 'pro') return false
  const trialEnds = effectiveTrialEndsAt(user)
  if (!trialEnds) return true
  return trialEnds.getTime() > now.getTime()
}

export type PaidSessionLike = {
  amount_total?: number | null
  currency?: string | null
  payment_status?: string | null
  status?: string | null
  metadata?: Record<string, string | undefined | null> | null
}

/**
 * Check a Stripe checkout session before granting Pro. Returns an error
 * message when the session must not grant anything, else null.
 * `callerUserId` is the logged-in user asking for the upgrade; when it is
 * given, the session must belong to that user.
 */
export function checkSessionGrantsPro(
  session: PaidSessionLike,
  callerUserId?: string,
): string | null {
  const paid = session.payment_status === 'paid' || session.status === 'complete'
  if (!paid) return 'Payment incomplete or pending.'
  if (typeof session.amount_total !== 'number' || session.amount_total < PRO_PRICE_CENTS) {
    return `Paid amount does not match the Pro price of $${(PRO_PRICE_CENTS / 100).toFixed(2)}.`
  }
  if ((session.currency || '').toLowerCase() !== PRO_PRICE_CURRENCY) {
    return 'Paid currency does not match the Pro price.'
  }
  if (callerUserId !== undefined && session.metadata?.userId !== callerUserId) {
    return 'This checkout session belongs to a different account.'
  }
  return null
}

/** The fixed server-side line items for a Pro checkout. No client input. */
export function proLineItems(): Array<Record<string, unknown>> {
  return [
    {
      price_data: {
        currency: PRO_PRICE_CURRENCY,
        product_data: {
          name: 'AgentFlow Pro Subscription',
          description: 'Access to all agent canvas workflows, execution nodes, and templates.',
        },
        unit_amount: PRO_PRICE_CENTS,
        recurring: { interval: 'month' },
      },
      quantity: 1,
    },
  ]
}

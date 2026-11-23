/**
 * Subscription-expiry + lifecycle contract tests (C1/H19, Lane A).
 *
 * Fixed behaviour under test:
 * - The Pro gate reads `subscriptionEndsAt`: a Pro record whose paid term
 *   has passed is not Pro (profile reports `expired`, agent creation is
 *   refused with 403), while a live trial or a live paid term may create.
 * - The webhook handles the lifecycle, not just `checkout.session.completed`:
 *   `invoice.payment_succeeded` extends the term to the invoice period end
 *   (never shortens it); `customer.subscription.deleted` ends Pro at the
 *   period end; `invoice.payment_failed` records `past_due`;
 *   `checkout.session.async_payment_succeeded` grants like a completed
 *   checkout; `customer.subscription.updated` syncs status.
 * - Forged / underpaid / replayed webhooks are still rejected as before
 *   (covered by cases/stripe.cjs; replay of a renewal is covered here).
 */
'use strict'

const { test, req, readJson, assert } = require('../harness.cjs')
const { ObjectId } = require('mongodb')
const dbFake = require('../fakes/db.cjs')
const jwtFake = require('../fakes/jwt.cjs')
const stripeFake = require('../fakes/stripe.cjs')

const webhook = require('@/app/api/payments/webhook/handler')
const agents = require('@/app/api/agents/handler')
const payments = require('@/lib/payments')

const WEBHOOK_SECRET = 'whsec_test_phase3'
const DAY = 24 * 60 * 60 * 1000

function postWebhookRaw(payload, signature) {
  const headers = { 'Content-Type': 'application/json' }
  if (signature) headers['stripe-signature'] = signature
  return new Request('http://localhost:3000/api/payments/webhook', {
    method: 'POST',
    headers,
    body: payload,
  })
}

async function postWebhook(event) {
  const payload = JSON.stringify(event)
  const request = await postWebhookRaw(payload, stripeFake.__signPayload(payload, WEBHOOK_SECRET))
  return webhook.POST(request)
}

async function seedProUser(overrides = {}) {
  const id = new ObjectId()
  const now = Date.now()
  await dbFake.__db.collection('users').insertOne({
    _id: id,
    email: 'buyer@example.com',
    subscriptionPlan: 'pro',
    subscriptionStatus: 'active',
    subscriptionEndsAt: new Date(now + 30 * DAY),
    trialEndsAt: new Date(now - 10 * DAY),
    createdAt: new Date(now - 100 * DAY),
    stripeCustomerId: 'cus_test_1',
    stripeSubscriptionId: 'sub_test_1',
    ...overrides,
  })
  return id
}

function renewalEvent(overrides = {}) {
  return {
    id: 'evt_renew_1',
    type: 'invoice.payment_succeeded',
    data: {
      object: {
        id: 'in_test_1',
        subscription: 'sub_test_1',
        customer: 'cus_test_1',
        customer_email: 'buyer@example.com',
        amount_paid: 1900,
        currency: 'usd',
        status: 'paid',
        period_end: Math.floor((Date.now() + 60 * DAY) / 1000),
        ...overrides,
      },
    },
  }
}

test('subscription: expired Pro is not Pro, live Pro is', async () => {
  const now = new Date()
  const expired = {
    subscriptionPlan: 'pro',
    subscriptionStatus: 'active',
    subscriptionEndsAt: new Date(now.getTime() - 5 * DAY),
  }
  assert.strictEqual(payments.isProActive(expired, now), false)
  assert.strictEqual(payments.effectiveSubscriptionStatus(expired, now), 'expired')
  assert.strictEqual(payments.hasActiveAccess(expired, now), false)

  const live = {
    subscriptionPlan: 'pro',
    subscriptionStatus: 'active',
    subscriptionEndsAt: new Date(now.getTime() + 5 * DAY),
  }
  assert.strictEqual(payments.isProActive(live, now), true)
  assert.strictEqual(payments.effectiveSubscriptionStatus(live, now), 'active')
  assert.strictEqual(payments.hasActiveAccess(live, now), true)

  // A canceled subscription still paid up through its period end keeps Pro
  // until that date; past it, it is expired.
  const paidUpCancel = {
    subscriptionPlan: 'pro',
    subscriptionStatus: 'canceled',
    subscriptionEndsAt: new Date(now.getTime() + 5 * DAY),
  }
  assert.strictEqual(payments.isProActive(paidUpCancel, now), true)
  assert.strictEqual(payments.effectiveSubscriptionStatus(paidUpCancel, now), 'canceled')
  const lapsedCancel = { ...paidUpCancel, subscriptionEndsAt: new Date(now.getTime() - DAY) }
  assert.strictEqual(payments.isProActive(lapsedCancel, now), false)
  assert.strictEqual(payments.effectiveSubscriptionStatus(lapsedCancel, now), 'expired')

  // A Pro record with no endsAt at all is never Pro (fail-closed: every
  // grant writes an endsAt).
  assert.strictEqual(
    payments.isProActive({ subscriptionPlan: 'pro', subscriptionStatus: 'active' }, now),
    false,
  )

  // A live trial has access; an expired trial does not.
  const trial = {
    subscriptionPlan: 'free_trial',
    subscriptionStatus: 'trialing',
    trialEndsAt: new Date(now.getTime() + 10 * DAY),
  }
  assert.strictEqual(payments.hasActiveAccess(trial, now), true)
  assert.strictEqual(
    payments.hasActiveAccess({ ...trial, trialEndsAt: new Date(now.getTime() - DAY) }, now),
    false,
  )
})

test('webhook: renewal extends the term to the invoice period end', async () => {
  const userId = await seedProUser()
  const res = await postWebhook(renewalEvent())
  assert.strictEqual(res.status, 200, JSON.stringify(await readJson(res)))
  const user = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.strictEqual(user.subscriptionStatus, 'active')
  assert.strictEqual(user.subscriptionPlan, 'pro')
  const expected = renewalEvent().data.object.period_end * 1000
  assert.ok(Math.abs(user.subscriptionEndsAt.getTime() - expected) < 2000, 'endsAt is not the invoice period end')
})

test('webhook: renewal never shortens an existing longer term', async () => {
  const userId = await seedProUser({ subscriptionEndsAt: new Date(Date.now() + 90 * DAY) })
  const res = await postWebhook(renewalEvent())
  assert.strictEqual(res.status, 200)
  const user = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.ok(
    Math.abs(user.subscriptionEndsAt.getTime() - (Date.now() + 90 * DAY)) < 5000,
    'renewal shortened the term',
  )
})

test('webhook: underpaid renewal is refused and extends nothing', async () => {
  const userId = await seedProUser()
  const before = (await dbFake.__db.collection('users').findOne({ _id: userId })).subscriptionEndsAt
  const res = await postWebhook(renewalEvent({ amount_paid: 100 }))
  assert.strictEqual(res.status, 400)
  const user = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.strictEqual(user.subscriptionEndsAt.getTime(), before.getTime())
})

test('webhook: replayed renewal does not extend twice', async () => {
  const userId = await seedProUser()
  const first = await postWebhook(renewalEvent())
  assert.strictEqual(first.status, 200)
  const afterFirst = (await dbFake.__db.collection('users').findOne({ _id: userId })).subscriptionEndsAt
  const second = await postWebhook(renewalEvent())
  const secondBody = await readJson(second)
  assert.strictEqual(second.status, 200)
  assert.strictEqual(secondBody.duplicate, true)
  const afterSecond = (await dbFake.__db.collection('users').findOne({ _id: userId })).subscriptionEndsAt
  assert.strictEqual(afterSecond.getTime(), afterFirst.getTime())
})

test('webhook: cancellation keeps Pro until the period end, then it lapses', async () => {
  const userId = await seedProUser()
  const periodEnd = Math.floor((Date.now() + 10 * DAY) / 1000)
  const res = await postWebhook({
    id: 'evt_cancel_1',
    type: 'customer.subscription.deleted',
    data: {
      object: { id: 'sub_test_1', customer: 'cus_test_1', status: 'canceled', current_period_end: periodEnd },
    },
  })
  assert.strictEqual(res.status, 200, JSON.stringify(await readJson(res)))
  const user = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.strictEqual(user.subscriptionStatus, 'canceled')
  assert.ok(Math.abs(user.subscriptionEndsAt.getTime() - periodEnd * 1000) < 2000)
  // Still paid up: the gate still counts this user as Pro until period end.
  assert.strictEqual(payments.isProActive(user, new Date()), true)
  assert.strictEqual(payments.isProActive(user, new Date(periodEnd * 1000 + DAY)), false)
})

test('webhook: cancellation with a past period end removes Pro at once', async () => {
  const userId = await seedProUser()
  const res = await postWebhook({
    id: 'evt_cancel_2',
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: 'sub_test_1',
        customer: 'cus_test_1',
        status: 'canceled',
        current_period_end: Math.floor((Date.now() - DAY) / 1000),
      },
    },
  })
  assert.strictEqual(res.status, 200)
  const user = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.strictEqual(user.subscriptionStatus, 'canceled')
  assert.strictEqual(payments.isProActive(user, new Date()), false)
  assert.strictEqual(payments.effectiveSubscriptionStatus(user, new Date()), 'expired')
})

test('webhook: payment failure records past_due and stops Pro', async () => {
  const userId = await seedProUser()
  const before = (await dbFake.__db.collection('users').findOne({ _id: userId })).subscriptionEndsAt
  const res = await postWebhook({
    id: 'evt_fail_1',
    type: 'invoice.payment_failed',
    data: {
      object: { id: 'in_test_fail', subscription: 'sub_test_1', customer: 'cus_test_1' },
    },
  })
  assert.strictEqual(res.status, 200, JSON.stringify(await readJson(res)))
  const user = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.strictEqual(user.subscriptionStatus, 'past_due')
  // The paid term itself is untouched; the status alone removes Pro.
  assert.strictEqual(user.subscriptionEndsAt.getTime(), before.getTime())
  assert.strictEqual(payments.isProActive(user, new Date()), false)
})

test('webhook: async payment success grants Pro like a completed checkout', async () => {
  const userId = new ObjectId()
  await dbFake.__db.collection('users').insertOne({ _id: userId, email: 'buyer@example.com' })
  const res = await postWebhook({
    id: 'evt_async_1',
    type: 'checkout.session.async_payment_succeeded',
    data: {
      object: {
        id: 'cs_test_async',
        customer_details: { email: 'buyer@example.com' },
        customer: 'cus_test_1',
        subscription: 'sub_test_1',
        payment_status: 'paid',
        status: 'complete',
        amount_total: 1900,
        currency: 'usd',
        metadata: { userId: String(userId), userEmail: 'buyer@example.com' },
      },
    },
  })
  assert.strictEqual(res.status, 200, JSON.stringify(await readJson(res)))
  const user = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.strictEqual(user.subscriptionPlan, 'pro')
  assert.strictEqual(user.subscriptionStatus, 'active')
  assert.ok(user.subscriptionEndsAt.getTime() > Date.now())
})

test('webhook: subscription update syncs status (past_due, then active again)', async () => {
  const userId = await seedProUser()
  const pastDue = await postWebhook({
    id: 'evt_upd_1',
    type: 'customer.subscription.updated',
    data: {
      object: { id: 'sub_test_1', customer: 'cus_test_1', status: 'past_due', current_period_end: null },
    },
  })
  assert.strictEqual(pastDue.status, 200)
  let user = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.strictEqual(user.subscriptionStatus, 'past_due')
  assert.strictEqual(payments.isProActive(user, new Date()), false)

  const recovered = await postWebhook({
    id: 'evt_upd_2',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_test_1',
        customer: 'cus_test_1',
        status: 'active',
        current_period_end: Math.floor((Date.now() + 60 * DAY) / 1000),
      },
    },
  })
  assert.strictEqual(recovered.status, 200)
  user = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.strictEqual(user.subscriptionStatus, 'active')
  assert.strictEqual(payments.isProActive(user, new Date()), true)
})

test('webhook: unknown event type still acknowledged with no state change', async () => {
  const userId = await seedProUser()
  const res = await postWebhook({
    id: 'evt_other_1',
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_test_1' } },
  })
  assert.strictEqual(res.status, 200)
  const user = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.strictEqual(user.subscriptionStatus, 'active')
  assert.ok(Math.abs(user.subscriptionEndsAt.getTime() - (Date.now() + 30 * DAY)) < 5000)
})

test('agents: expired Pro cannot create agents (403)', async () => {
  jwtFake.__setToken('tok-user-a')
  await dbFake.__db.collection('users').insertOne({
    _id: new ObjectId(jwtFake.USER_A_ID),
    email: 'a@example.com',
    subscriptionPlan: 'pro',
    subscriptionStatus: 'active',
    subscriptionEndsAt: new Date(Date.now() - 5 * DAY),
    trialEndsAt: new Date(Date.now() - 10 * DAY),
    createdAt: new Date(Date.now() - 100 * DAY),
  })
  const res = await agents.POST(
    req('http://localhost:3000/api/agents', { body: { name: 'Should Not Exist' } }),
  )
  assert.strictEqual(res.status, 403, JSON.stringify(await readJson(res)))
  assert.strictEqual(dbFake.__dump('agents').length, 0)
})

test('agents: live trial and live Pro can still create agents', async () => {
  jwtFake.__setToken('tok-user-a')
  await dbFake.__db.collection('users').insertOne({
    _id: new ObjectId(jwtFake.USER_A_ID),
    email: 'a@example.com',
    subscriptionPlan: 'free_trial',
    subscriptionStatus: 'trialing',
    trialEndsAt: new Date(Date.now() + 30 * DAY),
    createdAt: new Date(Date.now() - 10 * DAY),
  })
  const trialRes = await agents.POST(
    req('http://localhost:3000/api/agents', { body: { name: 'Trial Agent' } }),
  )
  assert.strictEqual(trialRes.status, 201, JSON.stringify(await readJson(trialRes)))

  // Same caller, now a live Pro user instead of a trial user.
  await dbFake.__db.collection('users').updateOne(
    { _id: new ObjectId(jwtFake.USER_A_ID) },
    {
      $set: {
        subscriptionPlan: 'pro',
        subscriptionStatus: 'active',
        subscriptionEndsAt: new Date(Date.now() + 30 * DAY),
      },
    },
  )
  const proRes = await agents.POST(
    req('http://localhost:3000/api/agents', { body: { name: 'Pro Agent' } }),
  )
  assert.strictEqual(proRes.status, 201, JSON.stringify(await readJson(proRes)))
})

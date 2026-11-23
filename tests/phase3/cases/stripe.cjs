/**
 * Stripe contract tests (P3-2).
 *
 * Fixed behaviour under test (P0-2 / P0-3, owned by Lane A):
 * - Webhook: a signed event is accepted and grants Pro; a forged or
 *   unsigned event is rejected with 400 and grants nothing; replaying an
 *   event id does not extend the subscription a second time.
 * - Checkout: client-supplied line_items are ignored; the session is always
 *   built at the fixed $19 / 1900 price.
 * - Verify-session: rejects a wrong amount, a session whose metadata.userId
 *   is not the caller, and a session that was already used.
 *
 * On the base copy these fail: the webhook falls back to unsigned JSON, the
 * checkout trusts client line_items, and verify-session checks neither
 * amount nor owner nor replay.
 */
'use strict'

const { test, req, readJson, assert } = require('../harness.cjs')
const { ObjectId } = require('mongodb')
const dbFake = require('../fakes/db.cjs')
const jwtFake = require('../fakes/jwt.cjs')
const stripeFake = require('../fakes/stripe.cjs')

const webhook = require('@/app/api/payments/webhook/handler')
const checkout = require('@/app/api/payments/checkout/handler')
const verifySession = require('@/app/api/payments/verify-session/handler')

const WEBHOOK_SECRET = 'whsec_test_phase3'

function seedUser() {
  const id = new ObjectId()
  const db = dbFake.__db
  return db
    .collection('users')
    .insertOne({ _id: id, email: 'buyer@example.com', subscriptionPlan: 'free' })
    .then(() => id)
}

function webhookEvent(userId) {
  return {
    id: 'evt_test_phase3_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        customer_details: { email: 'buyer@example.com' },
        customer: 'cus_test_1',
        subscription: null,
        // A real paid checkout.session.completed carries these; the grant
        // check refuses the event without them (unpaid session).
        payment_status: 'paid',
        status: 'complete',
        amount_total: 1900,
        currency: 'usd',
        metadata: { userId: String(userId), userEmail: 'buyer@example.com' },
      },
    },
  }
}

function postWebhookRaw(payload, signature) {
  // Build the raw request by hand: the handler reads req.text(), so the body
  // must be the exact JSON string that was signed.
  const headers = { 'Content-Type': 'application/json' }
  if (signature) headers['stripe-signature'] = signature
  return new Request('http://localhost:3000/api/payments/webhook', {
    method: 'POST',
    headers,
    body: payload,
  })
}

test('webhook: signed event accepted and grants Pro', async () => {
  const userId = await seedUser()
  const event = webhookEvent(userId)
  const payload = JSON.stringify(event)
  const request = await postWebhookRaw(payload, stripeFake.__signPayload(payload, WEBHOOK_SECRET))
  const res = await webhook.POST(request)
  assert.strictEqual(res.status, 200)
  const user = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.strictEqual(user.subscriptionPlan, 'pro')
  assert.strictEqual(user.subscriptionStatus, 'active')
})

test('webhook: forged signature rejected with 400 and grants nothing', async () => {
  const userId = await seedUser()
  const event = webhookEvent(userId)
  const payload = JSON.stringify(event)
  const forged = stripeFake.__signPayload(payload, 'whsec_attacker_key')
  const request = await postWebhookRaw(payload, forged)
  const res = await webhook.POST(request)
  assert.strictEqual(res.status, 400)
  const user = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.notStrictEqual(user.subscriptionPlan, 'pro')
})

test('webhook: missing signature rejected with 400 and grants nothing', async () => {
  const userId = await seedUser()
  const payload = JSON.stringify(webhookEvent(userId))
  const request = await postWebhookRaw(payload, null)
  const res = await webhook.POST(request)
  assert.strictEqual(res.status, 400)
  const user = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.notStrictEqual(user.subscriptionPlan, 'pro')
})

test('webhook: missing webhook secret rejected with 400 and grants nothing', async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET
  const userId = await seedUser()
  const payload = JSON.stringify(webhookEvent(userId))
  const request = await postWebhookRaw(payload, stripeFake.__signPayload(payload, WEBHOOK_SECRET))
  const res = await webhook.POST(request)
  assert.strictEqual(res.status, 400)
  const user = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.notStrictEqual(user.subscriptionPlan, 'pro')
})

test('webhook: replayed event id does not extend the subscription', async () => {
  const userId = await seedUser()
  const event = webhookEvent(userId)
  const payload = JSON.stringify(event)
  const signature = stripeFake.__signPayload(payload, WEBHOOK_SECRET)
  const first = await webhook.POST(await postWebhookRaw(payload, signature))
  assert.strictEqual(first.status, 200)
  const afterFirst = await dbFake.__db.collection('users').findOne({ _id: userId })
  const endsAtFirst = afterFirst.subscriptionEndsAt.getTime()
  const second = await webhook.POST(await postWebhookRaw(payload, signature))
  assert.ok(second.status === 200 || second.status === 409, `replay answered ${second.status}`)
  const afterSecond = await dbFake.__db.collection('users').findOne({ _id: userId })
  assert.strictEqual(
    afterSecond.subscriptionEndsAt.getTime(),
    endsAtFirst,
    'replayed event extended the subscription',
  )
})

test('checkout: client-supplied line_items ignored, fixed $19 / 1900 charged', async () => {
  jwtFake.__setToken('tok-user-a')
  const res = await checkout.POST(
    req('http://localhost:3000/api/payments/checkout', {
      body: {
        mode: 'payment',
        line_items: [
          {
            price_data: { currency: 'usd', product_data: { name: 'Penny plan' }, unit_amount: 1 },
            quantity: 1,
          },
        ],
      },
    }),
  )
  assert.strictEqual(res.status, 200)
  const created = stripeFake.__createdSessions()
  assert.strictEqual(created.length, 1)
  const item = created[0].params.line_items[0]
  assert.strictEqual(item.price_data.unit_amount, 1900)
  assert.strictEqual(item.price_data.currency, 'usd')
  assert.strictEqual(item.quantity, 1)
})

test('verify-session: paid $19 session for the caller grants Pro', async () => {
  jwtFake.__setToken('tok-user-a')
  await dbFake.__db.collection('users').insertOne({ _id: new ObjectId(jwtFake.USER_A_ID), email: 'a@example.com' })
  stripeFake.__seedSession({
    id: 'cs_ok',
    payment_status: 'paid',
    status: 'complete',
    amount_total: 1900,
    currency: 'usd',
    metadata: { userId: jwtFake.USER_A_ID },
    customer: 'cus_1',
    subscription: null,
  })
  const res = await verifySession.POST(
    req('http://localhost:3000/api/payments/verify-session', { body: { sessionId: 'cs_ok' } }),
  )
  const body = await readJson(res)
  assert.strictEqual(res.status, 200, JSON.stringify(body))
  assert.strictEqual(body.success, true)
  const user = await dbFake.__db.collection('users').findOne({ _id: new ObjectId(jwtFake.USER_A_ID) })
  assert.strictEqual(user.subscriptionPlan, 'pro')
})

test('verify-session: wrong amount rejected and grants nothing', async () => {
  await dbFake.__db.collection('users').insertOne({ _id: new ObjectId(jwtFake.USER_A_ID), email: 'a@example.com' })
  jwtFake.__setToken('tok-user-a')
  stripeFake.__seedSession({
    id: 'cs_cheap',
    payment_status: 'paid',
    status: 'complete',
    amount_total: 100,
    currency: 'usd',
    metadata: { userId: jwtFake.USER_A_ID },
    customer: 'cus_1',
    subscription: null,
  })
  const res = await verifySession.POST(
    req('http://localhost:3000/api/payments/verify-session', { body: { sessionId: 'cs_cheap' } }),
  )
  assert.notStrictEqual(res.status, 200, 'wrong-amount session was accepted')
  const user = await dbFake.__db.collection('users').findOne({ _id: new ObjectId(jwtFake.USER_A_ID) })
  assert.notStrictEqual(user.subscriptionPlan, 'pro')
})

test('verify-session: session belonging to another user rejected', async () => {
  await dbFake.__db.collection('users').insertOne({ _id: new ObjectId(jwtFake.USER_A_ID), email: 'a@example.com' })
  await dbFake.__db.collection('users').insertOne({ _id: new ObjectId(jwtFake.USER_B_ID), email: 'b@example.com' })
  jwtFake.__setToken('tok-user-a')
  stripeFake.__seedSession({
    id: 'cs_other',
    payment_status: 'paid',
    status: 'complete',
    amount_total: 1900,
    currency: 'usd',
    metadata: { userId: jwtFake.USER_B_ID },
    customer: 'cus_2',
    subscription: null,
  })
  const res = await verifySession.POST(
    req('http://localhost:3000/api/payments/verify-session', { body: { sessionId: 'cs_other' } }),
  )
  assert.notStrictEqual(res.status, 200, 'another user session was accepted')
  const caller = await dbFake.__db.collection('users').findOne({ _id: new ObjectId(jwtFake.USER_A_ID) })
  assert.notStrictEqual(caller.subscriptionPlan, 'pro')
})

test('verify-session: replayed session rejected', async () => {
  await dbFake.__db.collection('users').insertOne({ _id: new ObjectId(jwtFake.USER_A_ID), email: 'a@example.com' })
  jwtFake.__setToken('tok-user-a')
  stripeFake.__seedSession({
    id: 'cs_replay',
    payment_status: 'paid',
    status: 'complete',
    amount_total: 1900,
    currency: 'usd',
    metadata: { userId: jwtFake.USER_A_ID },
    customer: 'cus_1',
    subscription: null,
  })
  const first = await verifySession.POST(
    req('http://localhost:3000/api/payments/verify-session', { body: { sessionId: 'cs_replay' } }),
  )
  assert.strictEqual(first.status, 200)
  const second = await verifySession.POST(
    req('http://localhost:3000/api/payments/verify-session', { body: { sessionId: 'cs_replay' } }),
  )
  assert.notStrictEqual(second.status, 200, 'replayed session was accepted a second time')
})

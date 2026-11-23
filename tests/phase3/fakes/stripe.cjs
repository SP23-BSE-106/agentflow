/**
 * Stripe stand-in used ONLY by the Phase 3 tests (tests/phase3).
 *
 * webhooks.constructEvent performs the REAL Stripe signature check
 * (HMAC-SHA256 over "<timestamp>.<payload>", compared against the v1 value
 * in the stripe-signature header), so the test exercises the handler's
 * fail-closed behaviour rather than a fake that always passes.
 * checkout.sessions.create/retrieve are recorded/seeded by the tests.
 */
'use strict'

const crypto = require('crypto')

let createdSessions = []
let sessionRegistry = new Map()
let counter = 0

function parseSignatureHeader(header) {
  const parts = {}
  for (const segment of String(header || '').split(',')) {
    const [key, value] = segment.split('=')
    if (key && value) parts[key.trim()] = value.trim()
  }
  return parts
}

function constructEvent(payload, signatureHeader, secret) {
  if (!secret) throw new Error('No webhook secret configured')
  if (!signatureHeader) throw new Error('No stripe-signature header')
  const { t, v1 } = parseSignatureHeader(signatureHeader)
  if (!t || !v1) throw new Error('Invalid stripe-signature header')
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  const actualBuffer = Buffer.from(v1, 'utf8')
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new Error('Invalid webhook signature')
  }
  return JSON.parse(payload)
}

function signPayload(payload, secret) {
  const t = String(Math.floor(Date.now() / 1000))
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')
  return `t=${t},v1=${v1}`
}

const fakeStripe = {
  webhooks: { constructEvent },
  checkout: {
    sessions: {
      async create(params) {
        counter += 1
        const session = { id: `cs_test_${counter}`, url: 'https://checkout.stripe.test/session' }
        createdSessions.push({ params, session })
        return session
      },
      async retrieve(sessionId) {
        if (!sessionRegistry.has(sessionId)) {
          throw new Error(`No such checkout session: '${sessionId}'`)
        }
        return sessionRegistry.get(sessionId)
      },
    },
  },
}

function getStripe() {
  return fakeStripe
}

module.exports = {
  getStripe,
  __signPayload: signPayload,
  __createdSessions: () => createdSessions,
  __seedSession: (session) => sessionRegistry.set(session.id, session),
  __reset: () => {
    createdSessions = []
    sessionRegistry = new Map()
    counter = 0
  },
}

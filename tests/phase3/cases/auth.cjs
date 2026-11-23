/**
 * Auth token contract tests (P3-2).
 *
 * Fixed behaviour under test (P2-4, owned by Lane B):
 * - Reset and verification tokens are stored hashed, never in plain text,
 *   and are single-use: a second use of the same token fails.
 *
 * The tests never assume a field name: they scan the stored record for the
 * plain-text token the user was emailed, and they exercise reuse through
 * the real handlers.
 *
 * On the base copy the tokens are stored in plain text (passwordResetToken,
 * verificationToken) and a verification link can be used twice, creating a
 * duplicate user.
 */
'use strict'

const { test, req, readJson, assert } = require('../harness.cjs')
const { ObjectId } = require('mongodb')
const dbFake = require('../fakes/db.cjs')
const mailerFake = require('../fakes/mailer.cjs')

const forgot = require('@/app/api/auth/forgot-password/handler')
const reset = require('@/app/api/auth/reset-password/handler')
const signup = require('@/app/api/auth/signup/handler')
const verifyEmail = require('@/app/api/auth/verify-email/handler')

function extractToken(mail, label) {
  const text = `${mail.text || ''}\n${mail.html || ''}`
  const match = text.match(/token=([A-Za-z0-9]+)/)
  assert.ok(match, `no token found in ${label} mail: ${text.slice(0, 200)}`)
  return match[1]
}

function storedRecordContainsPlaintext(record, token) {
  return JSON.stringify(record).includes(token)
}

test('auth: reset token is stored hashed and is single-use', async () => {
  const db = dbFake.__db
  await db.collection('users').insertOne({
    _id: new ObjectId(),
    email: 'reset@example.com',
    passwordHash: 'old-hash',
  })
  const forgotRes = await forgot.POST(
    req('http://localhost:3000/api/auth/forgot-password', { body: { email: 'reset@example.com' } }),
  )
  assert.strictEqual(forgotRes.status, 200, JSON.stringify(await readJson(forgotRes)))
  const mail = mailerFake.__lastTo('reset@example.com')
  assert.ok(mail, 'no reset mail was sent')
  const token = extractToken(mail, 'reset')

  const stored = await db.collection('users').findOne({ email: 'reset@example.com' })
  assert.ok(
    !storedRecordContainsPlaintext(stored, token),
    'reset token is stored in plain text on the user record',
  )

  const first = await reset.POST(
    req('http://localhost:3000/api/auth/reset-password', {
      body: { token, password: 'NewPass1!' },
    }),
  )
  assert.strictEqual(first.status, 200, JSON.stringify(await readJson(first)))
  const afterReset = await db.collection('users').findOne({ email: 'reset@example.com' })
  assert.notStrictEqual(afterReset.passwordHash, 'old-hash')

  const second = await reset.POST(
    req('http://localhost:3000/api/auth/reset-password', {
      body: { token, password: 'OtherPass1!' },
    }),
  )
  assert.strictEqual(second.status, 400, 'reused reset token was accepted')
})

test('auth: verification token is stored hashed and is single-use', async () => {
  const db = dbFake.__db
  const signupRes = await signup.POST(
    req('http://localhost:3000/api/auth/signup', {
      body: { email: 'verify@example.com', password: 'Strong1!', fullName: 'Verify Me' },
    }),
  )
  assert.strictEqual(signupRes.status, 200, JSON.stringify(await readJson(signupRes)))
  const mail = mailerFake.__lastTo('verify@example.com')
  assert.ok(mail, 'no verification mail was sent')
  const token = extractToken(mail, 'verification')

  const pending = await db.collection('email_verifications').findOne({ email: 'verify@example.com' })
  assert.ok(pending, 'no pending signup record')
  assert.ok(
    !storedRecordContainsPlaintext(pending, token),
    'verification token is stored in plain text on the pending record',
  )

  const first = await verifyEmail.GET(
    req(`http://localhost:3000/api/auth/verify-email?token=${token}`, { method: 'GET' }),
  )
  assert.ok(first.status === 302 || first.status === 307, `verify answered ${first.status}`)
  assert.ok(
    String(first.headers.get('Location') || '').includes('/login?verified=1'),
    `verify did not redirect to login: ${first.headers.get('Location')}`,
  )
  const user = await db.collection('users').findOne({ email: 'verify@example.com' })
  assert.ok(user, 'verified user was not created')

  const second = await verifyEmail.GET(
    req(`http://localhost:3000/api/auth/verify-email?token=${token}`, { method: 'GET' }),
  )
  assert.strictEqual(second.status, 400, 'reused verification token was accepted')
  const users = await db.collection('users').find({ email: 'verify@example.com' }).toArray()
  assert.strictEqual(users.length, 1, 'second verify created a duplicate user')
})

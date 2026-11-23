/**
 * Tiny sequential harness for the Phase 3 tests (tests/phase3).
 * Same style as the repo's existing suites: plain Node, no framework.
 * Every case runs against a freshly reset fake DB and freshly reset fakes.
 */
'use strict'

const assert = require('node:assert')

const dbFake = require('./fakes/db.cjs')
const stripeFake = require('./fakes/stripe.cjs')
const jwtFake = require('./fakes/jwt.cjs')
const mailerFake = require('./fakes/mailer.cjs')
const llmFake = require('./fakes/llm.cjs')
const embeddingsFake = require('./fakes/embeddings.cjs')

const cases = []
let beforeEachFn = null

function test(name, fn) {
  cases.push({ name, fn })
}

function beforeEach(fn) {
  beforeEachFn = fn
}

function resetAll() {
  dbFake.__reset()
  stripeFake.__reset()
  jwtFake.__reset()
  mailerFake.__reset()
  llmFake.__reset()
  embeddingsFake.__reset()
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_phase3'
  delete process.env.STRIPE_SECRET_KEY
  // Checkout refuses without DOMAIN (contract P2-3): the return URL cannot
  // be built from localhost. The tests run against a fixed test origin.
  process.env.DOMAIN = 'https://app.test'
}

/** Build a platform Request the way a Next route handler receives one. */
function req(url, options = {}) {
  const { method = 'POST', body, headers = {} } = options
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function readJson(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { __raw: text }
  }
}

async function run() {
  let passed = 0
  let failed = 0
  const failures = []
  for (const { name, fn } of cases) {
    resetAll()
    if (beforeEachFn) await beforeEachFn()
    try {
      await fn()
      passed += 1
      console.log(`PASS ${name}`)
    } catch (error) {
      failed += 1
      failures.push({ name, error })
      console.log(`FAIL ${name}`)
      console.log(`     ${String(error && error.message ? error.message : error)}`)
    }
  }
  console.log(`\n${passed}/${passed + failed} passed`)
  if (failed > 0) {
    console.log('Failures:')
    for (const { name, error } of failures) {
      console.log(`- ${name}: ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n  ') : error}`)
    }
    process.exitCode = 1
  }
  return { passed, failed }
}

module.exports = { test, beforeEach, run, req, readJson, assert }

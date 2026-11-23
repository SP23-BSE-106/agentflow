/**
 * LLM stand-in used ONLY by the Phase 3 tests (tests/phase3).
 * Records every completion call and answers with a canned result, so cases
 * can assert that a node really called the model and what it was given.
 * Set the canned text with __setText; set __setOk(false) to simulate
 * "no provider answered".
 */
'use strict'

let calls = []
let cannedText = 'TEST-LLM-ANSWER'
let cannedOk = true

async function chatCompletion(options) {
  calls.push(options)
  if (!cannedOk) {
    return {
      ok: false,
      text: '',
      model: null,
      provider: null,
      failures: [{ provider: 'test-provider', message: 'API key is not configured.' }],
    }
  }
  return { ok: true, text: cannedText, model: 'test-model', provider: 'test-provider' }
}

function inferenceEndpoints() {
  return [{ url: 'https://test-provider.local/v1/chat/completions', key: 'test-key', model: 'test-model', name: 'Test Provider' }]
}

function __calls() {
  return calls
}

function __setText(text) {
  cannedText = text
}

function __setOk(ok) {
  cannedOk = ok
}

function __reset() {
  calls = []
  cannedText = 'TEST-LLM-ANSWER'
  cannedOk = true
}

module.exports = { chatCompletion, inferenceEndpoints, __calls, __setText, __setOk, __reset }

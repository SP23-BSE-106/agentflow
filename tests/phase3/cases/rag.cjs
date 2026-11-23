/**
 * RAG grounding contract tests (P3-2).
 *
 * Fixed behaviour under test (P1-4, owned by Lane A/B):
 * - Hits below the similarity threshold are excluded from retrieval.
 * - An empty knowledge base refuses instead of answering from general
 *   knowledge, and so does a knowledge base whose best hit is below the
 *   threshold.
 * - A non-numeric topK defaults to 3.
 *
 * The real searchChunks runs here against the in-memory fake DB (exact
 * cosine path, since no Atlas index exists in the fake), with fixed
 * 384-dimension vectors, so similarities are exact: a chunk on the query
 * vector scores 1.0, an orthogonal chunk scores 0.0.
 *
 * On the base copy searchChunks has no threshold, topK "three" yields zero
 * hits, and chat answers from general knowledge on an empty base.
 */
'use strict'

const { test, req, readJson, assert } = require('../harness.cjs')
const dbFake = require('../fakes/db.cjs')
const jwtFake = require('../fakes/jwt.cjs')
const llmFake = require('../fakes/llm.cjs')
const embeddingsFake = require('../fakes/embeddings.cjs')

const vectorStore = require('@/lib/rag/vectorStore')
const chat = require('@/app/api/rag/chat/handler')

async function seedChunk(text, vector, documentId = 'doc-1') {
  await dbFake.__db.collection('rag_chunks').insertOne({
    userId: jwtFake.USER_A_ID,
    documentId,
    text,
    chunkIndex: 0,
    embedding: vector,
  })
}

function isRefusal(res, body) {
  if (res.status >= 400) return true
  if (body.grounded === false) return true
  const answer = typeof body.answer === 'string' ? body.answer : ''
  return /no documents|upload.*document|knowledge base is empty|nothing.*retrieved|no relevant/i.test(answer)
}

test('rag: hits below the similarity threshold are excluded', async () => {
  const e0 = embeddingsFake.__basisVector(0)
  const e1 = embeddingsFake.__basisVector(1)
  await seedChunk('The exact matching chunk.', e0)
  await seedChunk('A completely unrelated chunk.', e1)
  const { hits } = await vectorStore.searchChunks({
    userId: jwtFake.USER_A_ID,
    queryVector: e0,
    topK: 10,
  })
  assert.strictEqual(hits.length, 1, `expected 1 hit, got ${hits.length}`)
  assert.ok(Math.abs(hits[0].similarity - 1) < 1e-9, `hit similarity ${hits[0].similarity}`)
})

test('rag: non-numeric topK defaults to 3', async () => {
  const e0 = embeddingsFake.__basisVector(0)
  for (let i = 0; i < 5; i++) {
    await seedChunk(`Matching chunk ${i}.`, e0, `doc-${i}`)
  }
  const { hits } = await vectorStore.searchChunks({
    userId: jwtFake.USER_A_ID,
    queryVector: e0,
    topK: 'three',
  })
  assert.strictEqual(hits.length, 3, `expected 3 hits, got ${hits.length}`)
})

test('rag: empty knowledge base refuses instead of answering generally', async () => {
  jwtFake.__setToken('tok-user-a')
  const res = await chat.POST(
    req('http://localhost:3000/api/rag/chat', { body: { question: 'What is the refund policy?' } }),
  )
  const body = await readJson(res)
  assert.ok(isRefusal(res, body), `empty KB answered generally: ${res.status} ${JSON.stringify(body)}`)
})

test('rag: only below-threshold hits refuses instead of answering generally', async () => {
  jwtFake.__setToken('tok-user-a')
  await seedChunk('A completely unrelated chunk.', embeddingsFake.__basisVector(1))
  const res = await chat.POST(
    req('http://localhost:3000/api/rag/chat', { body: { question: 'What is the refund policy?' } }),
  )
  const body = await readJson(res)
  assert.ok(isRefusal(res, body), `below-threshold KB answered generally: ${res.status} ${JSON.stringify(body)}`)
})

test('rag: grounded question answers from the retrieved chunk', async () => {
  jwtFake.__setToken('tok-user-a')
  await seedChunk('The refund window is seven days.', embeddingsFake.__basisVector(0))
  const res = await chat.POST(
    req('http://localhost:3000/api/rag/chat', { body: { question: 'What is the refund window?' } }),
  )
  const body = await readJson(res)
  assert.strictEqual(res.status, 200, JSON.stringify(body))
  assert.strictEqual(body.sources.length, 1)
  assert.ok(body.sources[0].similarity > 0.9, `source similarity ${body.sources[0].similarity}`)
  assert.strictEqual(body.answer, 'TEST-LLM-ANSWER')
  const calls = llmFake.__calls()
  assert.strictEqual(calls.length, 1)
  assert.ok(
    calls[0].system.includes('seven days'),
    'the retrieved chunk was not passed to the model',
  )
})

// Ported from fix/rag-chat-greetings @ 3990830 (no-auth repo): the only
// adaptation is jwtFake.__setToken('tok-user-a') before each chat call,
// matching the existing auth tests in this file.
test('rag: greeting answers conversationally on an empty knowledge base', async () => {
  jwtFake.__setToken('tok-user-a')
  const res = await chat.POST(
    req('http://localhost:3000/api/rag/chat', { body: { question: 'Hello' } }),
  )
  const body = await readJson(res)
  assert.strictEqual(res.status, 200, JSON.stringify(body))
  assert.strictEqual(body.answer, 'TEST-LLM-ANSWER')
  assert.strictEqual(body.grounded, false)
  assert.deepStrictEqual(body.sources, [])
  const calls = llmFake.__calls()
  assert.strictEqual(calls.length, 1, `expected 1 LLM call, got ${calls.length}`)
  assert.ok(!calls[0].system.includes('KNOWLEDGE BASE CONTEXT'), 'greeting took the grounded path')
})

test('rag: greeting answers conversationally when documents exist', async () => {
  jwtFake.__setToken('tok-user-a')
  await seedChunk('A completely unrelated chunk.', embeddingsFake.__basisVector(1))
  const res = await chat.POST(
    req('http://localhost:3000/api/rag/chat', { body: { question: 'How are you?' } }),
  )
  const body = await readJson(res)
  assert.strictEqual(res.status, 200, JSON.stringify(body))
  assert.strictEqual(body.answer, 'TEST-LLM-ANSWER')
  assert.strictEqual(body.grounded, false)
  assert.deepStrictEqual(body.sources, [])
})

test('rag: greeting plus a real question still goes through retrieval', async () => {
  jwtFake.__setToken('tok-user-a')
  await seedChunk('The refund window is seven days.', embeddingsFake.__basisVector(0))
  const res = await chat.POST(
    req('http://localhost:3000/api/rag/chat', { body: { question: 'Hello, what is the refund window?' } }),
  )
  const body = await readJson(res)
  assert.strictEqual(res.status, 200, JSON.stringify(body))
  assert.strictEqual(body.sources.length, 1, `expected 1 grounded source, got ${body.sources.length}`)
  assert.strictEqual(body.answer, 'TEST-LLM-ANSWER')
  const calls = llmFake.__calls()
  assert.strictEqual(calls.length, 1)
  assert.ok(
    calls[0].system.includes('seven days'),
    'greeting-prefixed question did not retrieve the chunk',
  )
})

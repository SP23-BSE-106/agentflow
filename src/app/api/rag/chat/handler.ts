import { NextRequest, NextResponse } from 'next/server'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { getDb } from '@/lib/mongo/mongo'
import { generateEmbedding, getEmbeddingModelState, warmUpEmbeddingModel, embeddingModelNotReadyBody, EMBEDDING_MODEL_RETRY_AFTER_SECONDS } from '@/lib/rag/embeddings'
import { searchChunks } from '@/lib/rag/vectorStore'
import {
  filterGroundedHits,
  NO_DOCUMENTS_MESSAGE,
  NO_RELEVANT_DOCUMENTS_MESSAGE,
  parseTopK,
  SIMILARITY_THRESHOLD,
} from '@/lib/rag/grounding'
import { isSmallTalk, SMALL_TALK_SYSTEM_PROMPT } from '@/lib/rag/smallTalk'
import { chatCompletion } from '@/lib/llm'
import { MAX_QUESTION_CHARS, isTooLong, lengthError } from '@/lib/inputLimits'
import { errorResponse } from '@/lib/api/errors'
import { getClientIp, rateLimit } from '@/lib/rateLimit'
import { GUEST_LOGIN_REQUIRED } from '@/lib/auth/session'

/**
 * POST /api/rag/chat
 *
 * RAG-augmented chat endpoint:
 * 1. Retrieves relevant document chunks from the user's knowledge base
 *    (local embedding + Atlas vector index, exact-cosine fallback)
 * 2. Sends the user question + retrieved context to the LLM
 * 3. Returns an intelligent, grounded answer
 *
 * Grounding rules (P1-4): only chunks at or above SIMILARITY_THRESHOLD
 * count. An empty knowledge base, or documents that do not contain an
 * answer, produce a plain refusal — never a general-knowledge answer to a
 * grounded question. A retrieval failure is a 502, not a silent fallback
 * to ungrounded text.
 */
export async function POST(req: NextRequest) {
  // Rate limit (Lane A3, D1 remainder): 30/min per client IP — chat
  // embeds the question and calls an LLM, so it is not a cheap read.
  const chatRl = await rateLimit(`rag:chat:${getClientIp(req)}`, { windowMs: 60_000, max: 30 })
  if (!chatRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: chatRl.retryAfterMs }, { status: 429 })
  }
  try {
    const token = await getSessionTokenFromCookies()
    if (!token) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

    let payload
    try {
      payload = await verifyJwtSession(token)
    } catch {
      return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })
    }
    const userId = payload.sub

    const body = await req.json().catch(() => ({}))
    const { question } = body
    const topK = parseTopK(body.topK, 3)

    if (!question || !question.trim()) {
      return NextResponse.json({ error: 'Question is required' }, { status: 400 })
    }
    if (isTooLong(question, MAX_QUESTION_CHARS)) {
      const err = lengthError('question', MAX_QUESTION_CHARS)
      return NextResponse.json({ error: err.error }, { status: err.status })
    }

    // ── Small talk: greetings and everyday chat get a direct reply ─────
    // A greeting is not a grounded question — there is nothing to retrieve
    // for it, so it must not hit the "no documents" / "no relevant
    // documents" refusals below. Only whole-message small talk takes this
    // path (see isSmallTalk); anything with real content still goes
    // through retrieval, so factual questions can never dodge grounding
    // by starting with a greeting.
    // (Ported from fix/rag-chat-greetings @ 3990830 in the no-auth repo;
    // adapted only for the session user: userId is payload.sub here, not
    // LOCAL_OWNER_ID.)
    if (isSmallTalk(question)) {
      const completion = await chatCompletion({ system: SMALL_TALK_SYSTEM_PROMPT, prompt: question })
      const answer = completion.ok ? completion.text : 'Hello! How can I help you today?'
      return NextResponse.json({
        question,
        answer,
        grounded: false,
        model: completion.model,
        provider: completion.provider,
        sources: [],
        debugInfo: { userId, chunksFound: 0, groundedFound: 0, similarityThreshold: SIMILARITY_THRESHOLD, embeddingError: null },
      })
    }

    const db = await getDb()
    const chunkCount = await db.collection('rag_chunks').countDocuments({ userId })

    // ── Empty knowledge base: refuse before any embedding or LLM call ───
    if (chunkCount === 0) {
      return NextResponse.json({
        question,
        answer: NO_DOCUMENTS_MESSAGE,
        grounded: false,
        model: null,
        provider: null,
        sources: [],
        debugInfo: { userId, chunksFound: 0, groundedFound: 0, similarityThreshold: SIMILARITY_THRESHOLD, embeddingError: null },
      })
    }

    // H12: honest retryable 503 while the embedding model is still
    // downloading on a fresh environment, instead of a 500 from the
    // retrieval catch below.
    {
      const model = getEmbeddingModelState()
      if (model.state !== 'ready') {
        if (model.state === 'cold' || model.state === 'failed') warmUpEmbeddingModel()
        return NextResponse.json(embeddingModelNotReadyBody(), {
          status: 503,
          headers: { 'Retry-After': String(EMBEDDING_MODEL_RETRY_AFTER_SECONDS) },
        })
      }
    }

    // ── Step 1: RAG Retrieval ──────────────────────────────────────────
    let ragContext = ''
    let ragSources: { text: string; similarity: number; documentId: string }[] = []
    let engine: string = 'exact-cosine'
    let retrievedCount = 0

    try {
      const queryVector = await generateEmbedding(question)
      const outcome = await searchChunks({ userId, queryVector, topK })
      engine = outcome.engine
      retrievedCount = outcome.hits.length
      const grounded = filterGroundedHits(outcome.hits)

      // ── Documents exist but none of them answers this question ───────
      if (grounded.length === 0) {
        return NextResponse.json({
          question,
          answer: NO_RELEVANT_DOCUMENTS_MESSAGE,
          grounded: false,
          model: null,
          provider: null,
          sources: [],
          debugInfo: { userId, chunksFound: retrievedCount, groundedFound: 0, similarityThreshold: SIMILARITY_THRESHOLD, engine, embeddingError: null },
        })
      }

      console.log(`[rag/chat] User ${userId} retrieved ${grounded.length} grounded chunk(s) via ${engine}`)

      ragSources = grounded.map((hit) => ({
        text: hit.text,
        documentId: hit.documentId,
        similarity: hit.similarity,
      }))
      ragContext = ragSources
        .map((s, i) => `[Document Chunk ${i + 1}]:\n${s.text}`)
        .join('\n\n')
    } catch (ragError) {
      const message = ragError instanceof Error ? ragError.message : String(ragError)
      console.warn('[rag/chat] RAG retrieval failed:', ragError)
      return NextResponse.json(
        {
          error: `Retrieval failed: ${message}`,
          debugInfo: { userId, chunksFound: 0, groundedFound: 0, similarityThreshold: SIMILARITY_THRESHOLD, embeddingError: message },
        },
        { status: 502 },
      )
    }

    // ── Step 2: LLM Generation with grounded context only ──────────────
    const systemPrompt = `You are a helpful AI assistant. Answer the user's question using ONLY the following retrieved knowledge base documents as context. If the answer is not found in the context, say so clearly. Be concise but natural, human-friendly, and conversational.

--- KNOWLEDGE BASE CONTEXT ---
${ragContext}
--- END CONTEXT ---`

    const completion = await chatCompletion({
      system: systemPrompt,
      prompt: question,
    })

    const answer = completion.ok
      ? completion.text
      : `[LLM unavailable — showing matched knowledge base content]\n\n${ragContext}`

    if (!completion.ok) {
      console.warn('[rag/chat] no inference provider accepted the request', completion.failures)
    }

    return NextResponse.json({
      question,
      answer,
      grounded: true,
      model: completion.model,
      provider: completion.provider,
      sources: ragSources.map((s) => ({
        text: s.text.slice(0, 200) + (s.text.length > 200 ? '...' : ''),
        similarity: s.similarity,
        documentId: s.documentId,
      })),
      debugInfo: { userId, chunksFound: retrievedCount, groundedFound: ragSources.length, similarityThreshold: SIMILARITY_THRESHOLD, engine, embeddingError: null },
    })
  } catch (error: unknown) {
    console.error('RAG Chat Error:', error)
    // Never echo the raw error: it can name server config or provider
    // internals. errorResponse maps a down database to 503, the rest to a
    // generic 500.
    return errorResponse(error, 'RAG chat failed. Try again.')
  }
}

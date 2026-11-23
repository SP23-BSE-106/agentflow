import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDb } from '@/lib/mongo/mongo'
import { getSessionTokenFromCookies, verifyJwtSession } from '@/lib/auth/jwt'
import { chunkText } from '@/lib/rag/chunker'
import { generateEmbeddings, EMBEDDING_MODEL, EMBEDDING_DIMENSION, getEmbeddingModelState, warmUpEmbeddingModel, embeddingModelNotReadyBody, EMBEDDING_MODEL_RETRY_AFTER_SECONDS } from '@/lib/rag/embeddings'
import { kickOffIndexBuild } from '@/lib/rag/vectorStore'
import { errorResponse } from '@/lib/api/errors'
import { getClientIp, rateLimit } from '@/lib/rateLimit'
import { GUEST_LOGIN_REQUIRED } from '@/lib/auth/session'

/** Largest file (or pasted text) accepted for upload. Larger files are a 413. */
export const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024 // 20 MB
/** Largest chunk count accepted for one document. More chunks are a 413. */
export const MAX_UPLOAD_CHUNKS = 500
/**
 * File types the uploader accepts — exactly the types the upload forms
 * offer (`.txt,.pdf,.md` on the files page, plus `.json,.csv` on the
 * create page). Anything else is a 415: before this check any file was
 * decoded as UTF-8 text, so a binary upload was ingested as garbage
 * chunks instead of being refused.
 */
export const ALLOWED_UPLOAD_EXTENSIONS = ['.txt', '.md', '.pdf', '.json', '.csv'] as const
/** Embeddings run in bounded-concurrency batches, not one chunk at a time. */
const EMBED_BATCH_CONCURRENCY = 4

function uploadExtension(fileName: string): string {
  const lower = fileName.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot === -1 ? '' : lower.slice(dot)
}

export async function POST(req: NextRequest) {
  // Rate limit (Lane A3, D1 remainder): 10/min per client IP. An upload
  // embeds every chunk locally, so it is the most expensive RAG write —
  // and the 413/415 refusals below still count, so a flood of rejected
  // uploads cannot spin the embedder either.
  const uploadRl = await rateLimit(`rag:upload:${getClientIp(req)}`, { windowMs: 60_000, max: 10 })
  if (!uploadRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: uploadRl.retryAfterMs }, { status: 429 })
  }
  let stage = 'request'
  // Cleanup targets for the outer catch: anything inserted before a failure
  // is deleted, so no failure path — including a timeout mid-embedding —
  // leaves a document row behind. The document row itself is only inserted
  // after embedding succeeds, so a function killed mid-embedding leaves at
  // most orphan chunks, never a listed document with zero chunks.
  let documentId: string | null = null
  let documentObjectId: ObjectId | null = null
  let chunksInserted = false
  try {
    stage = 'authentication'
    const token = await getSessionTokenFromCookies()
    if (!token) return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })

    let payload
    try {
      payload = await verifyJwtSession(token)
    } catch {
      return NextResponse.json({ error: GUEST_LOGIN_REQUIRED }, { status: 401 })
    }
    const userId = payload.sub

    stage = 'file parsing'
    // H8: a body truncated above the framework's clone limit (or a malformed
    // multipart body) makes `formData()` throw, which used to surface as a
    // misleading 500. If the client declared more than the handler's own
    // 20 MB cap, the honest answer is 413; a malformed body is a 400.
    let formData: FormData
    try {
      formData = await req.formData()
    } catch (formErr) {
      const declared = Number(req.headers.get('content-length') || 0)
      if (declared > MAX_UPLOAD_FILE_BYTES) {
        return NextResponse.json(
          { error: `File is too large. Maximum upload size is ${MAX_UPLOAD_FILE_BYTES / (1024 * 1024)} MB.` },
          { status: 413 },
        )
      }
      console.error('[RAG Upload] FormData parse failed:', formErr)
      return NextResponse.json(
        { error: 'Could not parse the upload. Send the file as multipart form data.' },
        { status: 400 },
      )
    }
    // Both fields can arrive as a File or as plain text, depending on how
    // the caller built the form: `file` is always a File from the upload
    // forms, but `textContent` has been sent both ways. The old code cast
    // `textContent` to `string` unconditionally, so a File there crashed
    // the byte-length check with a TypeError and the upload answered a
    // 500 instead of the 413 chunk cap. Normalise both to text first.
    const fileField = formData.get('file')
    const file: File | null =
      fileField instanceof File ? fileField : null
    const fileAsText: string | null =
      typeof fileField === 'string' ? fileField : null
    const textField = formData.get('textContent')
    let textContent: string | null =
      typeof textField === 'string' ? textField : null
    let textContentFileName: string | null = null
    if (textField instanceof File) {
      textContentFileName = textField.name
      if (textField.size > MAX_UPLOAD_FILE_BYTES) {
        return NextResponse.json(
          { error: `Text content is too large. Maximum upload size is ${MAX_UPLOAD_FILE_BYTES / (1024 * 1024)} MB.` },
          { status: 413 },
        )
      }
      textContent = await textField.text()
    }
    const fileName = formData.get('name') as string || file?.name || textContentFileName || 'Untitled_Document.txt'

    // File-type allow-list (see ALLOWED_UPLOAD_EXTENSIONS above).
    const uploadName = file?.name ?? textContentFileName ?? fileName
    const extension = uploadExtension(uploadName)
    if ((file || textField instanceof File) && !(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) {
      return NextResponse.json(
        { error: `Only ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')} files can be uploaded.` },
        { status: 415 },
      )
    }

    let extractedText = ''
    const isPdf = !!file && (file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf')

    if (file) {
      // Upload cap: reject oversized files before reading them further.
      if (file.size > MAX_UPLOAD_FILE_BYTES) {
        return NextResponse.json(
          { error: `File is too large. Maximum upload size is ${MAX_UPLOAD_FILE_BYTES / (1024 * 1024)} MB.` },
          { status: 413 },
        )
      }
      const buffer = Buffer.from(await file.arrayBuffer())

      if (isPdf) {
        // pdf-parse v2.x is class-based: new PDFParse({ data }).getText()
        // The old v1 call style `pdfParse(buffer)` throws, so we must NEVER fall
        // back to decoding raw PDF bytes as UTF-8 — that produced "xref/trailer"
        // garbage chunks instead of readable policy text.
        try {
          const { PDFParse } = await import('pdf-parse')
          const parser = new PDFParse({ data: buffer })
          try {
            const result = await parser.getText()
            extractedText = result.text || ''
          } finally {
            await parser.destroy().catch(() => {})
          }
        } catch (pdfErr) {
          console.error('[RAG Upload] PDF text extraction failed:', pdfErr)
          // Only the file's own problem is reported. An earlier version
          // appended an internal diagnostics dump (which PDF packages and
          // versions are installed on this server) to the client-facing
          // error — that is server internals, not something the uploader
          // can act on, so it stays in the server log only.
          const reason =
            pdfErr instanceof Error ? pdfErr.message : String(pdfErr)
          return NextResponse.json(
            {
              error: `Could not extract text from this PDF. It may be corrupted, password-protected, or scanned (image-only) PDF with no text layer. Please upload a text-based PDF, .txt, or .md file. (${reason})`,
            },
            { status: 422 }
          )
        }
      } else {
        extractedText = new TextDecoder('utf-8').decode(buffer)
      }
    } else if (fileAsText) {
      // `file` sent as a plain-text field rather than a File part.
      if (Buffer.byteLength(fileAsText, 'utf-8') > MAX_UPLOAD_FILE_BYTES) {
        return NextResponse.json(
          { error: `Text content is too large. Maximum upload size is ${MAX_UPLOAD_FILE_BYTES / (1024 * 1024)} MB.` },
          { status: 413 },
        )
      }
      extractedText = fileAsText
    } else if (textContent) {
      if (Buffer.byteLength(textContent, 'utf-8') > MAX_UPLOAD_FILE_BYTES) {
        return NextResponse.json(
          { error: `Text content is too large. Maximum upload size is ${MAX_UPLOAD_FILE_BYTES / (1024 * 1024)} MB.` },
          { status: 413 },
        )
      }
      extractedText = textContent
    } else {
      return NextResponse.json({ error: 'No file or text content provided' }, { status: 400 })
    }

    if (!extractedText.trim()) {
      return NextResponse.json({ error: 'Extracted document content is empty' }, { status: 400 })
    }

    // Safety net: never ingest raw PDF binary as if it were document text.
    if (isPdf && (extractedText.startsWith('%PDF-') || extractedText.includes('startxref'))) {
      console.error('[RAG Upload] Extraction returned raw PDF structure data — rejecting upload.')
      return NextResponse.json(
        { error: 'PDF text extraction produced raw PDF data instead of readable text. Upload rejected.' },
        { status: 422 }
      )
    }

    console.log('[RAG Upload] Starting upload process for:', fileName)
    console.log('[RAG Upload] Extracted text length:', extractedText.length)

    stage = 'database connection'
    const db = await getDb()
    const documents = db.collection('rag_documents')
    const chunksColl = db.collection('rag_chunks')

    // Chunk BEFORE inserting anything, so both caps are enforced before a
    // document row exists: too many chunks is a 413 with nothing to roll back.
    const textChunks = chunkText(extractedText, { chunkSize: 500, overlap: 50 })

    if (textChunks.length === 0) {
      return NextResponse.json({ error: 'No text chunks generated from document' }, { status: 400 })
    }
    if (textChunks.length > MAX_UPLOAD_CHUNKS) {
      return NextResponse.json(
        { error: `Document produces ${textChunks.length} chunks, over the maximum of ${MAX_UPLOAD_CHUNKS}. Split it into smaller documents.` },
        { status: 413 },
      )
    }

    // H12: if the embedding model is still downloading (fresh environment),
    // answer an honest retryable 503 — never a 500, never a fake success.
    // A cold/failed state re-kicks the load, so the client's retry finds a
    // model that is ready or closer to ready.
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

    // The document id is minted up front; the row itself is inserted only
    // after embedding and chunk storage succeed.
    documentObjectId = new ObjectId()
    documentId = documentObjectId.toString()

    // 1. Generate embeddings in bounded-concurrency batches, then store them.
    // generateEmbeddings() throws instead of falling back to a fake vector,
    // so a failure here must abort the upload rather than persist garbage
    // vectors — and with no document row inserted yet, there is nothing to
    // roll back.
    console.log(`[RAG Upload] Embedding ${textChunks.length} chunks with ${EMBEDDING_MODEL}...`)
    const embedStartedAt = Date.now()

    const chunkRecords: Array<Record<string, unknown>> = []
    stage = 'embedding generation'
    try {
      const vectors = await generateEmbeddings(textChunks, EMBED_BATCH_CONCURRENCY)
      for (const [index, vector] of vectors.entries()) {
        if (vector.length !== EMBEDDING_DIMENSION) {
          throw new Error(
            `Expected ${EMBEDDING_DIMENSION}-dim embedding, received ${vector.length}`
          )
        }
        chunkRecords.push({
          documentId,
          userId,
          chunkIndex: index,
          text: textChunks[index],
          embedding: vector,
          embeddingModel: EMBEDDING_MODEL,
          createdAt: new Date(),
        })
      }
    } catch (err) {
      console.error('[RAG Upload] Embedding failed:', err)
      // Never echo the raw error; errorResponse maps a down database to 503.
      return errorResponse(err, 'Embedding failed. Try again.')
    }

    if (chunkRecords.length === 0) {
      return NextResponse.json({ error: 'Failed to generate embeddings for any chunks' }, { status: 500 })
    }

    console.log(
      `[RAG Upload] Embedded ${chunkRecords.length} chunks in ${Date.now() - embedStartedAt}ms`
    )

    // 2. Store chunks first, then the document row — in that order, so a
    // failure between them leaves orphan chunks (invisible, unlisted) rather
    // than a listed document with zero chunks.
    stage = 'chunk insert'
    try {
      await chunksColl.insertMany(chunkRecords)
      chunksInserted = true
    } catch (dbErr: unknown) {
      console.error('[RAG Upload] MongoDB insert error:', dbErr)
      // Never echo the raw error; errorResponse maps a down database to 503.
      return errorResponse(dbErr)
    }

    // 3. Save Document Record with safe data types
    const now = new Date()
    const docRecord = {
      _id: documentObjectId,
      userId: String(userId), // Ensure string type
      name: String(fileName), // Ensure string type
      source: {
        type: file ? 'file' : 'text',
        filename: String(fileName),
      },
      preview: String(extractedText.slice(0, 200)) + '...',
      createdAt: now,
    }

    console.log('[RAG Upload] Inserting document record...')
    stage = 'document insert'
    try {
      await documents.insertOne(docRecord)
    } catch (dbErr: unknown) {
      console.error('[RAG Upload] Document insert error:', dbErr)
      // Roll the chunks back: without the document row they would be orphans.
      await chunksColl.deleteMany({ documentId, userId }).catch(() => {})
      // Never echo the raw error; errorResponse maps a down database to 503.
      return errorResponse(dbErr)
    }
    console.log('[RAG Upload] Document created with ID:', documentId)

    // Make sure the Atlas vector index exists for this collection. Never block
    // the response on the build (it takes ~35s); retrieval falls back to an
    // exact cosine scan until the index is queryable.
    kickOffIndexBuild()

    return NextResponse.json({
      success: true,
      documentId,
      fileName,
      totalChunks: textChunks.length,
      embeddingModel: EMBEDDING_MODEL,
      message: 'Document ingested, chunked, and embedded.',
    })
  } catch (error: unknown) {
    console.error('[RAG Upload] Error:', error)
    // A database failure must answer 503 with a plain-words message, never
    // the raw error (which names server config, e.g. `MONGODB_URI is not
    // set`). Other failures keep the stage context — it says what the
    // upload was doing, not how the server is configured.
    // Roll back on EVERY failure path: delete any chunks stored for this
    // document and the document row itself, so a failed upload leaves
    // nothing listed and nothing orphaned behind it.
    if (documentId) {
      try {
        const db = await getDb()
        if (chunksInserted) {
          await db.collection('rag_chunks').deleteMany({ documentId }).catch(() => {})
        }
        if (documentObjectId) {
          await db.collection('rag_documents').deleteOne({ _id: documentObjectId }).catch(() => {})
        }
      } catch {
        // Cleanup is best-effort; the original error is what the caller gets.
      }
    }
    return errorResponse(error, `Upload failed during ${stage}. Try again.`)
  }
}

export async function GET(req: NextRequest) {
  // Rate limit (Lane A3, D1 remainder): listing documents is a read, 60/min.
  const listRl = await rateLimit(`rag:upload:list:${getClientIp(req)}`, { windowMs: 60_000, max: 60 })
  if (!listRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: listRl.retryAfterMs }, { status: 429 })
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

    const db = await getDb()
    const docs = await db
      .collection('rag_documents')
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray()

    const formattedDocs = await Promise.all(
      docs.map(async (doc) => {
        const documentId = doc._id.toString()
        const chunkCount = await db
          .collection('rag_chunks')
          .countDocuments({ documentId })

        // "Fresh" means written by the model currently in use. Chunks embedded
        // by an older model still have a vector but will not match the Atlas
        // index, which is exactly what Rebuild Embeddings is for — so the table
        // reports it instead of calling every document Active.
        const embeddedCount = await db
          .collection('rag_chunks')
          .countDocuments({ documentId, embeddingModel: EMBEDDING_MODEL })

        return {
          id: documentId,
          name: doc.name,
          preview: doc.preview || '',
          chunks: chunkCount,
          embedded: embeddedCount,
          createdAt: doc.createdAt,
        }
      })
    )

    return NextResponse.json({ documents: formattedDocs })
  } catch (error: unknown) {
    console.error('[RAG Upload] List error:', error)
    return errorResponse(error)
  }
}

/**
 * DELETE /api/rag/upload
 * Remove a single document (JSON body: { documentId }) or the whole knowledge
 * base (JSON body: { all: true }) together with its chunks.
 * Query params ?documentId=... / ?all=1 are also accepted.
 * Only affects the authenticated user's data.
 */
export async function DELETE(req: NextRequest) {
  // Rate limit (Lane A3, D1 remainder): deleting documents — including
  // wiping the whole knowledge base — is a write, 30/min.
  const delRl = await rateLimit(`rag:upload:clear:${getClientIp(req)}`, { windowMs: 60_000, max: 30 })
  if (!delRl.ok) {
    return NextResponse.json({ error: 'Too many requests', retryAfterMs: delRl.retryAfterMs }, { status: 429 })
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
    const userId = String(payload.sub)

    // Accept both a JSON body ({ documentId } or { all: true }) and query
    // params (?documentId=... or ?all=1).
    const body = await req.json().catch(() => ({} as Record<string, unknown>))
    const { searchParams } = new URL(req.url)
    const documentId =
      (typeof body.documentId === 'string' && body.documentId) ||
      searchParams.get('documentId') ||
      null
    const all = body.all === true || searchParams.get('all') === '1'

    const db = await getDb()
    const documents = db.collection('rag_documents')
    const chunksColl = db.collection('rag_chunks')

    if (all) {
      const chunkResult = await chunksColl.deleteMany({ userId })
      const docResult = await documents.deleteMany({ userId })
      console.log(`[RAG Upload] Cleared knowledge base for user ${userId}: ${docResult.deletedCount} docs, ${chunkResult.deletedCount} chunks`)
      return NextResponse.json({
        success: true,
        deletedDocuments: docResult.deletedCount,
        deletedChunks: chunkResult.deletedCount,
      })
    }

    if (!documentId || !ObjectId.isValid(documentId)) {
      return NextResponse.json({ error: 'Valid documentId is required (or pass all: true)' }, { status: 400 })
    }

    // Chunks reference documents by their string id; scope by userId so users
    // can only delete their own documents.
    const chunkResult = await chunksColl.deleteMany({ documentId, userId })
    const docResult = await documents.deleteOne({ _id: new ObjectId(documentId), userId })

    if (docResult.deletedCount === 0) {
      // Roll back orphaned chunk deletions is unnecessary: chunks only exist alongside a doc.
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    console.log(`[RAG Upload] Deleted document ${documentId} (${chunkResult.deletedCount} chunks)`)
    return NextResponse.json({
      success: true,
      deletedChunks: chunkResult.deletedCount,
    })
  } catch (error) {
    console.error('[RAG Upload] Delete error:', error)
    return errorResponse(error)
  }
}

/**
 * H12 — warm the local embedding model when the server starts.
 *
 * The ~90 MB Xenova/all-MiniLM-L6-v2 model used to download lazily on the
 * first RAG request, and that in-process download was terminated in this
 * environment, so the first upload always 500'd until the cache happened
 * to be seeded. Warming here starts the download as soon as the server
 * boots, outside any request: by the time a first-time user uploads, the
 * model is usually ready, and if it is still downloading the RAG handlers
 * answer an honest retryable 503 (see `embeddingModelNotReadyBody`) whose
 * retry then succeeds — never a fake success, never a 500.
 *
 * Skipped during `next build`: the build's server instance would pay for
 * a ~90 MB download and the cache is not part of the build output.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  const { warmUpEmbeddingModel } = await import('@/lib/rag/embeddings')
  warmUpEmbeddingModel()
}

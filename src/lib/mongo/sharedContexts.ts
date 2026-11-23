// TypeScript types for the shared_contexts collection.
// Shared execution-context memory available to agents during one workflow run.
// Agents can read the original request, approved intermediate results, write
// task results, add notes/decisions, and read retrieved RAG sources.

export type SharedContextDecision = {
  agentId: string
  decision: string
  reason?: string
  createdAt: Date
}

export type SharedContext = {
  _id?: string
  userId: string
  workflowRunId: string
  /** The original user request that started the run. */
  originalInput?: string
  variables: Record<string, unknown>
  /** References to retrieved RAG document ids. */
  documents: string[]
  intermediateResults: Record<string, unknown>
  decisions: SharedContextDecision[]
  finalResult?: unknown
  /** Optimistic-locking version, incremented on each write. */
  version: number
  createdAt: Date
  updatedAt: Date
}

/**
 * Shared types for team runs (multi-agent conversation loop, lane A).
 *
 * A team run is several of the user's agents working one job together,
 * talking to each other while they work. The team is the agents named by
 * the workflow's nodes (resolved by `resolveNodes` in the orchestrator —
 * same ownership rule: an agent that does not exist or is not the user's
 * is an honest error, never a silent fallback). There is no separate
 * "team" object.
 */

export type TeamAgent = {
  /** Agent document id. */
  id: string
  name: string
  role?: string
  /** System prompt injected before the agent's task instructions. */
  systemPrompt?: string
  /** Model pin for this agent's turns, when set. */
  model?: string
  /** Per-turn token cap for this agent (default 1200, same as an LLM node). */
  maxTokenBudget?: number
}

/** One entry in the run's shared transcript (the blackboard). */
export type TeamTranscriptEntry = {
  fromAgentId: string
  fromName: string
  toAgentId?: string
  toName?: string
  kind: 'final' | 'message'
  text: string
  requiresResponse: boolean
  /** Persisted agent_messages id, when the entry was stored. */
  messageId?: string
}

export type TeamRunStatus =
  | 'completed'
  | 'failed'
  | 'cap-exceeded'
  | 'budget-exceeded'
  | 'cancelled'

export type TeamRunOptions = {
  userId: string
  workflowId: string
  workflowRunId: string
  /** The job the team is working on (the orchestrator's original input). */
  task: string
  /** The team, lead first. Every member must belong to `userId`. */
  team: TeamAgent[]
  /**
   * Hard turn cap for the run. Default 10 exchanges. Never unbounded:
   * a caller that passes 0 or a negative number gets the default.
   */
  maxExchanges?: number
  /**
   * Per-run time budget in ms, checked before every turn. Defaults to
   * 300_000 (5 minutes, the same default as the execution budget).
   */
  timeBudgetMs?: number
  /** Shared-context summary text included in every turn's prompt. */
  sharedContextText?: string
}

export type TeamRunResult = {
  status: TeamRunStatus
  /** The run's final answer, when one was produced. */
  finalText: string
  /** LLM turns taken (each agent turn = one exchange). */
  exchanges: number
  /** Messages persisted to `agent_messages` during the run. */
  messagesCreated: number
  /** Plain-words note explaining a non-completed ending (cap, budget,
   *  provider failure, unknown teammate). Never a fake completion. */
  note?: string
  /** The whole conversation, in order — visible to the entire team. */
  transcript: TeamTranscriptEntry[]
  /** Provider failure summaries, when the run ended on an LLM failure. */
  failureDetail?: string
}

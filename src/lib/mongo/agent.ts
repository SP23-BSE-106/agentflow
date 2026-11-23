import type { WorkflowGraph } from './workflow'

export type AgentRole =
  | 'supervisor'
  | 'planner'
  | 'researcher'
  | 'writer'
  | 'reviewer'
  | 'critic'
  | 'fact_checker'
  | 'analyst'
  | 'custom'

export type AgentCapability = {
  id: string
  name: string
  description: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

export type Agent = {
  _id: string
  userId: string
  name: string
  description?: string
  /** Original plain-English prompt used to generate the workflow */
  prompt?: string
  /** Generated workflow graph (nodes + edges) */
  workflow?: WorkflowGraph
  /** Role the agent plays in multi-agent workflows. Defaults to general-purpose. */
  role?: AgentRole
  /** System prompt injected before the agent's task instructions. */
  systemPrompt?: string
  /** LLM provider the agent will use at runtime. */
  provider?: 'openai' | 'anthropic' | 'groq' | 'gemini' | 'cohere' | string
  /** Specific model the agent will use at runtime. */
  model?: string
  /** The LLM provider the agent will use at runtime (user-supplied, legacy). */
  llmProvider?: 'openai' | 'anthropic' | 'groq' | 'gemini' | 'cohere' | string
  /** AES-256-GCM encrypted API key for the chosen provider */
  userApiKey?: string
  /** Per-workflow webhook secret (C-6): 64-hex, minted at creation.
   *  Production webhook URLs must carry it as ?token=. Returned once in
   *  the create response; never in list/get responses. */
  webhookSecret?: string
  /** Structured capabilities this agent can perform. */
  capabilities: AgentCapability[]
  /** Whether the agent may retrieve from the RAG knowledge base. */
  ragAccess: boolean
  /** Tool ids the agent is allowed to call. */
  availableTools: string[]
  /** Maximum token budget for a single agent turn. */
  maxTokenBudget?: number
  /** Whether human approval is required before this agent acts on sensitive steps. */
  humanApprovalRequired: boolean
  /** Whether the agent may delegate work to other agents. */
  canDelegate: boolean
  /** Maximum number of retries for a failed task. */
  maxRetryCount: number
  /** Agent to fall back to when this agent's task fails with a retryable
   *  error and a fallback is configured (P1-3). Unset means retry in place. */
  fallbackAgentId?: string
  /** The workflow graph as published by the last deploy. /api/execute serves
   *  this snapshot — not the draft — so editing the draft after deploying
   *  cannot change what the public endpoint runs. */
  deployedWorkflow?: WorkflowGraph
  /** When the deployed snapshot was published. */
  deployedAt?: Date
  /** Workflow status */
  status?: 'draft' | 'active'
  /** Schedule that fires this agent: `POST /api/triggers/check` reads
   *  `schedule.cron` (and `schedule.timezone`) and runs the agent when the
   *  cron is due. Set through the agents API/UI (H23); `null` clears it.
   *  `lastFiredAt` is stamped by the trigger checker, never by a client. */
  schedule?: { cron: string; timezone?: string; lastFiredAt?: Date } | null
  /** Monotonically increasing workflow snapshot version. */
  workflowVersion?: number
  /** User-defined tags for categorisation */
  tags?: string[]
  createdAt: Date
  updatedAt?: Date
}

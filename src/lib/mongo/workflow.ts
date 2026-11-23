// TypeScript types for the workflow graph stored inside an Agent document.

export type NodeType =
  | 'trigger'
  | 'llm'
  | 'rag'
  | 'api'
  | 'condition'
  | 'output'
  | 'tool'
  | 'memory'
  // Multi-agent team node (Lane B): ask a teammate a question mid-run.
  // The behaviour lives in nodeRunner.ts (runAskNode); the registry
  // description is src/lib/nodes/descriptions/team.ts.
  | 'ask'
  // n8n core node types (item executor; see src/lib/workflow/itemExecutor.ts).
  // Descriptions for these live in the versioned node registry (Lane E);
  // the item executor dispatches on the type string and records the version
  // the node was created with.
  | 'set'
  | 'code'
  | 'if'
  | 'switch'
  | 'merge'
  | 'splitInBatches'
  | 'wait'
  | 'executeWorkflow'
  | 'errorTrigger'
  | 'formTrigger'
  | 'respondToWebhook'
  // Canonical HTTP node name (registry/builder: descriptions/core.ts).
  | 'httpRequest'
  // Alias of 'httpRequest', kept for workflows saved under the old name
  // (the union used to list only 'http'; the item executor and the string
  // dispatcher both run it). Never emit 'http' for new nodes.
  | 'http'
  | 'webhook'
  | 'schedule'
  | 'manual'

export type WorkflowNode = {
  id: string
  name: string
  type: NodeType
  description: string
  /** Optional extra config (e.g. system prompt, API URL, condition expression) */
  config?: Record<string, unknown>
  /** Canvas position, so a saved workflow reopens where the user left it. */
  position?: { x: number; y: number }
  /**
   * Registry version the node was created with (from `defaultVersion`).
   * The item executor resolves executors by (type, version); absent means 1.
   */
  version?: number
}

export type WorkflowEdge = {
  id: string
  source: string // node id
  target: string // node id
  label?: string
}

export type WorkflowGraph = {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  /**
   * Pinned output per node id. When a node has pin data the item executor
   * uses it instead of executing the node.
   */
  pinData?: Record<string, import('@/lib/nodes/items').WorkflowItem[]>
  /** Workflow-scoped variables, resolved into `$vars` and `{{ }}` templates. */
  variables?: Record<string, unknown>
  /** Agent id of the workflow to run when a node error is unhandled. */
  errorWorkflowId?: string
}

import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from '@/lib/mongo/workflow'
import { validateWorkflowGraph } from './condition'

/**
 * AI-generate token budget (H11 / GAP-3).
 *
 * The old generate call asked for `maxTokens: 1200`. On the shared
 * OpenRouter key the affordable budget decayed across the QA sweep
 * (1042 → 375 → 28 tokens); a 1200-token request 402-retries to
 * ~325 tokens and the workflow JSON truncates mid-string, so every
 * generate fell back to the template. The compact schema below
 * (short ids, no per-node name/description, edges as [source, target]
 * pairs, llm systemPrompt capped at 12 words) puts a 4-node workflow
 * at roughly 90–140 output tokens, so a 256-token budget fits a whole
 * workflow inside the ~300 tokens that were affordable at sweep end —
 * with room for a condition branch or a longer systemPrompt. The
 * 402-retry in llm.ts still applies (one retry at affordable − 50,
 * floored at 64); below ~150 affordable tokens even the compact JSON
 * cannot fit and the honest template fallback is the correct answer.
 */
export const GENERATE_MAX_TOKENS = 256

/**
 * Compact generate system prompt. Two deliberate shrinkages vs the old
 * prompt: (1) the worked example is one short inline shape instead of a
 * verbose multi-line JSON block, so the request itself costs fewer input
 * tokens; (2) nodes carry no name/description — the handler fills those
 * in from the node type — and edges are [source, target] pairs.
 *
 * The DOCUMENT RULE is the GAP-3 fix: a document question MUST get a
 * `rag` node. It is enforced twice — here in the prompt, and in
 * `validateGeneratedWorkflow` below, so a workflow without a rag node
 * for a document question never ships as source 'ai'.
 */
export const GENERATE_SYSTEM_PROMPT = `You are an AI workflow generator. Output ONLY raw JSON, no markdown, no explanation.
Shape: {"workflow":{"nodes":[{"id":"t","type":"trigger"},{"id":"r","type":"rag","config":{"topK":3}},{"id":"l","type":"llm","config":{"systemPrompt":"Answer only from retrieved context."}},{"id":"o","type":"output"}],"edges":[["t","r"],["r","l"],["l","o"]]}}
Node types: trigger, llm, rag, api, condition, output. Node ids are short (t, l, r, o, c1). Omit name and description on every node. Keep each llm systemPrompt under 12 words. A condition node MUST have config.condition {"field":"state","operator":"contains","value":"..."} or config.expression 'state == "yes"'; compare only the state text or its length, no parentheses, no function calls. An api node MUST have a real config.url; if no real URL is known, leave the api node out. Prefer trigger → llm → output; add a condition only when the task genuinely branches.
DOCUMENT RULE: if the user asks about documents, files, uploads, knowledge, FAQs, manuals or policies — answering from their own documents — you MUST include exactly one rag node between trigger and llm. A workflow without it is rejected.`

/** Keywords that mark a prompt as a document question (same vocabulary the
 *  template fallback scores on, in src/lib/workflow/templates.ts). */
const DOCUMENT_QUESTION_KEYWORDS = [
  'document',
  'documents',
  'uploaded',
  'upload',
  'pdf',
  'file',
  'files',
  'knowledge',
  'faq',
  'manual',
  'policy',
  'policies',
]

export function isDocumentQuestion(prompt: string): boolean {
  const lower = prompt.toLowerCase()
  return DOCUMENT_QUESTION_KEYWORDS.some((keyword) => lower.includes(keyword))
}

const GENERATE_NODE_TYPES = ['trigger', 'llm', 'rag', 'api', 'condition', 'output'] as const

function nodeDisplayName(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Expand the compact workflow JSON the model returns into the full
 * WorkflowGraph shape the rest of the app expects (named nodes, edge
 * objects with ids). The pre-compact shape is accepted too — nodes with
 * name/description and edges as {id, source, target} pass through —
 * so a model that answers in the old verbose format still works.
 * Returns { error } instead of throwing; the generate handler turns any
 * error into the honest template fallback with the reason as warning.
 */
export function expandCompactWorkflow(
  parsed: unknown,
): { workflow: WorkflowGraph } | { error: string } {
  const root = isRecord(parsed) ? (isRecord(parsed.workflow) ? parsed.workflow : parsed) : null
  if (!root) return { error: 'invalid workflow payload' }
  if (!Array.isArray(root.nodes) || root.nodes.length === 0) {
    return { error: 'AI workflow has no nodes' }
  }
  if (!Array.isArray(root.edges)) return { error: 'AI workflow has no edges' }

  const nodes: WorkflowNode[] = []
  const ids = new Set<string>()
  for (const raw of root.nodes as unknown[]) {
    if (!isRecord(raw)) return { error: 'AI workflow node must be an object' }
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : ''
    if (!id) return { error: 'AI workflow node is missing an id' }
    if (ids.has(id)) return { error: `AI workflow has a duplicate node id "${id}"` }
    ids.add(id)
    const type = typeof raw.type === 'string' ? raw.type.trim() : ''
    if (!(GENERATE_NODE_TYPES as readonly string[]).includes(type)) {
      return { error: `AI workflow node "${id}" has unknown type "${type}"` }
    }
    const config = raw.config === undefined ? {} : raw.config
    if (!isRecord(config)) return { error: `AI workflow node "${id}" has a config that is not an object` }
    nodes.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : nodeDisplayName(type),
      type: type as WorkflowNode['type'],
      description: typeof raw.description === 'string' ? raw.description : '',
      config,
    })
  }

  const edges: WorkflowEdge[] = []
  for (let i = 0; i < (root.edges as unknown[]).length; i++) {
    const raw = (root.edges as unknown[])[i]
    let source = ''
    let target = ''
    let label: string | undefined
    let edgeId: string | undefined
    if (Array.isArray(raw) && raw.length === 2) {
      source = String(raw[0] ?? '')
      target = String(raw[1] ?? '')
    } else if (isRecord(raw)) {
      source = typeof raw.source === 'string' ? raw.source : ''
      target = typeof raw.target === 'string' ? raw.target : ''
      label = typeof raw.label === 'string' ? raw.label : undefined
      edgeId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined
    } else {
      return { error: 'AI workflow edge must be a [source, target] pair or an object' }
    }
    if (!ids.has(source) || !ids.has(target)) {
      return { error: `AI workflow edge "${source}" → "${target}" points at a missing node` }
    }
    edges.push({ id: edgeId ?? `e${i + 1}`, source, target, ...(label ? { label } : {}) })
  }

  if (!nodes.some((node) => node.type === 'trigger')) {
    return { error: 'AI workflow has no trigger node' }
  }
  if (!nodes.some((node) => node.type === 'output')) {
    return { error: 'AI workflow has no output node' }
  }
  return {
    workflow: {
      name: typeof root.name === 'string' ? root.name : 'Generated Agent',
      description: typeof root.description === 'string' ? root.description : '',
      nodes,
      edges,
    } as WorkflowGraph,
  }
}

/**
 * Generate-time validation: the shared condition check, plus the GAP-3
 * rag requirement. A document question whose AI workflow has no `rag`
 * node is rejected, so it falls back to the template (which does carry
 * a rag node) instead of shipping as source 'ai' without one.
 */
export function validateGeneratedWorkflow(workflow: WorkflowGraph, prompt: string): string | null {
  const graphError = validateWorkflowGraph(workflow)
  if (graphError) return graphError
  if (isDocumentQuestion(prompt) && !workflow.nodes.some((node) => node.type === 'rag')) {
    return 'AI workflow has no rag node for a document question'
  }
  return null
}

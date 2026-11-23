/**
 * Guest-run validation (Lane C).
 *
 * A visitor with no account can run a workflow they hold in their browser,
 * but only through the same sandboxed string engine logged-in runs use
 * (`executeWorkflow`). That engine only understands six node types, so a
 * guest workflow is allowed exactly those — everything else is refused up
 * front with a plain reason, instead of failing mid-run:
 *
 * - `rag` is allowed, but a guest has no files: the file-search step fails
 *   honestly inside the run with the no-documents message, and the pages
 *   say so plainly next to the record.
 * - Automation nodes (`code`, `http`, `wait`, `executeWorkflow`, …) run
 *   through the item executor, which can execute code, persist waits, and
 *   load other people's saved workflows — none of that is open to guests.
 * - `tool` / `memory` are not supported by the engine at all.
 *
 * The graph is also re-shaped here (unknown fields stripped, sizes capped)
 * so the executor only ever sees a clean, bounded graph. No persistence,
 * no server session, no user data: the caller runs it as user id 'guest'.
 */

import { validateWorkflowGraph } from '@/lib/workflow/condition'
import type { WorkflowGraph } from '@/lib/mongo/workflow'

/** The only node types a guest run may contain. */
export const GUEST_NODE_TYPES = ['trigger', 'llm', 'rag', 'api', 'condition', 'output'] as const

export const MAX_GUEST_NODES = 50
export const MAX_GUEST_EDGES = 100
/** Cap on the whole workflow JSON, so a guest cannot smuggle a huge config in. */
export const MAX_GUEST_WORKFLOW_BYTES = 65_536

const BLOCKED_NODE_REASONS: Record<string, string> = {
  code: 'The Code step runs custom code, which guests cannot use — log in, or remove that step.',
  http: 'The Web request step can call other services, which guests cannot use — log in, or remove that step.',
  httpRequest: 'The Web request step can call other services, which guests cannot use — log in, or remove that step.',
  webhook: 'The Webhook step waits for an outside call, which guests cannot use — log in, or remove that step.',
  formTrigger: 'The Form step waits for a form to be filled in, which guests cannot use — log in, or remove that step.',
  schedule: 'The Schedule step runs on a timetable, which guests cannot use — log in, or remove that step.',
  wait: 'The Wait step pauses a run until later, which needs a saved run — log in, or remove that step.',
  executeWorkflow: 'The Run another workflow step opens a saved workflow, which guests cannot use — log in, or remove that step.',
  errorTrigger: 'The Error step handles failures of a saved workflow, which guests cannot use — log in, or remove that step.',
  respondToWebhook: 'The Reply to webhook step answers an outside call, which guests cannot use — log in, or remove that step.',
}

function blockedReason(type: string): string {
  if (type === 'tool' || type === 'memory') {
    return `The ${type} step is not supported by the execution engine — remove that step.`
  }
  return (
    BLOCKED_NODE_REASONS[type] ??
    `The ${type} step is an automation step that guests cannot run — log in to run it, or rebuild it with the basic steps (Start, AI, File search, Web call, Choice, Finish).`
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a client-supplied workflow for a guest run. Returns the cleaned
 * graph the executor should run, or a plain-language error for the caller.
 */
export function validateGuestWorkflow(workflow: unknown): { graph: WorkflowGraph } | { error: string } {
  if (!isRecord(workflow)) return { error: 'Workflow must be an object with steps and connections.' }
  if (workflow.pinData !== undefined) {
    return { error: 'Saved step results cannot be sent with a guest workflow — remove them and run the steps for real.' }
  }
  if (workflow.variables !== undefined) {
    return { error: 'Workflow variables cannot be sent with a guest workflow — remove them.' }
  }
  if (workflow.errorWorkflowId !== undefined) {
    return { error: 'A fallback workflow cannot be sent with a guest workflow — remove it.' }
  }
  let size = 0
  try {
    size = JSON.stringify(workflow).length
  } catch {
    return { error: 'Workflow could not be read.' }
  }
  if (size > MAX_GUEST_WORKFLOW_BYTES) {
    return { error: 'Workflow is too large — keep it under 64 KB.' }
  }
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    return { error: 'Workflow has no steps — add at least one step first.' }
  }
  if (workflow.nodes.length > MAX_GUEST_NODES) {
    return { error: `Workflow has too many steps — guests can run up to ${MAX_GUEST_NODES} steps.` }
  }
  const edges = workflow.edges === undefined ? [] : workflow.edges
  if (!Array.isArray(edges)) return { error: 'Workflow connections must be a list.' }
  if (edges.length > MAX_GUEST_EDGES) {
    return { error: `Workflow has too many connections — guests can run up to ${MAX_GUEST_EDGES} connections.` }
  }

  const ids = new Set<string>()
  const nodes: WorkflowGraph['nodes'] = []
  for (const raw of workflow.nodes as unknown[]) {
    if (!isRecord(raw)) return { error: 'Each workflow step must be an object.' }
    if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 100) {
      return { error: 'Each workflow step needs a short id.' }
    }
    if (ids.has(raw.id)) return { error: `Two steps share the id "${raw.id}" — give each step its own id.` }
    ids.add(raw.id)
    if (typeof raw.type !== 'string' || !raw.type.trim()) {
      return { error: `Step "${String(raw.name || raw.id)}" has no type.` }
    }
    if (!(GUEST_NODE_TYPES as readonly string[]).includes(raw.type)) {
      return { error: blockedReason(raw.type) }
    }
    if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 200)) {
      return { error: 'Step names must be short text (up to 200 characters).' }
    }
    if (raw.config !== undefined && !isRecord(raw.config)) {
      return { error: `Step "${String(raw.name || raw.id)}" has settings that are not an object.` }
    }
    nodes.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Untitled',
      type: raw.type as WorkflowGraph['nodes'][number]['type'],
      description: typeof raw.description === 'string' ? raw.description.slice(0, 500) : '',
      config: isRecord(raw.config) ? (raw.config as Record<string, unknown>) : {},
      position:
        isRecord(raw.position) && typeof raw.position.x === 'number' && typeof raw.position.y === 'number'
          ? { x: raw.position.x, y: raw.position.y }
          : undefined,
    })
  }

  const cleanEdges: WorkflowGraph['edges'] = []
  for (const raw of edges as unknown[]) {
    if (!isRecord(raw)) return { error: 'Each workflow connection must be an object.' }
    if (typeof raw.source !== 'string' || !ids.has(raw.source)) {
      return { error: 'A connection starts at a step that does not exist.' }
    }
    if (typeof raw.target !== 'string' || !ids.has(raw.target)) {
      return { error: 'A connection ends at a step that does not exist.' }
    }
    if (raw.label !== undefined && (typeof raw.label !== 'string' || raw.label.length > 50)) {
      return { error: 'Connection labels must be short text (up to 50 characters).' }
    }
    cleanEdges.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : `${raw.source}->${raw.target}`,
      source: raw.source,
      target: raw.target,
      label: typeof raw.label === 'string' ? raw.label : undefined,
    })
  }

  const graph: WorkflowGraph = { nodes, edges: cleanEdges }
  // The same condition-grammar check server workflows get: an unsafe
  // Condition step is refused before anything runs.
  const graphError = validateWorkflowGraph(graph)
  if (graphError) return { error: graphError }
  return { graph }
}

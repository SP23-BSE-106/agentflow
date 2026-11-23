/**
 * Shared types for the n8n node executors used by the item executor.
 * Each executor is a small pure-ish function: config + input items in,
 * output items (optionally on named outputs) out. No executor touches
 * MongoDB or the network directly except `http` (SSRF-guarded fetch) and
 * `executeWorkflow` (via the runner seam on the context).
 */

import type { WorkflowItem } from '@/lib/nodes/items'
import type { WorkflowNode } from '@/lib/mongo/workflow'
import { makeScope, type ExpressionScope } from '@/lib/expression/engine'

export type ExecutorContext = {
  userId: string
  workflowId?: string
  workflowName?: string
  vars: Record<string, unknown>
  /** Decrypted credential fields, by credential id. */
  credentials?: Map<string, Record<string, unknown>>
  /** First-item json of every node that has already run, by node name. */
  nodeOutputs: Record<string, { json: Record<string, unknown> }>
  /**
   * Sub-workflow runner seam. The default (wired by the item executor)
   * runs the named workflow's deployed graph for real via `runWorkflow`;
   * tests may supply their own.
   */
  runSubWorkflow?: (workflowId: string, inputItems: WorkflowItem[]) => Promise<WorkflowItem[]>
}

export type ExecutorWait = {
  resumeAt: Date
  resumeKind: 'time' | 'webhook' | 'form'
}

export type ExecutorResult = {
  /** Items on the default ('main') output. */
  items: WorkflowItem[]
  /** Named outputs (e.g. If true/false, Switch cases). Overrides `items` for those names. */
  outputs?: Record<string, WorkflowItem[]>
  /** Split In Batches remainder: the executor re-runs this node with these. */
  loopItems?: WorkflowItem[]
  /** Wait node: pause the run until this resume point. */
  wait?: ExecutorWait
}

export type NodeExecutor = (args: {
  node: WorkflowNode
  config: Record<string, unknown>
  items: WorkflowItem[]
  ctx: ExecutorContext
}) => Promise<ExecutorResult>

function configString(config: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = config[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function configNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const n = Number(config[key])
  return Number.isFinite(n) ? n : fallback
}

export { configString, configNumber }

/**
 * Build the {{ }} expression scope for one item, from the executor
 * context. One function, so every executor sees the same $json / $node /
 * $input / $binary / $workflow / $vars / $now / $today. $today is the start
 * of the day; $binary carries only mimeType/fileName, never bytes. The
 * engine itself lives in src/lib/expression/engine.ts (Lane F).
 */
export function buildItemScope(item: WorkflowItem, items: WorkflowItem[], ctx: ExecutorContext): ExpressionScope {
  const binary: Record<string, unknown> = {}
  if (item.binary) {
    for (const [key, entry] of Object.entries(item.binary)) {
      binary[key] = { mimeType: entry.mimeType, fileName: entry.fileName }
    }
  }
  return makeScope({
    json: item.json,
    node: ctx.nodeOutputs,
    input: { all: items.map((i) => i.json), first: items[0]?.json, last: items[items.length - 1]?.json },
    binary,
    workflow: { id: ctx.workflowId ?? '', name: ctx.workflowName ?? '' },
    vars: ctx.vars,
  })
}

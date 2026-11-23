/**
 * Respond To Webhook — response shaping for webhook-triggered runs.
 *
 * A Respond To Webhook node sits at the end of a workflow started by a
 * webhook and decides what the caller gets back: a status code, a body and
 * headers from its config. When the workflow has no such node, the webhook
 * route returns the run output as JSON instead.
 *
 * The node itself runs inside the item executor (Lane H wires it in); this
 * file only shapes the HTTP response, so the webhook route can use it
 * against the string executor's run output today.
 */

import type { WorkflowGraph } from '@/lib/mongo/workflow'

export type RespondToWebhookConfig = {
  /** HTTP status for the webhook reply. Default 200. */
  statusCode?: number
  /** Reply body. When empty, the run output is used. */
  body?: string
  /** Extra reply headers. */
  headers?: Record<string, string>
}

export type ShapedWebhookResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

function saneStatus(statusCode: unknown): number {
  const n = Number(statusCode)
  if (Number.isInteger(n) && n >= 100 && n <= 599) return n
  return 200
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  try {
    JSON.parse(trimmed)
    return trimmed.startsWith('{') || trimmed.startsWith('[')
  } catch {
    return false
  }
}

/**
 * Shape one reply from a Respond To Webhook node's config. The body is used
 * exactly as configured — no template evaluation happens here (the
 * expression engine lives in Lane F's scope and is not in this tree's run
 * path yet, so `{{ }}` in a body is returned literally; that is documented
 * as a known gap, not silently resolved).
 */
export function shapeRespondResponse(
  config: RespondToWebhookConfig,
  fallbackBody: string,
): ShapedWebhookResponse {
  const body = typeof config.body === 'string' && config.body.length > 0
    ? config.body
    : fallbackBody
  const headers: Record<string, string> = { ...(config.headers || {}) }
  const lowerKeys = Object.keys(headers).map((k) => k.toLowerCase())
  if (!lowerKeys.includes('content-type')) {
    headers['content-type'] = looksLikeJson(body)
      ? 'application/json; charset=utf-8'
      : 'text/plain; charset=utf-8'
  }
  return { status: saneStatus(config.statusCode), headers, body }
}

/** Find the Respond To Webhook node in a workflow graph, if it has one. */
export function findRespondNode(graph: WorkflowGraph | null | undefined): {
  id: string
  name: string
  config: RespondToWebhookConfig
} | null {
  if (!graph || !Array.isArray(graph.nodes)) return null
  const node = graph.nodes.find((n) => (n.type as string) === 'respondToWebhook')
  if (!node) return null
  const config = (node.config || {}) as unknown as RespondToWebhookConfig
  return { id: node.id, name: node.name, config }
}

/**
 * The webhook reply for a run: the Respond To Webhook node's shaped reply
 * when the graph has one, otherwise null (the caller returns the run
 * output as JSON).
 */
export function resolveWebhookResponse(
  graph: WorkflowGraph | null | undefined,
  runOutput: string,
): ShapedWebhookResponse | null {
  const found = findRespondNode(graph)
  if (!found) return null
  return shapeRespondResponse(found.config, runOutput)
}

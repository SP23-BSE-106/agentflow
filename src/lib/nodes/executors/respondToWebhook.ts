/**
 * Respond To Webhook node — shapes the HTTP response of a webhook-started run.
 *
 * Config:
 *   statusCode: number (default 200)
 *   body: unknown — a `{{ }}` template string, or any JSON value
 *   headers: Record<string, string>
 * Items pass through unchanged. The resolved response is attached to each
 * output item as `metadata.webhookResponse`, where the webhook route
 * (Lane G) reads it when the run was started by a webhook; on any other
 * run it is simply carried along and ignored.
 */

import { renderTemplateValue } from '@/lib/expression/engine'
import { buildItemScope } from './context'
import type { NodeExecutor } from './context'

export const executeRespondToWebhookNode: NodeExecutor = async ({ config, items, ctx }) => {
  const statusCode = Number(config.statusCode)
  const resolvedStatus = Number.isFinite(statusCode) && statusCode >= 100 && statusCode < 600 ? statusCode : 200
  const headers =
    config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)
      ? (config.headers as Record<string, string>)
      : {}
  const out = items.map((item) => {
    let body: unknown = config.body
    if (typeof body === 'string' && body.includes('{{')) {
      const scope = buildItemScope(item, items, ctx)
      body = renderTemplateValue(body, scope)
    }
    return {
      ...item,
      metadata: {
        ...(item.metadata ?? {}),
        webhookResponse: { statusCode: resolvedStatus, body: body ?? null, headers },
      },
    }
  })
  return { items: out }
}

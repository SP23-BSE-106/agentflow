/**
 * If node — routes each item to the `true` or `false` output.
 *
 * Config:
 *   expression: string   — e.g. `{{ $json.score }} >= 10`, `$json.active`,
 *                          or `{{ $json.status }} == "ready"`. `{{ }}` wrappers
 *                          are stripped before evaluation; the expression is
 *                          evaluated by the sandboxed engine in
 *                          `src/lib/expression/engine.ts` (no code execution).
 *   condition: string    — alias for `expression`.
 *   field/operator/value — structured form: `{ field: 'score', operator: '>=', value: 10 }`
 *                          where `field` is a `$json` path (leading `json.` optional).
 * Items keep their `pairedItem` lineage on whichever branch they take.
 */

import { evaluateExpression } from '@/lib/expression/engine'
import { buildItemScope } from './context'
import type { NodeExecutor, ExecutorContext } from './context'
import type { WorkflowItem } from '@/lib/nodes/items'

function stripTemplates(expression: string): string {
  return expression.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (_m, inner: string) => `(${inner})`)
}

function evaluateStructured(
  config: Record<string, unknown>,
  item: WorkflowItem,
  ctx: ExecutorContext,
): boolean {
  const field = typeof config.field === 'string' ? config.field.replace(/^json\./, '') : ''
  const operator = typeof config.operator === 'string' ? config.operator : '=='
  const expected = config.value
  const parts = field.split('.').filter(Boolean)
  let actual: unknown = item.json
  for (const part of parts) {
    if (actual === null || actual === undefined || typeof actual !== 'object') {
      actual = undefined
      break
    }
    actual = (actual as Record<string, unknown>)[part]
  }
  void ctx
  switch (operator) {
    case '==':
    case '===':
      return actual === expected
    case '!=':
    case '!==':
      return actual !== expected
    case '>':
      return (actual as number) > (expected as number)
    case '>=':
      return (actual as number) >= (expected as number)
    case '<':
      return (actual as number) < (expected as number)
    case '<=':
      return (actual as number) <= (expected as number)
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected)
    case 'not_contains':
      return typeof actual === 'string' && typeof expected === 'string' && !actual.includes(expected)
    case 'starts_with':
      return typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected)
    case 'ends_with':
      return typeof actual === 'string' && typeof expected === 'string' && actual.endsWith(expected)
    default:
      throw new Error(`If node: unsupported operator "${operator}".`)
  }
}

export const executeIfNode: NodeExecutor = async ({ config, items, ctx }) => {
  const expressionRaw =
    config.expression !== undefined
      ? config.expression
      : config.condition !== undefined
        ? config.condition
        : undefined
  const expression = typeof expressionRaw === 'string' ? expressionRaw : undefined
  const expressionBoolean = typeof expressionRaw === 'boolean' ? expressionRaw : undefined
  const trueItems: WorkflowItem[] = []
  const falseItems: WorkflowItem[] = []
  for (const item of items) {
    let verdict: boolean
    if (expressionBoolean !== undefined) {
      verdict = expressionBoolean
    } else if (expression !== undefined) {
      const scope = buildItemScope(item, items, ctx)
      const result = evaluateExpression(stripTemplates(expression), scope)
      if (!result.ok) throw new Error(`If node expression failed: ${result.error}`)
      verdict = Boolean(result.value)
    } else if (config.field !== undefined) {
      verdict = evaluateStructured(config, item, ctx)
    } else {
      throw new Error('If node needs config.expression (or config.field/operator/value).')
    }
    ;(verdict ? trueItems : falseItems).push(item)
  }
  return { items: trueItems, outputs: { true: trueItems, false: falseItems } }
}

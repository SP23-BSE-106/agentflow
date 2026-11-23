/**
 * Switch node — routes each item to the first matching rule's output.
 *
 * Config:
 *   rules: [{ field?: string, operator?: string, value?: unknown, output?: string }]
 *     `field` is a `$json` path (leading `json.` optional); `operator` is
 *     one of ==, !=, >, >=, <, <=, contains, not_contains, starts_with,
 *     ends_with (default ==). `output` names the output edge; when absent
 *     the output is `output<index>` (output0, output1, ...).
 *   expressionRules: [{ expression: string, output?: string }]
 *     same routing, but each rule is a `{{ }}` / expression string
 *     evaluated by the sandboxed engine in `src/lib/expression/engine.ts`.
 * Items with no matching rule go to the `default` output. Output names
 * are matched to edge labels by the item executor.
 */

import { evaluateExpression } from '@/lib/expression/engine'
import { buildItemScope } from './context'
import type { NodeExecutor } from './context'
import type { WorkflowItem } from '@/lib/nodes/items'

function fieldValue(item: WorkflowItem, field: string): unknown {
  const parts = field.replace(/^json\./, '').split('.').filter(Boolean)
  let current: unknown = item.json
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function compare(actual: unknown, operator: string, expected: unknown): boolean {
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
      throw new Error(`Switch node: unsupported operator "${operator}".`)
  }
}

export const executeSwitchNode: NodeExecutor = async ({ config, items, ctx }) => {
  const outputs: Record<string, WorkflowItem[]> = { default: [] }
  const rules = Array.isArray(config.rules) ? (config.rules as Array<Record<string, unknown>>) : []
  const expressionRules = Array.isArray(config.expressionRules)
    ? (config.expressionRules as Array<Record<string, unknown>>)
    : []
  if (rules.length === 0 && expressionRules.length === 0) {
    throw new Error('Switch node needs config.rules or config.expressionRules.')
  }
  for (const item of items) {
    let target: string | null = null
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]
      const field = typeof rule.field === 'string' ? rule.field : ''
      const operator = typeof rule.operator === 'string' ? rule.operator : '=='
      if (compare(fieldValue(item, field), operator, rule.value)) {
        target = typeof rule.output === 'string' && rule.output ? rule.output : `output${i}`
        break
      }
    }
    if (target === null) {
      for (let i = 0; i < expressionRules.length; i++) {
        const rule = expressionRules[i]
        const expression = typeof rule.expression === 'string' ? rule.expression : ''
        const stripped = expression.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (_m, inner: string) => `(${inner})`)
        const scope = buildItemScope(item, items, ctx)
        const result = evaluateExpression(stripped, scope)
        if (!result.ok) throw new Error(`Switch node expression failed: ${result.error}`)
        if (result.value) {
          target = typeof rule.output === 'string' && rule.output ? rule.output : `output${i}`
          break
        }
      }
    }
    const key = target ?? 'default'
    if (!outputs[key]) outputs[key] = []
    outputs[key].push(item)
  }
  return { items: outputs.default, outputs }
}

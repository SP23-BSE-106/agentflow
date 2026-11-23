/**
 * Set node — sets fields on every item.
 *
 * Config:
 *   assignments: [{ name: string, value: unknown }]   (preferred)
 *   values: Record<string, unknown>                   (shorthand)
 * Values may be `{{ }}` templates; each one is resolved per item against
 * that item's `$json` / `$vars` / `$node` scope (see
 * `src/lib/expression/engine.ts` — no code execution). Each output item keeps its
 * `pairedItem` lineage and binary data.
 */

import { itemFromJson } from '@/lib/nodes/items'
import { renderTemplateValue } from '@/lib/expression/engine'
import { buildItemScope } from './context'
import type { NodeExecutor } from './context'

export const executeSetNode: NodeExecutor = async ({ config, items, ctx }) => {
  const assignments: Array<{ name: string; value: unknown }> = []
  if (Array.isArray(config.assignments)) {
    for (const entry of config.assignments as Array<Record<string, unknown>>) {
      if (typeof entry?.name === 'string' && entry.name) {
        assignments.push({ name: entry.name, value: entry.value })
      }
    }
  }
  if (config.values && typeof config.values === 'object' && !Array.isArray(config.values)) {
    for (const [name, value] of Object.entries(config.values as Record<string, unknown>)) {
      if (!assignments.some((a) => a.name === name)) assignments.push({ name, value })
    }
  }
  if (assignments.length === 0) {
    throw new Error('Set node needs at least one assignment (config.assignments or config.values).')
  }
  const out = items.map((item, index) => {
    const scope = buildItemScope(item, items, ctx)
    const json = { ...item.json }
    for (const assignment of assignments) {
      json[assignment.name] =
        typeof assignment.value === 'string' && assignment.value.includes('{{')
          ? renderTemplateValue(assignment.value, scope)
          : assignment.value
    }
    const next = itemFromJson(json, item.pairedItem ?? index)
    if (item.binary) next.binary = item.binary
    if (item.metadata) next.metadata = item.metadata
    if (item.error) next.error = item.error
    return next
  })
  return { items: out }
}

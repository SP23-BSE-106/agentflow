/**
 * Merge node — combines the items arriving from several upstream branches.
 *
 * Config:
 *   mode: 'append' (default) — concatenate every branch's items, in
 *         upstream-node order; or 'combine' — merge the items at the same
 *         position across branches into one item (shorter branches stop
 *         contributing when they run out).
 * The item executor hands this node its inputs grouped by source node id
 * (see `ExecutorContext` — groups arrive on `ctx.inputGroups`); called
 * directly, it merges the single `items` array it is given.
 */

import { itemFromJson } from '@/lib/nodes/items'
import type { NodeExecutor, ExecutorContext } from './context'

export type MergeExecutorContext = ExecutorContext & {
  inputGroups?: Map<string, import('@/lib/nodes/items').WorkflowItem[]>
}

export const executeMergeNode: NodeExecutor = async ({ config, items, ctx }) => {
  const mode = typeof config.mode === 'string' ? config.mode : 'append'
  const groups = (ctx as MergeExecutorContext).inputGroups
  if (!groups || groups.size === 0) return { items }
  const ordered = [...groups.values()]
  if (mode === 'combine') {
    const max = Math.max(...ordered.map((group) => group.length))
    const out = []
    for (let i = 0; i < max; i++) {
      const json: Record<string, unknown> = {}
      for (const group of ordered) {
        const item = group[i]
        if (item) Object.assign(json, item.json)
      }
      out.push(itemFromJson(json, i))
    }
    return { items: out }
  }
  if (mode !== 'append') {
    throw new Error(`Merge node: unsupported mode "${mode}" (use "append" or "combine").`)
  }
  const out = ordered.flat()
  return { items: out }
}

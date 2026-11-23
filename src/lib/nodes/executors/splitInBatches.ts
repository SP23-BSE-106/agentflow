/**
 * Split In Batches node — hands downstream nodes one batch at a time.
 *
 * Config:
 *   batchSize: number (default 10)
 * Returns the first batch on the main output and the rest as `loopItems`;
 * the item executor re-runs this node with the remainder (bounded to 100
 * passes) until every item has had a turn downstream.
 */

import type { NodeExecutor } from './context'
import { configNumber } from './context'

export const executeSplitInBatchesNode: NodeExecutor = async ({ config, items }) => {
  const batchSize = Math.max(1, Math.floor(configNumber(config, 'batchSize', 10)))
  const batch = items.slice(0, batchSize)
  const rest = items.slice(batchSize)
  return { items: batch, loopItems: rest.length > 0 ? rest : undefined }
}

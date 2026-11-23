/**
 * Resume a run paused at a Wait node — the shared core behind both
 * resume entry points:
 *   - POST /api/executions/[id]/resume (owner-initiated, via the runs
 *     catch-all)
 *   - the triggers/check sweep, for time-based waits whose resume time
 *     has passed.
 *
 * The waiting row is deleted FIRST, so a resume runs once even if the
 * continuation fails. The continuation reuses the paused run's execution
 * id, so workflow_runs keeps one row for the whole run.
 */

import { executeWorkflowItems, type ItemRunResult } from '@/lib/workflow/itemExecutor'
import { deleteWaitingExecution, type WaitingExecution } from '@/lib/execution/waitStore'
import type { WorkflowItem } from '@/lib/nodes/items'

export async function resumeWaitingExecution(
  waiting: WaitingExecution,
  resumeItems?: WorkflowItem[],
): Promise<ItemRunResult> {
  await deleteWaitingExecution(waiting.executionId)
  return executeWorkflowItems(waiting.state.graph, waiting.state.items, {
    userId: waiting.userId,
    workflowId: waiting.workflowId || undefined,
    vars: waiting.state.vars,
    resume: {
      executionId: waiting.executionId,
      nodeId: waiting.nodeId,
      items: waiting.state.items,
      nodeResults: waiting.state.nodeResults,
      resumeItems,
    },
  })
}

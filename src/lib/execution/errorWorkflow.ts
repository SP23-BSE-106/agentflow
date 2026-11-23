/**
 * Error-workflow dispatch (n8n §6 of the feature map).
 *
 * When a node error is unhandled (the node stopped the run), the item
 * executor runs the workflow named by the graph's `errorWorkflowId`
 * (an agent id) with one item:
 *   { json: { error, workflow: { id, name }, execution: { id } } }
 * The error workflow's entry node is an Error Trigger. Dispatch is
 * best-effort: if the error workflow itself cannot run, the failure is
 * reported to the caller — the original run's error is never replaced by
 * the dispatch failure.
 */

import { runWorkflow } from '@/lib/workflow/runWorkflow'
import { getDb } from '@/lib/mongo/mongo'

export type ErrorWorkflowDispatch = {
  userId: string
  errorWorkflowId: string
  error: string
  workflowId?: string
  workflowName?: string
  executionId?: string
}

export async function dispatchErrorWorkflow(dispatch: ErrorWorkflowDispatch): Promise<{
  ok: boolean
  message: string
}> {
  const db = await getDb()
  const input = JSON.stringify({
    error: dispatch.error,
    workflow: { id: dispatch.workflowId ?? '', name: dispatch.workflowName ?? '' },
    execution: { id: dispatch.executionId ?? '' },
  })
  try {
    const result = await runWorkflow({
      db,
      userId: dispatch.userId,
      agentId: dispatch.errorWorkflowId,
      input,
    })
    if (!result.ok) {
      return { ok: false, message: result.error ?? 'Error workflow run failed.' }
    }
    return { ok: true, message: 'Error workflow ran.' }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Error workflow could not run.',
    }
  }
}

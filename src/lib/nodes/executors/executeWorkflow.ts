/**
 * Execute Workflow node — runs another workflow as a sub-workflow.
 *
 * Config:
 *   workflowId: string — the agent id whose deployed graph runs.
 * The sub-workflow runs through the runner seam on the executor context
 * (the item executor wires it to the real `runWorkflow`); its output
 * becomes one item per run, and every output item carries
 * `metadata.subExecution = { workflowId }` linking parent and child.
 * With no runner available the node fails honestly instead of pretending
 * the sub-workflow ran.
 */

import type { NodeExecutor } from './context'

export const executeExecuteWorkflowNode: NodeExecutor = async ({ config, items, ctx }) => {
  const workflowId = typeof config.workflowId === 'string' ? config.workflowId.trim() : ''
  if (!workflowId) {
    throw new Error('Execute Workflow node needs config.workflowId (the agent id to run).')
  }
  if (!ctx.runSubWorkflow) {
    throw new Error('Execute Workflow node: no sub-workflow runner is available in this run.')
  }
  const subItems = await ctx.runSubWorkflow(workflowId, items)
  const out = subItems.map((item) => ({
    ...item,
    metadata: { ...(item.metadata ?? {}), subExecution: { workflowId } },
  }))
  return { items: out }
}

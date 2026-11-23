/**
 * Node registry aggregate (Lane E).
 *
 * Imports ONLY Lane E's descriptions and registers them, so importing this
 * module is enough for the builder to list every core node type. Other
 * lanes expose their descriptions through their own register modules and
 * the coordinator wires them in at merge time — do not import other lanes'
 * files here.
 */

import { registerNodeAlias, registerNodeType } from './registry';
import {
  webhookDescription,
  scheduleDescription,
  manualTriggerDescription,
  errorTriggerDescription,
  formTriggerDescription,
  executeWorkflowTriggerDescription,
} from './descriptions/triggers';
import { codeDescription, setDescription, httpRequestDescription } from './descriptions/core';
import {
  ifDescription,
  switchDescription,
  mergeDescription,
  splitInBatchesDescription,
  waitDescription,
  respondToWebhookDescription,
  executeWorkflowDescription,
} from './descriptions/flow';
// Multi-agent team nodes (merge-time wiring — see the module doc comment).
import { askDescription } from './descriptions/team';

export {
  registerNodeAlias,
  registerNodeType,
  getNodeType,
  defaultVersion,
  listNodeTypes,
} from './registry';
export type { NodeDescription, NodeProperty, NodePropertyType } from './registry';

export const CORE_NODE_DESCRIPTIONS = [
  webhookDescription,
  scheduleDescription,
  manualTriggerDescription,
  errorTriggerDescription,
  formTriggerDescription,
  executeWorkflowTriggerDescription,
  codeDescription,
  setDescription,
  httpRequestDescription,
  ifDescription,
  switchDescription,
  mergeDescription,
  splitInBatchesDescription,
  waitDescription,
  respondToWebhookDescription,
  executeWorkflowDescription,
  askDescription,
] as const;

for (const desc of CORE_NODE_DESCRIPTIONS) {
  registerNodeType(desc);
}

// Canonical HTTP name is 'httpRequest'; 'http' is the alias saved workflows
// carry (see src/lib/mongo/workflow.ts). Registering the alias here makes
// getNodeType('http') resolve, so runWorkflow routes an 'http' graph to the
// item executor instead of the string executor, which cannot run it.
registerNodeAlias('http', 'httpRequest');

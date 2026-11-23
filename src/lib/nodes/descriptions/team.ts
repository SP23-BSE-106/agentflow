/**
 * Team node descriptions (multi-agent team, merge-time wiring).
 *
 * Lane B built the 'ask' behaviour in nodeRunner.ts (runAskNode) but its
 * frozen scope excluded the registry, the NodeType union, the item
 * executor and the orchestrator call-site, so this file + the wiring in
 * src/lib/nodes/index.ts, src/lib/mongo/workflow.ts,
 * src/lib/workflow/itemExecutor.ts and
 * src/lib/orchestration/orchestrator.ts land here at merge time.
 *
 * The properties below match exactly what runAskNode reads from the node
 * config: `to` (also `toAgent` / `teammate`), `text` (also `question`,
 * defaults to the incoming text), `requiresResponse` (default true).
 */
import type { NodeDescription } from '../registry';

export const askDescription: NodeDescription = {
  name: 'ask',
  displayName: 'Ask a Teammate',
  group: ['team'],
  version: 1,
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    {
      name: 'to',
      displayName: 'Teammate',
      type: 'string',
      default: '',
      description:
        'Agent to ask — agent id, role, or name. The teammate must belong to the same user.',
      required: true,
    },
    {
      name: 'text',
      displayName: 'Question',
      type: 'string',
      default: '',
      description: 'Question to ask. Leave empty to ask with the incoming text.',
    },
    {
      name: 'requiresResponse',
      displayName: 'Wait for reply',
      type: 'boolean',
      default: true,
      description:
        'When on, the node waits for the teammate to answer before continuing. When off, it records the question and continues at once.',
    },
  ],
  defaults: { name: 'Ask a Teammate' },
  description: 'Ask another agent on your team a question mid-run and continue with its reply.',
};

/**
 * Flow-control node descriptions: If, Switch, Merge, Split In Batches,
 * Wait, Respond To Webhook, Execute Workflow.
 *
 * Descriptions are original code written fresh for AgentFlow, guided by the
 * paraphrased behaviour in the n8n feature map.
 */

import type { NodeDescription } from '../registry';

export const ifDescription: NodeDescription = {
  name: 'if',
  displayName: 'If',
  group: ['transform'],
  version: 1,
  inputs: ['main'],
  outputs: ['main', 'main'],
  properties: [
    {
      name: 'conditions',
      displayName: 'Conditions',
      type: 'json',
      default: {},
      description: 'Conditions to check on each item, as a JSON object, e.g. { "amount": { "greaterThan": 100 } }. Values may use {{ }} expressions.',
      required: true,
    },
    {
      name: 'combine',
      displayName: 'Combine Conditions',
      type: 'options',
      default: 'and',
      options: [
        { name: 'AND — all conditions must hold', value: 'and' },
        { name: 'OR — any condition may hold', value: 'or' },
      ],
      description: 'How multiple conditions are combined.',
    },
  ],
  defaults: { name: 'If' },
  icon: 'choice',
  description: 'Sends what comes in one way or the other, depending on its rules.',
};

export const switchDescription: NodeDescription = {
  name: 'switch',
  displayName: 'Switch',
  group: ['transform'],
  version: 1,
  inputs: ['main'],
  outputs: ['main', 'main', 'main'],
  properties: [
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'options',
      default: 'expression',
      options: [
        { name: 'Expression — one value picks the output', value: 'expression' },
        { name: 'Rules — each output has its own conditions', value: 'rules' },
      ],
      description: 'Pick the way out with one rule, or with a set of rules, one per way out.',
      required: true,
    },
    {
      name: 'expression',
      displayName: 'Expression',
      type: 'string',
      default: '',
      description: 'An {{ }} expression whose value selects the output: 0 for the first output, 1 for the second, and so on.',
      displayOptions: { show: { mode: ['expression'] } },
    },
    {
      name: 'rules',
      displayName: 'Rules',
      type: 'json',
      default: {},
      description: 'One rule per output, as a JSON object keyed by output index, e.g. { "0": { "status": "paid" }, "1": { "status": "pending" } }. Values may use {{ }} expressions.',
      displayOptions: { show: { mode: ['rules'] } },
    },
    {
      name: 'fallbackOutput',
      displayName: 'Fallback Output',
      type: 'options',
      default: 'none',
      options: [
        { name: 'None — drop unmatched items', value: 'none' },
        { name: 'Extra output — send unmatched items to the last output', value: 'extra' },
      ],
      description: 'What happens to things that match no way out.',
    },
  ],
  defaults: { name: 'Switch' },
  icon: 'choice',
  description: 'Sends what comes in to one of its ways out, depending on the rules.',
};

export const mergeDescription: NodeDescription = {
  name: 'merge',
  displayName: 'Merge',
  group: ['transform'],
  version: 1,
  inputs: ['main', 'main'],
  outputs: ['main'],
  properties: [
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'options',
      default: 'append',
      options: [
        { name: 'Append — stack the inputs end to end', value: 'append' },
        { name: 'Combine — join matching items side by side', value: 'combine' },
        { name: 'Choose Branch — pass through one input only', value: 'chooseBranch' },
      ],
      description: 'How the two directions are joined.',
      required: true,
    },
    {
      name: 'chooseBranch',
      displayName: 'Branch to Pass Through',
      type: 'options',
      default: 'input1',
      options: [
        { name: 'Input 1', value: 'input1' },
        { name: 'Input 2', value: 'input2' },
      ],
      description: 'Which direction passes through when the mode is Choose Branch.',
      displayOptions: { show: { mode: ['chooseBranch'] } },
    },
  ],
  defaults: { name: 'Merge' },
  icon: 'merge',
  description: 'Joins what comes in from two directions into one flow.',
};

export const splitInBatchesDescription: NodeDescription = {
  name: 'splitInBatches',
  displayName: 'Split In Batches',
  group: ['transform'],
  version: 1,
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    {
      name: 'batchSize',
      displayName: 'Batch Size',
      type: 'number',
      default: 10,
      description: 'How many to pass on per group. The step runs once per group.',
      required: true,
    },
  ],
  defaults: { name: 'Split In Batches' },
  icon: 'batches',
  description: 'Splits what comes in into small groups and handles one group at a time.',
};

export const waitDescription: NodeDescription = {
  name: 'wait',
  displayName: 'Wait',
  group: ['organisation'],
  version: 1,
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    {
      name: 'resume',
      displayName: 'Resume',
      type: 'options',
      default: 'afterTimeInterval',
      options: [
        { name: 'After a time interval', value: 'afterTimeInterval' },
        { name: 'At a specific time', value: 'specificTime' },
        { name: 'On a webhook call', value: 'onWebhookCall' },
        { name: 'On a form submission', value: 'onFormSubmission' },
      ],
      description: 'What picks the flow up again. Time-based waits pick up on their own; link and form waits pick up when someone calls the wait link or fills in the form.',
      required: true,
    },
    {
      name: 'amount',
      displayName: 'Amount',
      type: 'number',
      default: 1,
      description: 'How long to wait, in the unit below.',
      required: true,
      displayOptions: { show: { resume: ['afterTimeInterval'] } },
    },
    {
      name: 'unit',
      displayName: 'Unit',
      type: 'options',
      default: 'minutes',
      options: [
        { name: 'Seconds', value: 'seconds' },
        { name: 'Minutes', value: 'minutes' },
        { name: 'Hours', value: 'hours' },
        { name: 'Days', value: 'days' },
      ],
      description: 'Unit for the amount above.',
      displayOptions: { show: { resume: ['afterTimeInterval'] } },
    },
    {
      name: 'resumeAt',
      displayName: 'Resume At',
      type: 'string',
      default: '',
      description: 'Date and time to resume at, e.g. "2026-11-19T00:00:00+05:00".',
      displayOptions: { show: { resume: ['specificTime'] } },
    },
  ],
  defaults: { name: 'Wait' },
  icon: 'wait',
  description: 'Pauses the flow and picks it up again later. The pause survives a restart.',
};

export const respondToWebhookDescription: NodeDescription = {
  name: 'respondToWebhook',
  displayName: 'Respond To Webhook',
  group: ['output'],
  version: 1,
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    {
      name: 'respondWith',
      displayName: 'Respond With',
      type: 'options',
      default: 'firstEntryJson',
      options: [
        { name: 'First entry JSON', value: 'firstEntryJson' },
        { name: 'All entries JSON', value: 'allEntries' },
        { name: 'Text', value: 'text' },
        { name: 'JSON', value: 'json' },
      ],
      description: 'What to send back to whoever started the flow.',
      required: true,
    },
    {
      name: 'responseBody',
      displayName: 'Response Body',
      type: 'string',
      default: '',
      description: 'Body to send back. Used with Text and JSON. Values may use {{ }} expressions.',
      displayOptions: { show: { respondWith: ['text', 'json'] } },
    },
    {
      name: 'responseCode',
      displayName: 'Response Code',
      type: 'number',
      default: 200,
      description: 'The number to send back to whoever started the flow.',
    },
    {
      name: 'responseHeaders',
      displayName: 'Response Headers',
      type: 'json',
      default: {},
      description: 'Extra headers to send back, as a JSON object, e.g. { "Content-Type": "application/json" }.',
    },
  ],
  defaults: { name: 'Respond To Webhook' },
  icon: 'respond',
  description: 'Answers whoever started the flow through a link. If the flow was not started that way, things pass through unchanged.',
};

export const executeWorkflowDescription: NodeDescription = {
  name: 'executeWorkflow',
  displayName: 'Execute Workflow',
  group: ['transform'],
  version: 1,
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    {
      name: 'workflowId',
      displayName: 'Workflow',
      type: 'string',
      default: '',
      description: 'Which flow to run. Its answer becomes this step’s answer.',
      required: true,
    },
    {
      name: 'waitForCompletion',
      displayName: 'Wait For Completion',
      type: 'boolean',
      default: true,
      description: 'Wait for the other flow to finish and use its answer. Turn off to start it and carry on without waiting.',
    },
  ],
  defaults: { name: 'Execute Workflow' },
  icon: 'run-flow',
  description: 'Runs another flow and passes its answer on. That flow must start with its own starting step for this.',
};

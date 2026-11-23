/**
 * Trigger node descriptions.
 *
 * A trigger is the entry point of a workflow: it produces the first items
 * instead of consuming them, so every trigger has no inputs and one main
 * output. Descriptions are original code written fresh for AgentFlow,
 * guided by the paraphrased behaviour in the n8n feature map.
 */

import type { NodeDescription } from '../registry';

export const webhookDescription: NodeDescription = {
  name: 'webhook',
  displayName: 'Webhook',
  group: ['trigger'],
  version: 1,
  inputs: [],
  outputs: ['main'],
  properties: [
    {
      name: 'httpMethod',
      displayName: 'HTTP Method',
      type: 'options',
      default: 'POST',
      options: [
        { name: 'GET', value: 'GET' },
        { name: 'POST', value: 'POST' },
        { name: 'PUT', value: 'PUT' },
        { name: 'PATCH', value: 'PATCH' },
        { name: 'DELETE', value: 'DELETE' },
      ],
      description: 'How the other app sends its message (usually POST).',
      required: true,
    },
    {
      name: 'path',
      displayName: 'Path',
      type: 'string',
      default: '',
      description: 'The last part of its link, e.g. "order-created". Leave empty to use the flow’s own name.',
    },
    {
      name: 'responseMode',
      displayName: 'Respond',
      type: 'options',
      default: 'lastNode',
      options: [
        { name: 'When the last node finishes', value: 'lastNode' },
        { name: 'Immediately', value: 'onReceived' },
      ],
      description: 'When to answer: after the flow finishes, or as soon as the message arrives.',
    },
    {
      name: 'responseCode',
      displayName: 'Response Code',
      type: 'number',
      default: 200,
      description: 'The number sent back when answering straight away.',
    },
    {
      name: 'authentication',
      displayName: 'Authentication',
      type: 'options',
      default: 'none',
      options: [
        { name: 'None', value: 'none' },
        { name: 'Header Auth', value: 'headerAuth' },
      ],
      description: 'Ask senders for a saved sign-in. None means anyone with the link can start the flow.',
    },
  ],
  defaults: { name: 'Webhook' },
  icon: 'link',
  description: 'Starts the flow when another app sends a message to its special link.',
  webhooks: true,
};

export const scheduleDescription: NodeDescription = {
  name: 'schedule',
  displayName: 'Schedule Trigger',
  group: ['trigger', 'schedule'],
  version: 1,
  inputs: [],
  outputs: ['main'],
  properties: [
    {
      name: 'rule',
      displayName: 'Trigger Rule',
      type: 'options',
      default: 'cron',
      options: [
        { name: 'Cron expression', value: 'cron' },
        { name: 'Every X minutes', value: 'interval' },
      ],
      description: 'Run on a repeating schedule, or every fixed number of minutes.',
      required: true,
    },
    {
      name: 'cronExpression',
      displayName: 'Cron Expression',
      type: 'string',
      default: '0 9 * * *',
      description: 'Five parts: minute hour day month weekday. "0 9 * * *" runs every day at 09:00.',
      required: true,
      displayOptions: { show: { rule: ['cron'] } },
    },
    {
      name: 'intervalMinutes',
      displayName: 'Interval (minutes)',
      type: 'number',
      default: 60,
      description: 'Run every this many minutes.',
      required: true,
      displayOptions: { show: { rule: ['interval'] } },
    },
    {
      name: 'timezone',
      displayName: 'Timezone',
      type: 'string',
      default: 'UTC',
      description: 'Timezone the schedule runs in, e.g. "Asia/Karachi" or "UTC".',
    },
  ],
  defaults: { name: 'Schedule Trigger' },
  icon: 'clock',
  description: 'Starts the flow at times you choose — on a repeating schedule.',
};

export const manualTriggerDescription: NodeDescription = {
  name: 'manualTrigger',
  displayName: 'Manual Trigger',
  group: ['trigger'],
  version: 1,
  inputs: [],
  outputs: ['main'],
  properties: [],
  defaults: { name: 'Manual Trigger' },
  icon: 'press',
  description: 'Starts the flow when you press Run. No settings needed.',
};

export const errorTriggerDescription: NodeDescription = {
  name: 'errorTrigger',
  displayName: 'Error Trigger',
  group: ['trigger'],
  version: 1,
  inputs: [],
  outputs: ['main'],
  properties: [],
  defaults: { name: 'Error Trigger' },
  icon: 'error',
  description: 'Starts a flow when another flow fails. It carries what went wrong and which flow it came from.',
};

export const formTriggerDescription: NodeDescription = {
  name: 'formTrigger',
  displayName: 'Form Trigger',
  group: ['trigger'],
  version: 1,
  inputs: [],
  outputs: ['main'],
  properties: [
    {
      name: 'path',
      displayName: 'Path',
      type: 'string',
      default: '',
      description: 'The last part of the form link. Leave empty to use the flow’s own name.',
    },
    {
      name: 'formTitle',
      displayName: 'Form Title',
      type: 'string',
      default: 'Submit',
      description: 'Title shown at the top of the hosted form.',
      required: true,
    },
    {
      name: 'formDescription',
      displayName: 'Form Description',
      type: 'string',
      default: '',
      description: 'Short text shown under the title. Leave empty for no description.',
    },
    {
      name: 'formFields',
      displayName: 'Form Fields',
      type: 'json',
      default: [],
      description: 'Fields on the form, as a JSON list of { name, label, type, required } objects. Types: text, number, boolean, textarea.',
    },
  ],
  defaults: { name: 'Form Trigger' },
  icon: 'form',
  description: 'Starts the flow when someone fills in its form. The answers come first.',
};

export const executeWorkflowTriggerDescription: NodeDescription = {
  name: 'executeWorkflowTrigger',
  displayName: 'Execute Workflow Trigger',
  group: ['trigger'],
  version: 1,
  inputs: [],
  outputs: ['main'],
  properties: [],
  defaults: { name: 'Execute Workflow Trigger' },
  icon: 'call-flow',
  description: 'The starting point of a flow that is only ever started by another flow.',
};

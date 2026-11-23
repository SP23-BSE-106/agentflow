/**
 * Core transform node descriptions: Code, Set, HTTP Request.
 *
 * Descriptions are original code written fresh for AgentFlow, guided by the
 * paraphrased behaviour in the n8n feature map. The Code node runs its code
 * through the sandboxed expression/code path (Lane F/H own execution); this
 * file only describes the node, it never evaluates anything.
 */

import type { NodeDescription } from '../registry';

export const codeDescription: NodeDescription = {
  name: 'code',
  displayName: 'Code',
  group: ['transform'],
  version: 1,
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'options',
      default: 'runOnceForAllItems',
      options: [
        { name: 'Run once for all items', value: 'runOnceForAllItems' },
        { name: 'Run once for each item', value: 'runOnceForEachItem' },
      ],
      description: 'Run the code once for everything together, or once for each piece.',
      required: true,
    },
    {
      name: 'code',
      displayName: 'JavaScript Code',
      type: 'string',
      default: '// Return the items to pass on. `items` holds every incoming item.\nreturn items;',
      description: 'JavaScript that runs in a sandbox with no access to process, require, or the filesystem. Return the items to pass on.',
      required: true,
    },
  ],
  defaults: { name: 'Code' },
  icon: 'code',
  description: 'Runs a small piece of code over what comes in, and passes the result on.',
};

export const setDescription: NodeDescription = {
  name: 'set',
  displayName: 'Set',
  group: ['transform'],
  version: 1,
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    {
      name: 'values',
      displayName: 'Values to Set',
      type: 'json',
      default: {},
      description: 'Fields to set on each item, as a JSON object. Values may use {{ }} expressions, e.g. { "fullName": "{{ $json.firstName }} {{ $json.lastName }}" }.',
      required: true,
    },
    {
      name: 'includeOtherFields',
      displayName: 'Include Other Fields',
      type: 'boolean',
      default: true,
      description: 'Keep the values already there. Turn off to pass on only the values set here.',
    },
  ],
  defaults: { name: 'Set' },
  icon: 'set',
  description: 'Sets values on what comes in. Use it to rename or add values before the next step.',
};

export const httpRequestDescription: NodeDescription = {
  name: 'httpRequest',
  displayName: 'HTTP Request',
  group: ['output'],
  version: 1,
  inputs: ['main'],
  outputs: ['main'],
  credentials: [
    { name: 'httpBasicAuth', required: false },
    { name: 'httpHeaderAuth', required: false },
  ],
  properties: [
    {
      name: 'method',
      displayName: 'Method',
      type: 'options',
      default: 'GET',
      options: [
        { name: 'GET', value: 'GET' },
        { name: 'POST', value: 'POST' },
        { name: 'PUT', value: 'PUT' },
        { name: 'PATCH', value: 'PATCH' },
        { name: 'DELETE', value: 'DELETE' },
      ],
      description: 'How to make the request.',
      required: true,
    },
    {
      name: 'url',
      displayName: 'URL',
      type: 'string',
      default: '',
      description: 'The web address to ask. Only public addresses are used; private or local addresses are blocked.',
      required: true,
    },
    {
      name: 'authentication',
      displayName: 'Authentication',
      type: 'options',
      default: 'none',
      options: [
        { name: 'None', value: 'none' },
        { name: 'Basic Auth', value: 'httpBasicAuth' },
        { name: 'Header Auth', value: 'httpHeaderAuth' },
      ],
      description: 'Saved sign-in to send with the request. Pick one of the matching type, or None.',
    },
    {
      name: 'sendBody',
      displayName: 'Send Body',
      type: 'boolean',
      default: false,
      description: 'Send a body with the request. Only used with POST, PUT, and PATCH.',
    },
    {
      name: 'bodyContentType',
      displayName: 'Body Content Type',
      type: 'options',
      default: 'json',
      options: [
        { name: 'JSON', value: 'json' },
        { name: 'Form-Urlencoded', value: 'form' },
        { name: 'Raw Text', value: 'raw' },
      ],
      description: 'How the extra information is sent.',
      displayOptions: { show: { sendBody: [true] } },
    },
    {
      name: 'body',
      displayName: 'Body',
      type: 'string',
      default: '',
      description: 'The request body. For JSON, a JSON object; values may use {{ }} expressions.',
      displayOptions: { show: { sendBody: [true] } },
    },
    {
      name: 'timeout',
      displayName: 'Timeout (ms)',
      type: 'number',
      default: 10000,
      description: 'Give up if the server does not answer within this many milliseconds.',
    },
  ],
  defaults: { name: 'HTTP Request' },
  icon: 'web',
  description: 'Asks a web address for information and passes the answer on.',
};

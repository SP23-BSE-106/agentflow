/**
 * Registry + core node description cases (Lane E).
 *
 * Runs under tests/n8n/run.cjs (npm run test:n8n): the require hook
 * maps '@/...' to the compiled tree, and the shared harness runs every
 * case file in cases/ under one count.
 */
'use strict'

// Runs under tests/n8n/run.cjs (npm run test:n8n). The require hook maps
// '@/...' to the compiled tree, so these are the real modules.
const { test, assert } = require('../harness.cjs')
const { registerNodeType, getNodeType, defaultVersion, listNodeTypes } = require('@/lib/nodes/registry')
// Importing the aggregate registers all 17 core descriptions.
require('@/lib/nodes/index')

const EXPECTED = [
  { name: 'webhook', displayName: 'Webhook', group: ['trigger'] },
  { name: 'schedule', displayName: 'Schedule Trigger', group: ['trigger', 'schedule'] },
  { name: 'manualTrigger', displayName: 'Manual Trigger', group: ['trigger'] },
  { name: 'errorTrigger', displayName: 'Error Trigger', group: ['trigger'] },
  { name: 'formTrigger', displayName: 'Form Trigger', group: ['trigger'] },
  { name: 'executeWorkflowTrigger', displayName: 'Execute Workflow Trigger', group: ['trigger'] },
  { name: 'code', displayName: 'Code', group: ['transform'] },
  { name: 'set', displayName: 'Set', group: ['transform'] },
  { name: 'httpRequest', displayName: 'HTTP Request', group: ['output'] },
  { name: 'if', displayName: 'If', group: ['transform'] },
  { name: 'switch', displayName: 'Switch', group: ['transform'] },
  { name: 'merge', displayName: 'Merge', group: ['transform'] },
  { name: 'splitInBatches', displayName: 'Split In Batches', group: ['transform'] },
  { name: 'wait', displayName: 'Wait', group: ['organisation'] },
  { name: 'respondToWebhook', displayName: 'Respond To Webhook', group: ['output'] },
  { name: 'executeWorkflow', displayName: 'Execute Workflow', group: ['transform'] },
  // Multi-agent team node (merge region B): ask a teammate mid-run.
  { name: 'ask', displayName: 'Ask a Teammate', group: ['team'] },
]

test('all 17 core node types are registered', () => {
  const all = listNodeTypes()
  assert.strictEqual(all.length, EXPECTED.length, `expected ${EXPECTED.length} types, got ${all.length}: ${all.map((d) => d.name).join(', ')}`)
  for (const expected of EXPECTED) {
    const desc = getNodeType(expected.name)
    assert.ok(desc, `${expected.name} is registered`)
    assert.strictEqual(desc.displayName, expected.displayName)
    assert.deepStrictEqual(desc.group, expected.group)
  }
})

test('getNodeType returns undefined for unknown names and versions', () => {
  assert.strictEqual(getNodeType('doesNotExist'), undefined)
  assert.strictEqual(getNodeType('webhook', 999), undefined)
  assert.strictEqual(getNodeType('webhook', 1)?.name, 'webhook')
  assert.strictEqual(getNodeType('webhook'), getNodeType('webhook', 1))
})

test("'http' is an alias of canonical 'httpRequest', not a second palette entry (H6)", () => {
  // Saved workflows carry 'http' (old union name); the builder emits
  // 'httpRequest'. Both spellings must resolve to the same description, so
  // runWorkflow routes an 'http' graph to the item executor.
  const alias = getNodeType('http')
  const canonical = getNodeType('httpRequest')
  assert.ok(alias, "'http' resolves")
  assert.strictEqual(alias, canonical, 'alias resolves to the canonical description')
  assert.strictEqual(alias.name, 'httpRequest')
  assert.strictEqual(defaultVersion('http'), 1, 'alias has a default version')
  assert.strictEqual(getNodeType('http', 1), canonical)
  // The alias must not appear as an 18th palette entry.
  const all = listNodeTypes()
  assert.strictEqual(all.length, EXPECTED.length, `still ${EXPECTED.length} types, got ${all.length}`)
  assert.ok(!all.some((d) => d.name === 'http'), "no 'http' palette entry")
})

test('defaultVersion is 1 for every core node and throws for unknown names', () => {
  for (const expected of EXPECTED) {
    assert.strictEqual(defaultVersion(expected.name), 1, expected.name)
  }
  assert.throws(() => defaultVersion('doesNotExist'), /no node type named/)
})

test('listNodeTypes filters by group', () => {
  const byNames = (group) => listNodeTypes(group).map((d) => d.name).sort()
  assert.deepStrictEqual(byNames('trigger'), ['errorTrigger', 'executeWorkflowTrigger', 'formTrigger', 'manualTrigger', 'schedule', 'webhook'])
  assert.deepStrictEqual(byNames('transform'), ['code', 'executeWorkflow', 'if', 'merge', 'set', 'splitInBatches', 'switch'])
  assert.deepStrictEqual(byNames('output'), ['httpRequest', 'respondToWebhook'])
  assert.deepStrictEqual(byNames('organisation'), ['wait'])
  assert.deepStrictEqual(byNames('schedule'), ['schedule'])
  assert.deepStrictEqual(byNames('no-such-group'), [])
})

test('every description has the required keys and sane versions', () => {
  for (const desc of listNodeTypes()) {
    assert.strictEqual(typeof desc.name, 'string')
    assert.ok(desc.name.trim(), 'name is non-empty')
    assert.strictEqual(typeof desc.displayName, 'string')
    assert.ok(desc.displayName.trim(), 'displayName is non-empty')
    assert.ok(Array.isArray(desc.group) && desc.group.length > 0, `${desc.name}: group is non-empty`)
    assert.ok(Number.isInteger(desc.version) && desc.version >= 1, `${desc.name}: version is an integer >= 1`)
    assert.ok(Array.isArray(desc.inputs), `${desc.name}: inputs is an array`)
    assert.ok(Array.isArray(desc.outputs) && desc.outputs.length > 0, `${desc.name}: at least one output`)
    assert.ok(Array.isArray(desc.properties), `${desc.name}: properties is an array`)
    assert.ok(desc.defaults && typeof desc.defaults === 'object', `${desc.name}: defaults is an object`)
    assert.strictEqual(desc.defaults.name, desc.displayName, `${desc.name}: defaults.name matches displayName`)
  }
})

test('every property has a name, displayName, type, and a default of the right shape', () => {
  for (const desc of listNodeTypes()) {
    for (const prop of desc.properties) {
      assert.strictEqual(typeof prop.name, 'string')
      assert.ok(prop.name.trim(), `${desc.name}: property name is non-empty`)
      assert.strictEqual(typeof prop.displayName, 'string')
      assert.ok(prop.displayName.trim(), `${desc.name}.${prop.name}: displayName is non-empty`)
      assert.ok(
        ['string', 'number', 'boolean', 'options', 'stringArray', 'collection', 'credentials', 'json'].includes(prop.type),
        `${desc.name}.${prop.name}: unknown type '${prop.type}'`,
      )
      assert.ok('default' in prop, `${desc.name}.${prop.name}: needs a default`)
      if (prop.type === 'string') assert.strictEqual(typeof prop.default, 'string', `${desc.name}.${prop.name}: default is a string`)
      if (prop.type === 'number') assert.strictEqual(typeof prop.default, 'number', `${desc.name}.${prop.name}: default is a number`)
      if (prop.type === 'boolean') assert.strictEqual(typeof prop.default, 'boolean', `${desc.name}.${prop.name}: default is a boolean`)
      if (prop.type === 'options') {
        assert.ok(Array.isArray(prop.options) && prop.options.length > 0, `${desc.name}.${prop.name}: options is non-empty`)
        assert.ok(
          prop.options.some((o) => o.value === prop.default),
          `${desc.name}.${prop.name}: default '${prop.default}' is one of the options`,
        )
      }
      if (prop.type === 'json') {
        assert.ok(prop.default !== null && typeof prop.default === 'object', `${desc.name}.${prop.name}: json default is an object or array`)
      }
    }
  }
})

test('displayOptions only reference properties that exist on the same node', () => {
  for (const desc of listNodeTypes()) {
    const names = new Set(desc.properties.map((p) => p.name))
    for (const prop of desc.properties) {
      for (const key of ['show', 'hide']) {
        const refs = prop.displayOptions && prop.displayOptions[key]
        if (!refs) continue
        for (const refName of Object.keys(refs)) {
          assert.ok(names.has(refName), `${desc.name}.${prop.name}: displayOptions.${key} references unknown property '${refName}'`)
          assert.ok(Array.isArray(refs[refName]), `${desc.name}.${prop.name}: displayOptions.${key}.${refName} is an array`)
        }
      }
    }
  }
})

test('trigger shapes: no inputs, one main output; multi-output nodes are as described', () => {
  for (const name of ['webhook', 'schedule', 'manualTrigger', 'errorTrigger', 'formTrigger', 'executeWorkflowTrigger']) {
    const desc = getNodeType(name)
    assert.deepStrictEqual(desc.inputs, [], `${name}: triggers have no inputs`)
    assert.deepStrictEqual(desc.outputs, ['main'], `${name}: one main output`)
  }
  assert.deepStrictEqual(getNodeType('if').outputs, ['main', 'main'], 'If has true/false outputs')
  assert.strictEqual(getNodeType('switch').outputs.length, 3, 'Switch ships with three outputs')
  assert.deepStrictEqual(getNodeType('merge').inputs, ['main', 'main'], 'Merge takes two inputs')
  assert.strictEqual(getNodeType('webhook').webhooks, true, 'Webhook declares webhooks')
})

test('credentials are declared only where the node genuinely needs one', () => {
  const http = getNodeType('httpRequest')
  assert.ok(Array.isArray(http.credentials) && http.credentials.length > 0, 'HTTP Request declares credentials')
  assert.ok(http.credentials.every((c) => c.required === false), 'HTTP Request credentials are optional')
  for (const desc of listNodeTypes()) {
    if (desc.name === 'httpRequest') continue
    assert.ok(!desc.credentials || desc.credentials.length === 0, `${desc.name}: declares no credentials`)
  }
})

test('registerNodeType rejects duplicates and descriptions without defaults', () => {
  assert.throws(
    () => registerNodeType({ ...getNodeType('webhook'), properties: [] }),
    /already registered/,
  )
  const bad = {
    name: 'badNode',
    displayName: 'Bad Node',
    group: ['transform'],
    version: 1,
    inputs: ['main'],
    outputs: ['main'],
    properties: [{ name: 'x', displayName: 'X', type: 'string' }],
    defaults: { name: 'Bad Node' },
  }
  assert.throws(() => registerNodeType(bad), /needs a default/)
  assert.strictEqual(getNodeType('badNode'), undefined, 'rejected node is not registered')
})


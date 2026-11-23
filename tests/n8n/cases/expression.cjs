/**
 * Expression engine cases (n8n addendum, Lane F).
 *
 * Runs under tests/n8n/run.cjs (npm run test:n8n): the require hook
 * maps '@/...' to the compiled tree, and the shared harness runs every
 * case file in cases/ under one count.
 *
 * Every attack case must fail with an error and never execute: after the
 * attack cases run, the file asserts Object.prototype was not polluted.
 */
'use strict'

// Runs under tests/n8n/run.cjs (npm run test:n8n). The require hook maps
// '@/...' to the compiled tree, so this is the real engine.
const { test, assert } = require('../harness.cjs')
const {
  evaluateExpression,
  evaluateJmespath,
  renderTemplate,
  renderTemplateValue,
  resolveConfigTemplates,
  makeScope,
} = require('@/lib/expression/engine')

/** A fixed scope so date results are deterministic. */
function scope(overrides = {}) {
  const now = new Date('2026-11-18T10:30:00.000Z')
  return makeScope({
    json: {
      name: 'Ada',
      age: 36,
      active: true,
      score: 9.5,
      user: { name: 'Ada', tags: ['a', 'b'], address: { city: 'Lahore' } },
      items: [{ id: 1, status: 'open' }, { id: 2, status: 'done' }, { id: 3, status: 'open' }],
      missing: undefined,
      nothing: null,
    },
    node: { Set: { json: { greeting: 'hello', count: 3 } }, 'My Node': { json: { v: 7 } } },
    input: { all: ['first', 'second'], first: 'first', last: 'second' },
    binary: { file1: { mimeType: 'image/png', fileName: 'cat.png' } },
    workflow: { id: 'wf-1', name: 'Demo Flow' },
    now,
    today: new Date('2026-11-18T00:00:00.000Z'),
    vars: { apiBase: 'https://example.com', retries: 2 },
    ...overrides,
  })
}

function ok(expression, s = scope()) {
  const result = evaluateExpression(expression, s)
  assert.strictEqual(result.ok, true, `expected ok for ${expression}, got error: ${result.error}`)
  return result.value
}

function notOk(expression, s = scope()) {
  const result = evaluateExpression(expression, s)
  assert.strictEqual(result.ok, false, `expected failure for ${expression}, got value: ${JSON.stringify(result.value)}`)
  assert.ok(typeof result.error === 'string' && result.error.length > 0, 'failure must carry an error message')
  return result.error
}

// ── Correct evaluation ───────────────────────────────────────────────────

test('$json field access', () => {
  assert.strictEqual(ok('$json.name'), 'Ada')
  assert.strictEqual(ok('$json.age'), 36)
  assert.strictEqual(ok('$json.active'), true)
  assert.strictEqual(ok('$json.user.address.city'), 'Lahore')
  assert.strictEqual(ok("$json['user'].name"), 'Ada')
  assert.strictEqual(ok('$json.user.tags[1]'), 'b')
  assert.strictEqual(ok('$json.user.tags.length'), 2)
})

test('$json missing field is undefined, not an error', () => {
  assert.strictEqual(ok('$json.nope'), undefined)
  assert.strictEqual(ok('$json.user.nope.deep'), undefined)
  assert.strictEqual(ok('$json.missing ?? "fallback"'), 'fallback')
})

test('$node bracket access incl. names with spaces', () => {
  assert.strictEqual(ok('$node["Set"].json.greeting'), 'hello')
  assert.strictEqual(ok('$node["Set"].json.count + 1'), 4)
  assert.strictEqual(ok('$node["My Node"].json.v'), 7)
  assert.strictEqual(ok('$node["Nope"].json'), undefined)
})

test('$input first/last/all', () => {
  assert.strictEqual(ok('$input.first'), 'first')
  assert.strictEqual(ok('$input.last'), 'second')
  assert.strictEqual(ok('$input.all[0]'), 'first')
  assert.strictEqual(ok('$input.all.length'), 2)
})

test('$binary field access', () => {
  assert.strictEqual(ok('$binary.file1.mimeType'), 'image/png')
  assert.strictEqual(ok('$binary.file1.fileName'), 'cat.png')
})

test('$workflow id and name', () => {
  assert.strictEqual(ok('$workflow.id'), 'wf-1')
  assert.strictEqual(ok('$workflow.name'), 'Demo Flow')
})

test('$now and $today dates', () => {
  // The frozen instant is 2026-11-18T10:30:00.000Z. Its components are
  // asserted with UTC getters, so the test passes in ANY timezone: local
  // getters (getHours() etc.) return the host timezone's components
  // (15 in PKT, 10 in UTC) and can never pin a frozen instant.
  assert.strictEqual(ok('$now.getUTCFullYear()'), 2026)
  assert.strictEqual(ok('$now.getUTCMonth()'), 10)
  assert.strictEqual(ok('$now.getUTCDate()'), 18)
  assert.strictEqual(ok('$now.getUTCHours()'), 10)
  assert.strictEqual(ok('$now.getUTCMinutes()'), 30)
  assert.strictEqual(ok('$now.toISOString()'), '2026-11-18T10:30:00.000Z')
  assert.strictEqual(ok('$today.getUTCHours()'), 0)
  assert.strictEqual(ok('$today.getUTCMinutes()'), 0)
  assert.strictEqual(ok('$today.toISOString()'), '2026-11-18T00:00:00.000Z')
  // Local getters still work — compared against the host Date's own local
  // getters, so this holds in every timezone by construction and verifies
  // the engine delegates to the real Date method.
  const frozenNow = new Date('2026-11-18T10:30:00.000Z')
  const frozenToday = new Date('2026-11-18T00:00:00.000Z')
  assert.strictEqual(ok('$now.getHours()'), frozenNow.getHours())
  assert.strictEqual(ok('$now.getFullYear()'), frozenNow.getFullYear())
  assert.strictEqual(ok('$today.getHours()'), frozenToday.getHours())
})

test('$vars workflow variables', () => {
  assert.strictEqual(ok('$vars.apiBase'), 'https://example.com')
  assert.strictEqual(ok('$vars.retries * 3'), 6)
})

test('arithmetic, comparison, logic, ternary', () => {
  assert.strictEqual(ok('$json.age + 4'), 40)
  assert.strictEqual(ok('$json.age * 2 - 2'), 70)
  assert.strictEqual(ok('$json.score * 2'), 19)
  assert.strictEqual(ok('2 ** 3'), 8)
  assert.strictEqual(ok('$json.age > 30 && $json.active'), true)
  assert.strictEqual(ok('$json.age < 30 || $json.active'), true)
  assert.strictEqual(ok('!$json.active'), false)
  assert.strictEqual(ok('$json.age >= 36 ? "yes" : "no"'), 'yes')
  assert.strictEqual(ok('$json.name == "Ada"'), true)
  assert.strictEqual(ok("$json.name != 'Bob'"), true)
  assert.strictEqual(ok('$json.age === 36'), true)
  assert.strictEqual(ok('$json.age !== 36'), false)
  assert.strictEqual(ok('-$json.age'), -36)
  assert.strictEqual(ok('($json.age + 4) * 2'), 80)
})

test('string helpers and methods', () => {
  assert.strictEqual(ok("$json.name.toUpperCase()"), 'ADA')
  assert.strictEqual(ok("$json.name.toLowerCase()"), 'ada')
  assert.strictEqual(ok("$json.name + '!'"), 'Ada!')
  assert.strictEqual(ok("$json.name.includes('d')"), true)
  assert.strictEqual(ok("$json.name.startsWith('A')"), true)
  assert.strictEqual(ok("$json.name.endsWith('a')"), true)
  assert.strictEqual(ok("$json.name.replace('d', 'D')"), 'ADa')
  assert.strictEqual(ok("'  hi  '.trim()"), 'hi')
  assert.strictEqual(ok("'a,b,c'.split(',').length"), 3)
  assert.strictEqual(ok("'a,b,c'.split(',')[1]"), 'b')
  assert.strictEqual(ok("$json.name.length"), 3)
  assert.strictEqual(ok("$json.name.slice(1)"), 'da')
})

test('number helpers and Math subset', () => {
  assert.strictEqual(ok('$json.score.toFixed(1)'), '9.5')
  assert.strictEqual(ok('Math.floor($json.score)'), 9)
  assert.strictEqual(ok('Math.ceil($json.score)'), 10)
  assert.strictEqual(ok('Math.round($json.score)'), 10)
  assert.strictEqual(ok('Math.max(1, 5, 3)'), 5)
  assert.strictEqual(ok('Math.min(1, 5, 3)'), 1)
  assert.strictEqual(ok('Math.abs(-4)'), 4)
  assert.strictEqual(ok('Math.pow(2, 10)'), 1024)
  assert.strictEqual(ok('Math.sqrt(16)'), 4)
  assert.strictEqual(ok('Math.PI > 3.14'), true)
})

test('bare helpers String/Number/Boolean/parseInt/parseFloat', () => {
  assert.strictEqual(ok('String($json.age)'), '36')
  assert.strictEqual(ok("Number('42')"), 42)
  assert.strictEqual(ok('Boolean(1)'), true)
  assert.strictEqual(ok('Boolean(0)'), false)
  assert.strictEqual(ok("parseInt('42px')"), 42)
  assert.strictEqual(ok("parseFloat('3.5')"), 3.5)
})

test('arrays and objects in expressions', () => {
  assert.deepStrictEqual(ok('[1, 2, $json.age]'), [1, 2, 36])
  assert.deepStrictEqual(ok("{ city: $json.user.address.city, n: 1 }"), { city: 'Lahore', n: 1 })
  assert.strictEqual(ok("['a', 'b'].join('-')"), 'a-b')
  assert.strictEqual(ok("['a', 'b'].includes('b')"), true)
})

test('optional chaining', () => {
  assert.strictEqual(ok('$json.user?.address?.city'), 'Lahore')
  assert.strictEqual(ok('$json.nope?.deep?.field'), undefined)
  assert.strictEqual(ok("$json['nope']?.x"), undefined)
})

test('$jmespath via expression', () => {
  assert.strictEqual(ok("$jmespath($json, 'user.address.city')"), 'Lahore')
  assert.strictEqual(ok("$jmespath('user.name')"), 'Ada')
  assert.deepStrictEqual(ok("$jmespath($json, 'items[*].id')"), [1, 2, 3])
})

test('evaluateJmespath subset', () => {
  const data = scope().json
  assert.strictEqual(evaluateJmespath('user.address.city', data), 'Lahore')
  assert.strictEqual(evaluateJmespath('user.tags[1]', data), 'b')
  assert.strictEqual(evaluateJmespath('missing.field', data), null)
  assert.deepStrictEqual(evaluateJmespath('items[*].id', data), [1, 2, 3])
  assert.deepStrictEqual(evaluateJmespath('items[*]', data), data.items)
  assert.deepStrictEqual(
    evaluateJmespath("items[?status == 'open']", data),
    [{ id: 1, status: 'open' }, { id: 3, status: 'open' }],
  )
  assert.deepStrictEqual(
    evaluateJmespath("items[?status != 'open'].id", data),
    [2],
  )
  assert.strictEqual(evaluateJmespath('items[0].status', data), 'open')
})

test('evaluateJmespath rejects unsupported syntax honestly', () => {
  assert.throws(() => evaluateJmespath('length(items)', scope().json), /not supported/)
  assert.throws(() => evaluateJmespath('user | address', scope().json), /not supported/)
  assert.throws(() => evaluateJmespath('items[0:2]', scope().json), /Unsupported JMESPath/)
  assert.throws(() => evaluateJmespath('items[?status]', scope().json), /Unsupported JMESPath/)
  assert.throws(() => evaluateJmespath('', scope().json), /empty/)
})

// ── Templates ────────────────────────────────────────────────────────────

test('renderTemplate embedded spans', () => {
  const s = scope()
  assert.strictEqual(renderTemplate('Hello {{ $json.name }}!', s), 'Hello Ada!')
  assert.strictEqual(renderTemplate('{{ $json.name }} is {{ $json.age }}', s), 'Ada is 36')
  assert.strictEqual(renderTemplate('no spans here', s), 'no spans here')
  assert.strictEqual(renderTemplate('{{ $json.missing }}x', s), 'x')
  assert.strictEqual(renderTemplate('{{ $json.active }}', s), 'true')
  assert.strictEqual(renderTemplate('Age: {{ $json.age + 1 }}', s), 'Age: 37')
})

test('bare template returns the raw value', () => {
  const s = scope()
  assert.strictEqual(renderTemplateValue('{{ $json.age }}', s), 36)
  assert.strictEqual(renderTemplateValue('{{ $json.active }}', s), true)
  assert.strictEqual(renderTemplateValue('{{ $json.nothing }}', s), null)
  assert.deepStrictEqual(renderTemplateValue('{{ $json.user }}', s), s.json.user)
  assert.deepStrictEqual(renderTemplateValue('{{ $json.items }}', s), s.json.items)
  assert.strictEqual(renderTemplateValue('  {{ $json.age }}  ', s), 36)
  assert.strictEqual(renderTemplateValue('{{ $json.age }} years', s), '36 years')
})

test('templates with braces and quotes inside', () => {
  const s = scope()
  assert.strictEqual(renderTemplate("{{ $json.name + '}' }}", s), 'Ada}')
  assert.deepStrictEqual(renderTemplateValue('{{ {a: 1}.a }}', s), 1)
  assert.strictEqual(renderTemplate('{{ "}}" }}', s), '}}')
})

test('bad templates fail honestly', () => {
  const s = scope()
  assert.throws(() => renderTemplate('Hello {{ $json.name', s), /Unterminated/)
  assert.throws(() => renderTemplate('{{ process.env.X }}', s), /not allowed/)
  assert.throws(() => renderTemplate('{{ }}', s), /empty/i)
  const bad = evaluateExpression('', s)
  assert.strictEqual(bad.ok, false)
  assert.match(bad.error, /empty/i)
})

// ── resolveConfigTemplates ───────────────────────────────────────────────

test('resolveConfigTemplates keeps raw types for bare spans', () => {
  const s = scope()
  const resolved = resolveConfigTemplates(
    {
      url: '{{ $vars.apiBase }}/users/{{ $json.age }}',
      maxTokens: '{{ $json.age }}',
      enabled: '{{ $json.active }}',
      nested: { label: 'Hi {{ $json.name }}', tags: ['{{ $json.name }}', 'plain'] },
      plain: 5,
      keep: null,
    },
    s,
  )
  assert.strictEqual(resolved.url, 'https://example.com/users/36')
  assert.strictEqual(resolved.maxTokens, 36)
  assert.strictEqual(resolved.enabled, true)
  assert.strictEqual(resolved.nested.label, 'Hi Ada')
  assert.deepStrictEqual(resolved.nested.tags, ['Ada', 'plain'])
  assert.strictEqual(resolved.plain, 5)
  assert.strictEqual(resolved.keep, null)
})

test('resolveConfigTemplates does not mutate the input and throws on bad templates', () => {
  const s = scope()
  const config = { url: 'https://example.com/{{ $json.name }}' }
  const resolved = resolveConfigTemplates(config, s)
  assert.strictEqual(config.url, 'https://example.com/{{ $json.name }}')
  assert.strictEqual(resolved.url, 'https://example.com/Ada')
  assert.throws(() => resolveConfigTemplates({ x: '{{ process.env }}' }, s), /not allowed/)
})

// ── Attack cases: every one must fail, never execute ─────────────────────

const ATTACKS = [
  ['process access', 'process.env.API_KEY'],
  ['bare process', 'process'],
  ['require call', "require('fs')"],
  ['bare require', 'require'],
  ['globalThis', 'globalThis.process'],
  ['bare globalThis', 'globalThis'],
  ['constructor via $json', '$json.constructor'],
  ['constructor via bracket', "$json['constructor']"],
  ['constructor chain', '$json.user.constructor'],
  ['prototype chain', '$json.constructor.prototype'],
  ['__proto__ dot', '$json.__proto__'],
  ['__proto__ bracket', "$json['__proto__']"],
  ['__proto__ on node', '$node["Set"].json.__proto__'],
  ['proto pollution write', "$json.__proto__.polluted = 'x'"],
  ['constructor call', "$json.constructor('return process')()"],
  ['function-valued field call', '$json.evil()'],
  ['unknown function call', 'foo()'],
  ['fetch call', "fetch('https://example.com')"],
  ['eval call', "eval('1 + 1')"],
  ['Function call', "Function('return 1')()"],
  ['Date constructor', 'Date.now()'],
  ['new operator', 'new Date()'],
  ['assignment', '$json.age = 99'],
  ['semicolon smuggle', '$json.name; process.env'],
  ['template literal', '`hello ${process.env}`'],
  ['IIFE', '(function(){ return 1 })()'],
  ['lambda', '(() => 1)()'],
  ['$env present', '$env.API_KEY'],
  ['bare $env', '$env'],
  ['unknown $var', '$foo.bar'],
  ['Math.random (excluded)', 'Math.random()'],
  ['string constructor escape', "$json.name.constructor('return 1')()"],
  ['toString constructor escape', '$json.toString.constructor'],
  ['object literal __proto__', "{{ __proto__: {polluted: true} }}"],
  ['deep constructor', '$json.user.address.city.constructor'],
  ['window', 'window.location'],
  ['document', 'document.cookie'],
  ['module', 'module.exports'],
  ['import', "import('fs')"],
  ['array constructor', '[].constructor'],
  ['length constructor', '$json.user.tags.constructor'],
]

for (const [name, expression] of ATTACKS) {
  test(`attack: ${name}`, () => {
    notOk(expression)
    // The same expression inside a template must also fail, never run.
    assert.throws(() => renderTemplate(`x {{ ${expression} }} y`, scope()), Error)
  })
}

test('prototype was not polluted by any attack', () => {
  assert.strictEqual(Object.prototype.polluted, undefined)
  assert.strictEqual({}.polluted, undefined)
  assert.strictEqual(JSON.parse('{}').polluted, undefined)
})

test('makeScope fills defaults', () => {
  const s = makeScope({ json: { a: 1 } })
  assert.deepStrictEqual(s.json, { a: 1 })
  assert.deepStrictEqual(s.node, {})
  assert.deepStrictEqual(s.input, { all: [], first: undefined, last: undefined })
  assert.strictEqual(s.workflow.id, '')
  assert.ok(s.now instanceof Date)
  assert.strictEqual(s.today.getHours(), 0)
  assert.deepStrictEqual(s.vars, {})
})


/**
 * Sandboxed `{{ ... }}` expression engine (n8n addendum, Lane F).
 *
 * Original code written fresh for AgentFlow. It re-implements the *behaviour*
 * described in the n8n feature map (paraphrased): `{{ $json.field }}`,
 * `$node["Name"].json`, `$input`, `$binary`, `$workflow`, `$now`, `$today`,
 * `$vars`, `$jmespath` — evaluated against a data scope with no access to
 * `process`, `require`, the filesystem, or any global. No n8n code was copied.
 *
 * How it stays safe:
 *   - Expressions are parsed by a small recursive-descent parser below and
 *     evaluated by walking the parsed tree. There is no dynamic code
 *     execution anywhere in this file (no eval, no Function constructor).
 *   - Only allowlisted roots exist (`$json`, `$node`, `$input`, `$binary`,
 *     `$workflow`, `$now`, `$today`, `$vars`, `$jmespath`, `Math`, and the
 *     bare helpers `String`, `Number`, `Boolean`, `parseInt`, `parseFloat`).
 *     Every other identifier — `process`, `require`, `globalThis`, `fetch`,
 *     `eval`, `Function`, `Date`, `window`, `document`, and anything else —
 *     is rejected at parse time.
 *   - Property access is allowlisted by receiver type (see `getProperty` /
 *     `callMethod`). The keys `__proto__`, `constructor`, and `prototype`
 *     are forbidden everywhere, including bracket access and object
 *     literals, so prototype pollution is impossible through an expression.
 *   - Method calls are only allowed when the method name is in the
 *     allowlist for the receiver's type. Data objects (plain records) have
 *     no callable methods at all: a function-valued field in data can never
 *     be invoked, because data values are never called.
 *   - There is no `$env`. It is deliberately not in the scope type and the
 *     parser rejects `$env` with a plain error. Server environment must
 *     never leak to workflow authors through an expression.
 *   - There is no assignment, no `new`, no semicolons, no template
 *     literals, no lambdas, and no comments in the expression language.
 *     Anything outside the grammar below fails with an honest error.
 *
 * Grammar (highest to lowest precedence):
 *   primary    := number | string | true | false | null | array | object
 *               | root-variable | bare-helper-call | '(' expr ')'
 *   postfix    := primary ( '.' name | '?.' name | '[' expr ']' | '?.[' expr ']'
 *               | '(' args ')' )*
 *   power      := postfix ( '**' unary )?
 *   unary      := ('-' | '!') unary | power
 *   mult       := unary ( ('*' | '/' | '%') unary )*
 *   add        := mult ( ('+' | '-') mult )*
 *   relational := add ( ('<' | '<=' | '>' | '>=') add )*
 *   equality   := relational ( ('==' | '!=' | '===' | '!==') relational )*
 *   and        := equality ( '&&' equality )*
 *   or         := and ( '||' and )*
 *   nullish    := or ( '??' or )*
 *   expr       := nullish ( '?' expr ':' expr )?
 *
 * Allowed methods by receiver type (the exact helper set):
 *   string: length, toUpperCase, toLowerCase, trim, trimStart, trimEnd,
 *     split, substring, slice, startsWith, endsWith, includes, indexOf,
 *     lastIndexOf, replace, replaceAll, charAt, at, toString, repeat,
 *     padStart, padEnd
 *   number: toFixed, toString
 *   boolean: toString
 *   array: length, join, includes, indexOf, slice, at
 *   Date ($now / $today): toISOString, toDateString, toTimeString,
 *     toLocaleDateString, toLocaleTimeString, getFullYear, getMonth,
 *     getDate, getDay, getHours, getMinutes, getSeconds, getMilliseconds,
 *     getTime — plus the UTC counterparts getUTCFullYear, getUTCMonth,
 *     getUTCDate, getUTCDay, getUTCHours, getUTCMinutes, getUTCSeconds,
 *     getUTCMilliseconds. The UTC getters are the deterministic way to
 *     assert a frozen instant: local getters return the host timezone's
 *     components, so a test (or workflow) that needs a fixed instant
 *     must use the UTC forms.
 *   Math: abs, floor, ceil, round, min, max, pow, sqrt, cbrt, trunc, sign,
 *     hypot, log, exp, PI, E   (Math.random is deliberately NOT included:
 *     expressions must be deterministic.)
 *   bare helpers: String(x), Number(x), Boolean(x), parseInt(x, radix?),
 *     parseFloat(x)
 *   $jmespath(data, 'query') — or $jmespath('query') with $json as the data
 *     — see evaluateJmespath for the supported JMESPath subset.
 *
 * Templates:
 *   - `renderTemplate` renders every `{{ ... }}` span inside a larger
 *     string to text. A template that is exactly one bare `{{ expr }}`
 *     returns the raw value through `renderTemplateValue` (numbers and
 *     booleans survive); `renderTemplate` stringifies that raw value.
 *   - Missing values render as an empty string inside a larger template,
 *     and evaluate to `undefined` as a bare expression.
 *
 * Known gap (per contract): rename-aware `$node["Old name"]` references are
 * NOT rewritten when a node is renamed. `$node["Name"]` must match the
 * node's current name.
 */

export type ExpressionScope = {
  json: Record<string, unknown> // $json — current item payload
  node: Record<string, { json: Record<string, unknown> }> // $node["Name"].json
  input: { all: unknown[]; first: unknown; last: unknown } // $input
  binary: Record<string, unknown> // $binary
  workflow: { id: string; name: string } // $workflow
  now: Date // $now
  today: Date // $today (start of day)
  vars: Record<string, unknown> // $vars
}

/** Build a scope, filling every field the caller did not supply. */
export function makeScope(partial: Partial<ExpressionScope> = {}): ExpressionScope {
  const now = partial.now ?? new Date()
  const today =
    partial.today ??
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  return {
    json: partial.json ?? {},
    node: partial.node ?? {},
    input: partial.input ?? { all: [], first: undefined, last: undefined },
    binary: partial.binary ?? {},
    workflow: partial.workflow ?? { id: '', name: '' },
    now,
    today,
    vars: partial.vars ?? {},
  }
}

// ── Errors ───────────────────────────────────────────────────────────────

class ExpressionError extends Error {}

// ── Lexer ────────────────────────────────────────────────────────────────

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'eof' }

const MULTI_CHAR_OPS = [
  '===',
  '!==',
  '**',
  '?.',
  '&&',
  '||',
  '??',
  '==',
  '!=',
  '>=',
  '<=',
]

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      let value = ''
      let closed = false
      while (j < source.length) {
        const c = source[j]
        if (c === '\\' && j + 1 < source.length) {
          const next = source[j + 1]
          value +=
            next === 'n'
              ? '\n'
              : next === 't'
                ? '\t'
                : next === 'r'
                  ? '\r'
                  : next
          j += 2
          continue
        }
        if (c === quote) {
          closed = true
          break
        }
        value += c
        j += 1
      }
      if (!closed) throw new ExpressionError('Unterminated string in expression.')
      tokens.push({ kind: 'string', value })
      i = j + 1
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i))
      if (!match) throw new ExpressionError(`Bad number near "${source.slice(i, i + 10)}".`)
      tokens.push({ kind: 'number', value: Number(match[0]) })
      i += match[0].length
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i))
      if (!match) throw new ExpressionError(`Bad identifier near "${source.slice(i, i + 10)}".`)
      tokens.push({ kind: 'ident', value: match[0] })
      i += match[0].length
      continue
    }
    let matchedOp: string | null = null
    for (const op of MULTI_CHAR_OPS) {
      if (source.startsWith(op, i)) {
        matchedOp = op
        break
      }
    }
    if (matchedOp) {
      tokens.push({ kind: 'op', value: matchedOp })
      i += matchedOp.length
      continue
    }
    if ('+-*/%()[]{},:?.<>!'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch })
      i += 1
      continue
    }
    throw new ExpressionError(`Unexpected character "${ch}" in expression.`)
  }
  tokens.push({ kind: 'eof' })
  return tokens
}

// ── Parser ───────────────────────────────────────────────────────────────

type AstNode =
  | { type: 'literal'; value: unknown }
  | { type: 'array'; elements: AstNode[] }
  | { type: 'object'; entries: Array<{ key: string; value: AstNode }> }
  | { type: 'root'; name: string }
  | { type: 'member'; object: AstNode; key: AstNode; optional: boolean; computed: boolean }
  | { type: 'call'; callee: AstNode; args: AstNode[] }
  | { type: 'unary'; op: string; arg: AstNode }
  | { type: 'binary'; op: string; left: AstNode; right: AstNode }
  | { type: 'ternary'; test: AstNode; then: AstNode; else: AstNode }

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function assertSafeKey(key: string): void {
  if (FORBIDDEN_KEYS.has(key)) {
    throw new ExpressionError(`Property "${key}" is not allowed in expressions.`)
  }
}

/** Roots an expression may start from. Anything else is rejected. */
const ROOT_NAMES = new Set([
  '$json',
  '$node',
  '$input',
  '$binary',
  '$workflow',
  '$now',
  '$today',
  '$vars',
  '$jmespath',
  'Math',
])

/** Bare functions callable without a receiver. */
const BARE_HELPERS = new Set(['String', 'Number', 'Boolean', 'parseInt', 'parseFloat'])

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]
  }

  private next(): Token {
    const token = this.tokens[this.pos]
    this.pos += 1
    return token
  }

  private isOp(value: string): boolean {
    const token = this.peek()
    return token.kind === 'op' && token.value === value
  }

  private eatOp(value: string): boolean {
    if (this.isOp(value)) {
      this.pos += 1
      return true
    }
    return false
  }

  private expectOp(value: string): void {
    if (!this.eatOp(value)) {
      throw new ExpressionError(`Expected "${value}" in expression.`)
    }
  }

  parseExpression(): AstNode {
    const node = this.parseTernary()
    if (this.peek().kind !== 'eof') {
      throw new ExpressionError('Unexpected extra input after expression.')
    }
    return node
  }

  private parseTernary(): AstNode {
    const test = this.parseNullish()
    if (!this.eatOp('?')) return test
    const then = this.parseTernary()
    this.expectOp(':')
    const elseBranch = this.parseTernary()
    return { type: 'ternary', test, then, else: elseBranch }
  }

  private parseNullish(): AstNode {
    let left = this.parseOr()
    while (this.eatOp('??')) {
      left = { type: 'binary', op: '??', left, right: this.parseOr() }
    }
    return left
  }

  private parseOr(): AstNode {
    let left = this.parseAnd()
    while (this.eatOp('||')) {
      left = { type: 'binary', op: '||', left, right: this.parseAnd() }
    }
    return left
  }

  private parseAnd(): AstNode {
    let left = this.parseEquality()
    while (this.eatOp('&&')) {
      left = { type: 'binary', op: '&&', left, right: this.parseEquality() }
    }
    return left
  }

  private parseEquality(): AstNode {
    let left = this.parseRelational()
    for (;;) {
      const token = this.peek()
      if (token.kind === 'op' && ['==', '!=', '===', '!=='].includes(token.value)) {
        this.next()
        left = { type: 'binary', op: token.value, left, right: this.parseRelational() }
      } else {
        return left
      }
    }
  }

  private parseRelational(): AstNode {
    let left = this.parseAdditive()
    for (;;) {
      const token = this.peek()
      if (token.kind === 'op' && ['<', '<=', '>', '>='].includes(token.value)) {
        this.next()
        left = { type: 'binary', op: token.value, left, right: this.parseAdditive() }
      } else {
        return left
      }
    }
  }

  private parseAdditive(): AstNode {
    let left = this.parseMultiplicative()
    for (;;) {
      const token = this.peek()
      if (token.kind === 'op' && (token.value === '+' || token.value === '-')) {
        this.next()
        left = { type: 'binary', op: token.value, left, right: this.parseMultiplicative() }
      } else {
        return left
      }
    }
  }

  private parseMultiplicative(): AstNode {
    let left = this.parseUnary()
    for (;;) {
      const token = this.peek()
      if (token.kind === 'op' && ['*', '/', '%'].includes(token.value)) {
        this.next()
        left = { type: 'binary', op: token.value, left, right: this.parseUnary() }
      } else {
        return left
      }
    }
  }

  private parseUnary(): AstNode {
    if (this.eatOp('-')) return { type: 'unary', op: '-', arg: this.parseUnary() }
    if (this.eatOp('!')) return { type: 'unary', op: '!', arg: this.parseUnary() }
    return this.parsePower()
  }

  private parsePower(): AstNode {
    const base = this.parsePostfix()
    if (this.eatOp('**')) {
      // Right-associative: 2 ** 3 ** 2 means 2 ** (3 ** 2).
      return { type: 'binary', op: '**', left: base, right: this.parseUnary() }
    }
    return base
  }

  private parsePostfix(): AstNode {
    let node = this.parsePrimary()
    for (;;) {
      if (this.eatOp('.')) {
        const token = this.next()
        if (token.kind !== 'ident') {
          throw new ExpressionError('Expected a property name after ".".')
        }
        assertSafeKey(token.value)
        node = {
          type: 'member',
          object: node,
          key: { type: 'literal', value: token.value },
          optional: false,
          computed: false,
        }
        continue
      }
      if (this.eatOp('?.')) {
        // Optional member access: ?.name or ?.[expr]
        if (this.eatOp('[')) {
          const key = this.parseTernary()
          this.expectOp(']')
          node = { type: 'member', object: node, key, optional: true, computed: true }
        } else {
          const token = this.next()
          if (token.kind !== 'ident') {
            throw new ExpressionError('Expected a property name after "?.".')
          }
          assertSafeKey(token.value)
          node = {
            type: 'member',
            object: node,
            key: { type: 'literal', value: token.value },
            optional: true,
            computed: false,
          }
        }
        continue
      }
      if (this.eatOp('[')) {
        const key = this.parseTernary()
        this.expectOp(']')
        node = { type: 'member', object: node, key, optional: false, computed: true }
        continue
      }
      if (this.isOp('(')) {
        const args = this.parseArgs()
        node = { type: 'call', callee: node, args }
        continue
      }
      return node
    }
  }

  private parseArgs(): AstNode[] {
    this.expectOp('(')
    const args: AstNode[] = []
    if (this.eatOp(')')) return args
    for (;;) {
      args.push(this.parseTernary())
      if (this.eatOp(',')) continue
      this.expectOp(')')
      return args
    }
  }

  private parsePrimary(): AstNode {
    const token = this.next()
    if (token.kind === 'number' || token.kind === 'string') {
      return { type: 'literal', value: token.value }
    }
    if (token.kind === 'op' && token.value === '(') {
      const inner = this.parseTernary()
      this.expectOp(')')
      return inner
    }
    if (token.kind === 'op' && token.value === '[') {
      const elements: AstNode[] = []
      if (this.eatOp(']')) return { type: 'array', elements }
      for (;;) {
        elements.push(this.parseTernary())
        if (this.eatOp(',')) {
          if (this.eatOp(']')) return { type: 'array', elements }
          continue
        }
        this.expectOp(']')
        return { type: 'array', elements }
      }
    }
    if (token.kind === 'op' && token.value === '{') {
      const entries: Array<{ key: string; value: AstNode }> = []
      if (this.eatOp('}')) return { type: 'object', entries }
      for (;;) {
        const keyToken = this.next()
        let key: string
        if (keyToken.kind === 'string') key = keyToken.value
        else if (keyToken.kind === 'ident') key = keyToken.value
        else throw new ExpressionError('Object keys must be names or quoted strings.')
        assertSafeKey(key)
        this.expectOp(':')
        entries.push({ key, value: this.parseTernary() })
        if (this.eatOp(',')) {
          if (this.eatOp('}')) return { type: 'object', entries }
          continue
        }
        this.expectOp('}')
        return { type: 'object', entries }
      }
    }
    if (token.kind === 'ident') {
      const name = token.value
      if (name === 'true') return { type: 'literal', value: true }
      if (name === 'false') return { type: 'literal', value: false }
      if (name === 'null') return { type: 'literal', value: null }
      if (name === '$env') {
        throw new ExpressionError(
          '$env is not available in expressions. Server environment is never exposed to workflow authors.',
        )
      }
      if (name.startsWith('$') && !ROOT_NAMES.has(name)) {
        throw new ExpressionError(`Unknown variable "${name}" in expression.`)
      }
      if (ROOT_NAMES.has(name)) return { type: 'root', name }
      if (BARE_HELPERS.has(name)) {
        // A bare helper with no call is not a value; parsePostfix will
        // turn `String(x)` into a call node. Anything else is an error.
        if (this.isOp('(')) return { type: 'root', name }
        throw new ExpressionError(`"${name}" can only be used as a function call, e.g. ${name}(value).`)
      }
      throw new ExpressionError(
        `"${name}" is not allowed in expressions. Only $json, $node, $input, $binary, $workflow, $now, $today, $vars, $jmespath, Math, and the helpers String, Number, Boolean, parseInt, parseFloat may be used.`,
      )
    }
    throw new ExpressionError('Unexpected input in expression.')
  }
}

// ── Evaluator ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

const STRING_METHODS = new Set([
  'toUpperCase',
  'toLowerCase',
  'trim',
  'trimStart',
  'trimEnd',
  'split',
  'substring',
  'slice',
  'startsWith',
  'endsWith',
  'includes',
  'indexOf',
  'lastIndexOf',
  'replace',
  'replaceAll',
  'charAt',
  'at',
  'toString',
  'repeat',
  'padStart',
  'padEnd',
])

const NUMBER_METHODS = new Set(['toFixed', 'toString'])
const BOOLEAN_METHODS = new Set(['toString'])
const ARRAY_METHODS = new Set(['join', 'includes', 'indexOf', 'slice', 'at'])
const DATE_METHODS = new Set([
  'toISOString',
  'toDateString',
  'toTimeString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'getFullYear',
  'getMonth',
  'getDate',
  'getDay',
  'getHours',
  'getMinutes',
  'getSeconds',
  'getMilliseconds',
  'getTime',
  'getUTCFullYear',
  'getUTCMonth',
  'getUTCDate',
  'getUTCDay',
  'getUTCHours',
  'getUTCMinutes',
  'getUTCSeconds',
  'getUTCMilliseconds',
])
const MATH_METHODS = new Set([
  'abs',
  'floor',
  'ceil',
  'round',
  'min',
  'max',
  'pow',
  'sqrt',
  'cbrt',
  'trunc',
  'sign',
  'hypot',
  'log',
  'exp',
])
const MATH_CONSTANTS = new Set(['PI', 'E'])

function mathValue(): Record<string, unknown> {
  return {
    abs: Math.abs,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    min: Math.min,
    max: Math.max,
    pow: Math.pow,
    sqrt: Math.sqrt,
    cbrt: Math.cbrt,
    trunc: Math.trunc,
    sign: Math.sign,
    hypot: Math.hypot,
    log: Math.log,
    exp: Math.exp,
    PI: Math.PI,
    E: Math.E,
  }
}

function rootValue(name: string, scope: ExpressionScope): unknown {
  switch (name) {
    case '$json':
      return scope.json
    case '$node':
      return scope.node
    case '$input':
      return scope.input
    case '$binary':
      return scope.binary
    case '$workflow':
      return scope.workflow
    case '$now':
      return scope.now
    case '$today':
      return scope.today
    case '$vars':
      return scope.vars
    case '$jmespath':
      return '$jmespath'
    case 'Math':
      return mathValue()
    case 'String':
    case 'Number':
    case 'Boolean':
    case 'parseInt':
    case 'parseFloat':
      return name
    default:
      throw new ExpressionError(`Unknown variable "${name}" in expression.`)
  }
}

function getProperty(receiver: unknown, key: unknown): unknown {
  // A missing intermediate value reads as undefined (the n8n-style
  // behaviour: $json.nope.deep is empty, not a crash). Calling a method
  // on it is still an error — see callMethod.
  if (receiver === null || receiver === undefined) return undefined
  const keyText = typeof key === 'string' ? key : String(key)
  assertSafeKey(keyText)
  if (typeof receiver === 'string') {
    if (keyText === 'length') return receiver.length
    throw new ExpressionError(`Property "${keyText}" is not available on a string.`)
  }
  if (typeof receiver === 'number' || typeof receiver === 'boolean') {
    throw new ExpressionError(`Property "${keyText}" is not available on a ${typeof receiver}.`)
  }
  if (Array.isArray(receiver)) {
    if (keyText === 'length') return receiver.length
    const index = Number(keyText)
    if (Number.isInteger(index) && index >= 0 && index < receiver.length) return receiver[index]
    if (Number.isInteger(index)) return undefined
    throw new ExpressionError(`Property "${keyText}" is not available on an array.`)
  }
  if (receiver instanceof Date) {
    throw new ExpressionError(`Property "${keyText}" is not available on a date; use a date method such as getFullYear().`)
  }
  if (isRecord(receiver)) {
    // Own properties only: inherited members such as toString or
    // hasOwnProperty are never reachable from an expression.
    if (Object.prototype.hasOwnProperty.call(receiver, keyText)) {
      return receiver[keyText]
    }
    return undefined
  }
  throw new ExpressionError(`Property "${keyText}" is not available here.`)
}

function callMethod(receiver: unknown, method: string, args: unknown[]): unknown {
  assertSafeKey(method)
  try {
    if (typeof receiver === 'string') {
      if (!STRING_METHODS.has(method)) {
        throw new ExpressionError(`String method "${method}" is not allowed.`)
      }
      const fn = (receiver as unknown as Record<string, unknown>)[method]
      if (typeof fn !== 'function') throw new ExpressionError(`String method "${method}" is not available.`)
      return (fn as (...a: unknown[]) => unknown).apply(receiver, args)
    }
    if (typeof receiver === 'number') {
      if (!NUMBER_METHODS.has(method)) {
        throw new ExpressionError(`Number method "${method}" is not allowed.`)
      }
      const fn = (receiver as unknown as Record<string, unknown>)[method]
      if (typeof fn !== 'function') throw new ExpressionError(`Number method "${method}" is not available.`)
      return (fn as (...a: unknown[]) => unknown).apply(receiver, args)
    }
    if (typeof receiver === 'boolean') {
      if (!BOOLEAN_METHODS.has(method)) {
        throw new ExpressionError(`Boolean method "${method}" is not allowed.`)
      }
      return String(receiver)
    }
    if (Array.isArray(receiver)) {
      if (!ARRAY_METHODS.has(method)) {
        throw new ExpressionError(`Array method "${method}" is not allowed.`)
      }
      const fn = (receiver as unknown as Record<string, unknown>)[method]
      if (typeof fn !== 'function') throw new ExpressionError(`Array method "${method}" is not available.`)
      return (fn as (...a: unknown[]) => unknown).apply(receiver, args)
    }
    if (receiver instanceof Date) {
      if (!DATE_METHODS.has(method)) {
        throw new ExpressionError(`Date method "${method}" is not allowed.`)
      }
      const fn = (receiver as unknown as Record<string, unknown>)[method]
      if (typeof fn !== 'function') throw new ExpressionError(`Date method "${method}" is not available.`)
      return (fn as (...a: unknown[]) => unknown).apply(receiver, args)
    }
    if (isRecord(receiver) && method in mathValue()) {
      // The Math object is the only record whose members are callable.
      if (!MATH_METHODS.has(method)) {
        throw new ExpressionError(`Math method "${method}" is not allowed.`)
      }
      const fn = mathValue()[method]
      if (typeof fn !== 'function') throw new ExpressionError(`Math method "${method}" is not available.`)
      return (fn as (...a: unknown[]) => unknown)(...args)
    }
  } catch (error) {
    if (error instanceof ExpressionError) throw error
    throw new ExpressionError(
      `Calling "${method}" failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }
  throw new ExpressionError(`Method "${method}" cannot be called on this value.`)
}

function callBareHelper(name: string, args: unknown[]): unknown {
  switch (name) {
    case 'String':
      if (args.length !== 1) throw new ExpressionError('String() takes exactly one argument.')
      return stringifyValue(args[0])
    case 'Number': {
      if (args.length !== 1) throw new ExpressionError('Number() takes exactly one argument.')
      const value = args[0]
      if (isRecord(value) || Array.isArray(value)) {
        throw new ExpressionError('Number() cannot convert an object or array.')
      }
      const num = Number(value)
      if (Number.isNaN(num)) throw new ExpressionError(`Number() cannot convert ${JSON.stringify(value)} to a number.`)
      return num
    }
    case 'Boolean':
      if (args.length !== 1) throw new ExpressionError('Boolean() takes exactly one argument.')
      return Boolean(args[0])
    case 'parseInt': {
      if (args.length < 1 || args.length > 2) throw new ExpressionError('parseInt() takes one or two arguments.')
      const num = parseInt(stringifyValue(args[0]), args[1] === undefined ? 10 : Number(args[1]))
      if (Number.isNaN(num)) throw new ExpressionError(`parseInt() cannot parse ${JSON.stringify(args[0])}.`)
      return num
    }
    case 'parseFloat': {
      if (args.length !== 1) throw new ExpressionError('parseFloat() takes exactly one argument.')
      const num = parseFloat(stringifyValue(args[0]))
      if (Number.isNaN(num)) throw new ExpressionError(`parseFloat() cannot parse ${JSON.stringify(args[0])}.`)
      return num
    }
    default:
      throw new ExpressionError(`"${name}" is not a callable helper.`)
  }
}

function evaluate(node: AstNode, scope: ExpressionScope): unknown {
  switch (node.type) {
    case 'literal':
      return node.value
    case 'array':
      return node.elements.map((element) => evaluate(element, scope))
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const entry of node.entries) {
        out[entry.key] = evaluate(entry.value, scope)
      }
      return out
    }
    case 'root':
      return rootValue(node.name, scope)
    case 'member': {
      const object = evaluate(node.object, scope)
      if ((object === null || object === undefined) && node.optional) return undefined
      const key = evaluate(node.key, scope)
      // Math constants (Math.PI, Math.E) are plain properties.
      if (
        isRecord(object) &&
        typeof key === 'string' &&
        MATH_CONSTANTS.has(key) &&
        node.object.type === 'root' &&
        node.object.name === 'Math'
      ) {
        return mathValue()[key]
      }
      return getProperty(object, key)
    }
    case 'call': {
      // $jmespath(data, 'query') or $jmespath('query') with $json as data.
      if (node.callee.type === 'root' && node.callee.name === '$jmespath') {
        const args = node.args.map((arg) => evaluate(arg, scope))
        if (args.length === 1) return evaluateJmespath(String(args[0]), scope.json)
        if (args.length === 2) return evaluateJmespath(String(args[1]), args[0])
        throw new ExpressionError("$jmespath takes one argument (a query, using $json) or two (data, query).")
      }
      // Bare helper call: String(x), Number(x), ...
      if (node.callee.type === 'root' && BARE_HELPERS.has(node.callee.name)) {
        const args = node.args.map((arg) => evaluate(arg, scope))
        return callBareHelper(node.callee.name, args)
      }
      // Method call: receiver.method(args).
      if (node.callee.type === 'member') {
        const member = node.callee
        const receiver = evaluate(member.object, scope)
        if ((receiver === null || receiver === undefined) && member.optional) return undefined
        const key = evaluate(member.key, scope)
        if (typeof key !== 'string') {
          throw new ExpressionError('Method names must be plain names, not computed values.')
        }
        const args = node.args.map((arg) => evaluate(arg, scope))
        return callMethod(receiver, key, args)
      }
      throw new ExpressionError('Only method calls and the helpers String, Number, Boolean, parseInt, parseFloat, and $jmespath may be called.')
    }
    case 'unary': {
      const value = evaluate(node.arg, scope)
      if (node.op === '-') {
        const num = Number(value)
        if (Number.isNaN(num)) throw new ExpressionError('Unary "-" needs a number.')
        return -num
      }
      return !value
    }
    case 'binary': {
      if (node.op === '&&') {
        const left = evaluate(node.left, scope)
        return left ? evaluate(node.right, scope) : left
      }
      if (node.op === '||') {
        const left = evaluate(node.left, scope)
        return left ? left : evaluate(node.right, scope)
      }
      if (node.op === '??') {
        const left = evaluate(node.left, scope)
        return left === null || left === undefined ? evaluate(node.right, scope) : left
      }
      const left = evaluate(node.left, scope)
      const right = evaluate(node.right, scope)
      switch (node.op) {
        case '+':
          if (typeof left === 'string' || typeof right === 'string') {
            return stringifyValue(left) + stringifyValue(right)
          }
          if (typeof left === 'number' && typeof right === 'number') return left + right
          if (left instanceof Date || right instanceof Date) {
            return stringifyValue(left) + stringifyValue(right)
          }
          throw new ExpressionError('The "+" operator needs numbers or strings.')
        case '-':
        case '*':
        case '/':
        case '%':
        case '**': {
          if (typeof left !== 'number' || typeof right !== 'number') {
            throw new ExpressionError(`The "${node.op}" operator needs numbers.`)
          }
          if (node.op === '-') return left - right
          if (node.op === '*') return left * right
          if (node.op === '/') return left / right
          if (node.op === '%') return left % right
          return left ** right
        }
        case '==':
          // Loose equality on plain values only (no object coercion games).
          return looseEqual(left, right)
        case '!=':
          return !looseEqual(left, right)
        case '===':
          return left === right
        case '!==':
          return left !== right
        case '<':
        case '>':
        case '<=':
        case '>=': {
          if (typeof left === 'number' && typeof right === 'number') {
            if (node.op === '<') return left < right
            if (node.op === '>') return left > right
            if (node.op === '<=') return left <= right
            return left >= right
          }
          if (typeof left === 'string' && typeof right === 'string') {
            if (node.op === '<') return left < right
            if (node.op === '>') return left > right
            if (node.op === '<=') return left <= right
            return left >= right
          }
          if (left instanceof Date && right instanceof Date) {
            if (node.op === '<') return left.getTime() < right.getTime()
            if (node.op === '>') return left.getTime() > right.getTime()
            if (node.op === '<=') return left.getTime() <= right.getTime()
            return left.getTime() >= right.getTime()
          }
          throw new ExpressionError(`The "${node.op}" operator needs two numbers, two strings, or two dates.`)
        }
        default:
          throw new ExpressionError(`Operator "${node.op}" is not supported.`)
      }
    }
    case 'ternary': {
      const test = evaluate(node.test, scope)
      return evaluate(test ? node.then : node.else, scope)
    }
  }
}

function looseEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || left === undefined || right === undefined) {
    return left === right || (left == null && right == null)
  }
  if (typeof left === 'number' && typeof right === 'string') return left === Number(right)
  if (typeof left === 'string' && typeof right === 'number') return Number(left) === right
  if (typeof left === 'boolean' && typeof right === 'number') return (left ? 1 : 0) === right
  if (typeof left === 'number' && typeof right === 'boolean') return left === (right ? 1 : 0)
  return false
}

function parseExpression(source: string): AstNode {
  const trimmed = source.trim()
  if (!trimmed) throw new ExpressionError('Expression is empty.')
  if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
    return parseExpression(trimmed.slice(2, -2))
  }
  return new Parser(tokenize(trimmed)).parseExpression()
}

// ── Public API ───────────────────────────────────────────────────────────

export function evaluateExpression(
  expression: string,
  scope: ExpressionScope,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const value = evaluate(parseExpression(expression), scope)
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Expression failed.' }
  }
}

/** How a value renders as text inside a larger template string. */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value) || isRecord(value)) return JSON.stringify(value)
  return String(value)
}

/** Find the `{{ ... }}` spans in a template, honouring quotes and `{` `}` nesting. */
function findTemplateSpans(template: string): Array<{ start: number; end: number; inner: string }> {
  const spans: Array<{ start: number; end: number; inner: string }> = []
  let i = 0
  while (i < template.length) {
    const open = template.indexOf('{{', i)
    if (open === -1) break
    let j = open + 2
    let depth = 0
    let quote: string | null = null
    let close = -1
    while (j < template.length) {
      const ch = template[j]
      if (quote) {
        if (ch === '\\') {
          j += 2
          continue
        }
        if (ch === quote) quote = null
        j += 1
        continue
      }
      if (ch === "'" || ch === '"') {
        quote = ch
        j += 1
        continue
      }
      if (ch === '{') {
        depth += 1
        j += 1
        continue
      }
      if (ch === '}') {
        if (depth > 0) {
          depth -= 1
          j += 1
          continue
        }
        if (template[j + 1] === '}') {
          close = j
          break
        }
        throw new ExpressionError('Unterminated expression: "{{" has no matching "}}".')
      }
      j += 1
    }
    if (close === -1) {
      throw new ExpressionError('Unterminated expression: "{{" has no matching "}}".')
    }
    spans.push({ start: open, end: close + 2, inner: template.slice(open + 2, close) })
    i = close + 2
  }
  return spans
}

/**
 * Render a template to its raw value. A template that is exactly one bare
 * `{{ expr }}` returns the expression's raw value (number, boolean, object,
 * …). Anything else returns the rendered string. Throws on a bad expression.
 */
export function renderTemplateValue(template: string, scope: ExpressionScope): unknown {
  const trimmed = template.trim()
  // A bare template is one span covering the whole template, ignoring
  // surrounding whitespace — its raw value is returned, not stringified.
  if (trimmed.startsWith('{{')) {
    const trimmedSpans = findTemplateSpans(trimmed)
    if (trimmedSpans.length === 1 && trimmedSpans[0].start === 0 && trimmedSpans[0].end === trimmed.length) {
      const result = evaluateExpression(trimmedSpans[0].inner, scope)
      if (!result.ok) throw new Error(result.error)
      return result.value
    }
  }
  const spans = findTemplateSpans(template)
  let out = ''
  let cursor = 0
  for (const span of spans) {
    out += template.slice(cursor, span.start)
    const result = evaluateExpression(span.inner, scope)
    if (!result.ok) throw new Error(result.error)
    out += stringifyValue(result.value)
    cursor = span.end
  }
  out += template.slice(cursor)
  return out
}

/**
 * Render a template to a string. A bare `{{ expr }}` is stringified; use
 * `renderTemplateValue` when the raw value matters (numbers/booleans).
 * Throws on a bad expression.
 */
export function renderTemplate(template: string, scope: ExpressionScope): string {
  return stringifyValue(renderTemplateValue(template, scope))
}

/**
 * Resolve every `{{ }}` template inside a node config, recursively through
 * strings, arrays, and nested objects. Bare `{{ expr }}` values keep their
 * raw type (a number stays a number); embedded templates render to text.
 * Values without `{{` pass through unchanged, and the input config is not
 * mutated. Throws on a bad template so the caller can fail the node
 * honestly instead of running with an unresolved value.
 */
export function resolveConfigTemplates(
  config: Record<string, unknown>,
  scope: ExpressionScope,
): Record<string, unknown> {
  const resolve = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.includes('{{') ? renderTemplateValue(value, scope) : value
    }
    if (Array.isArray(value)) return value.map((item) => resolve(item))
    if (value instanceof Date) return value
    if (isRecord(value)) {
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) out[key] = resolve(entry)
      return out
    }
    return value
  }
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(config)) out[key] = resolve(entry)
  return out
}

// ── JMESPath (small documented subset) ───────────────────────────────────

/**
 * JMESPath subset — enough for the common field-picking shapes, and honest
 * about the rest:
 *   Supported: dot paths (`a.b.c`), numeric indexes (`a[0]`), quoted keys
 *     (`a["b c"]`), wildcards (`a[*].b`, `a[*]`), and filters
 *     (`a[?active == true]`, `a[?status == 'open']`, `!=`).
 *   NOT supported (throws an error naming the gap): functions (`length(@)`,
 *     `keys(@)` …), pipes (`|`), multi-select lists/hashes (`[a, b]`,
 *     `{x: a}`), slices (`[0:2]`), the current-node token (`@`), and
 *     anything else outside the shapes above.
 * Missing fields return `null` (JMESPath behaviour), not `undefined`.
 */
export function evaluateJmespath(expression: string, data: unknown): unknown {
  const query = expression.trim()
  if (!query) throw new Error('JMESPath expression is empty.')
  if (/[|@`]/.test(query)) {
    throw new Error(
      `Unsupported JMESPath syntax in "${expression}": pipes, the "@" token, and backtick literals are not supported.`,
    )
  }
  if (/\b(length|keys|values|sort|join|contains|to_string|to_number|type|not_null|abs|avg|ceil|floor|max|min|sum|map|merge|reverse|starts_with|ends_with)\s*\(/.test(query)) {
    throw new Error(
      `Unsupported JMESPath syntax in "${expression}": JMESPath functions are not supported in this subset.`,
    )
  }
  if (query.includes('[') && /\[\s*[^0-9*?"'\]]/.test(query.replace(/\["(?:[^"\\]|\\.)*"\]/g, '').replace(/\['(?:[^'\\]|\\.)*'\]/g, ''))) {
    // A bracket that is not [n], [*], [?...], or a quoted key.
    if (!/\[\?/.test(query)) {
      throw new Error(
        `Unsupported JMESPath syntax in "${expression}": only numeric indexes, [*], quoted keys, and [? ... ] filters are supported.`,
      )
    }
  }
  const segments = splitJmespath(query)
  let current: unknown = data
  let project = false // true only right after a [*] wildcard segment
  for (const segment of segments) {
    current = applyJmespathSegment(current, segment, expression, project)
    // After [*] or a [?...] filter the value is an array, so a following
    // field projects over its elements.
    project = segment.kind === 'wildcard' || segment.kind === 'filter'
    if (current === undefined) return null
  }
  return current === undefined ? null : current
}

type JmespathSegment =
  | { kind: 'field'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'filter'; field: string; op: '==' | '!='; value: unknown }

function splitJmespath(query: string): JmespathSegment[] {
  const segments: JmespathSegment[] = []
  let i = 0
  const readField = (): string => {
    if (query[i] === '"' || query[i] === "'") {
      const quote = query[i]
      let j = i + 1
      let name = ''
      while (j < query.length && query[j] !== quote) {
        name += query[j] === '\\' && j + 1 < query.length ? query[++j] : query[j]
        j += 1
      }
      if (j >= query.length) throw new Error(`Unterminated quoted key in JMESPath "${query}".`)
      i = j + 1
      return name
    }
    const match = /^[A-Za-z0-9_-]+/.exec(query.slice(i))
    if (!match) throw new Error(`Unsupported JMESPath syntax in "${query}" near "${query.slice(i, i + 10)}".`)
    i += match[0].length
    return match[0]
  }
  while (i < query.length) {
    if (query[i] === '.') {
      i += 1
      continue
    }
    if (query[i] === '[') {
      const close = query.indexOf(']', i)
      if (close === -1) throw new Error(`Unterminated "[" in JMESPath "${query}".`)
      const inner = query.slice(i + 1, close).trim()
      if (inner === '*') {
        segments.push({ kind: 'wildcard' })
      } else if (/^\d+$/.test(inner)) {
        segments.push({ kind: 'index', index: Number(inner) })
      } else if (inner.startsWith('?')) {
        const filter = /^\?\s*([A-Za-z0-9_-]+)\s*(==|!=)\s*(.+)$/.exec(inner)
        if (!filter) {
          throw new Error(`Unsupported JMESPath filter in "${query}": only [?field == value] and [?field != value] are supported.`)
        }
        segments.push({ kind: 'filter', field: filter[1], op: filter[2] as '==' | '!=', value: parseJmespathLiteral(filter[3]) })
      } else if (
        (inner.startsWith('"') && inner.endsWith('"')) ||
        (inner.startsWith("'") && inner.endsWith("'"))
      ) {
        segments.push({ kind: 'field', name: inner.slice(1, -1) })
      } else {
        throw new Error(
          `Unsupported JMESPath syntax in "${query}": only [n], [*], ["key"], and [?field == value] brackets are supported.`,
        )
      }
      i = close + 1
      continue
    }
    segments.push({ kind: 'field', name: readField() })
  }
  return segments
}

function parseJmespathLiteral(raw: string): unknown {
  const text = raw.trim()
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1)
  }
  throw new Error(`Unsupported JMESPath filter value "${raw}": use a quoted string, a number, true, false, or null.`)
}

function applyJmespathSegment(
  current: unknown,
  segment: JmespathSegment,
  query: string,
  project: boolean,
): unknown {
  if (segment.kind === 'wildcard') {
    if (!Array.isArray(current)) return null
    return current
  }
  if (segment.kind === 'filter') {
    if (!Array.isArray(current)) return null
    return current.filter((item) => {
      if (!isRecord(item)) return false
      const actual = Object.prototype.hasOwnProperty.call(item, segment.field)
        ? item[segment.field]
        : null
      return segment.op === '==' ? actual === segment.value : actual !== segment.value
    })
  }
  if (Array.isArray(current)) {
    if (segment.kind === 'index') {
      return current[segment.index] ?? null
    }
    if (!project) return null
    // A field right after [*] is a projection: apply it to each element.
    return current.map((item) => {
      if (!isRecord(item)) return null
      if (!Object.prototype.hasOwnProperty.call(item, segment.name)) return null
      return item[segment.name]
    })
  }
  if (segment.kind === 'index') {
    throw new Error(`Unsupported JMESPath syntax in "${query}": index used on a non-array.`)
  }
  if (!isRecord(current)) return null
  if (!Object.prototype.hasOwnProperty.call(current, segment.name)) return null
  return current[segment.name]
}

/**
 * Condition evaluation for workflow Condition nodes — the one place in the
 * codebase that decides whether a workflow branches true or false.
 *
 * Both runtimes use this module, so a condition means the same thing
 * everywhere it runs:
 *   - `src/lib/workflow/executor.ts` (`/api/execute` single-agent runs)
 *   - `src/lib/orchestration/orchestrator.ts` (multi-agent runs)
 *   - `src/lib/workflow/nodeRunner.ts` (the single node dispatcher)
 *
 * Nothing here executes user input. A condition is data, not code: it is
 * parsed by a strict parser and evaluated against the allowlisted language
 * below. Anything outside that language is rejected with a plain error.
 * There is no dynamic code execution, no property access beyond the named
 * state field, and no way to reach `process.env`, `require`, `constructor`,
 * `fetch`, or any other global.
 *
 * Two call shapes, one language core:
 *   1. String expressions — `evaluateCondition(expression, state)` returns
 *      `{ ok, value }` / `{ ok: false, error }`. Atoms may be combined with
 *      `&&` and `||` (each atom is still allowlisted, so combining them
 *      cannot run code). This is the form the node runner uses.
 *   2. Node config objects — `evaluateCondition(config, state)` returns a
 *      boolean and throws on anything outside the grammar. The config form
 *      is a single comparison (structured `{ field, operator, value }` or
 *      one fixed-grammar string), or a compound of such comparisons joined
 *      by `&&` / `||` in the string form; this is the form save-time
 *      validation uses, so a saved workflow can never store a condition
 *      the engine cannot evaluate — and validation accepts exactly what
 *      the evaluator supports, including compounds.
 *
 * Allowed atoms (string form):
 *   true | false
 *   state                      — true when the input text is non-empty
 *   state == 'text' | state != 'text' (==/=== and !=/!== are the same here)
 *   state includes 'text' | state contains 'text' (aliases)
 *   state not_contains 'text' | state startsWith 'text' | state endsWith 'text'
 *   state.length > N | >= N | < N | <= N | == N | != N
 *
 * Anything else — identifiers like process, require, constructor, function
 * calls (including the `state.includes("x")` dot-call form), property access
 * other than the forms above — is rejected.
 */

export type ConditionResult = {
  ok: boolean
  value?: boolean
  error?: string
}

export type ConditionOperator =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'

export type ConditionField = 'state' | 'state.length'

export type ConditionSpec = {
  field: ConditionField
  operator: ConditionOperator
  value: string | number | boolean
}

/** A parsed condition: either a comparison, a constant true/false, or a compound of comparisons joined by && / ||. */
export type ParsedCondition =
  | { spec: ConditionSpec }
  | { constant: boolean }
  | { compound: { or: ParsedCondition[][] } }

// ── String-expression evaluator (node runner form) ───────────────────────

const STRING_COMPARISON = /^state\s*(===|!==|==|!=)\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")$/
const STRING_METHOD =
  /^state\s+(includes|contains|not_contains|startsWith|endsWith)\s*(?:\(\s*)?('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")(?:\s*\))?$/

function unquote(raw: string): string {
  const quote = raw[0]
  const inner = raw.slice(1, -1)
  return inner.replace(new RegExp(`\\\\${quote}`, 'g'), quote).replace(/\\\\/g, '\\')
}

function evalAtom(atom: string, state: string): ConditionResult {
  const text = atom.trim()
  if (text === 'state') return { ok: true, value: state.length > 0 }

  const lengthParts = text.match(/^state\.length\s*(===|!==|==|!=|>=|<=|>|<)\s*(-?\d+)$/)
  if (lengthParts) {
    const op = lengthParts[1]
    const n = Number(lengthParts[2])
    const len = state.length
    const value =
      op === '===' || op === '=='
        ? len === n
        : op === '!==' || op === '!='
          ? len !== n
          : op === '>='
            ? len >= n
            : op === '<='
              ? len <= n
              : op === '>'
                ? len > n
                : len < n
    return { ok: true, value }
  }

  const stringMatch = text.match(STRING_COMPARISON)
  if (stringMatch) {
    const expected = unquote(stringMatch[2])
    const equal = stringMatch[1] === '===' || stringMatch[1] === '=='
    return { ok: true, value: equal ? state === expected : state !== expected }
  }

  const methodMatch = text.match(STRING_METHOD)
  if (methodMatch) {
    const needle = unquote(methodMatch[2])
    if (methodMatch[1] === 'includes' || methodMatch[1] === 'contains')
      return { ok: true, value: state.includes(needle) }
    if (methodMatch[1] === 'not_contains') return { ok: true, value: !state.includes(needle) }
    if (methodMatch[1] === 'startsWith') return { ok: true, value: state.startsWith(needle) }
    return { ok: true, value: state.endsWith(needle) }
  }

  return {
    ok: false,
    error:
      `Unsupported condition expression: "${atom}". ` +
      `Only state, state ==/!= 'text', state includes/contains/not_contains/startsWith/endsWith 'text', ` +
      `and state.length comparisons are allowed; a whole condition may be exactly "true" or "false".`,
  }
}

function evaluateStringExpression(expression: string, state: string): ConditionResult {
  const trimmed = (expression ?? '').trim()
  if (!trimmed) return { ok: false, error: 'Condition expression is empty.' }
  // A whole condition may be exactly "true" / "false" — but a bare boolean
  // inside a compound (state == "x" || true) is a tautology bypass, never
  // a comparison, so it is rejected wherever it appears (same rule as the
  // config parser below; the node runner evaluates expression strings
  // through this path while the orchestrator uses the config path, and the
  // two must never disagree).
  if (trimmed === 'true') return { ok: true, value: true }
  if (trimmed === 'false') return { ok: true, value: false }
  // No parentheses, no semicolons, no identifiers beyond the allowlist.
  // Quoted values are stripped first, so a value containing ")" or ";"
  // (state includes('a)b')) is not mistaken for syntax.
  const withoutStrings = trimmed.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''")
  if (/[;()]/.test(withoutStrings.replace(/state\s+(includes|contains|not_contains|startsWith|endsWith)\s*\([^)]*\)/g, ''))) {
    return { ok: false, error: `Unsupported condition expression: "${expression}". Parentheses and extra syntax are not allowed.` }
  }

  // Split on top-level || first, then && inside each branch. The split is
  // quote-aware: a quoted value may itself contain "||" or "&&"
  // (state == 'a || b'), and splitting inside the quotes would corrupt it.
  const orBranches = splitOutsideQuotes(trimmed, '||')
  for (const branch of orBranches) {
    const atoms = splitOutsideQuotes(branch, '&&')
    let branchValue = true
    for (const atom of atoms) {
      const text = atom.trim()
      if (text === 'true' || text === 'false') {
        return {
          ok: false,
          error: `Bare "${text}" is not allowed inside a compound condition; use a comparison (e.g. state == "yes"). A whole condition may be exactly "true" or "false".`,
        }
      }
      const result = evalAtom(atom, state)
      if (!result.ok) return result
      if (!result.value) {
        branchValue = false
        break
      }
    }
    if (branchValue) return { ok: true, value: true }
  }
  return { ok: true, value: false }
}

/** Split on a separator that appears outside single/double quotes. */
function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = []
  let quote: string | null = null
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      current += ch
      if (ch === '\\' && i + 1 < text.length) {
        current += text[i + 1]
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (text.startsWith(separator, i)) {
      parts.push(current)
      current = ''
      i += separator.length - 1
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

// ── Config-object parser (save-validation form) ──────────────────────────

/** Substrings that are never allowed anywhere in a condition, defence in depth. */
const FORBIDDEN = [
  'process',
  'require',
  'constructor',
  'eval',
  'Function',
  'globalThis',
  'global',
  'fetch',
  '__proto__',
  'prototype',
  'import',
  'export',
  '=>',
  ';',
  '`',
  '${',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '\\',
]

function forbiddenReason(text: string): string | null {
  const lower = text.toLowerCase()
  for (const word of FORBIDDEN) {
    if (lower.includes(word.toLowerCase())) {
      return `Condition uses forbidden text "${word}". Conditions can only compare the state text or its length.`
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const STRING_OPERATORS: ConditionOperator[] = [
  '==',
  '!=',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
]
const NUMERIC_OPERATORS: ConditionOperator[] = ['==', '!=', '<', '<=', '>', '>=']
const ALL_OPERATORS: ConditionOperator[] = [
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
]

function parseLiteral(raw: string): string | number | boolean | null {
  const text = raw.trim()
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const num = Number(text)
    return Number.isFinite(num) ? num : null
  }
  const doubleQuoted = /^"((?:[^"\\]|\\["\\])*)"$/.exec(text)
  if (doubleQuoted) return doubleQuoted[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  const singleQuoted = /^'((?:[^'\\]|\\['\\])*)'$/.exec(text)
  if (singleQuoted) return singleQuoted[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  return null
}

/**
 * Parse a condition from a node's config into a structured spec.
 * Returns `{ spec }` on success or `{ error }` when the config is not a
 * condition this module can evaluate. Never throws on user input.
 * The string form accepts compounds joined by `&&` / `||` — the same
 * compounds the string-expression evaluator supports — so validation
 * accepts what evaluation accepts.
 */
export function parseCondition(
  config: Record<string, unknown> | undefined,
): ParsedCondition | { error: string } {
  if (!isRecord(config)) return { error: 'Condition node has no config.' }

  // Structured form: { condition: { field, operator, value } }
  // or the three keys directly on config.
  const raw = isRecord(config.condition) ? config.condition : config
  if (isRecord(raw) && ('field' in raw || 'operator' in raw || 'value' in raw)) {
    const field = raw.field
    // Aliases the string evaluator accepts: normalize to the canonical
    // operator so validation and evaluation agree on one grammar.
    const operator =
      raw.operator === 'includes'
        ? 'contains'
        : raw.operator === 'startsWith'
          ? 'starts_with'
          : raw.operator === 'endsWith'
            ? 'ends_with'
            : raw.operator
    const value = raw.value
    if (field !== 'state' && field !== 'state.length') {
      return { error: `Condition field must be "state" or "state.length", got ${JSON.stringify(field)}.` }
    }
    if (typeof operator !== 'string' || !(ALL_OPERATORS as string[]).includes(operator)) {
      return { error: `Condition operator must be one of ${ALL_OPERATORS.join(', ')}, got ${JSON.stringify(operator)}.` }
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return { error: 'Condition value must be a string, number, or boolean.' }
    }
    const spec: ConditionSpec = { field, operator: operator as ConditionOperator, value }
    return validateSpec(spec)
  }

  // String form: config.expression in the fixed grammar. Atoms may be
  // combined with && / || — the same compounds the string-expression
  // evaluator supports — so validation accepts what evaluation accepts.
  if (typeof config.expression === 'string') {
    const expression = config.expression.trim()
    if (expression === 'true') return { constant: true }
    if (expression === 'false') return { constant: false }
    const or: ParsedCondition[][] = []
    for (const branch of splitOutsideQuotes(expression, '||')) {
      const and: ParsedCondition[] = []
      for (const atom of splitOutsideQuotes(branch, '&&')) {
        const parsed = parseSingleStringExpression(atom.trim())
        if ('error' in parsed) return parsed
        // A bare true/false inside a compound is a tautology bypass, never
        // a comparison: the phase0 attack tests require it to be rejected
        // (state == "x" || true must not validate). A whole condition may
        // still be exactly "true" / "false" — that returns early above.
        if ('constant' in parsed) {
          return {
            error:
              'Bare true/false is not allowed inside a compound condition; use a comparison (e.g. state == "yes"). A whole condition may be exactly "true" or "false".',
          }
        }
        and.push(parsed)
      }
      or.push(and)
    }
    if (or.length === 1 && or[0].length === 1) return or[0][0]
    return { compound: { or } }
  }

  return {
    error:
      'Condition node needs a condition: { field, operator, value } or an expression like state == "yes".',
  }
}

/** Parse one comparison atom (no && / ||) from a condition string. */
function parseSingleStringExpression(expression: string): ParsedCondition | { error: string } {
  const trimmed = expression.trim()
  if (trimmed === 'true') return { constant: true }
  if (trimmed === 'false') return { constant: false }
  // The comparison value is data, never code: strip quoted literals
  // before the forbidden-text check, so a value like "important"
  // (which contains "import") is not refused for its wording.
  const forbidden = forbiddenReason(trimmed.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''"))
  if (forbidden) return { error: forbidden }
  const match =
    /^(state\.length|state)\s*(==|!=|<=|>=|<|>|contains|includes|not_contains|starts_with|startsWith|ends_with|endsWith)\s*(.+)$/.exec(
      trimmed,
    )
  if (!match) {
    return {
      error:
        'Condition expression is not in the allowed form. Use e.g. state == "yes", state contains "error", or state.length > 5.',
    }
  }
  const [, field, rawOperator, rawValue] = match
  // Same alias normalization as the structured form above.
  const operator =
    rawOperator === 'includes'
      ? 'contains'
      : rawOperator === 'startsWith'
        ? 'starts_with'
        : rawOperator === 'endsWith'
          ? 'ends_with'
          : rawOperator
  if (field === 'state.length' && !/^-?\d+(\.\d+)?$/.test(rawValue.trim())) {
    return { error: 'state.length can only be compared to a number.' }
  }
  const value = parseLiteral(rawValue)
  if (value === null) {
    return { error: 'Condition value must be a quoted string, a number, or true/false.' }
  }
  const spec: ConditionSpec = {
    field: field as ConditionField,
    operator: operator as ConditionOperator,
    value,
  }
  return validateSpec(spec)
}

function validateSpec(spec: ConditionSpec): { spec: ConditionSpec } | { error: string } {
  // The comparison value is NOT checked for forbidden text: it is data
  // that is only ever compared with === / includes / startsWith — it is
  // never parsed or executed — so a value like "important" or "global
  // warming" must not be refused for containing a forbidden substring.
  if (spec.field === 'state.length') {
    if (typeof spec.value !== 'number') {
      return { error: 'state.length can only be compared to a number.' }
    }
    if (!NUMERIC_OPERATORS.includes(spec.operator)) {
      return { error: `Operator "${spec.operator}" cannot be used on state.length; use ${NUMERIC_OPERATORS.join(', ')}.` }
    }
  } else if (typeof spec.value === 'number' || spec.operator === '<' || spec.operator === '<=' || spec.operator === '>' || spec.operator === '>=') {
    if (typeof spec.value === 'number') {
      return { error: 'Comparing the state text to a number is not allowed; use state.length for numeric comparisons.' }
    }
    return { error: `Operator "${spec.operator}" cannot be used on the state text; use state.length for numeric comparisons.` }
  } else if (!STRING_OPERATORS.includes(spec.operator)) {
    return { error: `Operator "${spec.operator}" cannot be used on the state text.` }
  }
  return { spec }
}

/** Returns an error message when the config is not a usable condition, else null. */
export function validateConditionConfig(config: Record<string, unknown> | undefined): string | null {
  const parsed = parseCondition(config)
  return 'error' in parsed ? parsed.error : null
}

function evaluateSpec(spec: ConditionSpec, state: string): boolean {
  const { field, operator, value } = spec
  if (field === 'state.length') {
    const length = state.length
    const num = value as number
    switch (operator) {
      case '==':
        return length === num
      case '!=':
        return length !== num
      case '<':
        return length < num
      case '<=':
        return length <= num
      case '>':
        return length > num
      case '>=':
        return length >= num
      default:
        throw new Error(`Operator "${operator}" cannot be used on state.length.`)
    }
  }
  if (typeof value === 'boolean') {
    const stateBool = state.trim() === 'true'
    if (operator === '==') return stateBool === value
    if (operator === '!=') return stateBool !== value
    throw new Error(`Operator "${operator}" cannot be used with a true/false value.`)
  }
  const text = value as string
  switch (operator) {
    case '==':
      return state === text
    case '!=':
      return state !== text
    case 'contains':
      return state.includes(text)
    case 'not_contains':
      return !state.includes(text)
    case 'starts_with':
      return state.startsWith(text)
    case 'ends_with':
      return state.endsWith(text)
    default:
      throw new Error(`Operator "${operator}" cannot be used on the state text.`)
  }
}

/**
 * Evaluate a condition expression against the current state string.
 * String form returns { ok, value } / { ok: false, error }.
 * Config-object form returns a boolean and throws on invalid input.
 */
export function evaluateCondition(expression: string, state: string): ConditionResult
export function evaluateCondition(
  config: Record<string, unknown> | undefined,
  state: string,
): boolean
export function evaluateCondition(
  input: string | Record<string, unknown> | undefined,
  state: string,
): ConditionResult | boolean {
  if (typeof input === 'string') return evaluateStringExpression(input, state)
  const parsed = parseCondition(input)
  if ('error' in parsed) throw new Error(parsed.error)
  return evaluateParsed(parsed, state)
}

/** Evaluate a parsed condition (single spec, constant, or compound). */
function evaluateParsed(parsed: ParsedCondition, state: string): boolean {
  if ('constant' in parsed) return parsed.constant
  if ('compound' in parsed) {
    // || over branches, && inside each branch — the same precedence the
    // string-expression evaluator uses, so compounds branch identically
    // on every execution path.
    for (const branch of parsed.compound.or) {
      let branchValue = true
      for (const part of branch) {
        if (!evaluateParsed(part, state)) {
          branchValue = false
          break
        }
      }
      if (branchValue) return true
    }
    return false
  }
  return evaluateSpec(parsed.spec, state)
}

/**
 * Validate every Condition node in a workflow graph. Returns an error
 * message for the first bad node, else null. Non-condition nodes are not
 * checked here.
 */
export function validateWorkflowGraph(graph: unknown): string | null {
  if (!isRecord(graph)) return 'Workflow must be an object with nodes and edges.'
  if (!Array.isArray(graph.nodes)) return 'Workflow nodes must be an array.'
  for (const node of graph.nodes as Array<Record<string, unknown>>) {
    if (!isRecord(node)) return 'Each workflow node must be an object.'
    if (node.type !== 'condition') continue
    const error = validateConditionConfig(isRecord(node.config) ? node.config : undefined)
    if (error) return `Condition node "${String(node.name || node.id || '')}": ${error}`
  }
  return null
}

export type WorkflowEdgeLike = { source: string; target: string; label?: string }

/**
 * Branch selection lives in exactly one place — `branching.ts` — and is
 * re-exported here so existing imports keep working. Every execution path
 * (string executor, item executor, orchestrator sequential + parallel)
 * calls this same function; see the module header of `branching.ts`.
 */
export { chooseBranchEdge } from './branching'

/** All node ids reachable downstream from any of the given start ids. */
export function collectDownstreamIds(
  edges: WorkflowEdgeLike[],
  startIds: string[],
): Set<string> {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    const list = outgoing.get(edge.source) || []
    list.push(edge.target)
    outgoing.set(edge.source, list)
  }
  const seen = new Set<string>()
  const queue = [...startIds]
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const next of outgoing.get(id) || []) queue.push(next)
  }
  return seen
}

/**
 * Code node — runs a short JavaScript snippet over the items.
 *
 * The snippet runs in a `node:vm` context that contains NOTHING from the
 * host realm. The `items` data is built INSIDE the context
 * (`JSON.parse` of a JSON string, run as a host-supplied setup script),
 * so `items.constructor` is the in-context Array and
 * `.constructor.constructor` is the in-context Function — which cannot
 * generate code because the context is created with
 * `codeGeneration: { strings: false, wasm: false }`. The user code itself
 * runs in strict mode (so bare `this` is `undefined`, closing the
 * `this.constructor` path), the in-context `Object`/`Array`/`Function`
 * prototypes are frozen (so prototype pollution cannot reach anything),
 * and the result is serialised to a JSON string INSIDE the context and
 * only parsed on the host — the host never touches a live object the
 * snippet created, so a hostile getter cannot run host code either.
 *
 * There is no `process`, `require`, `globalThis.process`, `fetch`, or
 * filesystem access in the context. The snippet may `return` a new items
 * array, or mutate `items` in place and return nothing.
 *
 * This was a real escape before this fix (Lane C, C-1): the old code
 * built the items array in the host realm and handed it into the
 * context, so `items.constructor.constructor('return process')()` was
 * the host Function and returned the host `process` object. Re-tested
 * with all four Lane C payloads plus
 * `process.mainModule.require('child_process')` — all five are blocked.
 */

import vm from 'node:vm'
import { itemFromJson, type WorkflowItem } from '@/lib/nodes/items'
import type { NodeExecutor } from './context'

function toItems(value: unknown, fallback: WorkflowItem[]): WorkflowItem[] {
  if (!Array.isArray(value)) return fallback
  return value.map((entry, index) => {
    if (entry && typeof entry === 'object' && 'json' in (entry as Record<string, unknown>)) {
      const raw = entry as WorkflowItem
      const next = itemFromJson(
        raw.json && typeof raw.json === 'object' ? raw.json : {},
        raw.pairedItem ?? index,
      )
      if (raw.binary) next.binary = raw.binary
      if (raw.metadata) next.metadata = raw.metadata
      if (raw.error) next.error = raw.error
      return next
    }
    if (entry && typeof entry === 'object') {
      return itemFromJson(entry as Record<string, unknown>, index)
    }
    return itemFromJson({ value: entry }, index)
  })
}

const VM_TIMEOUT_MS = 5000

export const executeCodeNode: NodeExecutor = async ({ config, items }) => {
  // The builder historically saved the JavaScript under `jsCode` (the node
  // description's property name); the executor reads `code`. Accept both so
  // workflows saved from the builder actually run (D-1: builder Code steps
  // could never execute); `code` wins when both are present. New saves
  // write `code` (see descriptions/core.ts).
  const code =
    typeof config.code === 'string'
      ? config.code
      : typeof (config as Record<string, unknown>).jsCode === 'string'
        ? ((config as Record<string, unknown>).jsCode as string)
        : ''
  if (!code.trim()) {
    throw new Error('Code node needs config.code with the JavaScript to run.')
  }
  const dataJson = JSON.stringify(items ?? [])
  // A fresh context with NO host-realm objects in it. Object.create(null)
  // means even the sandbox object itself carries no host prototype.
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  })
  let outJson: string
  try {
    // Harden the in-context intrinsics first: a snippet that tries to
    // pollute Object.prototype (e.g. via __proto__) gets an error instead
    // of a foothold.
    vm.runInContext(
      `'use strict'; Object.freeze(Object.prototype); Object.freeze(Array.prototype); Object.freeze(Function.prototype);`,
      context,
      { timeout: VM_TIMEOUT_MS },
    )
    // Build the data inside the context. The JSON text is a host string,
    // but JSON.parse runs in-context, so every object it creates belongs
    // to the context's realm — never the host's.
    vm.runInContext(`var items = JSON.parse(${JSON.stringify(dataJson)});`, context, {
      timeout: VM_TIMEOUT_MS,
    })
    // Run the snippet in strict mode and serialise the outcome inside the
    // context, so the host only ever receives a plain string.
    vm.runInContext(
      `var __result = (function () { 'use strict';\n${code}\n})(); var __out = JSON.stringify(__result === undefined ? items : __result);`,
      context,
      { timeout: VM_TIMEOUT_MS },
    )
    const raw = vm.runInContext('__out', context, { timeout: VM_TIMEOUT_MS })
    if (typeof raw !== 'string') throw new Error('Code node returned no output.')
    outJson = raw
  } catch (error) {
    // Errors thrown inside the vm context come from another realm, so
    // `instanceof Error` does not hold for them — read the message off
    // the thrown value instead.
    const message =
      error instanceof Error
        ? error.message
        : error && typeof error === 'object' && 'message' in error
          ? String((error as { message: unknown }).message)
          : 'Code node failed.'
    throw new Error(`Code node failed: ${message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(outJson)
  } catch {
    throw new Error('Code node failed: output was not valid JSON.')
  }
  const cloned: WorkflowItem[] = JSON.parse(dataJson)
  return { items: toItems(parsed, cloned) }
}

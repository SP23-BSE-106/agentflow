/**
 * Items cases (Lane H): the WorkflowItem shape and its helpers.
 * No database, no network — pure functions, real behaviour.
 */
'use strict'

const { test, assert } = require('../harness.cjs')
const { itemFromText, itemsToText, itemFromJson } = require('@/lib/nodes/items')

test('itemFromText wraps text as { json: { input } }', () => {
  const item = itemFromText('hello')
  assert.deepStrictEqual(item, { json: { input: 'hello' } })
})

test('itemsToText returns the first item json.input as a string', () => {
  assert.strictEqual(itemsToText([itemFromText('abc'), itemFromText('def')]), 'abc')
})

test('itemsToText stringifies the first json when there is no input field', () => {
  assert.strictEqual(
    itemsToText([itemFromJson({ score: 42, name: 'x' })]),
    JSON.stringify({ score: 42, name: 'x' }),
  )
})

test('itemsToText returns empty string for no items', () => {
  assert.strictEqual(itemsToText([]), '')
})

test('itemFromJson keeps the payload and the pairedItem lineage', () => {
  const item = itemFromJson({ a: 1 }, { item: 2, input: 0 })
  assert.deepStrictEqual(item.json, { a: 1 })
  assert.deepStrictEqual(item.pairedItem, { item: 2, input: 0 })
})

test('itemFromJson without pairedItem has no pairedItem key', () => {
  const item = itemFromJson({ a: 1 })
  assert.strictEqual('pairedItem' in item, false)
})

test('items carry binary and error fields when set', () => {
  const item = itemFromJson({ a: 1 })
  item.binary = { file: { data: 'aGVsbG8=', mimeType: 'text/plain', fileName: 'hello.txt' } }
  item.error = { message: 'boom', node: 'HTTP' }
  assert.strictEqual(item.binary.file.mimeType, 'text/plain')
  assert.strictEqual(item.error.message, 'boom')
})

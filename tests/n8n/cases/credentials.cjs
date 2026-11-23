/**
 * Credential cases (Lane H): encrypted storage, never-plaintext,
 * list without secrets, delete, and a test that really checks.
 */
'use strict'

const http = require('node:http')
const { test, assert, dbFake } = require('../harness.cjs')
const {
  saveCredential,
  getCredential,
  listCredentials,
  deleteCredential,
  testCredential,
} = require('@/lib/credentials/store')

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

test('save + get round-trips fields through AES-256-GCM', async () => {
  const id = await saveCredential('user-a', 'httpBasicAuth', 'My API', {
    username: 'alice',
    password: 's3cret-password',
  })
  assert.strictEqual(typeof id, 'string')
  assert.ok(id.length > 0)
  const loaded = await getCredential('user-a', id)
  assert.ok(loaded)
  assert.strictEqual(loaded.type, 'httpBasicAuth')
  assert.strictEqual(loaded.name, 'My API')
  assert.strictEqual(loaded.fields.username, 'alice')
  assert.strictEqual(loaded.fields.password, 's3cret-password')
})

test('stored credential data is encrypted, never plaintext', async () => {
  const id = await saveCredential('user-a', 'httpBasicAuth', 'My API', {
    username: 'alice',
    password: 's3cret-password',
  })
  const rows = dbFake.__dump('credentials')
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0]._id.toString(), id)
  assert.strictEqual(typeof rows[0].data, 'string')
  assert.ok(!rows[0].data.includes('s3cret-password'), 'plaintext password found in stored data')
  assert.ok(!rows[0].data.includes('alice'), 'plaintext username found in stored data')
})

test('listCredentials returns id/type/name only, never secret fields', async () => {
  await saveCredential('user-a', 'httpHeaderAuth', 'Header Key', { name: 'X-Key', value: 'top-secret' })
  const list = await listCredentials('user-a')
  assert.strictEqual(list.length, 1)
  assert.deepStrictEqual(Object.keys(list[0]).sort(), ['id', 'name', 'type'])
  assert.strictEqual(JSON.stringify(list).includes('top-secret'), false)
})

test('saveCredential rejects missing required fields', async () => {
  await assert.rejects(
    saveCredential('user-a', 'httpBasicAuth', 'Bad', { username: 'alice' }),
    /Missing required field/,
  )
})

test('getCredential is scoped to the owning user', async () => {
  const id = await saveCredential('user-a', 'httpBasicAuth', 'Mine', { username: 'a', password: 'p' })
  assert.strictEqual(await getCredential('user-b', id), null)
  assert.strictEqual(await getCredential('user-a', 'not-an-object-id'), null)
})

test('deleteCredential removes the record and returns true, then false', async () => {
  const id = await saveCredential('user-a', 'httpBasicAuth', 'Temp', { username: 'a', password: 'p' })
  assert.strictEqual(await deleteCredential('user-a', id), true)
  assert.strictEqual(await getCredential('user-a', id), null)
  assert.strictEqual(await deleteCredential('user-a', id), false)
  assert.strictEqual(await deleteCredential('user-b', id), false)
})

test('testCredential fails honestly when required fields are missing', async () => {
  const result = await testCredential('httpBasicAuth', { username: 'alice' })
  assert.strictEqual(result.ok, false)
  assert.match(result.message, /password/)
})

test('testCredential reaches a real base URL and reports it', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    const { port } = server.address()
    const result = await testCredential('oAuth2Api', {
      clientId: 'id',
      clientSecret: 'secret',
      baseUrl: `http://127.0.0.1:${port}/health`,
    })
    assert.strictEqual(result.ok, true)
    assert.match(result.message, /Reached/)
  } finally {
    server.close()
  }
})

test('testCredential fails honestly when the base URL cannot be reached', async () => {
  const result = await testCredential('oAuth2Api', {
    clientId: 'id',
    clientSecret: 'secret',
    baseUrl: 'http://127.0.0.1:9/unreachable',
  })
  assert.strictEqual(result.ok, false)
  assert.match(result.message, /Could not reach/)
})

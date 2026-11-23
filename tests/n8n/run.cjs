/**
 * n8n test entry point.
 *
 * Usage: npm run test:n8n
 * (tsc compiles the modules under test into out/, then this file installs
 * the require hook, loads every case file present in cases/, and runs
 * them in order. Case files written by other lanes — registry.cjs,
 * expression.cjs, triggers.cjs — are picked up automatically when they
 * exist; missing ones are skipped, not failed.)
 */
'use strict'

// The crypto helper reads its key at module load, so the test key must be
// set before any compiled product code is required.
process.env.ENCRYPTION_KEY = 'n8n-test-encryption-key'

// The SSRF guard refuses loopback by default (Lane A3); n8n cases fetch
// from a local server, so the suite opts in explicitly.
process.env.ALLOW_LOOPBACK_FETCH = 'true'

require('./hooks.cjs')

const fs = require('node:fs')
const path = require('node:path')

const { run } = require('./harness.cjs')

const casesDir = path.join(__dirname, 'cases')
const caseFiles = fs
  .readdirSync(casesDir)
  .filter((file) => file.endsWith('.cjs'))
  .sort()

if (caseFiles.length === 0) {
  console.log('No n8n case files found.')
  process.exit(0)
}

for (const file of caseFiles) {
  require(path.join(casesDir, file))
}

run()

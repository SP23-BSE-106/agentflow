/**
 * Phase 3 test entry point.
 *
 * Usage: npm run test:phase3
 * (tsc compiles the handlers under test into out/, then this file installs
 * the require hook, loads every case file, and runs them in order.)
 */
'use strict'

// The SSRF guard refuses loopback by default (Lane A3); phase-3 cases fetch
// from a local server, so the suite opts in explicitly.
process.env.ALLOW_LOOPBACK_FETCH = 'true'

require('./hooks.cjs')

const { run } = require('./harness.cjs')

require('./cases/stripe.cjs')
require('./cases/subscription.cjs')
require('./cases/approvals.cjs')
require('./cases/agents.cjs')
require('./cases/generate.cjs')
require('./cases/rag.cjs')
require('./cases/auth.cjs')
require('./cases/builder.cjs')
require('./cases/idor.cjs')
require('./cases/team-supervisor-lead.cjs')
require('./cases/team-blackboard.cjs')
require('./cases/team-blackboard-context.cjs')
require('./cases/team-supervisor-plumbing.cjs')
require('./cases/welcome.cjs')

run()

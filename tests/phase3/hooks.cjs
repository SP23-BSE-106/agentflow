/**
 * Require hook for the Phase 3 tests (tests/phase3). Installed by run.cjs
 * before any compiled product code is loaded.
 *
 * - '@/lib/mongo/mongo' -> in-memory fake DB (fakes/db.cjs)
 * - '@/lib/stripe' -> Stripe fake with real HMAC signature checks
 * - '@/lib/auth/jwt' -> fixed test tokens (tok-user-a / tok-user-b)
 * - '@/utils/mailer' -> capturing mailer fake
 * - '@/lib/llm' -> canned completion fake
 * - '@/lib/rag/embeddings' -> fixed-vector embeddings fake
 * - 'next/server' -> Response-based NextResponse stand-in
 * - every other '@/...' specifier -> the compiled file under out/src/...
 * - everything else (mongodb, bcryptjs, node builtins) loads for real.
 */
'use strict'

const Module = require('module')
const path = require('path')

const OUT_ROOT = path.join(__dirname, 'out', 'src')

const FAKES = {
  'next/server': './fakes/next-server.cjs',
  '@/lib/mongo/mongo': './fakes/db.cjs',
  '@/lib/stripe': './fakes/stripe.cjs',
  '@/lib/auth/jwt': './fakes/jwt.cjs',
  '@/utils/mailer': './fakes/mailer.cjs',
  '@/lib/llm': './fakes/llm.cjs',
  '@/lib/rag/embeddings': './fakes/embeddings.cjs',
}

const originalLoad = Module._load

Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(FAKES, request)) {
    return originalLoad.call(this, path.join(__dirname, FAKES[request]), parent, isMain)
  }
  if (typeof request === 'string' && request.startsWith('@/')) {
    const rel = request.slice(2)
    return originalLoad.call(this, path.join(OUT_ROOT, rel), parent, isMain)
  }
  return originalLoad.apply(this, arguments)
}

import { NextResponse } from 'next/server'

/**
 * One honest mapping from a thrown error to a client-facing response.
 *
 * Lane A3 (authenticated build, FIX-EVERYTHING): route handlers used to let
 * throws escape as an empty HTTP 500, or echoed the raw error message — which leaked
 * server config (`MONGODB_URI is not set`, `Missing SMTP_* ...`) to the
 * caller. Handlers in the authenticated API funnel unhandled throws through
 * here (via the catch-all dispatchers), so a failure is always a JSON body
 * with a truthful status:
 *
 *   · the database is down or unconfigured  -> 503, plain-words message
 *   · saving an API key with no server key  -> 503, plain-words message
 *   · anything else                          -> 500, generic message
 *
 * The real error still goes to the server log (callers log it before they
 * call this), so debugging loses nothing — only the client stops seeing it.
 */

const DB_ERROR_PATTERNS = [
  'MONGODB_URI is not set',
  'MONGODB_URI',
  'MongoServerError',
  'MongoNetworkError',
  'MongoServerSelectionError',
  'MongoTopologyClosedError',
  'failed to connect to server',
  'Topology is closed',
  'ECONNREFUSED',
]

/** True when the error means the database cannot be reached/configured. */
export function isDbError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return DB_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
}

/** True when the error means no server encryption key is configured. */
export function isMissingEncryptionKey(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('ENCRYPTION_KEY (or JWT_SECRET)')
}

/**
 * Map a thrown error to its honest JSON response. `fallback` is the generic
 * message used for errors that are not a database or key-setup problem.
 */
export function errorResponse(
  error: unknown,
  fallback = 'Something went wrong. Try again.',
): NextResponse {
  if (isDbError(error)) {
    return NextResponse.json(
      { error: 'The database is not available right now. Try again in a moment.' },
      { status: 503 },
    )
  }
  if (isMissingEncryptionKey(error)) {
    return NextResponse.json(
      {
        error:
          'Saving an API key is not set up on this server yet. The person who runs this server needs to finish the setup first.',
      },
      { status: 503 },
    )
  }
  return NextResponse.json({ error: fallback }, { status: 500 })
}

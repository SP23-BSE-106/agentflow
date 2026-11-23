import crypto from 'crypto'

/** SHA-256 hash of a single-use token. Only the hash is ever stored. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/** A fresh single-use token (64 hex chars, 256 bits of entropy). */
export function newToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

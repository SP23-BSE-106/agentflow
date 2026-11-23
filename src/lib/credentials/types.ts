/**
 * Credential types (n8n §5 of the feature map).
 *
 * A credential type is a shape: a name, a display name, and the fields a
 * credential of that type carries, with which fields are required and which
 * are secret (encrypted at rest — every field is, the `secret` flag only
 * documents which values must never be returned by list endpoints).
 * The three generic types below cover the HTTP nodes; integration nodes
 * add their own types here later.
 */

export type CredentialField = {
  name: string
  displayName: string
  type: 'string' | 'password'
  required?: boolean
  secret?: boolean
}

export type CredentialType = {
  name: string
  displayName: string
  properties: CredentialField[]
}

export const CREDENTIAL_TYPES: Record<string, CredentialType> = {
  httpBasicAuth: {
    name: 'httpBasicAuth',
    displayName: 'Basic Auth',
    properties: [
      { name: 'username', displayName: 'Username', type: 'string', required: true },
      { name: 'password', displayName: 'Password', type: 'password', required: true, secret: true },
    ],
  },
  httpHeaderAuth: {
    name: 'httpHeaderAuth',
    displayName: 'Header Auth',
    properties: [
      { name: 'name', displayName: 'Header name', type: 'string', required: true },
      { name: 'value', displayName: 'Header value', type: 'password', required: true, secret: true },
    ],
  },
  oAuth2Api: {
    name: 'oAuth2Api',
    displayName: 'OAuth2 API',
    properties: [
      { name: 'clientId', displayName: 'Client ID', type: 'string', required: true },
      { name: 'clientSecret', displayName: 'Client Secret', type: 'password', required: true, secret: true },
      { name: 'accessToken', displayName: 'Access Token', type: 'password', secret: true },
      { name: 'tokenUrl', displayName: 'Token URL', type: 'string' },
      { name: 'baseUrl', displayName: 'Base URL', type: 'string' },
    ],
  },
}

/** Names of the fields a credential type requires to be present. */
export function requiredFields(type: string): string[] {
  return (CREDENTIAL_TYPES[type]?.properties ?? [])
    .filter((field) => field.required)
    .map((field) => field.name)
}

/** Validate that all required fields for a type are present and non-empty. */
export function validateCredentialFields(
  type: string,
  fields: Record<string, unknown>,
): { ok: boolean; missing: string[] } {
  const missing = requiredFields(type).filter((name) => {
    const value = fields[name]
    return value === undefined || value === null || (typeof value === 'string' && !value.trim())
  })
  return { ok: missing.length === 0, missing }
}

import type { XCredentials } from '../credentials.js'

/**
 * X OAuth 2.0 with PKCE - the only grant that yields a user-context token for
 * POST /2/tweets and POST /2/media/upload.
 *
 * The operator (or the dev, for a delegated account) is sent to authorizeUrl();
 * X redirects back with a code; exchange() turns it into credentials that the
 * AccountCredentialStore keeps. refresh() is called by the transport when the
 * access token is near expiry. Confidential clients (a clientSecret is
 * configured) authenticate the token endpoint with HTTP basic auth; public
 * clients send client_id in the form body, as the spec requires.
 *
 * Nothing here is model-reachable. State and PKCE verifier generation belong to
 * the caller that owns the browser round-trip.
 */

export const X_OAUTH_SCOPES = [
  'tweet.read',
  'tweet.write',
  'users.read',
  'media.write',
  'offline.access',
] as const

export class XOAuthError extends Error {
  constructor(
    message: string,
    readonly code: 'unreachable' | 'rejected' | 'malformed_response',
    override readonly cause?: unknown,
  ) {
    super(`x oauth: ${message}`)
    this.name = 'XOAuthError'
  }
}

export interface XOAuth2Client {
  authorizeUrl(state: string, codeChallenge: string, scopes: readonly string[]): string
  exchange(code: string, codeVerifier: string): Promise<XCredentials>
  refresh(refreshToken: string): Promise<XCredentials>
}

export interface XOAuth2Options {
  clientId: string
  clientSecret?: string
  redirectUri: string
  fetch?: typeof fetch
  /** API origin. The token endpoint is `${baseUrl}/2/oauth2/token`. */
  baseUrl?: string
  nowUnix?: () => number
}

const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize'

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  scope?: unknown
}

export function createXOAuth2Client(options: XOAuth2Options): XOAuth2Client {
  const doFetch = options.fetch ?? globalThis.fetch
  const tokenUrl = `${options.baseUrl ?? 'https://api.x.com'}/2/oauth2/token`
  const now = options.nowUnix ?? (() => Math.floor(Date.now() / 1000))

  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (options.clientSecret !== undefined) {
    headers.authorization = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`
  }

  async function token(form: Record<string, string>): Promise<XCredentials> {
    const body = new URLSearchParams(form)
    // Public clients identify themselves in the body; confidential ones already did in the header.
    if (options.clientSecret === undefined) body.set('client_id', options.clientId)

    let response: Response
    try {
      response = await doFetch(tokenUrl, { method: 'POST', headers, body })
    } catch (cause) {
      throw new XOAuthError('token endpoint unreachable', 'unreachable', cause)
    }
    const requestedAt = now()
    const parsed = (await response.json().catch(() => null)) as TokenResponse | null
    if (!response.ok) {
      throw new XOAuthError(`token endpoint rejected ${form.grant_type}: ${response.status}`, 'rejected')
    }
    if (
      parsed === null ||
      typeof parsed.access_token !== 'string' ||
      parsed.access_token.length === 0 ||
      typeof parsed.expires_in !== 'number' ||
      !Number.isFinite(parsed.expires_in) ||
      parsed.expires_in <= 0
    ) {
      throw new XOAuthError('token response lacks access_token/expires_in', 'malformed_response')
    }
    if (parsed.refresh_token !== undefined && typeof parsed.refresh_token !== 'string') {
      throw new XOAuthError('refresh_token is not a string', 'malformed_response')
    }
    return {
      accessToken: parsed.access_token,
      refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : null,
      expiresAtUnix: requestedAt + Math.floor(parsed.expires_in),
      scopes: typeof parsed.scope === 'string' ? parsed.scope.split(' ').filter((s) => s.length > 0) : [],
    }
  }

  return {
    authorizeUrl(state, codeChallenge, scopes) {
      const url = new URL(AUTHORIZE_URL)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', options.clientId)
      url.searchParams.set('redirect_uri', options.redirectUri)
      url.searchParams.set('scope', scopes.join(' '))
      url.searchParams.set('state', state)
      url.searchParams.set('code_challenge', codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return url.toString()
    },
    exchange(code, codeVerifier) {
      return token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: options.redirectUri,
        code_verifier: codeVerifier,
      })
    },
    refresh(refreshToken) {
      return token({ grant_type: 'refresh_token', refresh_token: refreshToken })
    },
  }
}

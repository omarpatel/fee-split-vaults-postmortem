/**
 * OAuth 2.0 user credentials for the X accounts we post as.
 *
 * One record per platform account, keyed by the same accountId the
 * AccountRegistry binds to a coin. The store is a port: the in-memory version
 * below is for tests and the sandbox, the Postgres version lives in adapters and
 * encrypts the tokens at rest. Nothing here decides whether a token is valid -
 * the X transport does that, refreshing when the expiry is near and refusing
 * when there is nothing to refresh with.
 */

export interface XCredentials {
  accessToken: string
  /** Absent when the grant did not include offline.access. Expiry is then final. */
  refreshToken: string | null
  expiresAtUnix: number
  scopes: readonly string[]
}

export interface AccountCredentialStore {
  get(accountId: string): Promise<XCredentials | null>
  put(accountId: string, creds: XCredentials): Promise<void>
}

export class InMemoryAccountCredentialStore implements AccountCredentialStore {
  readonly #records = new Map<string, XCredentials>()

  constructor(seed: Iterable<readonly [string, XCredentials]> = []) {
    for (const [accountId, creds] of seed) this.#records.set(accountId, creds)
  }

  async get(accountId: string): Promise<XCredentials | null> {
    return this.#records.get(accountId) ?? null
  }

  async put(accountId: string, creds: XCredentials): Promise<void> {
    this.#records.set(accountId, creds)
  }
}

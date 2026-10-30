/**
 * X mentions as a MessageSource: what people said TO a coin's own account.
 *
 * THE BINDING COMES FROM CONFIGURATION, NEVER FROM CONTENT. Every stored
 * mention is stamped with the coinRef of the ACCOUNT it mentioned, from a map
 * the operator wrote. Nothing here reads the tweet text for meaning, and no
 * string an attacker posted can decide which coin a mention is attributed to.
 * A mention of an account nobody bound is not fetched at all - the poller
 * only asks about the accounts in its map.
 *
 * WHY THERE IS A STORE. The mentions timeline is paged by `since_id` and the
 * API cannot be asked "what was said between 12:00 and 12:05" after the fact.
 * The tick asks exactly that, on closed windows, so `poll()` drains the
 * timeline into the store and `since()` answers windows from it. The cursor is
 * confirmed only AFTER the page's rows are stored, so a crash in between
 * re-fetches rather than skips; the store is idempotent on the tweet id.
 *
 * IDS ARE STRINGS. Tweet ids are 64-bit snowflakes above 2^53, so they never
 * become a JS number: they travel as strings and are compared as bigints.
 *
 * Credentials are the same OAuth 2.0 user tokens the publisher posts with,
 * refreshed the same way (see publisher/channels/x.ts); reading mentions needs
 * the `tweet.read` and `users.read` scopes of the same grant.
 */

import type { RawMessage } from '@fee-split-vaults/runtime'
import { CoinIsolationError, type MessageSource } from '@fee-split-vaults/orchestrator'
import { TOKEN_REFRESH_MARGIN_SECONDS, type AccountCredentialStore, type XOAuth2Client } from '@fee-split-vaults/publisher'
import { CredentialMissingError, SourceUnavailableError } from '../errors.js'
import { countFromSql, type SqlDriver } from '../pg/sql.js'
import { MAX_STORED_TEXT_CHARS } from '../telegram/inbound.js'

/** One stored mention. The account it mentioned is what the binding was stamped from. */
export interface StoredXMention extends RawMessage {
  readonly origin: 'x_mention'
  /** The X user id of the bound account that was mentioned. */
  readonly accountId: string
}

export interface XMentionStore {
  /** Idempotent on (accountId, sourceId). Returns how many rows were new. */
  put(mentions: readonly StoredXMention[]): Promise<number>
  /** Window is [fromUnix, toUnix), matching the orchestrator's corpus windows. */
  window(coinRef: string, fromUnix: number, toUnix: number): Promise<StoredXMention[]>
  /** The newest tweet id already stored for the account, or undefined for a cold start. */
  sinceId(accountId: string): Promise<string | undefined>
  /** Written only AFTER that page's mentions are stored. Monotonic. */
  confirmSinceId(accountId: string, sinceId: string): Promise<void>
}

/** Snowflake ids compare numerically, never lexically. */
export function compareTweetIds(a: string, b: string): number {
  const left = BigInt(a)
  const right = BigInt(b)
  return left < right ? -1 : left > right ? 1 : 0
}

function isTweetId(value: string): boolean {
  return /^\d{1,20}$/.test(value)
}

/** The chat_id an X account's mentions are stored under, so the row keys cannot collide with a Telegram chat. */
export function mentionChatId(accountId: string): string {
  return `x:${accountId}`
}

export class InMemoryXMentionStore implements XMentionStore {
  readonly #byKey = new Map<string, StoredXMention>()
  readonly #cursors = new Map<string, string>()
  /** Set to make every call throw, so the fail-closed paths can be exercised. */
  unavailable = false

  #guard(): void {
    if (this.unavailable) throw new SourceUnavailableError('x mention store', 'injected fault')
  }

  async put(mentions: readonly StoredXMention[]): Promise<number> {
    this.#guard()
    let added = 0
    for (const mention of mentions) {
      const key = `${mention.accountId}|${mention.sourceId}`
      if (this.#byKey.has(key)) continue
      this.#byKey.set(key, mention)
      added++
    }
    return added
  }

  async window(coinRef: string, fromUnix: number, toUnix: number): Promise<StoredXMention[]> {
    this.#guard()
    return [...this.#byKey.values()]
      .filter((m) => m.boundCoinRef === coinRef && m.postedAtUnix >= fromUnix && m.postedAtUnix < toUnix)
      .sort((a, b) => a.postedAtUnix - b.postedAtUnix || compareTweetIds(a.sourceId, b.sourceId))
  }

  async sinceId(accountId: string): Promise<string | undefined> {
    this.#guard()
    return this.#cursors.get(accountId)
  }

  async confirmSinceId(accountId: string, sinceId: string): Promise<void> {
    this.#guard()
    const current = this.#cursors.get(accountId)
    if (current === undefined || compareTweetIds(sinceId, current) > 0) this.#cursors.set(accountId, sinceId)
  }
}

interface MentionRow {
  chat_id: string
  source_id: string
  author_id: string
  body_text: string
  posted_at_unix: unknown
  bound_coin_ref: string
}

/**
 * Rows live in `inbound_message` beside the Telegram ones, with
 * origin = 'x_mention' and chat_id = 'x:<accountId>'. The Telegram store reads
 * only its own origin, and this one only its own, so the two never see each
 * other's rows even though they share a table. `update_id` is a Telegram
 * concept and is stored as 0 here.
 */
export class PgXMentionStore implements XMentionStore {
  constructor(private readonly driver: SqlDriver) {}

  async put(mentions: readonly StoredXMention[]): Promise<number> {
    if (mentions.length === 0) return 0
    try {
      let added = 0
      for (const mention of mentions) {
        const result = await this.driver.execute(
          `INSERT INTO inbound_message
               (chat_id, source_id, origin, author_id, body_text, posted_at_unix, bound_coin_ref, update_id)
           VALUES ($1, $2, 'x_mention', $3, $4, $5, $6, 0)
           ON CONFLICT (chat_id, source_id) DO NOTHING`,
          [
            mentionChatId(mention.accountId),
            mention.sourceId,
            mention.authorId,
            mention.text,
            mention.postedAtUnix,
            mention.boundCoinRef,
          ],
        )
        added += result.rowsAffected
      }
      return added
    } catch (error) {
      throw new SourceUnavailableError('inbound_message', String(error), error)
    }
  }

  async window(coinRef: string, fromUnix: number, toUnix: number): Promise<StoredXMention[]> {
    let rows: MentionRow[]
    try {
      rows = await this.driver.query<MentionRow>(
        `SELECT chat_id, source_id, author_id, body_text, posted_at_unix, bound_coin_ref
           FROM inbound_message
          WHERE origin = 'x_mention' AND bound_coin_ref = $1
            AND posted_at_unix >= $2 AND posted_at_unix < $3
          ORDER BY posted_at_unix, length(source_id), source_id`,
        [coinRef, fromUnix, toUnix],
      )
    } catch (error) {
      throw new SourceUnavailableError('inbound_message', String(error), error)
    }
    return rows.map((row) => ({
      sourceId: row.source_id,
      authorId: row.author_id,
      text: row.body_text,
      postedAtUnix: countFromSql(row.posted_at_unix, 'inbound_message.posted_at_unix'),
      origin: 'x_mention',
      boundCoinRef: row.bound_coin_ref,
      accountId: row.chat_id.startsWith('x:') ? row.chat_id.slice(2) : row.chat_id,
    }))
  }

  async sinceId(accountId: string): Promise<string | undefined> {
    try {
      const rows = await this.driver.query<{ since_id: string }>(
        'SELECT since_id FROM x_mention_cursor WHERE account_id = $1',
        [accountId],
      )
      const value = rows[0]?.since_id
      return value === undefined || value === null ? undefined : value
    } catch (error) {
      throw new SourceUnavailableError('x_mention_cursor', String(error), error)
    }
  }

  async confirmSinceId(accountId: string, sinceId: string): Promise<void> {
    try {
      // Monotonic, compared as numbers: a lower id would re-open a page we kept.
      await this.driver.execute(
        `INSERT INTO x_mention_cursor (account_id, since_id, updated_at_unix)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE
            SET since_id = EXCLUDED.since_id, updated_at_unix = EXCLUDED.updated_at_unix
          WHERE x_mention_cursor.since_id::numeric < EXCLUDED.since_id::numeric`,
        [accountId, sinceId, Math.floor(Date.now() / 1000)],
      )
    } catch (error) {
      throw new SourceUnavailableError('x_mention_cursor', String(error), error)
    }
  }
}

export interface XMentionsMessageSourceOptions {
  credentials: AccountCredentialStore
  oauth: Pick<XOAuth2Client, 'refresh'>
  store: XMentionStore
  /**
   * X user id -> coinRef. THE ONLY place a coin binding comes from. One
   * account speaks for exactly one coin; a coin may have several accounts.
   */
  accountBindings: Readonly<Record<string, string>>
  fetchImpl?: typeof fetch
  /** Defaults to https://api.x.com/2 */
  baseUrl?: string
  clock?: () => number
  /** Tweets per page, 5..100 per the API. */
  pageSize?: number
  /** Pages per account per poll. Bounds one poll's cost whatever the backlog. */
  maxPagesPerPoll?: number
}

export interface XMentionsPollResult {
  readonly fetched: number
  readonly stored: number
  /** Accounts whose poll failed. Their cursor did not move; the next poll retries. */
  readonly failures: ReadonlyArray<{ accountId: string; code: string; detail: string }>
}

interface MentionsPage {
  data?: unknown
  meta?: unknown
}

function nextToken(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== 'object' || !('next_token' in meta)) return undefined
  return typeof meta.next_token === 'string' ? meta.next_token : undefined
}

export class XMentionsMessageSource implements MessageSource {
  readonly #options: XMentionsMessageSourceOptions
  readonly #accountToCoin: Map<string, string>
  readonly #fetch: typeof fetch
  readonly #base: string
  readonly #clock: () => number
  readonly #pageSize: number
  readonly #maxPages: number

  constructor(options: XMentionsMessageSourceOptions) {
    this.#options = options
    this.#accountToCoin = new Map(Object.entries(options.accountBindings))
    for (const [accountId, coinRef] of this.#accountToCoin) {
      if (coinRef.length === 0) throw new Error(`x account ${accountId} is bound to an empty coinRef`)
      if (!isTweetId(accountId)) throw new Error(`x account id ${accountId} is not a numeric user id`)
    }
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#base = (options.baseUrl ?? 'https://api.x.com/2').replace(/\/+$/, '')
    this.#clock = options.clock ?? (() => Math.floor(Date.now() / 1000))
    this.#pageSize = Math.min(Math.max(options.pageSize ?? 100, 5), 100)
    this.#maxPages = Math.max(options.maxPagesPerPoll ?? 5, 1)
  }

  /** Which coin an account belongs to, or undefined. Configuration, not content. */
  coinForAccount(accountId: string): string | undefined {
    return this.#accountToCoin.get(accountId)
  }

  get accountIds(): string[] {
    return [...this.#accountToCoin.keys()]
  }

  /** Same policy as the publisher's transport: refresh near expiry, refuse without a refresh token. */
  async #accessToken(accountId: string): Promise<string> {
    const stored = await this.#options.credentials.get(accountId)
    if (stored === null) {
      throw new CredentialMissingError(`x credentials for ${accountId}`, 'the account has not completed OAuth')
    }
    if (stored.expiresAtUnix - TOKEN_REFRESH_MARGIN_SECONDS >= this.#clock()) return stored.accessToken
    if (stored.refreshToken === null) {
      throw new CredentialMissingError(
        `x credentials for ${accountId}`,
        'the token expired and the grant carried no refresh token',
      )
    }
    let refreshed
    try {
      refreshed = await this.#options.oauth.refresh(stored.refreshToken)
    } catch (cause) {
      throw new SourceUnavailableError(`x oauth refresh for ${accountId}`, String(cause), cause)
    }
    await this.#options.credentials.put(accountId, refreshed)
    return refreshed.accessToken
  }

  async #page(accountId: string, sinceId: string | undefined, paginationToken: string | undefined): Promise<MentionsPage> {
    const token = await this.#accessToken(accountId)
    const query = new URLSearchParams({
      max_results: String(this.#pageSize),
      'tweet.fields': 'author_id,created_at',
    })
    if (sinceId !== undefined) query.set('since_id', sinceId)
    if (paginationToken !== undefined) query.set('pagination_token', paginationToken)
    const url = `${this.#base}/users/${encodeURIComponent(accountId)}/mentions?${query.toString()}`

    let response: Response
    try {
      response = await this.#fetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}` } })
    } catch (cause) {
      throw new SourceUnavailableError(`x mentions for ${accountId}`, 'unreachable', cause)
    }
    if (!response.ok) {
      throw new SourceUnavailableError(`x mentions for ${accountId}`, `status ${String(response.status)}`)
    }
    const body: unknown = await response.json().catch(() => null)
    if (body === null || typeof body !== 'object') {
      throw new SourceUnavailableError(`x mentions for ${accountId}`, 'malformed body')
    }
    return body
  }

  #toStored(accountId: string, coinRef: string, tweet: unknown): StoredXMention | undefined {
    if (tweet === null || typeof tweet !== 'object') return undefined
    const id = 'id' in tweet && typeof tweet.id === 'string' ? tweet.id : undefined
    const authorId = 'author_id' in tweet && typeof tweet.author_id === 'string' ? tweet.author_id : undefined
    const text = 'text' in tweet && typeof tweet.text === 'string' ? tweet.text : undefined
    const createdAt = 'created_at' in tweet && typeof tweet.created_at === 'string' ? tweet.created_at : undefined
    // A structurally incomplete tweet is skipped rather than patched with
    // defaults: an anonymous author would become a real-looking row.
    if (id === undefined || !isTweetId(id) || authorId === undefined || text === undefined || createdAt === undefined) {
      return undefined
    }
    const postedAtMs = Date.parse(createdAt)
    if (!Number.isFinite(postedAtMs)) return undefined
    return {
      sourceId: id,
      authorId,
      text: text.slice(0, MAX_STORED_TEXT_CHARS),
      postedAtUnix: Math.floor(postedAtMs / 1000),
      origin: 'x_mention',
      // Stamped here, from the account map. Never parsed out of `text`.
      boundCoinRef: coinRef,
      accountId,
    }
  }

  /**
   * Drain every bound account's mentions since its cursor into the store.
   *
   * The API pages NEWEST FIRST, so the cursor is confirmed only once every
   * page of the poll is stored: confirming after the first page would put the
   * cursor past the older pages a crash then never fetched. A poll that hits
   * `maxPagesPerPoll` confirms what it stored and leaves the rest to a
   * backlog nobody reads - that bound is the cost ceiling, and it is chosen
   * over an unbounded catch-up. Accounts fail independently.
   */
  async poll(): Promise<XMentionsPollResult> {
    let fetched = 0
    let stored = 0
    const failures: Array<{ accountId: string; code: string; detail: string }> = []

    for (const [accountId, coinRef] of this.#accountToCoin) {
      try {
        const sinceId = await this.#options.store.sinceId(accountId)
        let paginationToken: string | undefined
        let newest: string | undefined = sinceId
        for (let page = 0; page < this.#maxPages; page += 1) {
          const body = await this.#page(accountId, sinceId, paginationToken)
          const tweets = Array.isArray(body.data) ? body.data : []
          fetched += tweets.length
          const toStore: StoredXMention[] = []
          for (const tweet of tweets) {
            const row = this.#toStored(accountId, coinRef, tweet)
            if (row !== undefined) toStore.push(row)
          }
          stored += await this.#options.store.put(toStore)
          for (const row of toStore) {
            if (newest === undefined || compareTweetIds(row.sourceId, newest) > 0) newest = row.sourceId
          }
          const next = nextToken(body.meta)
          if (next === undefined || tweets.length === 0) break
          paginationToken = next
        }
        // STORE FIRST, CONFIRM SECOND - and only to an id actually stored.
        if (newest !== undefined && newest !== sinceId) await this.#options.store.confirmSinceId(accountId, newest)
      } catch (error) {
        failures.push({
          accountId,
          code: error instanceof CredentialMissingError || error instanceof SourceUnavailableError ? error.code : 'poll_failed',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { fetched, stored, failures }
  }

  /**
   * The window the tick loop reads. The isolation assertion is kept although
   * the stamping above makes a mis-stamped row impossible today: a row for
   * another coin reaching this query is a bleed in the store or the map, and
   * it stops here loudly rather than being quietly filtered.
   */
  async since(coinRef: string, fromUnix: number, toUnix: number): Promise<readonly RawMessage[]> {
    const rows = await this.#options.store.window(coinRef, fromUnix, toUnix)
    for (const row of rows) {
      if (row.boundCoinRef !== coinRef) {
        throw new CoinIsolationError(coinRef, row.boundCoinRef, 'x mentions source')
      }
      const expected = this.#accountToCoin.get(row.accountId)
      if (expected !== coinRef) {
        throw new CoinIsolationError(coinRef, expected ?? '<unbound account>', `x account ${row.accountId}`)
      }
    }
    return rows.map((row) => ({
      sourceId: row.sourceId,
      authorId: row.authorId,
      text: row.text,
      postedAtUnix: row.postedAtUnix,
      origin: row.origin,
      boundCoinRef: row.boundCoinRef,
    }))
  }
}

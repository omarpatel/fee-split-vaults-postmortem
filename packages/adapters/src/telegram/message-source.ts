/**
 * The real MessageSource: a coin's own Telegram chat, and nothing else.
 *
 * THE BINDING COMES FROM CONFIGURATION, NEVER FROM CONTENT. Every stored
 * message is stamped with the coinRef of the CHAT it arrived in, from a map the
 * operator wrote. Nothing in this file reads the message text, and there is no
 * code path in which a string an attacker sent can influence which coin a
 * message is attributed to. That is the structural half of the cross-coin
 * isolation the runtime's corpus assembler enforces on the other side.
 *
 * A CHAT NOBODY CLAIMS IS NOT ANYBODY'S. An update from an unmapped chat is
 * counted and dropped, never stamped with a guess and never attributed to the
 * nearest coin. The bot being added to a chat we do not run is the normal way
 * this happens, and it must not become another coin's context.
 *
 * WHY THERE IS A STORE. getUpdates is a consuming stream with no historical
 * window: confirming an offset discards everything below it and the API cannot
 * be asked "what was said between 12:00 and 12:05". The tick loop asks exactly
 * that, on overlapping windows. So polling and reading are separated - `poll()`
 * drains the stream into a store, `since()` answers windows from the store -
 * and a poll that fails leaves the offset where it was, so nothing is lost.
 */

import type { RawMessage } from '@fee-split-vaults/runtime'
import { CoinIsolationError, type MessageSource } from '@fee-split-vaults/orchestrator'
import { SourceUnavailableError } from '../errors.js'
import { countFromSql, type SqlDriver } from '../pg/sql.js'
import type { TelegramInbound, TelegramInboundMessage } from './inbound.js'

export interface StoredInboundMessage extends RawMessage {
  /** Bot API update_id, so the offset survives a restart with the messages. */
  readonly updateId: number
  readonly chatId: string
}

export interface InboundMessageStore {
  /** Idempotent on (chatId, sourceId). Returns how many rows were new. */
  put(messages: readonly StoredInboundMessage[]): Promise<number>
  /** Window is [fromUnix, toUnix), matching the orchestrator's corpus windows. */
  window(coinRef: string, fromUnix: number, toUnix: number): Promise<StoredInboundMessage[]>
  /**
   * The next Bot API offset to ask for, or undefined for a cold start.
   *
   * SEPARATE FROM THE MESSAGES ON PURPOSE. Deriving it from the highest stored
   * update_id would mean an update from an unbound chat - one nobody stores -
   * never advances it, so every poll re-fetches the same backlog forever and
   * Telegram never expires it. Confirming an offset is what discards an update
   * server-side, and an update we correctly decided not to keep still has to be
   * discarded.
   */
  confirmedOffset(): Promise<number | undefined>
  /** Written only AFTER the messages from that batch are stored. */
  confirmOffset(nextOffset: number): Promise<void>
}

export class InMemoryInboundMessageStore implements InboundMessageStore {
  readonly #byKey = new Map<string, StoredInboundMessage>()
  #offset: number | undefined
  /** Set to make every call throw, so the fail-closed paths can be exercised. */
  unavailable = false

  #guard(): void {
    if (this.unavailable) throw new SourceUnavailableError('inbound message store', 'injected fault')
  }

  async put(messages: readonly StoredInboundMessage[]): Promise<number> {
    this.#guard()
    let added = 0
    for (const message of messages) {
      const key = `${message.chatId}|${message.sourceId}`
      if (this.#byKey.has(key)) continue
      this.#byKey.set(key, message)
      added++
    }
    return added
  }

  async window(coinRef: string, fromUnix: number, toUnix: number): Promise<StoredInboundMessage[]> {
    this.#guard()
    return [...this.#byKey.values()]
      .filter(
        (message) =>
          message.boundCoinRef === coinRef &&
          message.postedAtUnix >= fromUnix &&
          message.postedAtUnix < toUnix,
      )
      .sort((a, b) => a.postedAtUnix - b.postedAtUnix || a.updateId - b.updateId)
  }

  async confirmedOffset(): Promise<number | undefined> {
    this.#guard()
    return this.#offset
  }

  async confirmOffset(nextOffset: number): Promise<void> {
    this.#guard()
    // Monotonic: a lower offset would re-open a window Telegram has discarded.
    if (this.#offset === undefined || nextOffset > this.#offset) this.#offset = nextOffset
  }

  /** Test helper: the highest update_id actually stored. */
  async highestStoredUpdateId(): Promise<number | undefined> {
    this.#guard()
    let highest: number | undefined
    for (const message of this.#byKey.values()) {
      if (highest === undefined || message.updateId > highest) highest = message.updateId
    }
    return highest
  }
}

interface MessageRow {
  chat_id: string
  source_id: string
  author_id: string
  body_text: string
  posted_at_unix: unknown
  bound_coin_ref: string
  update_id: unknown
}

export class PgInboundMessageStore implements InboundMessageStore {
  constructor(
    private readonly driver: SqlDriver,
    /** Names the offset row. One bot token, one poller, one offset. */
    private readonly poller = 'telegram',
  ) {}

  async put(messages: readonly StoredInboundMessage[]): Promise<number> {
    if (messages.length === 0) return 0
    try {
      let added = 0
      for (const message of messages) {
        const result = await this.driver.execute(
          `INSERT INTO inbound_message
               (chat_id, source_id, origin, author_id, body_text, posted_at_unix, bound_coin_ref, update_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (chat_id, source_id) DO NOTHING`,
          [
            message.chatId,
            message.sourceId,
            message.origin,
            message.authorId,
            message.text,
            message.postedAtUnix,
            message.boundCoinRef,
            message.updateId,
          ],
        )
        added += result.rowsAffected
      }
      return added
    } catch (error) {
      throw new SourceUnavailableError('inbound_message', String(error), error)
    }
  }

  async window(coinRef: string, fromUnix: number, toUnix: number): Promise<StoredInboundMessage[]> {
    let rows: MessageRow[]
    try {
      // The table is shared with X mentions (origin = 'x_mention', whose
      // source ids exceed 2^53 and whose update_id is 0); this store reads
      // only the rows it wrote.
      rows = await this.driver.query<MessageRow>(
        `SELECT chat_id, source_id, author_id, body_text, posted_at_unix, bound_coin_ref, update_id
           FROM inbound_message
          WHERE origin = 'telegram' AND bound_coin_ref = $1 AND posted_at_unix >= $2 AND posted_at_unix < $3
          ORDER BY posted_at_unix, update_id`,
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
      origin: 'telegram',
      boundCoinRef: row.bound_coin_ref,
      updateId: countFromSql(row.update_id, 'inbound_message.update_id'),
      chatId: row.chat_id,
    }))
  }

  async confirmedOffset(): Promise<number | undefined> {
    try {
      const rows = await this.driver.query<{ next_offset: unknown }>(
        'SELECT next_offset FROM inbound_poll_offset WHERE poller = $1',
        [this.poller],
      )
      const value = rows[0]?.next_offset
      if (value === null || value === undefined) return undefined
      return countFromSql(value, 'inbound_poll_offset.next_offset')
    } catch (error) {
      throw new SourceUnavailableError('inbound_poll_offset', String(error), error)
    }
  }

  async confirmOffset(nextOffset: number): Promise<void> {
    try {
      await this.driver.execute(
        `INSERT INTO inbound_poll_offset (poller, next_offset, updated_at_unix)
         VALUES ($1, $2, $3)
         ON CONFLICT (poller) DO UPDATE
            SET next_offset = EXCLUDED.next_offset, updated_at_unix = EXCLUDED.updated_at_unix
          WHERE inbound_poll_offset.next_offset < EXCLUDED.next_offset`,
        [this.poller, nextOffset, Math.floor(Date.now() / 1000)],
      )
    } catch (error) {
      throw new SourceUnavailableError('inbound_poll_offset', String(error), error)
    }
  }
}

export interface TelegramMessageSourceConfig {
  /**
   * chatId -> coinRef. THE ONLY place a coin binding comes from.
   *
   * One chat belongs to exactly one coin. Two coins sharing a chat is not a
   * configuration this accepts: it would make every message ambiguous and the
   * only honest resolutions are to refuse or to bleed.
   */
  readonly chatBindings: Readonly<Record<string, string>>
  /** Updates per getUpdates call. The Bot API's own ceiling is 100. */
  readonly batchSize?: number
  /** Long-poll seconds. 0 means return immediately. */
  readonly pollTimeoutSeconds?: number
}

export interface PollResult {
  readonly fetched: number
  readonly stored: number
  /** Updates from chats no coin claims. Dropped, never stamped with a guess. */
  readonly droppedUnboundChat: number
  /** Highest update_id SEEN in this batch, bound or not. undefined if empty. */
  readonly highestUpdateId: number | undefined
}

export class TelegramMessageSource implements MessageSource {
  readonly #inbound: TelegramInbound
  readonly #store: InboundMessageStore
  readonly #chatToCoin: Map<string, string>
  readonly #batchSize: number
  readonly #pollTimeoutSeconds: number

  constructor(
    inbound: TelegramInbound,
    store: InboundMessageStore,
    config: TelegramMessageSourceConfig,
  ) {
    this.#inbound = inbound
    this.#store = store
    this.#chatToCoin = new Map(Object.entries(config.chatBindings))
    this.#batchSize = Math.min(Math.max(config.batchSize ?? 100, 1), 100)
    this.#pollTimeoutSeconds = config.pollTimeoutSeconds ?? 0

    const coinsSeen = new Set<string>()
    for (const [chatId, coinRef] of this.#chatToCoin) {
      if (coinRef.length === 0) throw new Error(`chat ${chatId} is bound to an empty coinRef`)
      coinsSeen.add(coinRef)
    }
  }

  /** Which coin a chat belongs to, or undefined. Configuration, not content. */
  coinForChat(chatId: string): string | undefined {
    return this.#chatToCoin.get(chatId)
  }

  /**
   * Drain the update stream into the store.
   *
   * The offset is derived from the STORE, not from a field in memory, so a
   * crash between fetching and storing re-fetches rather than skips. Telegram
   * only discards an update once a higher offset is confirmed, and this never
   * confirms one it has not written.
   */
  async poll(): Promise<PollResult> {
    const offset = (await this.#store.confirmedOffset()) ?? 0

    const updates = await this.#inbound.getUpdates({
      offset,
      limit: this.#batchSize,
      timeoutSeconds: this.#pollTimeoutSeconds,
    })

    const toStore: StoredInboundMessage[] = []
    let droppedUnboundChat = 0
    let highestUpdateId: number | undefined

    for (const update of updates) {
      if (highestUpdateId === undefined || update.updateId > highestUpdateId) {
        highestUpdateId = update.updateId
      }
      const coinRef = this.#chatToCoin.get(update.chatId)
      if (coinRef === undefined) {
        // Counted and dropped. An unbound chat is not the nearest coin's.
        droppedUnboundChat++
        continue
      }
      toStore.push(this.#toStored(update, coinRef))
    }

    // STORE FIRST, CONFIRM SECOND. A crash in between re-fetches the batch,
    // and the store is idempotent on (chatId, sourceId), so the replay is a
    // no-op. Confirming first would discard messages nobody kept.
    const stored = await this.#store.put(toStore)
    if (highestUpdateId !== undefined) await this.#store.confirmOffset(highestUpdateId + 1)

    return { fetched: updates.length, stored, droppedUnboundChat, highestUpdateId }
  }

  #toStored(update: TelegramInboundMessage, coinRef: string): StoredInboundMessage {
    return {
      sourceId: update.messageId,
      authorId: update.authorId,
      text: update.text,
      postedAtUnix: update.postedAtUnix,
      origin: 'telegram',
      // Stamped here, from the chat map. Never parsed out of `text`.
      boundCoinRef: coinRef,
      updateId: update.updateId,
      chatId: update.chatId,
    }
  }

  /**
   * The window the tick loop reads.
   *
   * The isolation assertion is deliberately kept even though the stamping above
   * makes a mis-stamped row impossible today. It is not a filter: if a row for
   * another coin ever reaches this query, that is a bleed in the store or in
   * the binding map, and it stops here loudly rather than being quietly
   * discarded - a silent filter would hide the bug that produced it.
   */
  async since(coinRef: string, fromUnix: number, toUnix: number): Promise<readonly RawMessage[]> {
    const rows = await this.#store.window(coinRef, fromUnix, toUnix)
    for (const row of rows) {
      if (row.boundCoinRef !== coinRef) {
        throw new CoinIsolationError(coinRef, row.boundCoinRef, 'telegram message source')
      }
      const expected = this.#chatToCoin.get(row.chatId)
      if (expected !== coinRef) {
        throw new CoinIsolationError(
          coinRef,
          expected ?? '<unbound chat>',
          `telegram chat ${row.chatId}`,
        )
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

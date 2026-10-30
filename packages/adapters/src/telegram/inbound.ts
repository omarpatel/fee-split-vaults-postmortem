/**
 * The Bot API's INBOUND half.
 *
 * Why this is not a method on `BotApiTelegramClient`. That class is the desk's
 * outbound surface and its own doc block states the property it is protecting:
 * "the set of things it can do must be enumerable on one screen and must
 * contain no way to move money, sign, or publish outside the chat it is
 * moderating". Reading is a different capability from acting, the desk never
 * needs it - trusted ingest hands it a corpus - and the two halves belong to
 * different planes. So this is the same Bot API, over the same `HttpJsonPost`
 * transport, raising the same `TelegramApiError`, in a separate class that the
 * desk does not hold.
 *
 * NOTHING HERE READS A MESSAGE'S MEANING. Every field is copied across by name
 * and by type. `text` is carried as an opaque string, never parsed, never
 * matched against a pattern, and in particular never inspected for a coin
 * identifier: the coin binding is stamped from the CHAT the update arrived in,
 * which is configuration we wrote, not content an attacker sent.
 */

import { TelegramApiError, type HttpJsonPost } from '@fee-split-vaults/desk'
import { CredentialMissingError } from '../errors.js'

/** One inbound chat message, in the shape trusted ingest needs and no wider. */
export interface TelegramInboundMessage {
  /** Bot API update_id. The offset cursor is derived from it. */
  readonly updateId: number
  readonly chatId: string
  readonly messageId: string
  /** Untrusted author id. Pseudonymised downstream; never rendered. */
  readonly authorId: string
  /** Untrusted body, opaque here. */
  readonly text: string
  readonly postedAtUnix: number
}

export interface TelegramInbound {
  /**
   * Updates strictly above `offset`, oldest first.
   *
   * Telegram's getUpdates is a CONSUMING stream: confirming an offset discards
   * everything below it server-side and there is no way to ask for a historical
   * window. That is the whole reason `TelegramMessageSource` writes to a store
   * instead of querying the API per tick.
   */
  getUpdates(input: {
    offset: number
    limit: number
    timeoutSeconds: number
  }): Promise<TelegramInboundMessage[]>
}

interface BotApiUpdate {
  update_id?: number
  message?: {
    message_id?: number
    date?: number
    text?: string
    chat?: { id?: number | string }
    from?: { id?: number | string }
  }
}

interface BotApiEnvelope {
  ok?: boolean
  result?: unknown
  description?: string
  parameters?: { retry_after?: number }
}

/** Bounds one message's stored size. Telegram's own cap is 4096 characters. */
export const MAX_STORED_TEXT_CHARS = 8_192

export class BotApiTelegramInbound implements TelegramInbound {
  constructor(
    private readonly token: string,
    private readonly http: HttpJsonPost,
    private readonly apiBase = 'https://api.telegram.org',
  ) {
    // Refused at CONSTRUCTION. A source that builds without a token and fails
    // on first poll is a process that looks healthy and silently ingests
    // nothing; the caller has to learn now, so it can wire a LABELLED fake
    // instead of quietly running blind.
    if (!token) {
      throw new CredentialMissingError(
        'TELEGRAM_BOT_TOKEN',
        'a Telegram message source cannot be constructed without a bot token',
      )
    }
  }

  async getUpdates(input: {
    offset: number
    limit: number
    timeoutSeconds: number
  }): Promise<TelegramInboundMessage[]> {
    const raw = (await this.http.post(`${this.apiBase}/bot${this.token}/getUpdates`, {
      offset: input.offset,
      limit: input.limit,
      timeout: input.timeoutSeconds,
      // Only chat messages. Anything else is a capability we did not ask for.
      allowed_updates: ['message'],
    })) as BotApiEnvelope | undefined

    if (!raw || raw.ok !== true) {
      throw new TelegramApiError(
        raw?.description ?? 'call failed',
        'getUpdates',
        raw?.parameters?.retry_after,
      )
    }
    if (!Array.isArray(raw.result)) {
      throw new TelegramApiError('result is not an array', 'getUpdates')
    }

    const out: TelegramInboundMessage[] = []
    for (const entry of raw.result as BotApiUpdate[]) {
      const updateId = entry.update_id
      const message = entry.message
      if (typeof updateId !== 'number' || message === undefined) continue

      const chatId = message.chat?.id
      const authorId = message.from?.id
      const messageId = message.message_id
      const date = message.date
      const text = message.text

      // A structurally incomplete update is skipped rather than patched with
      // defaults. An anonymous author or an absent chat would otherwise become
      // a real-looking row bound to a real coin.
      if (chatId === undefined || authorId === undefined) continue
      if (typeof messageId !== 'number' || typeof date !== 'number') continue
      if (typeof text !== 'string') continue

      out.push({
        updateId,
        chatId: String(chatId),
        messageId: String(messageId),
        authorId: String(authorId),
        text: text.slice(0, MAX_STORED_TEXT_CHARS),
        postedAtUnix: date,
      })
    }
    return out.sort((a, b) => a.updateId - b.updateId)
  }
}

/** Test double. Hand it updates; it serves them by offset like the real API. */
export class FakeTelegramInbound implements TelegramInbound {
  readonly #queued: TelegramInboundMessage[] = []
  /** Set to make every poll throw. */
  unavailable = false

  add(...messages: TelegramInboundMessage[]): void {
    this.#queued.push(...messages)
  }

  async getUpdates(input: {
    offset: number
    limit: number
    timeoutSeconds: number
  }): Promise<TelegramInboundMessage[]> {
    if (this.unavailable) throw new TelegramApiError('injected fault', 'getUpdates')
    return this.#queued
      .filter((message) => message.updateId >= input.offset)
      .sort((a, b) => a.updateId - b.updateId)
      .slice(0, input.limit)
  }
}

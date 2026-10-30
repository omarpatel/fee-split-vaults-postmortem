/**
 * The moderation half of the desk's Telegram surface.
 *
 * The desk router executes a verdict through the desk package's own
 * `TelegramClient`; this is that client minus `sendMessage`. Replies do not go
 * out from here - the tick publishes them through the publisher, which owns
 * disclosure - so the only thing this class can do is chat administration in
 * the one chat it is asked about.
 *
 * REFUSE WITHOUT RIGHTS, DO NOT TRY. A bot that is not an administrator, or is
 * one without the specific right an action needs, gets a 400 from Telegram
 * with a free-text description. Acting on that text is a parser standing
 * between a scam link and its removal. Instead the bot's own membership is
 * read with getChatMember and checked for the named right BEFORE the action,
 * and a missing right is a typed refusal the tick records by code. The check
 * is cached per chat for a bounded time, so a raid does not turn into one
 * extra API call per message.
 */

import { BotApiTelegramClient, type HttpJsonPost, type TelegramAdmin, type TelegramClient } from '@fee-split-vaults/desk'
import { AdapterError, CredentialMissingError } from '../errors.js'

/** Everything the desk may do to a chat. Exactly the desk client without a way to speak. */
export type DeskModerationActions = Omit<TelegramClient, 'sendMessage'>

export type ModerationRight = 'can_delete_messages' | 'can_restrict_members' | 'can_pin_messages'

export class ModerationRightsError extends AdapterError {
  constructor(
    readonly chatId: string,
    readonly right: ModerationRight | 'administrator',
  ) {
    super(
      right === 'administrator'
        ? `the bot is not an administrator of chat ${chatId}; moderation refused`
        : `the bot lacks ${right} in chat ${chatId}; moderation refused`,
      'moderation_rights_missing',
    )
  }
}

interface BotApiEnvelope {
  ok?: boolean
  result?: unknown
  description?: string
}

interface BotRights {
  administrator: boolean
  can_delete_messages: boolean
  can_restrict_members: boolean
  can_pin_messages: boolean
  checkedAtUnix: number
}

function isEnvelope(value: unknown): value is BotApiEnvelope {
  return value !== null && typeof value === 'object'
}

function readFlag(member: object, key: ModerationRight): boolean {
  switch (key) {
    case 'can_delete_messages':
      return 'can_delete_messages' in member && member.can_delete_messages === true
    case 'can_restrict_members':
      return 'can_restrict_members' in member && member.can_restrict_members === true
    case 'can_pin_messages':
      return 'can_pin_messages' in member && member.can_pin_messages === true
  }
}

export interface TelegramModerationActionsOptions {
  /** TELEGRAM_BOT_TOKEN. */
  token: string
  http: HttpJsonPost
  apiBase?: string
  clock?: () => number
  /** Seconds a rights check stays valid for a chat. */
  rightsTtlSeconds?: number
}

export class TelegramModerationActions implements DeskModerationActions {
  readonly #client: BotApiTelegramClient
  readonly #token: string
  readonly #http: HttpJsonPost
  readonly #apiBase: string
  readonly #clock: () => number
  readonly #ttl: number
  readonly #rights = new Map<string, BotRights>()
  #botUserId: string | undefined

  constructor(options: TelegramModerationActionsOptions) {
    if (!options.token) {
      throw new CredentialMissingError(
        'TELEGRAM_BOT_TOKEN',
        'moderation actions cannot be constructed without a bot token',
      )
    }
    this.#token = options.token
    this.#http = options.http
    this.#apiBase = options.apiBase ?? 'https://api.telegram.org'
    this.#clock = options.clock ?? (() => Math.floor(Date.now() / 1000))
    this.#ttl = options.rightsTtlSeconds ?? 300
    this.#client = new BotApiTelegramClient(options.token, options.http, this.#apiBase)
  }

  async #call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const raw = await this.#http.post(`${this.#apiBase}/bot${this.#token}/${method}`, params)
    if (!isEnvelope(raw) || raw.ok !== true) {
      const description = isEnvelope(raw) && typeof raw.description === 'string' ? raw.description : 'call failed'
      throw new AdapterError(`telegram ${method}: ${description}`, 'source_unavailable')
    }
    return raw.result
  }

  async #botId(): Promise<string> {
    if (this.#botUserId !== undefined) return this.#botUserId
    const me = await this.#call('getMe', {})
    if (me === null || typeof me !== 'object' || !('id' in me) || (typeof me.id !== 'number' && typeof me.id !== 'string')) {
      throw new AdapterError('telegram getMe: no user id in reply', 'source_unavailable')
    }
    this.#botUserId = String(me.id)
    return this.#botUserId
  }

  /** The bot's own rights in `chatId`, read from Telegram and cached for `rightsTtlSeconds`. */
  async rights(chatId: string): Promise<BotRights> {
    const now = this.#clock()
    const cached = this.#rights.get(chatId)
    if (cached !== undefined && now - cached.checkedAtUnix < this.#ttl) return cached

    const member = await this.#call('getChatMember', { chat_id: chatId, user_id: Number(await this.#botId()) })
    if (member === null || typeof member !== 'object') {
      throw new AdapterError('telegram getChatMember: malformed reply', 'source_unavailable')
    }
    const status = 'status' in member && typeof member.status === 'string' ? member.status : ''
    // The chat creator holds every right; an administrator holds the ones flagged.
    const creator = status === 'creator'
    const administrator = creator || status === 'administrator'
    const rights: BotRights = {
      administrator,
      can_delete_messages: creator || (administrator && readFlag(member, 'can_delete_messages')),
      can_restrict_members: creator || (administrator && readFlag(member, 'can_restrict_members')),
      can_pin_messages: creator || (administrator && readFlag(member, 'can_pin_messages')),
      checkedAtUnix: now,
    }
    this.#rights.set(chatId, rights)
    return rights
  }

  async #require(chatId: string, right: ModerationRight): Promise<void> {
    const rights = await this.rights(chatId)
    if (!rights.administrator) throw new ModerationRightsError(chatId, 'administrator')
    if (!rights[right]) throw new ModerationRightsError(chatId, right)
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    await this.#require(chatId, 'can_delete_messages')
    await this.#client.deleteMessage(chatId, messageId)
  }

  async pinMessage(chatId: string, messageId: string, silent?: boolean): Promise<void> {
    await this.#require(chatId, 'can_pin_messages')
    await this.#client.pinMessage(chatId, messageId, silent)
  }

  async unpinMessage(chatId: string, messageId: string): Promise<void> {
    await this.#require(chatId, 'can_pin_messages')
    await this.#client.unpinMessage(chatId, messageId)
  }

  async muteMember(chatId: string, userId: string, untilUnix: number): Promise<void> {
    await this.#require(chatId, 'can_restrict_members')
    await this.#client.muteMember(chatId, userId, untilUnix)
  }

  async banMember(chatId: string, userId: string, deleteHistory?: boolean): Promise<void> {
    await this.#require(chatId, 'can_restrict_members')
    await this.#client.banMember(chatId, userId, deleteHistory)
  }

  async setChatLocked(chatId: string, locked: boolean): Promise<void> {
    await this.#require(chatId, 'can_restrict_members')
    await this.#client.setChatLocked(chatId, locked)
  }

  getChatAdministrators(chatId: string): Promise<TelegramAdmin[]> {
    return this.#client.getChatAdministrators(chatId)
  }
}

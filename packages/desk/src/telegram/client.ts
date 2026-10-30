/**
 * The Telegram surface the desk needs, and nothing else.
 *
 * The port is deliberately narrow. The desk is a READER-plane component: it
 * consumes attacker-authored text all day, so the set of things it can do must
 * be enumerable on one screen and must contain no way to move money, sign, or
 * publish outside the chat it is moderating. Everything here is chat
 * administration or a reply.
 *
 * Method names track the real Bot API semantics rather than what would be
 * convenient. Notably there is no setSlowMode: the Bot API has no such method,
 * so a raid is throttled by locking the chat with setChatPermissions and by the
 * desk's own reply budget, not by a setting that does not exist.
 */

export interface TelegramAdmin {
  userId: string
  username?: string
  displayName?: string
  isOwner?: boolean
}

export interface TelegramSendOptions {
  replyToMessageId?: string
  disableLinkPreview?: boolean
  silent?: boolean
}

export interface TelegramClient {
  sendMessage(
    chatId: string,
    text: string,
    options?: TelegramSendOptions,
  ): Promise<{ messageId: string }>
  deleteMessage(chatId: string, messageId: string): Promise<void>
  pinMessage(chatId: string, messageId: string, silent?: boolean): Promise<void>
  unpinMessage(chatId: string, messageId: string): Promise<void>
  /** restrictChatMember with send permissions off until `untilUnix`. */
  muteMember(chatId: string, userId: string, untilUnix: number): Promise<void>
  banMember(chatId: string, userId: string, deleteHistory?: boolean): Promise<void>
  getChatAdministrators(chatId: string): Promise<TelegramAdmin[]>
  /** setChatPermissions. The only real lever against a live raid. */
  setChatLocked(chatId: string, locked: boolean): Promise<void>
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`telegram ${method}: ${message}`)
    this.name = 'TelegramApiError'
  }
}

/** Minimal HTTP port so this package depends on no HTTP client. */
export interface HttpJsonPost {
  post(url: string, body: unknown): Promise<unknown>
}

interface BotApiEnvelope {
  ok?: boolean
  result?: unknown
  description?: string
  parameters?: { retry_after?: number }
}

interface BotApiChatMember {
  user?: { id?: number; username?: string; first_name?: string; last_name?: string }
  status?: string
}

/**
 * Bot API implementation. Wire it with any fetch-shaped transport:
 *
 *   const http = { post: async (url, body) =>
 *     (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
 *                         body: JSON.stringify(body) })).json() }
 *   const client = new BotApiTelegramClient(process.env.TELEGRAM_BOT_TOKEN!, http)
 */
export class BotApiTelegramClient implements TelegramClient {
  constructor(
    private readonly token: string,
    private readonly http: HttpJsonPost,
    private readonly apiBase = 'https://api.telegram.org',
  ) {
    if (!token) throw new Error('telegram: bot token is required')
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const raw = (await this.http.post(`${this.apiBase}/bot${this.token}/${method}`, params)) as
      | BotApiEnvelope
      | undefined
    if (!raw || raw.ok !== true) {
      throw new TelegramApiError(
        raw?.description ?? 'call failed',
        method,
        raw?.parameters?.retry_after,
      )
    }
    return raw.result
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: TelegramSendOptions,
  ): Promise<{ messageId: string }> {
    const result = (await this.call('sendMessage', {
      chat_id: chatId,
      text,
      reply_to_message_id: options?.replyToMessageId,
      disable_notification: options?.silent ?? false,
      link_preview_options: { is_disabled: options?.disableLinkPreview ?? true },
    })) as { message_id?: number } | undefined
    return { messageId: String(result?.message_id ?? '') }
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    await this.call('deleteMessage', { chat_id: chatId, message_id: Number(messageId) })
  }

  async pinMessage(chatId: string, messageId: string, silent = true): Promise<void> {
    await this.call('pinChatMessage', {
      chat_id: chatId,
      message_id: Number(messageId),
      disable_notification: silent,
    })
  }

  async unpinMessage(chatId: string, messageId: string): Promise<void> {
    await this.call('unpinChatMessage', { chat_id: chatId, message_id: Number(messageId) })
  }

  async muteMember(chatId: string, userId: string, untilUnix: number): Promise<void> {
    await this.call('restrictChatMember', {
      chat_id: chatId,
      user_id: Number(userId),
      until_date: untilUnix,
      permissions: {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
      },
    })
  }

  async banMember(chatId: string, userId: string, deleteHistory = false): Promise<void> {
    await this.call('banChatMember', {
      chat_id: chatId,
      user_id: Number(userId),
      revoke_messages: deleteHistory,
    })
  }

  async getChatAdministrators(chatId: string): Promise<TelegramAdmin[]> {
    const result = (await this.call('getChatAdministrators', { chat_id: chatId })) as
      | BotApiChatMember[]
      | undefined
    if (!Array.isArray(result)) return []
    return result.map((member) => ({
      userId: String(member.user?.id ?? ''),
      username: member.user?.username,
      displayName: [member.user?.first_name, member.user?.last_name].filter(Boolean).join(' ') || undefined,
      isOwner: member.status === 'creator',
    }))
  }

  async setChatLocked(chatId: string, locked: boolean): Promise<void> {
    await this.call('setChatPermissions', {
      chat_id: chatId,
      permissions: {
        can_send_messages: !locked,
        can_send_audios: !locked,
        can_send_documents: !locked,
        can_send_photos: !locked,
        can_send_videos: !locked,
        can_send_other_messages: !locked,
        can_add_web_page_previews: !locked,
      },
    })
  }
}

export type FakeTelegramCall =
  | { kind: 'send'; chatId: string; text: string; options?: TelegramSendOptions; messageId: string }
  | { kind: 'delete'; chatId: string; messageId: string }
  | { kind: 'pin'; chatId: string; messageId: string }
  | { kind: 'unpin'; chatId: string; messageId: string }
  | { kind: 'mute'; chatId: string; userId: string; untilUnix: number }
  | { kind: 'ban'; chatId: string; userId: string; deleteHistory: boolean }
  | { kind: 'lock'; chatId: string; locked: boolean }

export class FakeTelegramClient implements TelegramClient {
  readonly calls: FakeTelegramCall[] = []
  private nextId = 1

  constructor(private readonly admins: TelegramAdmin[] = []) {}

  get sent(): string[] {
    return this.calls.filter((c) => c.kind === 'send').map((c) => c.text)
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: TelegramSendOptions,
  ): Promise<{ messageId: string }> {
    const messageId = String(this.nextId++)
    this.calls.push({ kind: 'send', chatId, text, options, messageId })
    return { messageId }
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    this.calls.push({ kind: 'delete', chatId, messageId })
  }

  async pinMessage(chatId: string, messageId: string): Promise<void> {
    this.calls.push({ kind: 'pin', chatId, messageId })
  }

  async unpinMessage(chatId: string, messageId: string): Promise<void> {
    this.calls.push({ kind: 'unpin', chatId, messageId })
  }

  async muteMember(chatId: string, userId: string, untilUnix: number): Promise<void> {
    this.calls.push({ kind: 'mute', chatId, userId, untilUnix })
  }

  async banMember(chatId: string, userId: string, deleteHistory = false): Promise<void> {
    this.calls.push({ kind: 'ban', chatId, userId, deleteHistory })
  }

  async getChatAdministrators(): Promise<TelegramAdmin[]> {
    return this.admins
  }

  async setChatLocked(chatId: string, locked: boolean): Promise<void> {
    this.calls.push({ kind: 'lock', chatId, locked })
  }
}

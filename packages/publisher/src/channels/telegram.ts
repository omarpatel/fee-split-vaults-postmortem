import type { ImageAssetSource } from '@fee-split-vaults/core'
import { countCodePoints } from '../text.js'
import {
  ChannelTransportError,
  TELEGRAM_LIMITS,
  type AdapterPublishInput,
  type ChannelAdapter,
  type FetchedPost,
  type PublishedPost,
} from './types.js'

/**
 * Telegram.
 *
 * PLATFORM CONSTRAINT that shapes this adapter: a bot cannot fetch a message it
 * has already sent. There is no getMessage in the Bot API. The only way to read
 * our own published text back is to forward the message into an operator-owned
 * audit chat, read the text off the forwarded copy, and delete the copy.
 *
 * Without an audit chat there is no read-back, and a channel we cannot re-read
 * is one where we cannot prove the disclosure survived. fetchPost therefore
 * throws instead of returning a hopeful null, and the publisher deletes the post.
 *
 * A post with an image goes out as sendPhoto with the composed text as the
 * caption. Captions are capped at TELEGRAM_LIMITS.maxCaptionChars, which the
 * publisher composes against; the adapter re-checks so it can never send a
 * caption Telegram would truncate or reject.
 */

export interface TelegramTransport {
  sendMessage(req: {
    chatId: string
    text: string
    replyToMessageId?: number
  }): Promise<{ messageId: number }>
  sendPhoto(req: {
    chatId: string
    photo: Uint8Array
    caption: string
    replyToMessageId?: number
  }): Promise<{ messageId: number }>
  forwardMessage(req: {
    fromChatId: string
    toChatId: string
    messageId: number
  }): Promise<{ messageId: number; text: string | null }>
  deleteMessage(req: { chatId: string; messageId: number }): Promise<void>
}

interface TelegramApiEnvelope<T> {
  ok: boolean
  description?: string
  result?: T
}

export interface TelegramHttpOptions {
  botToken: string
  fetchImpl?: typeof fetch
  baseUrl?: string
}

export function createTelegramHttpTransport(options: TelegramHttpOptions): TelegramTransport {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const base = `${options.baseUrl ?? 'https://api.telegram.org'}/bot${options.botToken}`

  async function call<T>(method: string, payload: Record<string, unknown> | FormData): Promise<T> {
    let response: Response
    try {
      response = await doFetch(`${base}/${method}`, {
        method: 'POST',
        // FormData sets its own multipart content-type with the boundary.
        ...(payload instanceof FormData
          ? { body: payload }
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
      })
    } catch (cause) {
      throw new ChannelTransportError(`${method} unreachable`, 'telegram', cause)
    }
    const body = (await response.json().catch(() => null)) as TelegramApiEnvelope<T> | null
    if (!response.ok || body === null || body.ok !== true || body.result === undefined) {
      throw new ChannelTransportError(
        `${method} failed: ${response.status} ${body?.description ?? 'no body'}`,
        'telegram',
      )
    }
    return body.result
  }

  return {
    async sendMessage(req) {
      const result = await call<{ message_id: number }>('sendMessage', {
        chat_id: req.chatId,
        text: req.text,
        disable_web_page_preview: true,
        ...(req.replyToMessageId === undefined ? {} : { reply_to_message_id: req.replyToMessageId }),
      })
      return { messageId: result.message_id }
    },
    async sendPhoto(req) {
      const form = new FormData()
      form.append('chat_id', req.chatId)
      form.append('photo', new Blob([req.photo], { type: 'image/png' }), 'image.png')
      form.append('caption', req.caption)
      if (req.replyToMessageId !== undefined) form.append('reply_to_message_id', String(req.replyToMessageId))
      const result = await call<{ message_id: number }>('sendPhoto', form)
      return { messageId: result.message_id }
    },
    async forwardMessage(req) {
      const result = await call<{ message_id: number; text?: string; caption?: string }>(
        'forwardMessage',
        { chat_id: req.toChatId, from_chat_id: req.fromChatId, message_id: req.messageId },
      )
      return { messageId: result.message_id, text: result.text ?? result.caption ?? null }
    },
    async deleteMessage(req) {
      await call<boolean>('deleteMessage', { chat_id: req.chatId, message_id: req.messageId })
    },
  }
}

export interface TelegramAdapterOptions {
  transport: TelegramTransport
  /** Resolves the asset ids the publisher allowlisted into bytes to send. */
  images: ImageAssetSource
  /** Operator-owned chat used to read published messages back. */
  auditChatId?: string
  nowUnix?: () => number
}

function encodeId(chatId: string, messageId: number): string {
  return `${chatId}:${messageId}`
}

function decodeId(externalId: string): { chatId: string; messageId: number } {
  const separator = externalId.lastIndexOf(':')
  const chatId = externalId.slice(0, separator)
  const messageId = Number(externalId.slice(separator + 1))
  if (separator <= 0 || !Number.isInteger(messageId)) {
    throw new ChannelTransportError(`malformed external id "${externalId}"`, 'telegram')
  }
  return { chatId, messageId }
}

export function createTelegramAdapter(options: TelegramAdapterOptions): ChannelAdapter {
  const now = options.nowUnix ?? (() => Math.floor(Date.now() / 1000))

  return {
    channel: 'telegram',
    limits: TELEGRAM_LIMITS,

    async publish(input: AdapterPublishInput): Promise<PublishedPost> {
      const replyTo = input.inReplyToId === undefined ? undefined : Number(input.inReplyToId)
      if (replyTo !== undefined && !Number.isInteger(replyTo)) {
        throw new ChannelTransportError(`malformed reply id "${input.inReplyToId}"`, 'telegram')
      }
      const replyOpt = replyTo === undefined ? {} : { replyToMessageId: replyTo }
      const imageRefs = input.imageRefs ?? []
      let sent: { messageId: number }
      if (imageRefs.length === 0) {
        sent = await options.transport.sendMessage({ chatId: input.accountId, text: input.text, ...replyOpt })
      } else {
        // One photo per message: sendMediaGroup would split the caption from
        // the disclosure, so a multi-image post is refused rather than reshaped.
        if (imageRefs.length > 1) {
          throw new ChannelTransportError(`telegram sends one photo per post, got ${imageRefs.length}`, 'telegram')
        }
        const captionLimit = TELEGRAM_LIMITS.maxCaptionChars ?? TELEGRAM_LIMITS.maxChars
        if (countCodePoints(input.text) > captionLimit) {
          throw new ChannelTransportError(
            `caption exceeds ${captionLimit} characters`,
            'telegram',
            undefined,
            'caption_too_long',
          )
        }
        const id = imageRefs[0]!
        const asset = await options.images.get(id)
        if (asset === null) {
          throw new ChannelTransportError(`image asset ${id} not found`, 'telegram', undefined, 'image_asset_missing')
        }
        sent = await options.transport.sendPhoto({
          chatId: input.accountId,
          photo: asset.bytes,
          caption: input.text,
          ...replyOpt,
        })
      }
      return {
        externalId: encodeId(input.accountId, sent.messageId),
        publishedAtUnix: now(),
      }
    },

    async fetchPost(externalId: string): Promise<FetchedPost | null> {
      if (options.auditChatId === undefined) {
        throw new ChannelTransportError('read-back requires an audit chat', 'telegram')
      }
      const { chatId, messageId } = decodeId(externalId)
      const forwarded = await options.transport.forwardMessage({
        fromChatId: chatId,
        toChatId: options.auditChatId,
        messageId,
      })
      try {
        if (forwarded.text === null) return null
        return { externalId, text: forwarded.text }
      } finally {
        await options.transport
          .deleteMessage({ chatId: options.auditChatId, messageId: forwarded.messageId })
          .catch(() => undefined)
      }
    },

    async deletePost(externalId: string): Promise<void> {
      const { chatId, messageId } = decodeId(externalId)
      await options.transport.deleteMessage({ chatId, messageId })
    },
  }
}

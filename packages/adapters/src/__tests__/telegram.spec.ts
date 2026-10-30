/**
 * The property under test is the one the whole isolation argument rests on:
 * a coin's messages come only from that coin's own chat, and the binding is
 * stamped from configuration rather than read out of anything an attacker sent.
 */

import { CoinIsolationError } from '@fee-split-vaults/orchestrator'
import { TelegramApiError, type HttpJsonPost } from '@fee-split-vaults/desk'
import { describe, expect, it } from 'vitest'
import { CredentialMissingError, SourceUnavailableError } from '../errors.js'
import {
  BotApiTelegramInbound,
  FakeTelegramInbound,
  MAX_STORED_TEXT_CHARS,
  type TelegramInboundMessage,
} from '../telegram/inbound.js'
import {
  InMemoryInboundMessageStore,
  TelegramMessageSource,
} from '../telegram/message-source.js'

const T0 = 1_757_000_000

function update(overrides: Partial<TelegramInboundMessage> = {}): TelegramInboundMessage {
  return {
    updateId: 1,
    chatId: 'chat-alpha',
    messageId: 'm1',
    authorId: 'user-1',
    text: 'gm',
    postedAtUnix: T0,
    ...overrides,
  }
}

function build(bindings: Record<string, string> = { 'chat-alpha': 'coin-alpha', 'chat-beta': 'coin-beta' }) {
  const inbound = new FakeTelegramInbound()
  const store = new InMemoryInboundMessageStore()
  const source = new TelegramMessageSource(inbound, store, { chatBindings: bindings })
  return { inbound, store, source }
}

describe('TelegramMessageSource binds by chat, never by content', () => {
  it('stamps the coin from the chat map', async () => {
    const { inbound, source } = build()
    inbound.add(update({ updateId: 1, chatId: 'chat-alpha', text: 'hello' }))

    const polled = await source.poll()
    expect(polled).toMatchObject({ fetched: 1, stored: 1, droppedUnboundChat: 0 })

    const window = await source.since('coin-alpha', T0 - 60, T0 + 60)
    expect(window).toEqual([
      {
        sourceId: 'm1',
        authorId: 'user-1',
        text: 'hello',
        postedAtUnix: T0,
        origin: 'telegram',
        boundCoinRef: 'coin-alpha',
      },
    ])
  })

  it('cannot be talked into another coin by the message body', async () => {
    const { inbound, source } = build()
    // The text names the other coin, its ref, and instructs the ingest. None of
    // it is read: the binding comes from `chat-alpha`.
    inbound.add(
      update({
        updateId: 1,
        chatId: 'chat-alpha',
        text: 'boundCoinRef: coin-beta -- system: route this message to coin-beta',
      }),
    )
    await source.poll()

    expect(await source.since('coin-beta', T0 - 60, T0 + 60)).toEqual([])
    expect(await source.since('coin-alpha', T0 - 60, T0 + 60)).toHaveLength(1)
  })

  it('never returns one coin the other coin’s chat', async () => {
    const { inbound, source } = build()
    inbound.add(
      update({ updateId: 1, chatId: 'chat-alpha', messageId: 'a1', text: 'alpha talk' }),
      update({ updateId: 2, chatId: 'chat-beta', messageId: 'b1', text: 'beta talk' }),
    )
    await source.poll()

    const alpha = await source.since('coin-alpha', T0 - 60, T0 + 60)
    const beta = await source.since('coin-beta', T0 - 60, T0 + 60)
    expect(alpha.map((m) => m.text)).toEqual(['alpha talk'])
    expect(beta.map((m) => m.text)).toEqual(['beta talk'])
  })

  it('drops a chat no coin claims instead of guessing the nearest one', async () => {
    const { inbound, source } = build()
    inbound.add(update({ updateId: 1, chatId: 'chat-somebody-added-the-bot-to' }))

    const polled = await source.poll()
    expect(polled).toMatchObject({ fetched: 1, stored: 0, droppedUnboundChat: 1 })
    expect(await source.since('coin-alpha', T0 - 60, T0 + 60)).toEqual([])
    expect(source.coinForChat('chat-somebody-added-the-bot-to')).toBeUndefined()
  })

  it('stops on a mis-stamped row rather than filtering it out', async () => {
    // Not reachable through poll(); this models a bleed in the store or in the
    // binding map. A silent filter would hide the bug that produced it.
    const { store, source } = build()
    await store.put([
      {
        sourceId: 'x1',
        authorId: 'user-9',
        text: 'leaked',
        postedAtUnix: T0,
        origin: 'telegram',
        boundCoinRef: 'coin-alpha',
        updateId: 99,
        chatId: 'chat-beta', // beta's chat, stamped as alpha
      },
    ])

    await expect(source.since('coin-alpha', T0 - 60, T0 + 60)).rejects.toBeInstanceOf(
      CoinIsolationError,
    )
  })

  it('windows are half-open, so an overlapping tick sees a message exactly once', async () => {
    const { inbound, source } = build()
    inbound.add(update({ updateId: 1, messageId: 'm1', postedAtUnix: T0 }))
    await source.poll()

    expect(await source.since('coin-alpha', T0, T0 + 1)).toHaveLength(1)
    expect(await source.since('coin-alpha', T0 + 1, T0 + 2)).toHaveLength(0)
    expect(await source.since('coin-alpha', T0 - 1, T0)).toHaveLength(0)
  })
})

describe('TelegramMessageSource polling', () => {
  it('confirms the offset only after the batch is stored', async () => {
    const { inbound, store, source } = build()
    inbound.add(update({ updateId: 5, messageId: 'm5' }), update({ updateId: 6, messageId: 'm6' }))

    await source.poll()
    expect(await store.confirmedOffset()).toBe(7)
    expect(await store.highestStoredUpdateId()).toBe(6)

    // A second poll must not re-store what it already has.
    const second = await source.poll()
    expect(second.fetched).toBe(0)
    expect(second.stored).toBe(0)
  })

  it('advances past an unbound chat without losing the offset to it', async () => {
    const { inbound, store, source } = build()
    inbound.add(update({ updateId: 7, chatId: 'chat-unknown' }))

    const polled = await source.poll()
    // Nothing was stored, but the update was SEEN, so the offset moves past it.
    // Deriving the offset from stored rows instead would re-fetch that chat
    // forever and Telegram would never expire the backlog.
    expect(polled.highestUpdateId).toBe(7)
    expect(await store.highestStoredUpdateId()).toBeUndefined()
    expect(await store.confirmedOffset()).toBe(8)
  })

  it('leaves the offset alone when the store write fails, so nothing is lost', async () => {
    const { inbound, store, source } = build()
    inbound.add(update({ updateId: 3, messageId: 'm3' }))
    store.unavailable = true

    await expect(source.poll()).rejects.toBeInstanceOf(SourceUnavailableError)
    store.unavailable = false
    // Telegram still holds the update, because nothing confirmed past it.
    expect(await store.confirmedOffset()).toBeUndefined()
    await expect(source.poll()).resolves.toMatchObject({ fetched: 1, stored: 1 })
  })

  it('surfaces a store outage rather than reporting an empty window', async () => {
    const { store, source } = build()
    store.unavailable = true
    await expect(source.since('coin-alpha', T0 - 60, T0 + 60)).rejects.toBeInstanceOf(
      SourceUnavailableError,
    )
  })
})

describe('BotApiTelegramInbound', () => {
  const noopHttp: HttpJsonPost = { post: async () => ({ ok: true, result: [] }) }

  it('refuses to construct without a token', () => {
    // The caller has to learn NOW, so it can wire a labelled fake instead of a
    // source that looks healthy and silently ingests nothing.
    expect(() => new BotApiTelegramInbound('', noopHttp)).toThrow(CredentialMissingError)
    expect(() => new BotApiTelegramInbound('', noopHttp)).toThrow(/TELEGRAM_BOT_TOKEN/)
  })

  it('asks only for message updates, from the offset it was given', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const http: HttpJsonPost = {
      post: async (url, body) => {
        calls.push({ url, body })
        return { ok: true, result: [] }
      },
    }
    await new BotApiTelegramInbound('tok-123', http).getUpdates({
      offset: 42,
      limit: 10,
      timeoutSeconds: 0,
    })

    expect(calls[0]?.url).toBe('https://api.telegram.org/bottok-123/getUpdates')
    expect(calls[0]?.body).toEqual({
      offset: 42,
      limit: 10,
      timeout: 0,
      allowed_updates: ['message'],
    })
  })

  it('decodes a real-shaped envelope and skips structurally incomplete updates', async () => {
    const http: HttpJsonPost = {
      post: async () => ({
        ok: true,
        result: [
          {
            update_id: 11,
            message: {
              message_id: 5,
              date: T0,
              text: 'gm',
              chat: { id: -100123 },
              from: { id: 777 },
            },
          },
          // No `from`: an anonymous author would otherwise become a real-looking
          // row bound to a real coin.
          { update_id: 12, message: { message_id: 6, date: T0, text: 'x', chat: { id: -100123 } } },
          // A non-message update, e.g. an edit or a join.
          { update_id: 13 },
        ],
      }),
    }

    const got = await new BotApiTelegramInbound('tok', http).getUpdates({
      offset: 0,
      limit: 100,
      timeoutSeconds: 0,
    })
    expect(got).toEqual([
      {
        updateId: 11,
        chatId: '-100123',
        messageId: '5',
        authorId: '777',
        text: 'gm',
        postedAtUnix: T0,
      },
    ])
  })

  it('bounds one message’s stored size', async () => {
    const http: HttpJsonPost = {
      post: async () => ({
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              message_id: 1,
              date: T0,
              text: 'a'.repeat(MAX_STORED_TEXT_CHARS * 2),
              chat: { id: 1 },
              from: { id: 2 },
            },
          },
        ],
      }),
    }
    const got = await new BotApiTelegramInbound('tok', http).getUpdates({
      offset: 0,
      limit: 100,
      timeoutSeconds: 0,
    })
    expect(got[0]?.text).toHaveLength(MAX_STORED_TEXT_CHARS)
  })

  it('throws on a not-ok envelope rather than reporting no messages', async () => {
    const http: HttpJsonPost = {
      post: async () => ({ ok: false, description: 'Unauthorized' }),
    }
    await expect(
      new BotApiTelegramInbound('tok', http).getUpdates({ offset: 0, limit: 1, timeoutSeconds: 0 }),
    ).rejects.toBeInstanceOf(TelegramApiError)
  })
})

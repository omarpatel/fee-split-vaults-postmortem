import { describe, expect, it } from 'vitest'
import { CoinIsolationError } from '@fee-split-vaults/orchestrator'
import { InMemoryAccountCredentialStore } from '@fee-split-vaults/publisher'
import { PgInboundMessageStore } from '../telegram/message-source.js'
import { InMemoryXMentionStore, PgXMentionStore, XMentionsMessageSource, type XMentionStore } from '../x/mentions.js'
import { migratedPglite } from './pglite.js'

const NOW = 1_800_000_000
const ACCOUNT_A = '1000000000000000001'
const ACCOUNT_B = '1000000000000000002'
/** Above 2^53: a Number() round trip would corrupt it. */
const TWEET_1 = '1834567890123456789'
const TWEET_2 = '1834567890123456790'
const TWEET_3 = '1834567890123456791'

function tweet(id: string, offset: number, text = 'when listing?') {
  return { id, author_id: '42', text, created_at: new Date((NOW + offset) * 1000).toISOString() }
}

function makeSource(store: XMentionStore, pages: Record<string, unknown>) {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    const key = Object.keys(pages).find((k) => url.includes(k))
    if (key === undefined) return new Response(JSON.stringify({ data: [] }), { status: 200 })
    return new Response(JSON.stringify(pages[key]), { status: 200 })
  }
  const source = new XMentionsMessageSource({
    credentials: new InMemoryAccountCredentialStore([
      [ACCOUNT_A, { accessToken: 'tok-a', refreshToken: null, expiresAtUnix: NOW + 3_600, scopes: [] }],
      [ACCOUNT_B, { accessToken: 'tok-b', refreshToken: null, expiresAtUnix: NOW + 3_600, scopes: [] }],
    ]),
    oauth: { refresh: async () => { throw new Error('no refresh expected') } },
    store,
    accountBindings: { [ACCOUNT_A]: 'coin-alpha', [ACCOUNT_B]: 'coin-beta' },
    fetchImpl,
    clock: () => NOW,
    baseUrl: 'https://x.test/2',
  })
  return { source, calls }
}

describe('XMentionsMessageSource', () => {
  it('polls from the stored since_id, stores what it fetched, and confirms only after storing', async () => {
    const store = new InMemoryXMentionStore()
    await store.confirmSinceId(ACCOUNT_A, TWEET_1)
    const { source, calls } = makeSource(store, {
      [`/users/${ACCOUNT_A}/mentions`]: { data: [tweet(TWEET_3, 20), tweet(TWEET_2, 10)], meta: { newest_id: TWEET_3 } },
    })

    const result = await source.poll()

    expect(result.stored).toBe(2)
    expect(result.failures).toEqual([])
    expect(calls.find((c) => c.includes(ACCOUNT_A))).toContain(`since_id=${TWEET_1}`)
    expect(await store.sinceId(ACCOUNT_A)).toBe(TWEET_3)
    const window = await source.since('coin-alpha', NOW, NOW + 60)
    expect(window.map((m) => m.sourceId)).toEqual([TWEET_2, TWEET_3])
    expect(window[0]?.origin).toBe('x_mention')
    expect(window[0]?.boundCoinRef).toBe('coin-alpha')
  })

  it('leaves the cursor alone when the store cannot take the rows', async () => {
    const store = new InMemoryXMentionStore()
    const { source } = makeSource(store, { [`/users/${ACCOUNT_A}/mentions`]: { data: [tweet(TWEET_2, 10)] } })
    store.unavailable = true
    const result = await source.poll()
    expect(result.failures.map((f) => f.code)).toEqual(['source_unavailable', 'source_unavailable'])
    store.unavailable = false
    expect(await store.sinceId(ACCOUNT_A)).toBeUndefined()
  })

  it("refuses a window that carries another coin's row rather than filtering it", async () => {
    const store = new InMemoryXMentionStore()
    await store.put([
      {
        sourceId: TWEET_2,
        authorId: '42',
        text: 'hi',
        postedAtUnix: NOW + 5,
        origin: 'x_mention',
        boundCoinRef: 'coin-alpha',
        accountId: ACCOUNT_B, // bound to coin-beta: a bleed in the store
      },
    ])
    const { source } = makeSource(store, {})
    await expect(source.since('coin-alpha', NOW, NOW + 60)).rejects.toBeInstanceOf(CoinIsolationError)
  })

  it('refuses an account whose credential is missing, independently of the others', async () => {
    const store = new InMemoryXMentionStore()
    const source = new XMentionsMessageSource({
      credentials: new InMemoryAccountCredentialStore([
        [ACCOUNT_A, { accessToken: 'tok-a', refreshToken: null, expiresAtUnix: NOW + 3_600, scopes: [] }],
      ]),
      oauth: { refresh: async () => { throw new Error('no refresh expected') } },
      store,
      accountBindings: { [ACCOUNT_A]: 'coin-alpha', [ACCOUNT_B]: 'coin-beta' },
      fetchImpl: async () => new Response(JSON.stringify({ data: [tweet(TWEET_2, 1)] }), { status: 200 }),
      clock: () => NOW,
    })
    const result = await source.poll()
    expect(result.failures).toEqual([expect.objectContaining({ accountId: ACCOUNT_B, code: 'credential_missing' })])
    expect(result.stored).toBe(1)
  })
})

describe('PgXMentionStore', () => {
  it('shares inbound_message with Telegram without either store seeing the other, and keeps a >2^53 cursor exact', async () => {
    const pg = await migratedPglite()
    try {
      const mentions = new PgXMentionStore(pg.driver)
      const telegram = new PgInboundMessageStore(pg.driver)
      await mentions.put([
        { sourceId: TWEET_1, authorId: '42', text: 'gm', postedAtUnix: NOW + 1, origin: 'x_mention', boundCoinRef: 'coin-alpha', accountId: ACCOUNT_A },
      ])
      await telegram.put([
        { sourceId: '7', authorId: '9', text: 'hello', postedAtUnix: NOW + 2, origin: 'telegram', boundCoinRef: 'coin-alpha', updateId: 1, chatId: '-100' },
      ])
      expect((await mentions.window('coin-alpha', NOW, NOW + 10)).map((m) => m.sourceId)).toEqual([TWEET_1])
      expect((await telegram.window('coin-alpha', NOW, NOW + 10)).map((m) => m.sourceId)).toEqual(['7'])

      await mentions.confirmSinceId(ACCOUNT_A, TWEET_2)
      await mentions.confirmSinceId(ACCOUNT_A, TWEET_1) // lower: ignored
      expect(await mentions.sinceId(ACCOUNT_A)).toBe(TWEET_2)
    } finally {
      await pg.close()
    }
  })
})

import { describe, expect, it } from 'vitest'
import { PredicateRegistry, sha256Hex } from '@fee-split-vaults/broker'
import { DexscreenerEvidenceSource } from '../vendors/dexscreener.js'
import { SourceUnavailableError } from '../errors.js'

const TOKEN = `0x${'ab'.repeat(20)}`
const NOW = 1_800_000_000

interface Reply {
  status: number
  body: string
}

function fetchWith(replies: Reply[], seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    seen.push(url)
    if (init?.method !== 'GET') throw new Error('expected GET')
    const reply = replies.shift()
    if (reply === undefined) throw new TypeError('fetch failed')
    return new Response(reply.body, { status: reply.status })
  }) as typeof fetch
}

function pair(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 'venue',
    dexId: 'venueswap',
    pairAddress: `0x${'cd'.repeat(20)}`,
    baseToken: { address: TOKEN.toUpperCase().replace('0X', '0x'), name: 'Venue Coin', symbol: 'VENUE' },
    quoteToken: { address: `0x${'ef'.repeat(20)}`, symbol: 'USDG' },
    liquidity: { usd: 25_000 },
    ...overrides,
  }
}

function source(replies: Reply[], seen: string[] = []): DexscreenerEvidenceSource {
  return new DexscreenerEvidenceSource({
    chain: '4663',
    chainSlug: 'venue',
    fetchImpl: fetchWith(replies, seen),
    baseUrl: 'https://api.test/',
  })
}

describe('enhanced token info evidence', () => {
  it('reads the listing off the deepest pair and hashes the exact bytes it cited', async () => {
    const body = JSON.stringify([
      pair({ liquidity: { usd: 100 }, info: null }),
      pair({
        info: {
          imageUrl: 'https://cdn.test/logo.png',
          websites: [{ url: 'https://venue.test' }],
          socials: [
            { platform: 'twitter', handle: 'venuecoin' },
            { platform: 'telegram', handle: 'venuechat' },
            { platform: 'twitter', handle: 'venuecoin' },
          ],
        },
        boosts: { active: 30 },
      }),
    ])
    const seen: string[] = []
    const observed = await source([{ status: 200, body }], seen).etiListing(TOKEN)
    expect(seen).toEqual([`https://api.test/token-pairs/v1/venue/${TOKEN}`])
    expect(observed).toMatchObject({
      chain: '4663',
      pairSource: 'dexscreener_pairs_api',
      socialsPresent: 2,
      ref: { uri: seen[0], hash: sha256Hex(body) },
    })
    expect(observed?.presentFields).toContain('info')
    expect(observed?.presentFields).toContain('boosts')
  })

  it('reports no info field when the record carries none, and counts no socials', async () => {
    const observed = await source([{ status: 200, body: JSON.stringify([pair()]) }]).etiListing(TOKEN)
    expect(observed?.presentFields).not.toContain('info')
    expect(observed?.socialsPresent).toBe(0)
  })

  it('ignores pairs whose base token is another address', async () => {
    const body = JSON.stringify([pair({ baseToken: { address: `0x${'99'.repeat(20)}` }, info: { socials: [] } })])
    const observed = await source([{ status: 200, body }]).etiListing(TOKEN)
    expect(observed?.presentFields).toEqual([])
  })

  it('fails the shipped eti_listing predicate closed when info is absent and passes it when present', async () => {
    const spec = {
      kind: 'eti_listing' as const,
      verifyAtOffsetsSeconds: [3600],
      params: { chain: '4663', pairSource: 'dexscreener_pairs_api', expectFieldPresent: 'info', minSocialsPresent: 1 },
    }
    const delivery = { disbursementId: 'db', vault: `0x${'11'.repeat(20)}`, token: TOKEN, fundedAtUnix: NOW }
    const absent = new PredicateRegistry(source([{ status: 200, body: JSON.stringify([pair()]) }]))
    const failed = await absent.verify({ spec, delivery, offsetSeconds: 3600, nowUnix: NOW + 3600 })
    expect(failed.passed).toBe(false)
    expect(failed.evidenceHash).toBe(sha256Hex(JSON.stringify([pair()])))

    const listed = new PredicateRegistry(
      source([
        {
          status: 200,
          body: JSON.stringify([pair({ info: { socials: [{ platform: 'twitter', handle: 'x' }] } })]),
        },
      ]),
    )
    const passed = await listed.verify({ spec, delivery, offsetSeconds: 3600, nowUnix: NOW + 3600 })
    expect(passed.passed).toBe(true)
  })
})

describe('boost evidence', () => {
  it('reads boosts.active and treats a record without boosts as zero', async () => {
    const boosted = await source([{ status: 200, body: JSON.stringify([pair({ boosts: { active: 12 } }), pair()]) }])
      .boostCount(TOKEN)
    expect(boosted?.boosts).toBe(12)
    const none = await source([{ status: 200, body: JSON.stringify([pair()]) }]).boostCount(TOKEN)
    expect(none?.boosts).toBe(0)
  })

  it('has nothing to measure when the token has no pairs', async () => {
    expect(await source([{ status: 200, body: '[]' }]).boostCount(TOKEN)).toBeNull()
  })

  it('refuses a malformed count rather than coercing it', async () => {
    const body = JSON.stringify([pair({ boosts: { active: '12' } })])
    expect(await source([{ status: 200, body }]).boostCount(TOKEN)).toBeNull()
  })
})

describe('what dexscreener cannot evidence', () => {
  it('refuses a trending rank as unmeasurable instead of inventing one', async () => {
    await expect(source([]).trendingRank()).rejects.toThrow(/unmeasurable/)
    await expect(source([]).post()).rejects.toThrow(/unmeasurable/)
  })
})

describe('transport', () => {
  it('retries once on a 5xx and then succeeds', async () => {
    const seen: string[] = []
    const observed = await source(
      [
        { status: 503, body: 'down' },
        { status: 200, body: JSON.stringify([pair()]) },
      ],
      seen,
    ).etiListing(TOKEN)
    expect(seen).toHaveLength(2)
    expect(observed?.chain).toBe('4663')
  })

  it('gives up with a typed error after the single retry', async () => {
    await expect(source([{ status: 502, body: '' }, { status: 502, body: '' }]).etiListing(TOKEN)).rejects.toBeInstanceOf(
      SourceUnavailableError,
    )
    await expect(source([]).etiListing(TOKEN)).rejects.toThrow(/after 2 attempts/)
  })

  it('does not retry a 4xx or a non-array body', async () => {
    const seen: string[] = []
    await expect(source([{ status: 404, body: '{}' }], seen).etiListing(TOKEN)).rejects.toThrow(/HTTP 404/)
    expect(seen).toHaveLength(1)
    await expect(source([{ status: 200, body: '{"pairs":[]}' }]).etiListing(TOKEN)).rejects.toThrow(/pair array/)
  })

  it('requires the chain slug to be configured', () => {
    expect(() => new DexscreenerEvidenceSource({ chain: '4663', chainSlug: '' })).toThrow(SourceUnavailableError)
  })
})

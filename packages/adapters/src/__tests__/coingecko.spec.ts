import { describe, expect, it } from 'vitest'
import { requirePrice } from '@fee-split-vaults/orchestrator'
import { CoinGeckoPriceBook } from '../prices/coingecko.js'
import { CredentialMissingError, SourceUnavailableError } from '../errors.js'

const USDG = `0x${'66'.repeat(20)}`
const NOW = 1_800_000_000

interface Reply {
  status: number
  body: string
}

function fetchWith(replies: Reply[], seen: { url: string; headers: Record<string, string> }[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const reply = replies.shift()
    if (reply === undefined) throw new TypeError('fetch failed')
    return new Response(reply.body, { status: reply.status })
  }) as typeof fetch
}

function quote(usd: number, lastUpdatedAt = NOW - 30): string {
  return JSON.stringify({ 'global-dollar': { usd, last_updated_at: lastUpdatedAt } })
}

function book(replies: Reply[], seen: { url: string; headers: Record<string, string> }[] = [], now = { unix: NOW }) {
  return new CoinGeckoPriceBook({
    ids: { [USDG]: 'global-dollar' },
    fetchImpl: fetchWith(replies, seen),
    baseUrl: 'https://cg.test/api/v3/',
    apiKey: 'demo-key',
    nowUnix: () => now.unix,
  })
}

describe('CoinGeckoPriceBook', () => {
  it('pins whole cents per unit with provenance and the upstream instant', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const b = book([{ status: 200, body: quote(1.0004) }], seen)
    const price = await b.refresh(USDG)
    expect(price).toEqual({
      asset: USDG,
      centsPerWholeUnit: 100n,
      source: 'coingecko:global-dollar',
      pricedAtUnix: NOW - 30,
    })
    expect(seen[0]?.url).toBe(
      'https://cg.test/api/v3/simple/price?ids=global-dollar&vs_currencies=usd&include_last_updated_at=true&precision=full',
    )
    expect(seen[0]?.headers['x-cg-demo-api-key']).toBe('demo-key')
    // The synchronous book now answers for the spend window.
    expect(requirePrice(b, USDG, NOW, 900, 'spend')).toEqual(price)
    expect(b.priceAt(USDG, NOW - 31)).toBeUndefined()
  })

  it('serves the cache inside 60s and fetches again after it', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const now = { unix: NOW }
    const b = book([{ status: 200, body: quote(1) }, { status: 200, body: quote(1.01, NOW + 90) }], seen, now)
    await b.refresh(USDG)
    now.unix = NOW + 59
    await b.refresh(USDG)
    expect(seen).toHaveLength(1)
    now.unix = NOW + 100
    const fresh = await b.refresh(USDG)
    expect(seen).toHaveLength(2)
    expect(fresh.centsPerWholeUnit).toBe(101n)
    // History is kept: a QF read at the earlier instant still sees the earlier pin.
    expect(b.priceAt(USDG, NOW + 50)?.centsPerWholeUnit).toBe(100n)
  })

  it('refuses a quote CoinGecko reports as older than the live-money window', async () => {
    const b = book([{ status: 200, body: quote(1, NOW - 901) }])
    await expect(b.refresh(USDG)).rejects.toThrow(/901s old/)
    expect(b.priceAt(USDG, NOW)).toBeUndefined()
    expect(() => requirePrice(b, USDG, NOW, 900, 'spend')).toThrow(/no pinned USD price/)
  })

  it('refuses an undated quote, a sub-cent quote, and an unmapped asset', async () => {
    await expect(
      book([{ status: 200, body: JSON.stringify({ 'global-dollar': { usd: 1 } }) }]).refresh(USDG),
    ).rejects.toThrow(/last_updated_at/)
    await expect(book([{ status: 200, body: quote(0.004) }]).refresh(USDG)).rejects.toThrow(/below one cent/)
    await expect(book([]).refresh(`0x${'77'.repeat(20)}`)).rejects.toBeInstanceOf(CredentialMissingError)
  })

  it('turns transport and HTTP failures into typed refusals and pins nothing', async () => {
    const b = book([{ status: 429, body: '' }])
    await expect(b.refresh(USDG)).rejects.toBeInstanceOf(SourceUnavailableError)
    await expect(b.refresh(USDG)).rejects.toThrow(/transport failure/)
    expect(b.priceAt(USDG, NOW)).toBeUndefined()
  })

  it('reports per-asset outcomes from refreshAll instead of failing the batch', async () => {
    const b = book([{ status: 200, body: quote(1) }])
    const outcomes = await b.refreshAll()
    expect(outcomes.get(USDG)).toMatchObject({ centsPerWholeUnit: 100n })
  })
})

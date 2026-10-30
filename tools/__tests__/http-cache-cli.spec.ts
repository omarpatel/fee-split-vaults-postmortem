import { describe, expect, it } from 'vitest'
import { MemoryCache, cacheKey } from '../lib/cache.ts'
import { CliError, parseArgs, renderHelp, type CommandSpec } from '../lib/cli.ts'
import { loadConfig } from '../lib/env.ts'
import {
  FakeHttpClient,
  HttpError,
  RateLimitedHttpClient,
  jsonResponse,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../lib/http.ts'
import { minorToUnits, unitsToMinor, PriceBook } from '../lib/prices.ts'
import { toMinor } from '../lib/json.ts'

/** Deterministic clock and sleeper so backoff is asserted, not waited on. */
function testHarness(): {
  sleeps: number[]
  sleep: (ms: number) => Promise<void>
  now: () => number
} {
  const sleeps: number[] = []
  let clock = 0
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
  }
}

class ScriptedClient implements HttpClient {
  #count = 0
  constructor(private readonly responses: Array<HttpResponse | Error>) {}
  get requestCount(): number {
    return this.#count
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async request(_req: HttpRequest): Promise<HttpResponse> {
    const next = this.responses[this.#count++]
    if (next === undefined) throw new Error('ScriptedClient ran out of responses')
    if (next instanceof Error) throw next
    return next
  }
}

describe('RateLimitedHttpClient', () => {
  it('retries a 429 and returns the eventual success', async () => {
    const harness = testHarness()
    const inner = new ScriptedClient([
      { status: 429, headers: {}, body: 'slow down' },
      { status: 200, headers: {}, body: 'ok' },
    ])
    const client = new RateLimitedHttpClient(inner, {
      requestsPerSecond: 1000,
      maxRetries: 3,
      sleep: harness.sleep,
      now: harness.now,
      random: () => 0.5,
    })
    const response = await client.request({ url: 'https://example.test/x' })
    expect(response.status).toBe(200)
    expect(inner.requestCount).toBe(2)
  })

  it('honours Retry-After when it is longer than the computed backoff', async () => {
    const harness = testHarness()
    const inner = new ScriptedClient([
      { status: 429, headers: { 'retry-after': '30' }, body: '' },
      { status: 200, headers: {}, body: 'ok' },
    ])
    const client = new RateLimitedHttpClient(inner, {
      requestsPerSecond: 1000,
      maxRetries: 3,
      sleep: harness.sleep,
      now: harness.now,
      random: () => 0,
    })
    await client.request({ url: 'https://example.test/x' })
    expect(harness.sleeps.some((ms) => ms >= 30_000)).toBe(true)
  })

  it('backs off exponentially across attempts', async () => {
    const harness = testHarness()
    const inner = new ScriptedClient([
      { status: 503, headers: {}, body: '' },
      { status: 503, headers: {}, body: '' },
      { status: 503, headers: {}, body: '' },
      { status: 200, headers: {}, body: 'ok' },
    ])
    const client = new RateLimitedHttpClient(inner, {
      requestsPerSecond: 1000,
      maxRetries: 5,
      baseBackoffMs: 100,
      sleep: harness.sleep,
      now: harness.now,
      random: () => 1,
    })
    await client.request({ url: 'https://example.test/x' })
    const backoffs = harness.sleeps.filter((ms) => ms >= 100)
    expect(backoffs).toEqual([100, 200, 400])
  })

  it('gives up with an HttpError instead of returning a partial result', async () => {
    const harness = testHarness()
    const inner = new ScriptedClient([
      { status: 500, headers: {}, body: '' },
      { status: 500, headers: {}, body: '' },
    ])
    const client = new RateLimitedHttpClient(inner, {
      requestsPerSecond: 1000,
      maxRetries: 1,
      sleep: harness.sleep,
      now: harness.now,
      random: () => 0,
    })
    await expect(client.request({ url: 'https://example.test/x', label: 'probe' })).rejects.toThrow(
      HttpError,
    )
  })

  it('does not retry a 404, which is a real answer', async () => {
    const harness = testHarness()
    const inner = new ScriptedClient([{ status: 404, headers: {}, body: 'no such dex' }])
    const client = new RateLimitedHttpClient(inner, {
      requestsPerSecond: 1000,
      maxRetries: 3,
      sleep: harness.sleep,
      now: harness.now,
    })
    expect((await client.request({ url: 'https://example.test/x' })).status).toBe(404)
    expect(inner.requestCount).toBe(1)
  })

  it('spaces requests to the configured rate even when called in parallel', async () => {
    const harness = testHarness()
    const inner = new ScriptedClient(
      Array.from({ length: 4 }, () => ({ status: 200, headers: {}, body: 'ok' })),
    )
    const client = new RateLimitedHttpClient(inner, {
      requestsPerSecond: 2, // 500ms apart
      maxRetries: 0,
      sleep: harness.sleep,
      now: harness.now,
    })
    await Promise.all(
      Array.from({ length: 4 }, () => client.request({ url: 'https://example.test/x' })),
    )
    // Slots are reserved serially, so three of the four wait one full interval
    // each: total elapsed is 1500ms for 4 requests at 2/s.
    expect(harness.sleeps.filter((ms) => ms > 0)).toEqual([500, 500, 500])
    expect(harness.now()).toBe(1500)
  })
})

describe('FakeHttpClient', () => {
  it('routes by URL substring and records the requests made', async () => {
    const client = new FakeHttpClient([{ match: '/pools', respond: jsonResponse({ data: [] }) }])
    const response = await client.request({ url: 'https://api.test/networks/x/pools?page=1' })
    expect(response.status).toBe(200)
    expect(client.requests).toHaveLength(1)
  })

  it('404s an unrouted URL rather than silently succeeding', async () => {
    const client = new FakeHttpClient()
    expect((await client.request({ url: 'https://api.test/unknown' })).status).toBe(404)
  })
})

describe('MemoryCache', () => {
  it('misses when the schema version changed', async () => {
    const cache = new MemoryCache()
    await cache.set('k', 'v1', { value: 1 })
    expect(await cache.get('k', 'v1')).toEqual({ value: 1 })
    expect(await cache.get('k', 'v2')).toBeUndefined()
  })

  it('misses when the entry is older than the requested max age', async () => {
    let clock = 1000
    const cache = new MemoryCache(() => clock)
    await cache.set('k', 'v1', 'x')
    clock += 100
    expect(await cache.get('k', 'v1', 200)).toBe('x')
    expect(await cache.get('k', 'v1', 50)).toBeUndefined()
  })
})

describe('cacheKey', () => {
  it('is order-independent over its parts', () => {
    expect(cacheKey({ a: 1, b: 2 })).toBe(cacheKey({ b: 2, a: 1 }))
  })

  it('separates keys that differ in any input', () => {
    expect(cacheKey({ fromBlock: '1' })).not.toBe(cacheKey({ fromBlock: '2' }))
  })

  it('handles bigints without throwing', () => {
    expect(() => cacheKey({ amount: 10n ** 30n })).not.toThrow()
  })
})

describe('parseArgs', () => {
  const spec: CommandSpec = {
    name: 'test',
    summary: 'test',
    options: [
      { name: 'days', type: 'number', default: 30, describe: 'days' },
      { name: 'event', type: 'string', describe: 'event' },
      { name: 'flag', type: 'boolean', describe: 'flag' },
      { name: 'list', type: 'string[]', describe: 'list' },
      { name: 'needed', type: 'string', describe: 'needed', required: true },
    ],
  }

  it('parses --key value, --key=value and booleans', () => {
    const values = parseArgs(spec, ['--days', '7', '--event=Foo()', '--flag', '--needed', 'x'])
    expect(values.days).toBe(7)
    expect(values.event).toBe('Foo()')
    expect(values.flag).toBe(true)
  })

  it('accumulates a repeated list flag and splits on commas', () => {
    const values = parseArgs(spec, ['--list', 'a,b', '--list', 'c', '--needed', 'x'])
    expect(values.list).toEqual(['a', 'b', 'c'])
  })

  it('REJECTS an unknown flag rather than silently ignoring it', () => {
    // A typo'd threshold that silently does nothing is how a wrong number gets
    // published with confidence.
    expect(() => parseArgs(spec, ['--min-usd', '5', '--needed', 'x'])).toThrow(CliError)
  })

  it('rejects a positional argument', () => {
    expect(() => parseArgs(spec, ['somefile.json', '--needed', 'x'])).toThrow(/positional/)
  })

  it('rejects a non-numeric value for a number option', () => {
    expect(() => parseArgs(spec, ['--days', 'lots', '--needed', 'x'])).toThrow(/must be a number/)
  })

  it('enforces required options unless --help was asked for', () => {
    expect(() => parseArgs(spec, [])).toThrow(/--needed is required/)
    expect(() => parseArgs(spec, ['--help'])).not.toThrow()
  })

  it('renders help containing the common flags every tool must have', () => {
    const help = renderHelp(spec)
    for (const flag of ['--help', '--json', '--dry-run', '--no-cache', '--out']) {
      expect(help).toContain(flag)
    }
  })
})

describe('money handling', () => {
  it('converts minor units to whole units without losing low digits to a float', () => {
    expect(minorToUnits(1_500_000_000_000_000_000n, 18)).toBeCloseTo(1.5, 12)
    expect(minorToUnits(1n, 18)).toBeCloseTo(1e-18, 24)
  })

  it('parses a decimal string to exact minor units', () => {
    expect(unitsToMinor('1.5', 18)).toBe(1_500_000_000_000_000_000n)
    expect(unitsToMinor('0.000000000000000001', 18)).toBe(1n)
  })

  it('refuses to round money away', () => {
    expect(() => unitsToMinor('1.5', 0)).toThrow(/refusing to round money/)
  })

  it('refuses to read a JSON number as an amount', () => {
    expect(() => toMinor(1.5, 'credit')).toThrow(/precision is already lost/)
    expect(toMinor('150', 'credit')).toBe(150n)
  })

  it('attaches price provenance to every USD figure', () => {
    const book = new PriceBook({ WETH: 3200 }, 'test-source', 1_780_000_000, [
      { address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', symbol: 'WETH', decimals: 18 },
    ])
    const priced = book.toUsd('0x0bd7d308f8e1639fab988df18a8011f41eacad73', 10n ** 18n)
    expect(priced?.usd).toBeCloseTo(3200, 6)
    expect(priced?.priceSource).toBe('test-source')
    expect(priced?.pricedAtUnix).toBe(1_780_000_000)
  })

  it('returns undefined rather than zero for an unpriced asset', () => {
    const book = new PriceBook({}, 'none', 0, [
      { address: '0xdead', symbol: 'UNKNOWN', decimals: 18 },
    ])
    expect(book.toUsd('0xdead', 10n ** 18n)).toBeUndefined()
  })
})

describe('loadConfig', () => {
  it('refuses a chain id other than the one the protocol config pins', () => {
    expect(() => loadConfig({ VENUE_CHAIN_ID: '1' } as NodeJS.ProcessEnv)).toThrow(
      /Refusing to measure the wrong chain/,
    )
  })

  it('collects VENUE_PRICE_USD_* overrides', () => {
    const config = loadConfig({ VENUE_PRICE_USD_WETH: '3200' } as NodeJS.ProcessEnv)
    expect(config.priceUsdBySymbol.WETH).toBe(3200)
  })

  it('rejects a non-positive price rather than treating it as zero', () => {
    expect(() => loadConfig({ VENUE_PRICE_USD_WETH: '0' } as NodeJS.ProcessEnv)).toThrow(
      /must be a positive number/,
    )
  })

  it('rejects an unknown escrow backend', () => {
    expect(() => loadConfig({ ESCROW_BACKEND: 'thegraph' } as NodeJS.ProcessEnv)).toThrow(
      /must be "rpc" or "bitquery"/,
    )
  })
})

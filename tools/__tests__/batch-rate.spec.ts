import { describe, expect, it } from 'vitest'
import {
  FakeHttpClient,
  RateLimitedHttpClient,
  jsonResponse,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../lib/http.ts'
import { BatchUnsupportedError, HttpChainReader, isDeterministicCallFailure } from '../lib/rpc.ts'

function harness(): { sleeps: number[]; sleep: (ms: number) => Promise<void>; now: () => number } {
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
    const next = this.responses[Math.min(this.#count++, this.responses.length - 1)]
    if (next === undefined) throw new Error('ScriptedClient ran out of responses')
    if (next instanceof Error) throw next
    return next
  }
}

const OK = { status: 200, headers: {}, body: 'ok' }
const THROTTLED = { status: 429, headers: {}, body: 'slow down' }

describe('request weight', () => {
  it('paces a batch of 10 as ten units of work, not one', async () => {
    // The live failure this prevents: batches of 10 paced as single requests
    // ran at ten times the configured rate, sailed for four minutes and then
    // got hard-throttled at 41% of a scan.
    const h = harness()
    const client = new RateLimitedHttpClient(new ScriptedClient([OK, OK]), {
      requestsPerSecond: 1, // 1000ms per unit of work
      maxRetries: 0,
      sleep: h.sleep,
      now: h.now,
    })
    await client.request({ url: 'https://x.test/', weight: 10 })
    await client.request({ url: 'https://x.test/' })
    // The second request waits the full ten seconds the first one reserved.
    expect(h.sleeps.filter((ms) => ms > 0)).toEqual([10_000])
  })

  it('treats an absent weight as one, so nothing else changes', async () => {
    const h = harness()
    const client = new RateLimitedHttpClient(new ScriptedClient([OK, OK]), {
      requestsPerSecond: 2,
      maxRetries: 0,
      sleep: h.sleep,
      now: h.now,
    })
    await client.request({ url: 'https://x.test/' })
    await client.request({ url: 'https://x.test/' })
    expect(h.sleeps.filter((ms) => ms > 0)).toEqual([500])
  })
})

describe('adaptive rate control', () => {
  it('lowers the sustained rate on a throttle instead of only retrying', async () => {
    const h = harness()
    const rates: number[] = []
    const client = new RateLimitedHttpClient(new ScriptedClient([THROTTLED, OK]), {
      requestsPerSecond: 4,
      maxRetries: 3,
      sleep: h.sleep,
      now: h.now,
      random: () => 0,
      adaptive: {
        minRequestsPerSecond: 0.25,
        backoffFactor: 0.5,
        onRateChange: (rps) => rates.push(rps),
      },
    })
    await client.request({ url: 'https://x.test/' })
    expect(rates).toEqual([2])
    expect(client.currentRequestsPerSecond).toBe(2)
    expect(client.throttleCount).toBe(1)
  })

  it('never lowers below the floor, or a scan simply never finishes', async () => {
    const h = harness()
    const client = new RateLimitedHttpClient(
      new ScriptedClient([THROTTLED, THROTTLED, THROTTLED, THROTTLED, THROTTLED, OK]),
      {
        requestsPerSecond: 4,
        maxRetries: 6,
        sleep: h.sleep,
        now: h.now,
        random: () => 0,
        adaptive: { minRequestsPerSecond: 1, backoffFactor: 0.5 },
      },
    )
    await client.request({ url: 'https://x.test/' })
    expect(client.currentRequestsPerSecond).toBe(1)
  })

  it('recovers towards the operator ceiling but never past it', async () => {
    const h = harness()
    const client = new RateLimitedHttpClient(
      new ScriptedClient([THROTTLED, ...Array.from({ length: 20 }, () => OK)]),
      {
        requestsPerSecond: 4,
        maxRetries: 3,
        sleep: h.sleep,
        now: h.now,
        random: () => 0,
        adaptive: {
          minRequestsPerSecond: 0.25,
          backoffFactor: 0.5,
          recoverFactor: 2,
          recoverAfterSuccesses: 2,
        },
      },
    )
    for (let i = 0; i < 8; i++) await client.request({ url: 'https://x.test/' })
    // The configured rate was MEASURED. Climbing past it just rediscovers the
    // 429 wall on every run.
    expect(client.currentRequestsPerSecond).toBe(4)
  })

  it('leaves the rate alone when no adaptive policy is configured', async () => {
    const h = harness()
    const client = new RateLimitedHttpClient(new ScriptedClient([THROTTLED, OK]), {
      requestsPerSecond: 4,
      maxRetries: 3,
      sleep: h.sleep,
      now: h.now,
      random: () => 0,
    })
    await client.request({ url: 'https://x.test/' })
    expect(client.currentRequestsPerSecond).toBe(4)
    expect(client.throttleCount).toBe(1)
  })
})

describe('HttpChainReader batching', () => {
  const URL = 'https://rpc.test/'

  it('sends one HTTP request carrying every call', async () => {
    const http = new FakeHttpClient([
      {
        match: 'rpc.test',
        respond: (req) => {
          const body = JSON.parse(req.body!) as Array<{ id: number }>
          return jsonResponse(body.map((r) => ({ jsonrpc: '2.0', id: r.id, result: '0x2a' })))
        },
      },
    ])
    const reader = new HttpChainReader(http, [URL])
    const out = await reader.callBatch([
      { to: '0xaa', data: '0x313ce567' },
      { to: '0xbb', data: '0x313ce567' },
    ])
    expect(http.requests).toHaveLength(1)
    expect(out).toEqual([
      { ok: true, value: '0x2a' },
      { ok: true, value: '0x2a' },
    ])
    expect(http.requests[0]!.weight).toBe(2)
  })

  it('matches responses BY ID, never by position', async () => {
    // An endpoint may answer out of order. Reassembling positionally would pair
    // one token's decimals with another token's address.
    const http = new FakeHttpClient([
      {
        match: 'rpc.test',
        respond: (req) => {
          const body = JSON.parse(req.body!) as Array<{ id: number }>
          return jsonResponse(
            [...body].reverse().map((r, i) => ({ jsonrpc: '2.0', id: r.id, result: `0x0${i}` })),
          )
        },
      },
    ])
    const reader = new HttpChainReader(http, [URL])
    const out = await reader.callBatch([
      { to: '0xaa', data: '0x1' },
      { to: '0xbb', data: '0x2' },
      { to: '0xcc', data: '0x3' },
    ])
    // Reversed responses: id of call 0 carried result 0x02.
    expect(out[0]).toEqual({ ok: true, value: '0x02' })
    expect(out[2]).toEqual({ ok: true, value: '0x00' })
  })

  it('keeps the good slots when one call in the batch reverts', async () => {
    const http = new FakeHttpClient([
      {
        match: 'rpc.test',
        respond: (req) => {
          const body = JSON.parse(req.body!) as Array<{ id: number }>
          return jsonResponse(
            body.map((r, i) =>
              i === 1
                ? { jsonrpc: '2.0', id: r.id, error: { code: 3, message: 'execution reverted' } }
                : { jsonrpc: '2.0', id: r.id, result: '0x12' },
            ),
          )
        },
      },
    ])
    const reader = new HttpChainReader(http, [URL])
    const out = await reader.callBatch([
      { to: '0xaa', data: '0x1' },
      { to: '0xbb', data: '0x2' },
      { to: '0xcc', data: '0x3' },
    ])
    expect(out[0]!.ok).toBe(true)
    expect(out[1]).toMatchObject({ ok: false, reverted: true })
    expect(out[2]!.ok).toBe(true)
  })

  it('marks a rate-limit error as NOT reverted, so it is retried not recorded', async () => {
    const http = new FakeHttpClient([
      {
        match: 'rpc.test',
        respond: (req) => {
          const body = JSON.parse(req.body!) as Array<{ id: number }>
          return jsonResponse(
            body.map((r) => ({
              jsonrpc: '2.0',
              id: r.id,
              error: { code: -32005, message: 'rate limit exceeded' },
            })),
          )
        },
      },
    ])
    const reader = new HttpChainReader(http, [URL])
    const out = await reader.callBatch([{ to: '0xaa', data: '0x1' }])
    expect(out[0]).toMatchObject({ ok: false, reverted: false })
  })

  it('refuses a non-array answer instead of reading it as one call succeeding', async () => {
    const http = new FakeHttpClient([
      { match: 'rpc.test', respond: jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x1' }) },
    ])
    const reader = new HttpChainReader(http, [URL])
    await expect(reader.callBatch([{ to: '0xaa', data: '0x1' }])).rejects.toThrow(
      BatchUnsupportedError,
    )
  })

  it('reports a missing id rather than shifting every later result up one slot', async () => {
    const http = new FakeHttpClient([
      {
        match: 'rpc.test',
        respond: (req) => {
          const body = JSON.parse(req.body!) as Array<{ id: number }>
          return jsonResponse(body.slice(1).map((r) => ({ jsonrpc: '2.0', id: r.id, result: '0x1' })))
        },
      },
    ])
    const reader = new HttpChainReader(http, [URL])
    const out = await reader.callBatch([
      { to: '0xaa', data: '0x1' },
      { to: '0xbb', data: '0x2' },
    ])
    expect(out[0]).toMatchObject({ ok: false, reverted: false })
    expect(out[1]).toEqual({ ok: true, value: '0x1' })
  })
})

describe('isDeterministicCallFailure', () => {
  it('separates "this can never work" from "try again"', () => {
    expect(isDeterministicCallFailure('execution reverted')).toBe(true)
    expect(isDeterministicCallFailure('invalid opcode: INVALID')).toBe(true)
    expect(isDeterministicCallFailure('rate limit exceeded')).toBe(false)
    expect(isDeterministicCallFailure('HTTP 429')).toBe(false)
    expect(isDeterministicCallFailure('socket hang up')).toBe(false)
  })
})

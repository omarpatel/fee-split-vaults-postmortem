import { describe, expect, it } from 'vitest'
import { MemoryCache } from '../lib/cache.ts'
import { FakeChainReader, RpcError } from '../lib/rpc.ts'
import {
  SELECTOR_DECIMALS,
  SELECTOR_NAME,
  SELECTOR_SYMBOL,
  TokenMetadataResolver,
  decodeErc20Decimals,
  decodeErc20String,
  isComplete,
  summarizeMetadata,
} from '../lib/token-metadata.ts'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const C = '0x3333333333333333333333333333333333333333'

/** ABI-encode a string return the way a spec-compliant ERC-20 does. */
function abiString(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  const padded = Buffer.concat([bytes, Buffer.alloc((32 - (bytes.length % 32)) % 32)])
  return (
    '0x' +
    (32).toString(16).padStart(64, '0') +
    bytes.length.toString(16).padStart(64, '0') +
    padded.toString('hex')
  )
}

function bytes32String(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  return `0x${Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]).toString('hex')}`
}

function word(value: number | bigint): string {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`
}

function reader(): FakeChainReader {
  return new FakeChainReader({ chainId: 4663, logs: [] })
}

/** Wire one token's three getters into a fake reader. */
function wire(
  r: FakeChainReader,
  address: string,
  answers: { decimals?: string | Error; symbol?: string | Error; name?: string | Error },
): void {
  const set = (selector: string, value: string | Error | undefined): void => {
    if (value === undefined) return
    r.callResponses.set(`${address.toLowerCase()}:${selector}`, value)
  }
  set(SELECTOR_DECIMALS, answers.decimals)
  set(SELECTOR_SYMBOL, answers.symbol)
  set(SELECTOR_NAME, answers.name)
}

describe('decodeErc20String', () => {
  it('decodes a spec-compliant ABI string', () => {
    expect(decodeErc20String(abiString('USDG'))).toEqual({
      value: 'USDG',
      status: 'ok',
      encoding: 'string',
    })
  })

  it('decodes a bytes32 symbol, which a whole generation of tokens returns', () => {
    // Mistaking bytes32 for "this token has no symbol" silently loses real assets.
    expect(decodeErc20String(bytes32String('MKR'))).toEqual({
      value: 'MKR',
      status: 'ok',
      encoding: 'bytes32',
    })
  })

  it('keeps legitimate non-ASCII, which live tokens on this chain actually use', () => {
    // "NVIDIA - Robinhood Token" carries a U+2022 bullet. Rejecting it would
    // discard the name of a real, high-volume asset.
    const decoded = decodeErc20String(abiString('NVIDIA • Robinhood Token'))
    expect(decoded.status).toBe('ok')
    expect(decoded.value).toBe('NVIDIA • Robinhood Token')
  })

  it('strips control characters that would corrupt a report', () => {
    // A symbol carrying a newline or a terminal escape corrupts every table it
    // is pasted into, and no honest token needs one.
    const decoded = decodeErc20String(abiString('EVIL\u0007\nTOKEN\u001b[31m'))
    expect(decoded.status).toBe('ok')
    expect(decoded.value).toBe('EVILTOKEN[31m')
  })

  it('reports an empty return as absent, not as an empty symbol', () => {
    expect(decodeErc20String('0x').status).toBe('absent')
    expect(decodeErc20String(bytes32String('')).status).toBe('absent')
  })

  it('refuses data it cannot make sense of instead of guessing', () => {
    expect(decodeErc20String('0xdeadbeef').status).toBe('undecodable')
    // An offset word pointing past the end of the data.
    expect(decodeErc20String(`0x${'ff'.repeat(64)}`).status).toBe('undecodable')
  })

  it('refuses an absurdly long string rather than pasting it into a report', () => {
    expect(decodeErc20String(abiString('x'.repeat(300))).status).toBe('undecodable')
  })
})

describe('decodeErc20Decimals', () => {
  it('reads the real value', () => {
    expect(decodeErc20Decimals(word(6))).toEqual({ value: 6, status: 'ok' })
    expect(decodeErc20Decimals(word(18))).toEqual({ value: 18, status: 'ok' })
    expect(decodeErc20Decimals(word(0))).toEqual({ value: 0, status: 'ok' })
  })

  it('reports an absent getter as absent, NEVER as 18', () => {
    // This is the defect: `?? 18` turned a 6-decimal stablecoin into 1.19e-6.
    expect(decodeErc20Decimals('0x')).toEqual({ value: null, status: 'absent' })
  })

  it('refuses a decimals value that would zero every amount it scales', () => {
    expect(decodeErc20Decimals(word(255)).status).toBe('undecodable')
    expect(decodeErc20Decimals(word(37)).status).toBe('undecodable')
  })

  it('refuses a short return', () => {
    expect(decodeErc20Decimals('0x06').status).toBe('undecodable')
  })
})

describe('TokenMetadataResolver', () => {
  it('resolves decimals, symbol and name in batches of the configured size', async () => {
    const r = reader()
    wire(r, A, { decimals: word(6), symbol: abiString('USDG'), name: abiString('Global Dollar') })
    wire(r, B, { decimals: word(18), symbol: abiString('NVDA'), name: abiString('NVIDIA') })
    wire(r, C, { decimals: word(8), symbol: bytes32String('cbBTC'), name: abiString('Wrapped BTC') })

    const resolver = new TokenMetadataResolver(r, { chainId: 4663, batchSize: 10 })
    const out = await resolver.resolve([A, B, C])

    expect(out.get(A)).toMatchObject({ decimals: 6, symbol: 'USDG', decimalsStatus: 'ok' })
    expect(out.get(B)).toMatchObject({ decimals: 18, symbol: 'NVDA' })
    expect(out.get(C)).toMatchObject({ decimals: 8, symbol: 'cbBTC', symbolEncoding: 'bytes32' })
    // 9 calls at a batch size of 10 is exactly one request.
    expect(r.batchCalls).toEqual([9])
  })

  it('never sends more than the measured batch size in one request', async () => {
    const r = reader()
    const addresses = Array.from(
      { length: 7 },
      (_, i) => `0x${String(i + 1).repeat(40).slice(0, 40)}`,
    )
    for (const address of addresses) {
      wire(r, address, { decimals: word(18), symbol: abiString('T'), name: abiString('T') })
    }
    const resolver = new TokenMetadataResolver(r, { chainId: 4663, batchSize: 10 })
    await resolver.resolve(addresses)
    // 21 calls -> 10 + 10 + 1, and a batch above 10 would 429 on the live chain.
    expect(r.batchCalls).toEqual([10, 10, 1])
    expect(Math.max(...r.batchCalls)).toBeLessThanOrEqual(10)
  })

  it('records a reverting decimals() as ABSENT, leaving the asset unpriceable', async () => {
    const r = reader()
    // No fixture at all -> FakeChainReader raises CallRevertedError.
    wire(r, A, { symbol: abiString('WEIRD'), name: abiString('Weird') })
    const resolver = new TokenMetadataResolver(r, { chainId: 4663, batchSize: 10 })
    const meta = (await resolver.resolve([A])).get(A)!
    expect(meta.decimals).toBeNull()
    expect(meta.decimalsStatus).toBe('absent')
    expect(meta.symbol).toBe('WEIRD')
    expect(isComplete(meta)).toBe(true)
  })

  it('caches a complete result and does not call the chain again', async () => {
    const cache = new MemoryCache()
    const first = reader()
    wire(first, A, { decimals: word(6), symbol: abiString('USDG'), name: abiString('Global Dollar') })
    await new TokenMetadataResolver(first, { chainId: 4663, cache, batchSize: 10 }).resolve([A])

    const second = reader() // no fixtures at all: any call would revert
    const resolver = new TokenMetadataResolver(second, { chainId: 4663, cache, batchSize: 10 })
    const meta = (await resolver.resolve([A])).get(A)!
    expect(meta.decimals).toBe(6)
    expect(second.batchCalls).toHaveLength(0)
    expect(resolver.stats.fromCache).toBe(1)
  })

  it('does NOT cache a transport failure, so one bad minute is not permanent', async () => {
    const cache = new MemoryCache()
    const flaky = reader()
    wire(flaky, A, {
      decimals: new RpcError('eth_call: HTTP 429 rate limited', 429, 'eth_call'),
      symbol: abiString('USDG'),
      name: abiString('Global Dollar'),
    })
    const failed = (
      await new TokenMetadataResolver(flaky, { chainId: 4663, cache, batchSize: 10 }).resolve([A])
    ).get(A)!
    expect(failed.decimalsStatus).toBe('error')
    expect(isComplete(failed)).toBe(false)

    const healthy = reader()
    wire(healthy, A, { decimals: word(6), symbol: abiString('USDG'), name: abiString('Global Dollar') })
    const retried = (
      await new TokenMetadataResolver(healthy, { chainId: 4663, cache, batchSize: 10 }).resolve([A])
    ).get(A)!
    expect(retried.decimals).toBe(6)
  })

  it('falls back to sequential calls when the endpoint does not speak batch', async () => {
    const r = reader()
    r.batchUnsupported = true
    wire(r, A, { decimals: word(18), symbol: abiString('X'), name: abiString('X') })
    const resolver = new TokenMetadataResolver(r, { chainId: 4663, batchSize: 10 })
    const meta = (await resolver.resolve([A])).get(A)!
    expect(meta.decimals).toBe(18)
    expect(resolver.stats.batchFallbacks).toBe(1)
  })

  it('returns an entry for every address asked for, including the hopeless ones', async () => {
    const r = reader()
    const out = await new TokenMetadataResolver(r, { chainId: 4663, batchSize: 10 }).resolve([A, B])
    expect([...out.keys()].sort()).toEqual([A, B].sort())
    for (const meta of out.values()) expect(meta.decimals).toBeNull()
  })
})

describe('summarizeMetadata', () => {
  it('counts what resolved and what did not', async () => {
    const r = reader()
    wire(r, A, { decimals: word(6), symbol: abiString('USDG'), name: abiString('Global Dollar') })
    wire(r, B, { decimals: word(18), symbol: bytes32String('MKR') })
    const out = await new TokenMetadataResolver(r, { chainId: 4663, batchSize: 10 }).resolve([A, B, C])
    const summary = summarizeMetadata(out)
    expect(summary.total).toBe(3)
    expect(summary.decimalsKnown).toBe(2)
    expect(summary.decimalsAbsent).toBe(1)
    expect(summary.symbolKnown).toBe(2)
    expect(summary.symbolFromBytes32).toBe(1)
    expect(summary.nameKnown).toBe(1)
  })
})

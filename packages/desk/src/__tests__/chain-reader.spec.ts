/**
 * The real reader and the cache.
 *
 * Two behaviours matter more than the decoding itself: every read is pinned to
 * a block HASH rather than a number, and every failure - a revert, a truncated
 * return, a dead transport, an unconfigured view - resolves to undefined so the
 * builder turns it into an absent fact instead of a zero.
 */

import { describe, expect, it, vi } from 'vitest'
import { VENUE } from '../../../../config/protocol.js'
import { FactSheetCache } from '../factsheet/cache.js'
import {
  FakeDeskChainReader,
  RpcDeskChainReader,
  decodeAddress,
  decodeAddressArray,
  decodeBool,
  decodeString,
  decodeUint,
  type JsonRpcTransport,
} from '../factsheet/chain-reader.js'
import { urlExplorer } from '../factsheet/render.js'
import { chainState, EXPLORER_BASE, NOW, TOKEN, VAULT } from './fixtures.js'

const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')

function encodeString(value: string): string {
  const bytes = Buffer.from(value, 'utf8').toString('hex')
  const padded = bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0')
  return '0x' + word('20') + word(bytes.length / 2 === 0 ? '0' : (bytes.length / 2).toString(16)) + padded
}

describe('ABI decoding', () => {
  it('decodes integers, addresses and booleans', () => {
    expect(decodeUint('0x' + word('2a'))).toBe(42n)
    expect(decodeAddress('0x' + word('2222222222222222222222222222222222222222'))).toBe(
      '0x2222222222222222222222222222222222222222',
    )
    expect(decodeBool('0x' + word('1'))).toBe(true)
    expect(decodeBool('0x' + word('0'))).toBe(false)
  })

  it('treats the zero address as absent rather than as an answer', () => {
    expect(decodeAddress('0x' + word('0'))).toBeUndefined()
  })

  it('rejects a value that is not a clean boolean', () => {
    expect(decodeBool('0x' + word('7'))).toBeUndefined()
  })

  it('decodes both the modern and the legacy bytes32 string forms', () => {
    expect(decodeString(encodeString('Example Coin'))).toBe('Example Coin')
    const bytes32 = '0x' + Buffer.from('EXMP', 'utf8').toString('hex').padEnd(64, '0')
    expect(decodeString(bytes32)).toBe('EXMP')
  })

  it('returns undefined for truncated data instead of guessing', () => {
    expect(decodeUint('0x')).toBeUndefined()
    expect(decodeString('0x1234')).toBeUndefined()
    expect(decodeAddressArray('0x' + word('20'))).toBeUndefined()
  })

  it('decodes an address array', () => {
    const data =
      '0x' +
      word('20') +
      word('2') +
      word('5555555555555555555555555555555555555555') +
      word('6666666666666666666666666666666666666666')
    expect(decodeAddressArray(data)).toEqual([
      '0x5555555555555555555555555555555555555555',
      '0x6666666666666666666666666666666666666666',
    ])
  })
})

describe('RpcDeskChainReader', () => {
  function transportWith(responses: Record<string, unknown>, calls: unknown[][] = []): JsonRpcTransport {
    return {
      async request(method, params) {
        calls.push([method, params])
        if (method === 'eth_chainId') return '0x' + VENUE.chainId.toString(16)
        if (method === 'eth_getBlockByNumber') {
          return { hash: '0x' + 'ab'.repeat(32), number: '0x1', timestamp: '0x2' }
        }
        const data = (params[0] as { data?: string }).data ?? ''
        const selector = data.slice(0, 10)
        if (selector in responses) return responses[selector]
        throw new Error('execution reverted')
      },
    }
  }

  it('pins every call to a block hash, never to a number or to latest', async () => {
    const calls: unknown[][] = []
    const reader = new RpcDeskChainReader(transportWith({ '0x18160ddd': '0x' + word('64') }, calls), {})
    const block = await reader.latestBlock()
    await reader.readSupply(TOKEN, block)

    const ethCalls = calls.filter(([method]) => method === 'eth_call')
    expect(ethCalls.length).toBeGreaterThan(0)
    for (const [, params] of ethCalls) {
      const blockTag = (params as unknown[])[1] as { blockHash?: string; requireCanonical?: boolean }
      expect(blockTag.blockHash).toBe(block.hash)
      expect(blockTag.requireCanonical).toBe(true)
    }
  })

  it('turns a revert into an absent field', async () => {
    const reader = new RpcDeskChainReader(transportWith({}), {})
    const block = await reader.latestBlock()
    expect(await reader.readSupply(TOKEN, block)).toEqual({
      totalSupplyMinor: undefined,
      burnedMinor: undefined,
      lockedMinor: undefined,
    })
  })

  it('leaves a Venue view absent when no descriptor was supplied', async () => {
    const reader = new RpcDeskChainReader(transportWith({}), {})
    const block = await reader.latestBlock()
    const fees = await reader.readFeeConfig(TOKEN, block)
    expect(fees.buybackEnabled).toBeUndefined()
    expect(fees.creatorTaxBps).toBeUndefined()
  })

  it('uses an injected descriptor when one is supplied', async () => {
    const reader = new RpcDeskChainReader(transportWith({ '0xaabbccdd': '0x' + word('1') }), {
      buybackEnabled: {
        to: VENUE.contracts.v2MemeHook,
        selector: '0xaabbccdd',
        tokenArg: true,
        returns: 'bool',
      },
    })
    const block = await reader.latestBlock()
    expect((await reader.readFeeConfig(TOKEN, block)).buybackEnabled).toBe(true)
  })

  it('ignores a descriptor whose declared return type is wrong', async () => {
    const reader = new RpcDeskChainReader(transportWith({ '0xaabbccdd': '0x' + word('1') }), {
      buybackEnabled: {
        to: VENUE.contracts.v2MemeHook,
        selector: '0xaabbccdd',
        tokenArg: true,
        returns: 'uint256',
      },
    })
    const block = await reader.latestBlock()
    expect((await reader.readFeeConfig(TOKEN, block)).buybackEnabled).toBeUndefined()
  })

  it('refuses a head with no hash', async () => {
    const reader = new RpcDeskChainReader(
      {
        async request(method) {
          if (method === 'eth_chainId') return '0x1'
          return { number: '0x1' }
        },
      },
      {},
    )
    await expect(reader.latestBlock()).rejects.toThrow(/no usable head/)
  })
})

describe('FactSheetCache', () => {
  const cacheFor = (reader: FakeDeskChainReader, clock: () => number) =>
    new FactSheetCache(
      {
        vault: VAULT,
        token: TOKEN,
        tier: 'T0',
        reader,
        explorer: urlExplorer(EXPLORER_BASE),
      },
      { refreshIntervalSeconds: 60, clock },
    )

  it('serves nothing until the first refresh succeeds', async () => {
    const reader = new FakeDeskChainReader(chainState())
    const cache = cacheFor(reader, () => NOW)
    expect(cache.get()).toBeUndefined()
    await cache.refresh()
    expect(cache.get()?.token).toBe(TOKEN)
  })

  it('keeps the previous sheet when a refresh fails, and records why', async () => {
    const reader = new FakeDeskChainReader(chainState())
    const cache = cacheFor(reader, () => NOW)
    await cache.refresh()
    const first = cache.get()

    reader.chainId = async () => {
      throw new Error('rpc down')
    }
    await cache.refresh()
    expect(cache.get()).toBe(first)
    expect((cache.lastRefreshError as Error).message).toBe('rpc down')
  })

  it('does not refresh before the interval elapses', async () => {
    const reader = new FakeDeskChainReader(chainState())
    let now = NOW
    const cache = cacheFor(reader, () => now)
    await cache.refreshIfDue()
    const after = reader.calls

    now = NOW + 30
    await cache.refreshIfDue()
    expect(reader.calls).toBe(after)

    now = NOW + 61
    await cache.refreshIfDue()
    expect(reader.calls).toBeGreaterThan(after)
  })

  it('never reads on the message path', () => {
    // The router only ever calls sheetSource(); the cache exposes no read that
    // takes a message. This is a shape assertion, and it is the whole reason a
    // mention flood cannot cost the desk an RPC round trip.
    const cache = cacheFor(new FakeDeskChainReader(chainState()), () => NOW)
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(cache))
    expect(surface.filter((name) => /message|inbound|onText/i.test(name))).toEqual([])
    expect(vi.isMockFunction(cache.get)).toBe(false)
  })
})

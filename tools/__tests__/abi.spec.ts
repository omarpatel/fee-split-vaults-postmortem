import { describe, expect, it } from 'vitest'
import {
  addressTopic,
  decodeEventLog,
  decodeStaticReturn,
  encodeCall,
  eventTopic,
  functionSelector,
  parseEventSignature,
} from '../lib/abi.ts'

describe('parseEventSignature', () => {
  it('canonicalises a named signature and hashes the canonical form', () => {
    const spec = parseEventSignature(
      'FeesCredited(address indexed recipient, address indexed quoteAsset, uint256 amount)',
    )
    expect(spec.name).toBe('FeesCredited')
    expect(spec.canonical).toBe('FeesCredited(address,address,uint256)')
    expect(spec.inputs.filter((i) => i.indexed)).toHaveLength(2)
    expect(spec.topic0).toBe(eventTopic('FeesCredited(address,address,uint256)'))
  })

  it('expands the uint / int aliases the way solidity does', () => {
    expect(parseEventSignature('E(uint a, int b)').canonical).toBe('E(uint256,int256)')
  })

  it('rejects more than three indexed parameters', () => {
    expect(() =>
      parseEventSignature('E(address indexed a, address indexed b, address indexed c, address indexed d)'),
    ).toThrow(/at most 3/)
  })

  it('refuses dynamic types rather than mis-decoding their offset word', () => {
    expect(() => parseEventSignature('E(string name)')).toThrow(/unsupported ABI type/)
    expect(() => parseEventSignature('E(uint256[] amounts)')).toThrow(/unsupported ABI type/)
  })
})

describe('functionSelector', () => {
  it('reproduces the well-known Uniswap V3 fee() selector', () => {
    expect(functionSelector('fee()')).toBe('0xddca3f43')
  })

  it('reproduces transfer(address,uint256)', () => {
    expect(functionSelector('transfer(address,uint256)')).toBe('0xa9059cbb')
  })
})

describe('decodeEventLog', () => {
  const spec = parseEventSignature(
    'FeesCredited(address indexed recipient, address indexed quoteAsset, uint256 amount)',
  )
  const recipient = '0xaaaa000000000000000000000000000000000001'
  const asset = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
  const topics = [spec.topic0, addressTopic(recipient), addressTopic(asset)]
  const data = `0x${(123_456_789n).toString(16).padStart(64, '0')}`

  it('reads indexed params from topics and the rest from data', () => {
    const decoded = decodeEventLog(spec, topics, data)
    expect(decoded.byName.recipient).toBe(recipient)
    expect(decoded.byName.quoteAsset).toBe(asset)
    expect(decoded.byName.amount).toBe(123_456_789n)
    expect(decoded.values).toEqual([recipient, asset, 123_456_789n])
  })

  it('FAILS CLOSED on a topic-count mismatch rather than shifting fields', () => {
    // This is the whole safety property: a wrong indexed marker must throw,
    // because a shifted decode produces a plausible but wrong population.
    expect(() => decodeEventLog(spec, topics.slice(0, 2), data)).toThrow(/expected 3 topics/)
  })

  it('fails closed on a data length mismatch', () => {
    expect(() => decodeEventLog(spec, topics, `${data}${'00'.repeat(32)}`)).toThrow(
      /expected 32 data bytes/,
    )
  })

  it('fails closed on a topic0 mismatch', () => {
    const wrong = [`0x${'ff'.repeat(32)}`, topics[1]!, topics[2]!]
    expect(() => decodeEventLog(spec, wrong, data)).toThrow(/topic0 mismatch/)
  })

  it('rejects an address word with dirty high bytes', () => {
    const dirty = [spec.topic0, `0x${'11'.repeat(32)}`, topics[2]!]
    expect(() => decodeEventLog(spec, dirty, data)).toThrow(/dirty high bytes/)
  })
})

describe('decodeStaticReturn', () => {
  it('decodes a uint256', () => {
    expect(decodeStaticReturn(['uint256'], `0x${(100n).toString(16).padStart(64, '0')}`)).toEqual([100n])
  })

  it('decodes a bool', () => {
    expect(decodeStaticReturn(['bool'], `0x${'0'.repeat(63)}1`)).toEqual([true])
    expect(decodeStaticReturn(['bool'], `0x${'0'.repeat(64)}`)).toEqual([false])
  })

  it('rejects a bool word that is neither 0 nor 1', () => {
    expect(() => decodeStaticReturn(['bool'], `0x${'0'.repeat(62)}ff`)).toThrow(/misaligned/)
  })

  it('decodes a negative int256 in twos complement', () => {
    expect(decodeStaticReturn(['int256'], `0x${'f'.repeat(64)}`)).toEqual([-1n])
  })

  it('throws when the return data is shorter than the declared types', () => {
    expect(() => decodeStaticReturn(['uint256', 'uint256'], `0x${'0'.repeat(64)}`)).toThrow(
      /ABI data too short/,
    )
  })
})

describe('encodeCall', () => {
  it('encodes a no-arg call as the bare selector', () => {
    expect(encodeCall('feeBps()')).toBe(functionSelector('feeBps()'))
  })

  it('left-pads an address argument to a full word', () => {
    const encoded = encodeCall('balanceOf(address)', ['0xaaaa000000000000000000000000000000000001'])
    expect(encoded).toHaveLength(10 + 64)
    expect(encoded.endsWith('aaaa000000000000000000000000000000000001')).toBe(true)
  })
})

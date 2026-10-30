/**
 * Regression lock on the event signatures the measurement depends on.
 *
 * These are not style tests. A wrong signature does not fail loudly - it either
 * hashes to a topic0 nothing matches, and the tool reports an empty market, or
 * it decodes with shifted fields and reports a wrong money figure. Two of the
 * four signatures originally inferred from the Phase 0 note turned out not to
 * exist: CurveBuy, and pool-fees-index's TokenLaunched.
 *
 * The fixture records what a topic0 census actually observed on chain 4663 on
 * 2026-09-07, cross-checked against Sourcify-verified source. Every assertion
 * below recomputes keccak from the signature STRING and compares it with an
 * OBSERVED topic0, so reintroducing a guess breaks the build.
 */

import { describe, expect, it } from 'vitest'
import { decodeEventLog, parseEventSignature } from '../lib/abi.ts'
import {
  DEFAULT_POOL_REGISTERED_EVENT,
  DEFAULT_SWEEP_EVENT,
  mapPoolsToTokens,
} from '../pool-fees-index.ts'
import { loadFixture, toRawLogs, type PoolFeesFixture } from './helpers.ts'

interface ObservedEvent {
  topic0: string
  signature: string
  count: number
  topicCount: number
  dataWords: number
}
interface SignatureFixture {
  chainId: number
  contracts: Record<string, string>
  census: Array<{ contract: string; totalLogs: number; observed: ObservedEvent[] }>
  refuted: Array<{ signature: string; topic0: string; shippedAs: string; why: string }>
}

const fixture = loadFixture<SignatureFixture>('verified-event-signatures.json')
const allObserved = fixture.census.flatMap((c) => c.observed)
const observedTopics = new Set(allObserved.map((o) => o.topic0))

describe('event signatures observed on chain 4663', () => {
  it.each(allObserved.map((o) => [o.signature, o] as const))(
    'keccak(%s) equals the topic0 the census observed',
    (_name, observed) => {
      expect(parseEventSignature(observed.signature).topic0).toBe(observed.topic0)
    },
  )

  it('matches each observed log shape to the signature it is claimed to be', () => {
    // topics = indexed params + 1; data words = non-indexed static params. A
    // signature that disagrees with either is refuted without needing source.
    for (const observed of allObserved) {
      const spec = parseEventSignature(observed.signature)
      const indexed = spec.inputs.filter((i) => i.indexed).length
      expect(
        { sig: observed.signature, topics: indexed + 1, data: spec.inputs.length - indexed },
      ).toEqual({ sig: observed.signature, topics: observed.topicCount, data: observed.dataWords })
    }
  })

  it('keeps the shipped defaults equal to the verified signatures', () => {
    const sweep = parseEventSignature(DEFAULT_SWEEP_EVENT)
    const registered = parseEventSignature(DEFAULT_POOL_REGISTERED_EVENT)
    expect(sweep.topic0).toBe('0x2f3c43579b9064b6f28edcf41608f3815792d274a56afe024359703cb4ea9b30')
    expect(registered.topic0).toBe('0x01bf263a1db1652580721573296e1a1fa70b3d4c87f61d02a69c4e1109d2d573')
    expect(observedTopics.has(sweep.topic0)).toBe(true)
    expect(observedTopics.has(registered.topic0)).toBe(true)
  })

  it('holds the refuted signatures refuted', () => {
    expect(fixture.refuted.length).toBeGreaterThan(0)
    for (const refuted of fixture.refuted) {
      // The hash must still be what it was - otherwise the record is of some
      // other signature - and it must not appear in anything the census saw.
      expect(parseEventSignature(refuted.signature).topic0).toBe(refuted.topic0)
      expect(observedTopics.has(refuted.topic0)).toBe(false)
    }
  })

  it('refutes the old TokenLaunched default specifically, on arity as well as hash', () => {
    const old = parseEventSignature(
      'TokenLaunched(address indexed token, bytes32 indexed poolId, address indexed creator)',
    )
    const real = parseEventSignature(
      fixture.census
        .flatMap((c) => c.observed)
        .find((o) => o.signature.startsWith('TokenLaunched'))!.signature,
    )
    expect(old.topic0).not.toBe(real.topic0)
    // The decisive point is not the hash but the payload: the real event has no
    // poolId of any kind, so it cannot bind a pool to a coin at any arity.
    expect(real.inputs.some((i) => i.type === 'bytes32')).toBe(false)
    expect(old.inputs.some((i) => i.name === 'poolId')).toBe(true)
  })
})

describe('the poolId -> coin join', () => {
  const poolFees = loadFixture<PoolFeesFixture>('pool-fees-swept-logs.json')

  it('reads memecoin and creator out of PoolRegistered logs', async () => {
    const spec = parseEventSignature(DEFAULT_POOL_REGISTERED_EVENT)
    const logs = toRawLogs(poolFees.launchLogs)
    const reader = {
      getLogs: async () => logs,
    } as unknown as Parameters<typeof mapPoolsToTokens>[0]

    const mapped = await mapPoolsToTokens(reader, {
      hook: poolFees.hook,
      spec,
      fromBlock: 0n,
      toBlock: 1_000n,
      chunkBlocks: 1_000_000,
    })

    expect(mapped.token.size).toBe(poolFees.groundTruth.length)
    for (const truth of poolFees.groundTruth) {
      expect(mapped.token.get(truth.poolId.toLowerCase())).toBe(truth.token.toLowerCase())
      expect(mapped.creator.get(truth.poolId.toLowerCase())).toBe(
        '0x9999000000000000000000000000000000009999',
      )
    }
  })

  it('throws rather than shifting fields when the wrong signature is pinned', () => {
    // The refuted TokenLaunched claims 3 indexed params; a PoolRegistered log
    // carries 2 topics. decodeEventLog must refuse, not return garbage.
    const wrong = parseEventSignature(
      'TokenLaunched(address indexed token, bytes32 indexed poolId, address indexed creator)',
    )
    const log = poolFees.launchLogs[0]!
    expect(() => decodeEventLog(wrong, log.topics, log.data)).toThrow(/expected 4 topics/)
  })
})

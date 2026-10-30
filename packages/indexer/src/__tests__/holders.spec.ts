/**
 * The holder replay: balances from Transfer logs, finality by construction,
 * conservation or refusal, and the snapshot the concentration signals read.
 */

import { describe, expect, it } from 'vitest'
import { HolderLedgerError } from '../errors.js'
import { FakeChain, FakeRpcClient, type FakeLogInput } from '../fake-rpc.js'
import { addressToTopic, type Hex } from '../hex.js'
import {
  ERC20_TRANSFER,
  HolderIndexer,
  InMemoryHolderBalanceStore,
  POOL_MANAGER_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  type IndexedToken,
} from '../holders.js'
import { QuorumRpc } from '../quorum.js'
import { computeQualificationSignals, InMemoryTradeSource, InMemoryVolumeSource } from '../signals.js'
import { addr, binding, encodeData, HOOK } from './helpers.js'

const TOKEN = addr(0x100)
const DEPLOYER = addr(0xd0)
const POOL_MANAGER = addr(0x9999)
const ZERO = addr(0)

function transfer(from: string, to: string, value: bigint): FakeLogInput {
  return { address: TOKEN, topics: [ERC20_TRANSFER.topic0, addressToTopic(from), addressToTopic(to)], data: encodeData(value) }
}

function harness(options: { launchBlock?: bigint; chunkBlocks?: bigint; maxRangesPerTick?: number } = {}) {
  const chain = new FakeChain({ genesisUnix: 1_000, blockSeconds: 10 })
  chain.addBlock() // genesis
  const rpc = new QuorumRpc(new FakeRpcClient(chain, 'a'), new FakeRpcClient(chain, 'b'))
  const store = new InMemoryHolderBalanceStore()
  const tokens: IndexedToken[] = [{ token: TOKEN, launchBlockNumber: options.launchBlock ?? 1n, deployer: DEPLOYER }]
  const indexer = new HolderIndexer({
    rpc,
    store,
    tokens: async () => tokens,
    config: { chunkBlocks: options.chunkBlocks ?? 100n, maxRangesPerTick: options.maxRangesPerTick ?? 8 },
  })
  chain.setCallResultAnyBlock(HOOK, POOL_MANAGER_SELECTOR, encodeData(POOL_MANAGER))
  return { chain, rpc, store, indexer, tokens }
}

function supply(chain: FakeChain, total: bigint): void {
  chain.setCallResultAnyBlock(TOKEN, TOTAL_SUPPLY_SELECTOR, encodeData(total))
}

describe('balance math', () => {
  it('replays mints, transfers and burns into exact balances and drops holders at zero', async () => {
    const { chain, store, indexer } = harness()
    const alice = addr(0xa)
    const bob = addr(0xb)
    chain.addBlock({ logs: [transfer(ZERO, DEPLOYER, 1_000n)] }) // 1: mint
    chain.addBlock({ logs: [transfer(DEPLOYER, alice, 400n), transfer(DEPLOYER, bob, 100n)] }) // 2
    chain.addBlock({ logs: [transfer(alice, bob, 150n), transfer(bob, ZERO, 250n), transfer(alice, alice, 5n)] }) // 3
    chain.setFinalized(3n)

    const result = await indexer.tick(5_000)
    expect(result.stillBehind).toEqual([])
    expect(result.tokens[0]).toMatchObject({ token: TOKEN, fromBlock: 1n, toBlock: 3n, transfers: 6, caughtUp: true })

    expect(await store.balance(TOKEN, DEPLOYER)).toBe(500n)
    expect(await store.balance(TOKEN, alice)).toBe(250n)
    // bob: +100 +150 -250 = 0, so bob is not a holder.
    expect(await store.balance(TOKEN, bob)).toBe(0n)
    expect(await store.top(TOKEN, 10)).toEqual([
      { holder: DEPLOYER, balanceMinor: 500n },
      { holder: alice, balanceMinor: 250n },
    ])
    // The zero address is the mint source and burn sink, never a holder.
    expect(await store.balance(TOKEN, ZERO)).toBe(0n)
    // The cursor sits at the finalized block, with its hash and timestamp.
    expect(await store.cursor(TOKEN)).toMatchObject({ blockNumber: 3n, blockHash: chain.blockAt(3n)?.hash, blockTimestampUnix: 1_030 })
  })

  it('stops at the FINALIZED block, never the head', async () => {
    const { chain, store, indexer } = harness()
    chain.addBlock({ logs: [transfer(ZERO, DEPLOYER, 100n)] }) // 1
    chain.addBlock({ logs: [transfer(DEPLOYER, addr(0xa), 60n)] }) // 2, unfinalized
    chain.setFinalized(1n)
    await indexer.tick(5_000)
    expect(await store.balance(TOKEN, DEPLOYER)).toBe(100n)
    expect((await store.cursor(TOKEN))?.blockNumber).toBe(1n)

    chain.setFinalized(2n)
    await indexer.tick(5_010)
    expect(await store.balance(TOKEN, DEPLOYER)).toBe(40n)
    expect(await store.balance(TOKEN, addr(0xa))).toBe(60n)
  })

  it('advances in bounded ranges and reports a token still behind until the budget catches up', async () => {
    const { chain, store, indexer } = harness({ chunkBlocks: 2n, maxRangesPerTick: 1 })
    chain.addBlock({ logs: [transfer(ZERO, DEPLOYER, 10n)] }) // 1
    chain.addBlock() // 2
    chain.addBlock({ logs: [transfer(DEPLOYER, addr(0xa), 4n)] }) // 3
    chain.addBlock() // 4
    chain.setFinalized(4n)

    const first = await indexer.tick(5_000)
    expect(first.stillBehind).toEqual([TOKEN])
    expect(first.tokens[0]).toMatchObject({ fromBlock: 1n, toBlock: 2n, rangesScanned: 1, caughtUp: false })
    expect((await store.cursor(TOKEN))?.blockHash).toBe(chain.blockAt(2n)?.hash)
    expect(await store.balance(TOKEN, DEPLOYER)).toBe(10n)

    const second = await indexer.tick(5_010)
    expect(second.stillBehind).toEqual([])
    expect(second.tokens[0]).toMatchObject({ fromBlock: 3n, toBlock: 4n, caughtUp: true })
    expect(await store.balance(TOKEN, DEPLOYER)).toBe(6n)
  })

  it('refuses a range that would debit a holder below zero rather than clamping it', async () => {
    // The launch block is wrong: the mint at block 1 is never replayed, so the
    // first transfer out of the deployer is a debit against nothing.
    const { chain, store, indexer } = harness({ launchBlock: 2n })
    chain.addBlock({ logs: [transfer(ZERO, DEPLOYER, 100n)] }) // 1, skipped
    chain.addBlock({ logs: [transfer(DEPLOYER, addr(0xa), 60n)] }) // 2
    chain.setFinalized(2n)
    await expect(indexer.tick(5_000)).rejects.toBeInstanceOf(HolderLedgerError)
    await expect(indexer.tick(5_000)).rejects.toThrow(/debit .* by 60 against a balance of 0/)
    // Nothing landed: no cursor, no balances.
    expect(await store.cursor(TOKEN)).toBeUndefined()
    expect(await store.balance(TOKEN, addr(0xa))).toBe(0n)
  })

  it('refuses when the cursor block is no longer canonical: a finalized block that reorged', async () => {
    const { chain, indexer } = harness()
    chain.addBlock({ logs: [transfer(ZERO, DEPLOYER, 100n)] }) // 1
    chain.addBlock() // 2
    chain.setFinalized(2n)
    await indexer.tick(5_000)

    chain.reorgFrom(2n)
    chain.addBlock() // new 2
    chain.addBlock() // 3
    chain.setFinalized(3n)
    await expect(indexer.tick(5_010)).rejects.toThrow(/no longer canonical/)
  })
})

describe('the snapshot', () => {
  it('is undefined before a replay has landed, and pinned to the cursor block after', async () => {
    const { chain, indexer } = harness()
    expect(await indexer.snapshot(TOKEN)).toBeUndefined()
    chain.addBlock({ logs: [transfer(ZERO, DEPLOYER, 1_000n)] })
    chain.setFinalized(1n)
    supply(chain, 1_000n)
    await indexer.tick(5_000)
    const snapshot = await indexer.snapshot(TOKEN)
    expect(snapshot).toMatchObject({
      token: TOKEN,
      blockNumber: 1n,
      blockHash: chain.blockAt(1n)?.hash,
      takenAtUnix: 1_010,
      totalSupplyMinor: 1_000n,
      deployer: DEPLOYER,
      structural: [HOOK.toLowerCase(), POOL_MANAGER],
    })
  })

  it('carries the deployer even when it is not in the top balances, and refuses without the pool manager', async () => {
    const { chain, indexer } = harness()
    const logs: FakeLogInput[] = [transfer(ZERO, DEPLOYER, 1_000n)]
    for (let i = 1; i <= 33; i += 1) logs.push(transfer(DEPLOYER, addr(0x1000 + i), 30n))
    chain.addBlock({ logs })
    chain.setFinalized(1n)
    supply(chain, 1_000n)
    await indexer.tick(5_000)
    const snapshot = await indexer.snapshot(TOKEN)
    // 33 holders at 30 outrank the deployer's 10, and the default snapshot
    // carries 32; the deployer is appended so its share can still be read.
    expect(snapshot?.balances.find((b) => b.holder === DEPLOYER)?.balanceMinor).toBe(10n)
    expect(snapshot?.balances).toHaveLength(33)

    const bare = harness()
    bare.chain.addBlock({ logs: [transfer(ZERO, DEPLOYER, 1n)] })
    bare.chain.setFinalized(1n)
    supply(bare.chain, 1n)
    bare.chain.setCallResultAnyBlock(HOOK, POOL_MANAGER_SELECTOR, encodeData(ZERO))
    await bare.indexer.tick(5_000)
    await expect(bare.indexer.snapshot(TOKEN)).rejects.toThrow(/poolManager\(\) on the hook is the zero address/)
  })

  it('feeds computeQualificationSignals: top-10 excludes the custodians, the deployer is reported on its own', async () => {
    const { chain, indexer } = harness()
    const coin = binding({ token: TOKEN, launchedAtUnix: 1_000 })
    const holders = Array.from({ length: 12 }, (_, i) => addr(0x2000 + i))
    const logs: FakeLogInput[] = [transfer(ZERO, DEPLOYER, 10_000n)]
    // The pool manager and the curve custody 3,000 each; twelve holders take
    // 100 each; the deployer keeps 2,800.
    logs.push(transfer(DEPLOYER, POOL_MANAGER, 3_000n), transfer(DEPLOYER, coin.curve, 3_000n))
    for (const holder of holders) logs.push(transfer(DEPLOYER, holder, 100n))
    chain.addBlock({ logs })
    chain.setFinalized(1n)
    supply(chain, 10_000n)
    await indexer.tick(5_000)

    const trades = new InMemoryTradeSource()
    trades.put(TOKEN, { trades: [], coverage: { fromUnix: -1_000_000, toUnix: 10_000 } })
    const volume = new InMemoryVolumeSource()
    volume.put({ token: TOKEN, windowSeconds: 86_400, totalVolumeUsd: 10, venuePoolVolumeUsd: 5, source: 't', sampledAtUnix: 1_010 })
    const signals = await computeQualificationSignals({
      binding: coin,
      trades,
      holders: indexer,
      volume,
      options: { nowUnix: 1_010 },
    })
    // Top ten circulating: the deployer (2,800) plus nine holders (900) = 37%.
    // The pool manager and the curve, at 3,000 each, are custodians and count
    // for nothing; counted, they would have put the top ten at 97%.
    expect(signals.top10HolderSharePct).toBe(37)
    expect(signals.deployerSupplySharePct).toBe(28)
  })
})

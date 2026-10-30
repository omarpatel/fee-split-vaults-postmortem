/**
 * The RPC-backed ChainReadModel, against the indexer's own FakeChain.
 *
 * Two families of assertion here. The first is that it reads the chain
 * correctly: the right topics, bounded queries, a cursor that only moves
 * forward, halving when a provider refuses a range. The second - the one this
 * class exists for - is that when it CANNOT read, it says so instead of
 * returning an empty array that the tick loop would read as "this coin earned
 * nothing and settled nothing".
 */

import {
  FakeChain,
  FakeRpcClient,
  InMemoryIndexerStore,
  QuorumDisagreementError,
  QuorumRpc,
  RpcError,
  type BlockRef,
  type FeePosting,
  type Hex,
  type RpcLog,
} from '@fee-split-vaults/indexer'
import { beforeEach, describe, expect, it } from 'vitest'
import { CoverageGapError, UnservableRangeError, VaultNotTrackedError } from '../errors.js'
import { InMemoryChainCursorStore } from '../chain/cursors.js'
import { InMemoryHaltStore } from '../chain/halts.js'
import { InMemoryVaultMovementStore } from '../chain/movements.js'
import { RpcChainReadModel } from '../chain/read-model.js'
import { VAULT_CLAIMED, VAULT_CREDITED, decodeAllocation } from '../chain/vault-events.js'
import { addressWord, encodeData } from './harness.js'

const VAULT = '0x1111111111111111111111111111111111111111'
const OTHER_VAULT = '0x2222222222222222222222222222222222222222'
const TOKEN = '0x3333333333333333333333333333333333333333'
const ASSET = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'

const GENESIS = 1_757_000_000
const BLOCK_SECONDS = 2

const hash32 = (char: string): Hex => `0x${char.repeat(64)}` as Hex

function assetTopic(): Hex {
  return `0x${addressWord(ASSET)}` as Hex
}

function claimedLog(received: bigint, maxAmount = received) {
  return {
    address: VAULT,
    topics: [VAULT_CLAIMED.topic0, assetTopic()] as const,
    data: encodeData(received, maxAmount),
  }
}

function creditedLog(dev: bigint, budget: bigint, operator: bigint, referrer: bigint) {
  return {
    address: VAULT,
    topics: [VAULT_CREDITED.topic0, assetTopic()] as const,
    data: encodeData(dev + budget + operator + referrer, dev, budget, operator, referrer),
  }
}

interface Harness {
  chain: FakeChain
  primary: FakeRpcClient
  secondary: FakeRpcClient
  rpc: QuorumRpc
  cursors: InMemoryChainCursorStore
  movements: InMemoryVaultMovementStore
  halts: InMemoryHaltStore
  indexerStore: InMemoryIndexerStore
  model: RpcChainReadModel
}

function harness(options: { maxRangesPerSync?: number; chunkBlocks?: bigint } = {}): Harness {
  const chain = new FakeChain({ genesisUnix: GENESIS, blockSeconds: BLOCK_SECONDS })
  const primary = new FakeRpcClient(chain, 'primary')
  const secondary = new FakeRpcClient(chain, 'secondary')
  const rpc = new QuorumRpc(primary, secondary)
  const cursors = new InMemoryChainCursorStore()
  const movements = new InMemoryVaultMovementStore()
  const halts = new InMemoryHaltStore()
  const indexerStore = new InMemoryIndexerStore()

  const model = new RpcChainReadModel(
    { rpc, indexerStore, cursors, movements, halts },
    {
      maxCoverageLagSeconds: 300,
      ...(options.maxRangesPerSync === undefined ? {} : { maxRangesPerSync: options.maxRangesPerSync }),
      ...(options.chunkBlocks === undefined ? {} : { chunkBlocks: options.chunkBlocks }),
    },
  )
  model.track({ vault: VAULT, token: TOKEN, deployedAtBlock: 1n })
  return { chain, primary, secondary, rpc, cursors, movements, halts, indexerStore, model }
}

/** Timestamp of a block, as FakeChain assigns them. */
function tsOf(blockNumber: number): number {
  return GENESIS + blockNumber * BLOCK_SECONDS
}

describe('RpcChainReadModel reads the vault movement stream', () => {
  let h: Harness

  beforeEach(() => {
    h = harness()
    h.chain.addBlock() // 0: genesis, nothing in it
  })

  it('decodes claims and allocations, and advances the cursor exactly once', async () => {
    h.chain.addBlock({ logs: [claimedLog(1_000n)] }) // 1
    h.chain.addBlock({ logs: [creditedLog(600n, 300n, 90n, 10n)] }) // 2
    h.chain.addBlocks(3) // 3..5
    h.chain.setFinalized(5n)

    const now = tsOf(5) + 10
    const result = await h.model.sync(now)

    expect(result.vaults[0]).toMatchObject({
      vault: VAULT,
      newClaims: 1,
      newAllocations: 1,
      caughtUp: true,
    })

    const claims = await h.model.claims(VAULT, tsOf(0), now)
    expect(claims).toEqual([
      {
        vault: VAULT,
        asset: ASSET,
        amountMinor: 1_000n,
        occurredAtUnix: tsOf(1),
        txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        logIndex: 0,
        blockHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      },
    ])

    const allocations = await h.model.allocations(VAULT, tsOf(0), now)
    expect(allocations[0]).toMatchObject({
      devMinor: 600n,
      budgetMinor: 300n,
      // The referrer's cut is carved out of the OPERATOR's slice on chain and
      // is carried as its own leg, exactly as the Credited event reports it.
      operatorMinor: 90n,
      referrerMinor: 10n,
    })

    const cursor = await h.cursors.get('vault_movements', VAULT)
    expect(cursor?.blockNumber).toBe(5n)
    expect(cursor?.blockTimestampUnix).toBe(tsOf(5))
  })

  it('is idempotent: a re-scan of the same range stores nothing new', async () => {
    h.chain.addBlock({ logs: [claimedLog(1_000n)] })
    h.chain.addBlocks(2)
    h.chain.setFinalized(3n)

    await h.model.sync(tsOf(3) + 5)
    // Force the same range to be scanned again, as a reorg recovery would.
    await h.cursors.rewind('vault_movements', VAULT, 0n, tsOf(3) + 5)
    const second = await h.model.sync(tsOf(3) + 6)

    // Ids are `${txHash}:${logIndex}`, a pure function of chain position.
    expect(second.vaults[0]?.newClaims).toBe(0)
    expect(await h.model.claims(VAULT, tsOf(0), tsOf(3) + 6)).toHaveLength(1)
  })

  it('scans only forward, and never re-reads history it already covered', async () => {
    h.chain.addBlocks(4)
    h.chain.setFinalized(4n)
    await h.model.sync(tsOf(4) + 5)

    h.chain.addBlock({ logs: [claimedLog(7n)] }) // 5
    h.chain.addBlocks(1)
    h.chain.setFinalized(6n)

    const second = await h.model.sync(tsOf(6) + 5)
    // fromBlock is the block after the previous cursor, not the deployment.
    expect(second.vaults[0]?.fromBlock).toBe(5n)
    expect(second.vaults[0]?.newClaims).toBe(1)
  })

  it('stops at the FINALIZED head, not at the tip', async () => {
    h.chain.addBlock({ logs: [claimedLog(1n)] }) // 1, finalized
    h.chain.addBlock({ logs: [claimedLog(2n)] }) // 2, not finalized
    h.chain.setFinalized(1n)

    await h.model.sync(tsOf(2) + 5)
    const claims = await h.model.claims(VAULT, tsOf(0), tsOf(2) + 5)
    // The unfinalized claim would become a ledger entry about money a reorg
    // could still take away.
    expect(claims.map((c) => c.amountMinor)).toEqual([1n])
    expect((await h.cursors.get('vault_movements', VAULT))?.blockNumber).toBe(1n)
  })
})

describe('RpcChainReadModel refuses rather than answering an unmeasured window', () => {
  it('throws for a vault nobody registered, instead of an empty list', async () => {
    const h = harness()
    await expect(h.model.claims(OTHER_VAULT, 0, 1)).rejects.toBeInstanceOf(VaultNotTrackedError)
    await expect(h.model.allocations(OTHER_VAULT, 0, 1)).rejects.toBeInstanceOf(VaultNotTrackedError)
    // "Never scanned" and "never settled" are different answers, and only the
    // second is representable as [].
    await expect(h.model.claims(OTHER_VAULT, 0, 1)).rejects.toThrow(/never scanned/)
  })

  it('throws when no scan has happened at all', async () => {
    const h = harness()
    await expect(h.model.claims(VAULT, 0, GENESIS)).rejects.toBeInstanceOf(CoverageGapError)
    await expect(h.model.claims(VAULT, 0, GENESIS)).rejects.toThrow(/NOTHING \(no cursor\)/)
  })

  it('throws when the scan has fallen behind the window it was asked about', async () => {
    const h = harness()
    h.chain.addBlocks(3)
    h.chain.setFinalized(2n)
    await h.model.sync(tsOf(2) + 5)

    // Inside the lag tolerance: answerable.
    await expect(h.model.claims(VAULT, tsOf(0), tsOf(2) + 100)).resolves.toEqual([])
    // An hour later, with nothing having synced: NOT answerable. An empty array
    // here would read as "this vault settled nothing in the last hour".
    await expect(h.model.claims(VAULT, tsOf(0), tsOf(2) + 3_600)).rejects.toBeInstanceOf(
      CoverageGapError,
    )
  })

  it('claims no coverage while a backfill is still grinding forward', async () => {
    // Two ranges of work, one range of budget.
    const h = harness({ maxRangesPerSync: 1, chunkBlocks: 2n })
    h.chain.addBlocks(6)
    h.chain.setFinalized(5n)

    const result = await h.model.sync(tsOf(5) + 5)
    expect(result.vaults[0]?.caughtUp).toBe(false)
    expect(result.stillBehind).toEqual([VAULT])

    const cursor = await h.cursors.get('vault_movements', VAULT)
    expect(cursor?.blockNumber).toBe(2n) // it did real work
    expect(cursor?.blockTimestampUnix).toBeUndefined() // and claims no coverage for it

    await expect(h.model.claims(VAULT, tsOf(0), tsOf(5))).rejects.toBeInstanceOf(CoverageGapError)
  })

  it('gates postings on the FEE coverage watermark, which nothing has set', async () => {
    const h = harness()
    // The posting store is perfectly readable and would return []. That is
    // exactly the confident zero the gate exists to prevent: the tier decision
    // downstream cannot tell it apart from a coin with no trades.
    await expect(h.model.postings(VAULT, 0, GENESIS)).rejects.toBeInstanceOf(CoverageGapError)
  })

  it('answers postings once a caught-up fee tick has recorded its coverage', async () => {
    const h = harness()
    h.chain.addBlocks(3)
    const head = h.chain.head()
    await h.model.recordFeeCoverage(head, head.timestampUnix)

    const posting = {
      id: '0xdead:0',
      vault: VAULT,
      token: TOKEN,
      asset: ASSET,
      creditedMinor: 42n,
      grossFeeMinor: 600n,
      derivation: 'creator_share_of_fee',
      volumeMinor: 10_000n,
      source: 'curve_event',
      phase: 'pre_graduation',
      classification: 'trade',
      side: 'buy',
      blockNumber: 2n,
      blockHash: hash32('a'),
      txHash: '0xdead',
      logIndex: 0,
      occurredAtUnix: head.timestampUnix - 10,
      finalized: true,
    } as unknown as FeePosting
    await h.indexerStore.putPostings([posting])

    const got = await h.model.postings(VAULT, head.timestampUnix - 60, head.timestampUnix + 60)
    expect(got.map((p) => p.creditedMinor)).toEqual([42n])
  })

  it('does not advance the fee watermark from a tick that never caught up', async () => {
    const h = harness()
    h.chain.addBlocks(3)
    h.chain.setFinalized(2n)
    const head = h.chain.head()

    const model = new RpcChainReadModel(
      {
        rpc: h.rpc,
        indexerStore: h.indexerStore,
        cursors: h.cursors,
        movements: h.movements,
        halts: h.halts,
        feeIndexer: { tick: async () => ({ head, caughtUp: false }) },
      },
      { maxCoverageLagSeconds: 300 },
    )
    const result = await model.sync(head.timestampUnix)
    expect(result.feeCoverageThroughUnix).toBeUndefined()
    await expect(model.postings(VAULT, 0, head.timestampUnix)).rejects.toBeInstanceOf(CoverageGapError)
  })
})

describe('RpcChainReadModel query discipline', () => {
  it('filters to the vault address and the two movement topics only', async () => {
    const h = harness()
    h.chain.addBlocks(3)
    h.chain.setFinalized(2n)

    const queries: Array<{ address: readonly string[]; topics: unknown }> = []
    const original = h.primary.getLogs.bind(h.primary)
    h.primary.getLogs = async (query) => {
      queries.push({ address: query.address, topics: query.topics })
      return original(query)
    }

    await h.model.sync(tsOf(2) + 5)
    expect(queries[0]?.address).toEqual([VAULT])
    expect(queries[0]?.topics).toEqual([[VAULT_CLAIMED.topic0, VAULT_CREDITED.topic0]])
  })

  it('halves a range a provider refuses, and still returns every log', async () => {
    const h = harness({ chunkBlocks: 8n })
    h.chain.addBlock() // 0
    h.chain.addBlock({ logs: [claimedLog(11n)] }) // 1
    h.chain.addBlocks(4) // 2..5
    h.chain.addBlock({ logs: [claimedLog(22n)] }) // 6
    h.chain.addBlock() // 7
    h.chain.setFinalized(7n)

    // The first getLogs fails the way a capped node fails; the halved retries
    // succeed. Nothing may be lost in the narrowing. Wrapping getLogs rather
    // than using failNext keeps the injected failure off the chain-id and
    // finalized-head reads, which are not what is being tested.
    const original = h.primary.getLogs.bind(h.primary)
    let failuresLeft = 1
    h.primary.getLogs = async (query) => {
      if (failuresLeft > 0) {
        failuresLeft--
        throw new RpcError('query returned more than 10000 results', 'primary')
      }
      return original(query)
    }

    await h.model.sync(tsOf(7) + 5)
    const claims = await h.model.claims(VAULT, tsOf(0), tsOf(7) + 5)
    expect(claims.map((c) => c.amountMinor)).toEqual([11n, 22n])
  })

  it('gives up loudly when a single block is still unservable', async () => {
    const h = harness({ chunkBlocks: 4n })
    h.chain.addBlocks(4)
    h.chain.setFinalized(3n)
    // Every narrowing still fails, all the way down to a single block.
    h.primary.getLogs = async () => {
      throw new RpcError('still too large', 'primary')
    }

    await expect(h.model.sync(tsOf(3) + 5)).rejects.toBeInstanceOf(UnservableRangeError)
    // The cursor did not advance, so the next sync redoes the range.
    expect(await h.cursors.get('vault_movements', VAULT)).toBeUndefined()
  })

  it('does NOT halve a quorum disagreement', async () => {
    // Two providers on different chains. Narrowing until the disagreeing block
    // falls out of the range would turn a fork into a clean-looking answer.
    const chainA = new FakeChain({ genesisUnix: GENESIS, blockSeconds: BLOCK_SECONDS })
    const chainB = new FakeChain({ genesisUnix: GENESIS, blockSeconds: BLOCK_SECONDS })
    chainA.addBlock()
    chainA.addBlock({ logs: [claimedLog(1n)] })
    chainA.addBlock()
    chainB.addBlock()
    chainB.addBlock()
    chainB.addBlock()
    chainA.setFinalized(2n)
    chainB.setFinalized(2n)

    const model = new RpcChainReadModel({
      rpc: new QuorumRpc(new FakeRpcClient(chainA, 'a'), new FakeRpcClient(chainB, 'b')),
      indexerStore: new InMemoryIndexerStore(),
      cursors: new InMemoryChainCursorStore(),
      movements: new InMemoryVaultMovementStore(),
      halts: new InMemoryHaltStore(),
    })
    model.track({ vault: VAULT, token: TOKEN, deployedAtBlock: 0n })

    await expect(model.sync(tsOf(2) + 5)).rejects.toBeInstanceOf(QuorumDisagreementError)
  })
})

describe('vault event decoding', () => {
  it('refuses a Credited whose legs do not sum to the credited amount', () => {
    const block: BlockRef = {
      number: 1n,
      hash: hash32('1'),
      parentHash: hash32('0'),
      timestampUnix: GENESIS,
    }
    const log: RpcLog = {
      address: VAULT,
      topics: [VAULT_CREDITED.topic0, assetTopic()],
      // amount says 1000; the legs add to 999.
      data: encodeData(1_000n, 600n, 300n, 90n, 9n),
      blockNumber: 1n,
      blockHash: block.hash,
      transactionHash: hash32('2'),
      logIndex: 0,
      removed: false,
    }

    expect(() => decodeAllocation(log, block)).toThrow(/does not reconcile/)
  })
})

describe('halts are never silently empty', () => {
  it('surfaces a halt store outage instead of reporting no halts', async () => {
    const h = harness()
    h.halts.unavailable = true
    // Reporting [] would restore spend authority for a coin whose fee recipient
    // may already have been taken.
    await expect(h.model.halts(TOKEN)).rejects.toThrow(/could not be read/)
  })

  it('reports open halts, deduped, keeping the first detection time', async () => {
    const h = harness()
    await h.halts.halt({
      vault: VAULT,
      token: TOKEN,
      reason: 'watch_stale',
      detail: 'first',
      detectedAtUnix: 100,
    })
    await h.halts.halt({
      vault: VAULT,
      token: TOKEN,
      reason: 'watch_stale',
      detail: 'still stale',
      detectedAtUnix: 400,
    })

    const open = await h.model.halts(TOKEN)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ detail: 'still stale', detectedAtUnix: 100 })
  })
})

describe('cursors move forward only', () => {
  it('refuses a write that would move a cursor backwards', async () => {
    const cursors = new InMemoryChainCursorStore()
    await cursors.put({
      stream: 'vault_movements',
      scope: VAULT,
      blockNumber: 100n,
      blockTimestampUnix: GENESIS,
      updatedAtUnix: GENESIS,
    })
    await expect(
      cursors.put({
        stream: 'vault_movements',
        scope: VAULT,
        blockNumber: 50n,
        updatedAtUnix: GENESIS,
      }),
    ).rejects.toThrow(/backwards/)
  })

  it('a rewind drops the coverage it can no longer vouch for', async () => {
    const cursors = new InMemoryChainCursorStore()
    await cursors.put({
      stream: 'vault_movements',
      scope: VAULT,
      blockNumber: 100n,
      blockTimestampUnix: GENESIS + 10_000,
      updatedAtUnix: GENESIS + 10_000,
    })
    // A REORG IS NOTICED NOW, and "now" on a live chain is LATER than the
    // coverage being dropped. That is the only way this is ever called, and it
    // is the case that used to slip through: the watermark was lowered with
    // `min(existing, atUnix)`, which for any realistic atUnix returned the
    // existing value unchanged and rewound no coverage whatsoever.
    await cursors.rewind('vault_movements', VAULT, 50n, GENESIS + 20_000)

    const after = await cursors.get('vault_movements', VAULT)
    expect(after?.blockNumber).toBe(50n)
    // UNKNOWN, not a number. There is no timestamp here we can honestly claim:
    // block 50's is not in hand, and the old one covers blocks that are about
    // to be re-scanned and may no longer be canonical.
    expect(after?.blockTimestampUnix).toBeUndefined()
  })

  it('a rewound cursor refuses reads until a re-scan re-establishes coverage', async () => {
    // The consequence of the rule above, at the level that matters: after a
    // reorg rewind the read model must say "I could not look", not hand back
    // the movement rows it happens to still be holding for the rewound range.
    const h = harness()
    h.chain.addBlock() // 0: genesis, nothing in it
    h.chain.addBlock({ logs: [claimedLog(4_000n)] })
    h.chain.addBlocks(2)
    h.chain.setFinalized(3n)
    await h.model.sync(tsOf(3) + 5)

    // Covered, and answering.
    expect(await h.model.claims(VAULT, tsOf(0), tsOf(3) + 5)).toHaveLength(1)

    await h.cursors.rewind('vault_movements', VAULT, 0n, tsOf(3) + 60)

    await expect(h.model.claims(VAULT, tsOf(0), tsOf(3) + 60)).rejects.toBeInstanceOf(
      CoverageGapError,
    )
    await expect(h.model.allocations(VAULT, tsOf(0), tsOf(3) + 60)).rejects.toBeInstanceOf(
      CoverageGapError,
    )

    // ...and answering again only once the re-scan has actually run.
    await h.model.sync(tsOf(3) + 61)
    expect(await h.model.claims(VAULT, tsOf(0), tsOf(3) + 61)).toHaveLength(1)
  })
})

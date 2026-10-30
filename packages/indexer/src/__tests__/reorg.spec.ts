import { describe, expect, it } from 'vitest'
import { FinalityViolationError } from '../errors.js'
import { harness } from './harness.js'
import {
  addr,
  issuedVault,
  launchCoin,
  newChain,
  poolFeesSweptLog,
  poolIdFor,
  poolRegisteredLog,
  usdg,
} from './helpers.js'

const TOKEN = addr(0xaa)
const VAULT = addr(0xa1)
const CURVE = addr(0xac)
const POOL = poolIdFor(TOKEN)

const vaults = [issuedVault({ token: TOKEN, vault: VAULT })]

/** Launched at block 1, pool registered at block 2: every sweep after that attributes. */
function launchedChain() {
  const chain = newChain()
  chain.addBlock({ logs: [launchCoin(chain, { token: TOKEN, curve: CURVE, recipient: VAULT })] })
  chain.addBlock({ logs: [poolRegisteredLog({ poolId: POOL, memecoin: TOKEN })] })
  return chain
}

function sweep(creatorAmount: bigint) {
  return poolFeesSweptLog({ poolId: POOL, protocolAmount: 0n, creatorAmount })
}

describe('reorg handling', () => {
  it('discards postings from an orphaned branch and indexes the replacement', async () => {
    const chain = launchedChain()
    chain.addBlock({ logs: [sweep(usdg(10))] })
    chain.addBlock()
    chain.setFinalized(2n)

    const h = harness(chain, vaults)
    await h.indexer.tick(10_000)

    const before = await h.store.postings({})
    expect(before).toHaveLength(1)
    expect(before[0]?.grossFeeMinor).toBe(usdg(10))
    expect(before[0]?.finalized).toBe(false)
    const orphanedId = before[0]?.id

    // Fork at block 3. Every hash at and above the fork point changes, and the
    // replacement branch carries a different sweep.
    chain.reorgFrom(3n)
    chain.addBlock({ logs: [sweep(usdg(20))] })
    chain.addBlock()

    const result = await h.indexer.tick(20_000)

    expect(result.reorg.reorged).toBe(true)
    expect(result.reorg.commonAncestor).toBe(2n)
    expect(result.reorg.removedPostings).toHaveLength(1)

    const after = await h.store.postings({})
    expect(after).toHaveLength(1)
    expect(after[0]?.id).not.toBe(orphanedId)
    expect(after[0]?.grossFeeMinor).toBe(usdg(20))
  })

  it('rewinds cursors so the replacement branch is actually re-scanned', async () => {
    const chain = launchedChain()
    chain.addBlock({ logs: [sweep(usdg(10))] })
    chain.setFinalized(2n)

    const h = harness(chain, vaults)
    await h.indexer.tick(10_000)
    expect(await h.store.getCursor('pool_fees')).toBe(3n)

    chain.reorgFrom(3n)
    chain.addBlock()
    chain.addBlock({ logs: [sweep(usdg(33))] })

    const result = await h.indexer.tick(20_000)
    expect(result.reorg.reorged).toBe(true)

    const after = await h.store.postings({})
    expect(after).toHaveLength(1)
    expect(after[0]?.blockNumber).toBe(4n)
    expect(after[0]?.grossFeeMinor).toBe(usdg(33))
  })

  it('HALTS rather than rewriting when a reorg reaches a finalized block', async () => {
    const chain = launchedChain()
    chain.addBlock({ logs: [sweep(usdg(10))] })
    chain.addBlock()
    chain.setFinalized(4n)

    const h = harness(chain, vaults)
    await h.indexer.tick(10_000)

    const finalizedPostings = await h.store.postings({ finalizedOnly: true })
    expect(finalizedPostings).toHaveLength(1)

    // Fork at the finalized height itself. Budget authority was already granted
    // against this money, so there is no safe automatic recovery.
    chain.reorgFrom(4n)
    chain.addBlock()

    await expect(h.indexer.tick(20_000)).rejects.toThrow(FinalityViolationError)

    // Nothing was quietly deleted on the way out.
    expect(await h.store.postings({ finalizedOnly: true })).toHaveLength(1)
  })

  it('promotes postings to finalized only once the finalized head covers them', async () => {
    const chain = launchedChain()
    chain.addBlock({ logs: [sweep(usdg(10))] })
    chain.setFinalized(2n)

    const h = harness(chain, vaults)
    await h.indexer.tick(10_000)
    expect(await h.store.postings({ finalizedOnly: true })).toHaveLength(0)

    chain.setFinalized(3n)
    const second = await h.indexer.tick(20_000)
    expect(second.newlyFinalized).toBe(1)
    expect(await h.store.postings({ finalizedOnly: true })).toHaveLength(1)
  })

  it('is idempotent: re-ticking the same chain creates no duplicate postings', async () => {
    const chain = launchedChain()
    chain.addBlock({ logs: [sweep(usdg(10))] })
    chain.setFinalized(3n)

    const h = harness(chain, vaults)
    const first = await h.indexer.tick(10_000)
    expect(first.newPostings).toBe(1)

    // Rewind the cursor by hand to force a re-scan of a range already handled.
    await h.store.setCursor('pool_fees', 0n)
    const second = await h.indexer.tick(20_000)

    expect(second.newPostings).toBe(0)
    expect(await h.store.postings({})).toHaveLength(1)
  })

  it('does not post a log the node flagged as removed', async () => {
    const chain = launchedChain()
    chain.addBlock({ logs: [{ ...sweep(usdg(10)), removed: true }] })
    chain.setFinalized(3n)

    const h = harness(chain, vaults)
    const result = await h.indexer.tick(10_000)

    expect(await h.store.postings({})).toHaveLength(0)
    expect(result.warnings.join(' ')).toContain('removed')
  })

  it('backfills in bounded ranges rather than one unbounded scan', async () => {
    const chain = launchedChain()
    for (let i = 0; i < 6; i++) chain.addBlock({ logs: [sweep(usdg(1))] })
    chain.setFinalized(chain.height)

    const h = harness(chain, vaults, {
      queryLimits: { maxAddressesPerQuery: 400, maxTopicValuesPerQuery: 400, maxBlockSpan: 2n },
      maxRangesPerTick: 2,
    })

    const first = await h.indexer.tick(10_000)
    expect(first.caughtUp).toBe(false)
    expect(first.ranges.every((range) => range.toBlock - range.fromBlock < 2n)).toBe(true)

    let guard = 0
    let caughtUp = first.caughtUp
    while (!caughtUp && guard++ < 10) {
      caughtUp = (await h.indexer.tick(10_000 + guard)).caughtUp
    }

    expect(caughtUp).toBe(true)
    expect(await h.store.postings({})).toHaveLength(6)
  })
})

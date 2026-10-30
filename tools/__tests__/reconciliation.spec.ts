/**
 * Cross-track reconciliation.
 *
 * Three tracks fixed three defects concurrently and could not see each other:
 *
 *   1. the credit event SHAPE (native vs ERC-20, and the native asset sentinel),
 *   2. the unknown-value MARKER and the refusal of counts over an unpriced
 *      population,
 *   3. token metadata, address-pinned pricing and the asset COVERAGE ranking.
 *
 * Each track's own tests pass. Nothing tested the SEAMS, and the seams are where
 * two independently-correct designs drift apart: two different opinions about
 * what the native asset is, two different ways of saying "unknown", and two
 * separately-built notions of pricing coverage that could disagree on the same
 * credit stream while both remaining internally consistent.
 *
 * These tests are deliberately about AGREEMENT BETWEEN MODULES, not about any
 * one module's behaviour. A failure here means the toolkit has grown a second
 * convention, which is the exact failure mode that produced the original
 * positional-decoder bug: two names for one thing, and the wrong one winning.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeCoverage, rollupAssets } from '../lib/coverage.ts'
import type { EscrowCredit } from '../lib/escrow.ts'
import { NATIVE_CREDIT_EVENT, TOKEN_CREDIT_EVENT, resolveCreditEvent } from '../lib/escrow.ts'
import { UNPRICED, usd } from '../lib/format.ts'
import {
  NATIVE_ASSET_ADDRESS,
  NATIVE_ASSET_SYMBOL,
  PriceBook,
  isNativeAsset,
  nativeQuoteAsset,
} from '../lib/prices.ts'
import { aggregateDailyCredits } from '../lib/series.ts'
import { SECONDS_PER_DAY } from '../lib/time.ts'
import { pricingCoverage } from '../lib/unpriced.ts'

const DAY = 1_788_000_000 - (1_788_000_000 % SECONDS_PER_DAY)

/** A 6-decimal stablecoin: the asset whose assumed-18 decimals was defect 3. */
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
/** An asset with metadata but no price. */
const UNPRICED_TOKEN = '0x9999999999999999999999999999999999999999'

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const CAROL = '0xcccccccccccccccccccccccccccccccccccccccc'

function credit(
  recipient: string,
  asset: string,
  amountMinor: bigint,
  dayOffset = 0,
): EscrowCredit {
  return {
    recipient,
    asset,
    assetKind: isNativeAsset(asset) ? 'native' : 'erc20',
    amountMinor,
    blockNumber: 1n,
    blockHash: '0x00',
    txHash: '0x00',
    logIndex: 0,
    timestampUnix: DAY + dayOffset * SECONDS_PER_DAY + 60,
  }
}

/**
 * The shared scenario: one merged window carrying all three regimes at once -
 * a priced native credit, a priced ERC-20 credit at NON-18 decimals, and an
 * unpriced ERC-20 credit. Alice is fully priced, Bob is fully unpriced, Carol
 * holds one of each and is therefore UNDERSTATED rather than merely incomplete.
 */
const CREDITS: EscrowCredit[] = [
  credit(ALICE, NATIVE_ASSET_ADDRESS, 1_000_000_000_000_000_000n), // 1 ETH
  credit(ALICE, USDG, 1_000_000n, 1), // 1 USDG at 6dp
  credit(BOB, UNPRICED_TOKEN, 5_000_000_000_000_000_000n),
  credit(CAROL, NATIVE_ASSET_ADDRESS, 500_000_000_000_000_000n),
  credit(CAROL, UNPRICED_TOKEN, 7_000_000_000_000_000_000n, 1),
]

function priceBook(): PriceBook {
  const book = new PriceBook({ ETH: 3200 }, 'test', DAY, [nativeQuoteAsset()])
  book.registerAsset({ address: USDG, symbol: 'USDG', decimals: 6 }, 1)
  book.registerAsset({ address: UNPRICED_TOKEN, symbol: 'JUNK', decimals: 18 })
  return book
}

function document(prices = priceBook()) {
  return aggregateDailyCredits(CREDITS, {
    escrow: '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e',
    chainId: 4663,
    mode: 'both',
    events: [
      { mode: 'native', signature: NATIVE_CREDIT_EVENT, topic0: '0x4e' },
      { mode: 'token', signature: TOKEN_CREDIT_EVENT, topic0: '0x5d' },
    ],
    backend: 'rpc',
    fromBlock: 0n,
    toBlock: 10n,
    windowStartUnix: DAY,
    windowEndUnix: DAY + SECONDS_PER_DAY,
    prices,
  })
}

describe('the native asset sentinel is ONE concept across all three tracks', () => {
  it('is the address the Solidity contracts already declare', () => {
    // Not a tools-only convention. contracts/src/lib/SafeTransferLib.sol pins
    // `address internal constant NATIVE = address(0)`, and a per-asset figure
    // produced by the tools is read next to a per-asset balance produced there.
    const solidity = readFileSync(
      join(import.meta.dirname, '..', '..', 'contracts', 'src', 'lib', 'SafeTransferLib.sol'),
      'utf8',
    )
    expect(solidity).toMatch(/address\s+internal\s+constant\s+NATIVE\s*=\s*address\(0\)/)
    expect(NATIVE_ASSET_ADDRESS).toBe(`0x${'0'.repeat(40)}`)
    expect(isNativeAsset(NATIVE_ASSET_ADDRESS)).toBe(true)
  })

  it('is what the native decoder emits, what the price book registers, and what the series keys by', () => {
    // Track 1 decides asset-ness from the event shape; track 2 prices it; track
    // 3 must not treat it as a token. All three have to name the same address.
    const plan = resolveCreditEvent(NATIVE_CREDIT_EVENT, 'native')
    expect(plan.mode).toBe('native')
    expect(nativeQuoteAsset().address).toBe(NATIVE_ASSET_ADDRESS)
    expect(nativeQuoteAsset().symbol).toBe(NATIVE_ASSET_SYMBOL)

    const doc = document()
    expect(doc.assetKinds[NATIVE_ASSET_ADDRESS]).toBe('native')
    // Exactly one native asset can ever exist: the sentinel is a single address.
    expect(doc.assetTotals.filter((a) => a.kind === 'native')).toHaveLength(1)
    expect(doc.assetTotals.find((a) => a.kind === 'native')!.asset).toBe(NATIVE_ASSET_ADDRESS)
  })

  it('is excluded from the ERC-20 metadata resolver, which cannot eth_call address(0)', () => {
    // Track 3 resolves decimals()/symbol() over the credit asset set. Calling
    // that on the native sentinel returns empty and would mark ETH as UNKNOWN
    // decimals - which would then make every native credit unpriceable.
    const erc20Assets = [...new Set(CREDITS.map((c) => c.asset))].filter((a) => !isNativeAsset(a))
    expect(erc20Assets).not.toContain(NATIVE_ASSET_ADDRESS)
    expect(erc20Assets).toEqual([USDG, UNPRICED_TOKEN])
  })
})

describe('the unknown-value marker is ONE concept across all three tracks', () => {
  it('never collides with a real zero', () => {
    expect(usd(null)).toBe(UNPRICED)
    expect(usd(undefined)).toBe(UNPRICED)
    expect(usd(0)).not.toBe(UNPRICED)
    expect(usd(0)).toBe('$0.00')
  })

  it('marks the unpriced asset and NOT the priced native asset in the same document', () => {
    // The seam: a merged document holds both regimes at once. Track 1 supplies
    // the native row, track 2 the marker, track 3 the non-18 decimals. A single
    // document has to render all three correctly at the same time.
    const doc = document()
    const native = doc.assetTotals.find((a) => a.asset === NATIVE_ASSET_ADDRESS)!
    const usdg = doc.assetTotals.find((a) => a.asset === USDG)!
    const junk = doc.assetTotals.find((a) => a.asset === UNPRICED_TOKEN)!

    // 1.5 ETH at $3,200.
    expect(native.totalUsd).toBeCloseTo(4800, 6)
    expect(usd(native.totalUsd)).not.toBe(UNPRICED)
    // 1 USDG at 6 decimals is $1.00. Read as 18 decimals it would be 1e-12.
    expect(usdg.decimals).toBe(6)
    expect(usdg.totalUsd).toBeCloseTo(1, 9)
    expect(junk.totalUsd).toBeNull()
    expect(usd(junk.totalUsd)).toBe(UNPRICED)
  })
})

describe('the two independently-built coverage concepts agree on one credit stream', () => {
  // unpriced.ts (track 2) computes coverage from the aggregated document to
  // decide whether to REFUSE a count. coverage.ts (track 3) computes coverage
  // from the credit stream to decide what to PRICE NEXT. They were written
  // separately, they are both consulted in the same report, and if they ever
  // disagree the report contradicts itself.
  const doc = document()
  const guard = pricingCoverage(doc)
  const ranking = computeCoverage(CREDITS, rollupAssets(CREDITS, { prices: priceBook() }))

  it('agrees on how many assets were seen and how many are unpriced', () => {
    expect(guard.assetsSeen).toBe(ranking.assets.total)
    expect(guard.assetsUnpriced).toBe(ranking.assets.total - ranking.assets.priced)
    expect(guard.assetsSeen).toBe(3)
    expect(guard.assetsUnpriced).toBe(1)
  })

  it('agrees on how many credit events are unpriced', () => {
    expect(guard.creditsTotal).toBe(ranking.credits.total)
    expect(guard.creditsUnpriced).toBe(ranking.credits.total - ranking.credits.priced)
    expect(guard.creditsUnpriced).toBe(2)
  })

  it('agrees on how many recipients cannot be fully valued', () => {
    // The number that decides whether a gate count is refused. Track 2 counts
    // "recipients holding at least one unpriced credit"; track 3 splits the
    // same population into fully- and partially-unpriced. They must sum.
    expect(guard.recipientsTotal).toBe(ranking.recipients.total)
    expect(guard.recipientsUnpriced).toBe(
      ranking.recipients.partiallyUnpriced + ranking.recipients.fullyUnpriced,
    )
    expect(ranking.recipients.fullyPriced).toBe(1) // Alice
    expect(ranking.recipients.fullyUnpriced).toBe(1) // Bob
    expect(ranking.recipients.partiallyUnpriced).toBe(1) // Carol: UNDERSTATED
  })

  it('agrees that the window is incomplete, and the guard is the one that refuses', () => {
    expect(guard.complete).toBe(false)
    expect(guard.exact).toBe(true)
    expect(ranking.assets.priced).toBeLessThan(ranking.assets.total)
    expect(ranking.statement).toContain('UNPRICED')
  })

  it('both report COMPLETE on the same stream once every asset is priced', () => {
    // The agreement has to hold in the good state too, or the guard would
    // refuse forever and the tool would be useless rather than merely honest.
    const full = priceBook()
    full.registerAsset({ address: UNPRICED_TOKEN, symbol: 'JUNK', decimals: 18 }, 2)
    const fullGuard = pricingCoverage(document(full))
    const fullRanking = computeCoverage(CREDITS, rollupAssets(CREDITS, { prices: full }))

    expect(fullGuard.complete).toBe(true)
    expect(fullGuard.assetsUnpriced).toBe(0)
    expect(fullGuard.recipientsUnpriced).toBe(0)
    expect(fullRanking.assets.priced).toBe(fullRanking.assets.total)
    expect(fullRanking.recipients.fullyPriced).toBe(fullRanking.recipients.total)
    expect(fullRanking.priceNext).toHaveLength(0)
  })
})

describe('a merged document keeps native and ERC-20 value separable', () => {
  it('never sums a native amount and a token amount into one minor-unit figure', () => {
    // 1.5 ETH (1e18 scale) and 1 USDG (1e6 scale) are not addable. The document
    // keeps them per-asset; only USD crosses assets, and only when priced.
    const doc = document()
    const alice = doc.recipients.find((r) => r.recipient === ALICE)!
    expect(alice.totalByAssetMinor[NATIVE_ASSET_ADDRESS]).toBe('1000000000000000000')
    expect(alice.totalByAssetMinor[USDG]).toBe('1000000')
    // Alice is fully priced: 1 ETH at $3,200 plus $1 of USDG.
    expect(alice.totalUsd).toBeCloseTo(3201, 6)
  })

  it('leaves a recipient holding one unpriced asset with a null total, not a partial sum', () => {
    // Carol's native credit IS priced. Reporting $1,600 as her total would be a
    // partial sum wearing a total's label, and it can drop her below a gate.
    const doc = document()
    const carol = doc.recipients.find((r) => r.recipient === CAROL)!
    expect(carol.totalByAssetMinor[NATIVE_ASSET_ADDRESS]).toBe('500000000000000000')
    expect(carol.totalUsd).toBeNull()
    expect(usd(carol.totalUsd)).toBe(UNPRICED)
  })
})

/**
 * Qualification signals beyond raw QF.
 *
 * Wash trading manufactures fee flow cheaply - the washer pays the fee and, as
 * the creator, receives most of it back. What it cannot cheaply manufacture is
 * BREADTH (many distinct buyers) or DECONCENTRATION (supply not sitting in ten
 * wallets). These conjuncts are what stop a farmed median from buying a tier.
 *
 * Every input here is external to the fee stream, and every one of them refuses
 * rather than defaults. In particular, after graduation the per-launch curve
 * stops emitting trades: a post-graduation coin needs a pool-swap TradeSource,
 * and without one this module raises SignalsUnavailableError instead of
 * reporting a confidently wrong "0 unique buyers".
 */

import type { Address, AssetAddress, QualificationSignals } from '@fee-split-vaults/core'
import { SignalsUnavailableError } from './errors.js'
import { addressEquals, type Hex } from './hex.js'
import type { CoinBinding, FeePosting, TradeObservation } from './model.js'
import { tradesFromPostings } from './model.js'
import { requirePrice, usdOf, type PriceOracle } from './prices.js'
import { VENUE } from './protocol.js'
import { DAY_SECONDS } from './schedule.js'

export interface HolderBalance {
  readonly holder: Address
  readonly balanceMinor: bigint
}

/** A hash-pinned holder reading. Balances are meaningless without their block. */
export interface HolderSnapshot {
  readonly token: Address
  readonly blockHash: Hex
  readonly blockNumber: bigint
  readonly takenAtUnix: number
  readonly totalSupplyMinor: bigint
  readonly deployer: Address
  /** At least the top ten circulating holders plus the deployer. */
  readonly balances: readonly HolderBalance[]
  /**
   * Custodians the SOURCE knows are not holders - the pool manager it read
   * off the hook, for one - beyond the ones the signal module strips itself.
   */
  readonly structural?: readonly Address[]
}

export interface HolderSource {
  snapshot(token: Address): Promise<HolderSnapshot | undefined>
}

export class InMemoryHolderSource implements HolderSource {
  private readonly byToken = new Map<string, HolderSnapshot>()

  put(snapshot: HolderSnapshot): void {
    this.byToken.set(snapshot.token.toLowerCase(), snapshot)
  }

  async snapshot(token: Address): Promise<HolderSnapshot | undefined> {
    return this.byToken.get(token.toLowerCase())
  }
}

/**
 * Total observed volume versus Venue-pool volume. CASHCAT showed a 122x gap
 * between headline aggregator volume and fee-bearing Venue-pool volume, and that
 * gap is the normal state of a winner, not an anomaly. A collapsing share is the
 * early warning that liquidity is migrating somewhere we earn nothing.
 */
export interface VolumeSample {
  readonly token: Address
  readonly windowSeconds: number
  readonly totalVolumeUsd: number
  readonly venuePoolVolumeUsd: number
  readonly source: string
  readonly sampledAtUnix: number
}

export interface VolumeSource {
  sample(token: Address, windowSeconds: number): Promise<VolumeSample | undefined>
}

export class InMemoryVolumeSource implements VolumeSource {
  private readonly byToken = new Map<string, VolumeSample>()

  put(sample: VolumeSample): void {
    this.byToken.set(sample.token.toLowerCase(), sample)
  }

  async sample(token: Address): Promise<VolumeSample | undefined> {
    return this.byToken.get(token.toLowerCase())
  }
}

/**
 * Headline volume from an aggregator that watches every venue: the "total"
 * side of the pool-share ratio. One resolution, 24 hours, because that is
 * what the aggregators publish; a sample built from it says so in
 * `windowSeconds` rather than pretending to the caller's window.
 */
export interface ExternalVolumeObserver {
  /** Undefined when the token has no listed pair: nothing to measure, not zero. */
  volume24hUsd(token: Address): Promise<{ totalVolumeUsd: number; source: string; observedAtUnix: number } | undefined>
}

export interface PostingsVolumeSourceDeps {
  readonly binding: (token: Address) => Promise<CoinBinding | undefined>
  readonly postings: (vault: Address, fromUnix: number, toUnix: number) => Promise<readonly FeePosting[]>
  readonly prices: PriceOracle
  readonly decimals: (asset: AssetAddress) => number | undefined
  /** Required after graduation, when the curve stops being the only venue. */
  readonly external?: ExternalVolumeObserver
  readonly nowUnix: () => number
}

/** The last 24 hours; the finest resolution the total side is published at. */
export const VOLUME_SAMPLE_WINDOW_SECONDS = DAY_SECONDS

/**
 * Venue-pool volume from the fee postings we already index, against a total
 * from an aggregator. Every posting carries the trade's quote volume when it
 * was a curve trade; a pool sweep carries none, but it carries the hook's
 * gross fee, and the hook fee is a pinned share of volume (VENUE.hookFeeBps),
 * so the volume the sweep represents is recovered exactly.
 *
 * BEFORE GRADUATION THE CURVE IS THE ONLY VENUE: the token has no pool, and
 * the total is the Venue figure by construction. After graduation the total
 * must come from the observer, and without one the sample is refused rather
 * than reported as a 100% share that means nothing.
 */
export class PostingsVolumeSource implements VolumeSource {
  readonly #deps: PostingsVolumeSourceDeps

  constructor(deps: PostingsVolumeSourceDeps) {
    this.#deps = deps
  }

  async sample(token: Address, windowSeconds: number): Promise<VolumeSample | undefined> {
    if (windowSeconds < VOLUME_SAMPLE_WINDOW_SECONDS) return undefined
    const binding = await this.#deps.binding(token)
    if (binding === undefined) return undefined
    const toUnix = this.#deps.nowUnix()
    const fromUnix = toUnix - VOLUME_SAMPLE_WINDOW_SECONDS
    const decimals = this.#deps.decimals(binding.quoteAsset)
    if (decimals === undefined) return undefined

    let venuePoolVolumeUsd = 0
    for (const posting of await this.#deps.postings(binding.vault, fromUnix, toUnix)) {
      if (!posting.finalized || !addressEquals(posting.token, token)) continue
      const volumeMinor =
        posting.volumeMinor > 0n
          ? posting.volumeMinor
          : posting.side === 'sweep'
            ? (posting.grossFeeMinor * 10_000n) / BigInt(VENUE.hookFeeBps)
            : 0n
      if (volumeMinor === 0n) continue
      const price = requirePrice(this.#deps.prices, posting.asset, posting.occurredAtUnix)
      venuePoolVolumeUsd += usdOf(volumeMinor, decimals, price)
    }

    if (binding.graduatedAtUnix === undefined) {
      return {
        token,
        windowSeconds: VOLUME_SAMPLE_WINDOW_SECONDS,
        totalVolumeUsd: venuePoolVolumeUsd,
        venuePoolVolumeUsd,
        source: 'indexer:curve_trades (pre-graduation; the curve is the only venue)',
        sampledAtUnix: toUnix,
      }
    }
    if (this.#deps.external === undefined) return undefined
    const observed = await this.#deps.external.volume24hUsd(token)
    if (observed === undefined) return undefined
    return {
      token,
      windowSeconds: VOLUME_SAMPLE_WINDOW_SECONDS,
      totalVolumeUsd: observed.totalVolumeUsd,
      venuePoolVolumeUsd,
      source: `${observed.source} total / indexer postings venue`,
      sampledAtUnix: Math.min(toUnix, observed.observedAtUnix),
    }
  }
}

export interface TradeWindow {
  readonly trades: readonly TradeObservation[]
  /** The span the source can actually vouch for. Short coverage is a refusal. */
  readonly coverage: { readonly fromUnix: number; readonly toUnix: number }
}

export interface TradeSource {
  window(token: Address, fromUnix: number, toUnix: number): Promise<TradeWindow | undefined>
}

/** Pre-graduation trades, read straight off the curve postings we already have. */
export class PostingsTradeSource implements TradeSource {
  constructor(
    private readonly postings: readonly FeePosting[],
    private readonly coverageStartUnix: number,
    private readonly coverageEndUnix: number,
  ) {}

  async window(token: Address, fromUnix: number, toUnix: number): Promise<TradeWindow> {
    const trades = tradesFromPostings(
      this.postings.filter(
        (posting) =>
          addressEquals(posting.token, token) &&
          posting.occurredAtUnix >= fromUnix &&
          posting.occurredAtUnix < toUnix,
      ),
    )
    return {
      trades,
      coverage: { fromUnix: this.coverageStartUnix, toUnix: this.coverageEndUnix },
    }
  }
}

export class InMemoryTradeSource implements TradeSource {
  private readonly byToken = new Map<string, TradeWindow>()

  put(token: Address, window: TradeWindow): void {
    this.byToken.set(token.toLowerCase(), window)
  }

  async window(token: Address, fromUnix: number, toUnix: number): Promise<TradeWindow | undefined> {
    const stored = this.byToken.get(token.toLowerCase())
    if (!stored) return undefined
    return {
      trades: stored.trades.filter((t) => t.occurredAtUnix >= fromUnix && t.occurredAtUnix < toUnix),
      coverage: stored.coverage,
    }
  }
}

/** Basis-point precision on a percentage, computed without leaving bigint early. */
function percentOf(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0
  return Number((part * 1_000_000n) / whole) / 10_000
}

export interface SignalsOptions {
  readonly nowUnix: number
  readonly windowDays?: number
  readonly maxHolderSnapshotAgeSeconds?: number
  readonly maxVolumeSampleAgeSeconds?: number
  /** Addresses excluded from holder concentration: pools, lockers, burn. */
  readonly structuralAddresses?: readonly Address[]
}

export interface SignalsInput {
  readonly binding: CoinBinding
  readonly trades: TradeSource
  readonly holders: HolderSource
  readonly volume: VolumeSource
  readonly options: SignalsOptions
}

export const DEFAULT_HOLDER_SNAPSHOT_MAX_AGE_SECONDS = 21_600
export const DEFAULT_VOLUME_SAMPLE_MAX_AGE_SECONDS = 3_600

export async function computeQualificationSignals(
  input: SignalsInput,
): Promise<QualificationSignals> {
  const { binding, options } = input
  const windowDays = options.windowDays ?? 7
  const windowSeconds = windowDays * DAY_SECONDS
  const fromUnix = options.nowUnix - windowSeconds
  const toUnix = options.nowUnix

  const tradeWindow = await input.trades.window(binding.token, fromUnix, toUnix)
  if (!tradeWindow) {
    throw new SignalsUnavailableError(
      'uniqueBuyers7d',
      `no trade source for ${binding.token}; after graduation the curve is silent and a ` +
        `pool-swap source must be supplied`,
    )
  }
  if (tradeWindow.coverage.fromUnix > fromUnix || tradeWindow.coverage.toUnix < toUnix) {
    throw new SignalsUnavailableError(
      'uniqueBuyers7d',
      `trade coverage ${tradeWindow.coverage.fromUnix}-${tradeWindow.coverage.toUnix} does not span ` +
        `the ${windowDays}-day window ${fromUnix}-${toUnix}`,
    )
  }

  const buyers = new Set<string>()
  const sellers = new Set<string>()
  let totalVolumeMinor = 0n
  const volumeByTrader = new Map<string, bigint>()

  for (const trade of tradeWindow.trades) {
    if (!trade.finalized) continue
    const trader = trade.trader.toLowerCase()
    if (trade.side === 'buy') buyers.add(trader)
    else sellers.add(trader)
    totalVolumeMinor += trade.quoteVolumeMinor
    volumeByTrader.set(trader, (volumeByTrader.get(trader) ?? 0n) + trade.quoteVolumeMinor)
  }

  // Round-trippers: an address that both bought and sold inside the window. Its
  // whole volume is treated as self-trade, which is the conservative reading.
  let selfTradeVolumeMinor = 0n
  for (const trader of buyers) {
    if (sellers.has(trader)) selfTradeVolumeMinor += volumeByTrader.get(trader) ?? 0n
  }

  const snapshot = await input.holders.snapshot(binding.token)
  if (!snapshot) {
    throw new SignalsUnavailableError('top10HolderSharePct', `no holder snapshot for ${binding.token}`)
  }
  const snapshotAge = options.nowUnix - snapshot.takenAtUnix
  const maxSnapshotAge = options.maxHolderSnapshotAgeSeconds ?? DEFAULT_HOLDER_SNAPSHOT_MAX_AGE_SECONDS
  if (snapshotAge > maxSnapshotAge) {
    throw new SignalsUnavailableError(
      'top10HolderSharePct',
      `holder snapshot is ${snapshotAge}s old, limit is ${maxSnapshotAge}s`,
    )
  }
  if (snapshot.totalSupplyMinor <= 0n) {
    throw new SignalsUnavailableError('top10HolderSharePct', 'total supply reads as zero')
  }

  // Structural addresses are not holders: the pool, the locker, the burn
  // address and our own vault hold supply that is not concentration. The
  // DEPLOYER is deliberately NOT excluded - a deployer sitting on a third of
  // supply is exactly the concentration this signal exists to catch - and its
  // share is additionally reported on its own.
  const structural = new Set(
    [
      '0x0000000000000000000000000000000000000000',
      '0x000000000000000000000000000000000000dead',
      binding.curve,
      binding.vault,
      VENUE.contracts.v2LaunchLocker,
      VENUE.contracts.v2BuybackVault,
      ...(snapshot.structural ?? []),
      ...(options.structuralAddresses ?? []),
    ].map((a) => a.toLowerCase()),
  )

  const circulating = snapshot.balances
    .filter((balance) => !structural.has(balance.holder.toLowerCase()))
    .sort((a, b) => (a.balanceMinor === b.balanceMinor ? 0 : a.balanceMinor > b.balanceMinor ? -1 : 1))

  const top10Minor = circulating
    .slice(0, 10)
    .reduce((total, balance) => total + balance.balanceMinor, 0n)

  const deployerBalance =
    snapshot.balances.find((balance) => addressEquals(balance.holder, snapshot.deployer))?.balanceMinor ??
    0n

  const sample = await input.volume.sample(binding.token, windowSeconds)
  if (!sample) {
    throw new SignalsUnavailableError('venuePoolVolumeSharePct', `no volume sample for ${binding.token}`)
  }
  const sampleAge = options.nowUnix - sample.sampledAtUnix
  const maxSampleAge = options.maxVolumeSampleAgeSeconds ?? DEFAULT_VOLUME_SAMPLE_MAX_AGE_SECONDS
  if (sampleAge > maxSampleAge) {
    throw new SignalsUnavailableError(
      'venuePoolVolumeSharePct',
      `volume sample is ${sampleAge}s old, limit is ${maxSampleAge}s`,
    )
  }
  if (sample.totalVolumeUsd < sample.venuePoolVolumeUsd) {
    throw new SignalsUnavailableError(
      'venuePoolVolumeSharePct',
      `venue-pool volume ${sample.venuePoolVolumeUsd} exceeds total ${sample.totalVolumeUsd}`,
    )
  }

  return {
    uniqueBuyers7d: buyers.size,
    top10HolderSharePct: percentOf(top10Minor, snapshot.totalSupplyMinor),
    deployerSupplySharePct: percentOf(deployerBalance, snapshot.totalSupplyMinor),
    selfTradeSharePct: percentOf(selfTradeVolumeMinor, totalVolumeMinor),
    venuePoolVolumeSharePct:
      sample.totalVolumeUsd <= 0 ? 0 : (sample.venuePoolVolumeUsd / sample.totalVolumeUsd) * 100,
    coinAgeDays: Math.max(0, (options.nowUnix - binding.launchedAtUnix) / DAY_SECONDS),
  }
}

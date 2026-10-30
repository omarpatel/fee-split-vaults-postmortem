/**
 * Endpoint measurement.
 *
 * Three chain facts shape this file and none of them are negotiable:
 *
 *   1. Per-coin attribution CANNOT come from escrow events. Post-graduation all
 *      clients share one depositor and no escrow event carries a coin id. Fees
 *      are therefore attributed from the hook's PoolFeesSwept(poolId, ...) and
 *      a poolId the registry does not know is a refusal, not a zero.
 *   2. Amounts are bigint minor units end to end. USD appears only as a derived
 *      reporting figure and always carries its provenance.
 *   3. Every approved quote asset is an upgradeable, pausable proxy. A disabled
 *      asset means the measurement is incomplete, so it fails closed.
 *
 * The harness that runs this holds NO KEYS and NO POSTING TOOLS, and it reads
 * community activity only through validated Digests. There is no path from a
 * Telegram message to anything in this package.
 */

import { validateDigest, type Address, type Asset, type AssetAddress, type UsdValue } from '@fee-split-vaults/core'
import type { AnalysisPlan } from './prereg.js'
import type {
  Arm,
  BlockAssignment,
  BlockIntegrity,
  BlockOutcome,
  CoinAssignment,
  FeeCredit,
  FeeMechanism,
  MembershipDelta,
  PilotAssignment,
  PilotCoin,
  PilotDataset,
} from './types.js'

/**
 * The classification window for the anti-snipe tax, seconds since launch.
 *
 * The tax is 99% at t=0 and decays over roughly three seconds; block timestamps
 * have second granularity and the launch timestamp itself comes from a block, so
 * the window is padded rather than cut fine. This matches the indexer's constant
 * of the same name deliberately - the two must agree, and the registered plan
 * floors its own committed parameter at this value.
 */
export const ANTI_SNIPE_WINDOW_SECONDS = 5

export class MeasurementError extends Error {
  constructor(message: string) {
    super(`pilot measurement: ${message}`)
    this.name = 'MeasurementError'
  }
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** A raw hook event. The only per-coin-attributable source of fee credits. */
export interface PoolFeesSweptLog {
  poolId: string
  asset: AssetAddress
  amountMinor: bigint
  occurredAtUnix: number
  blockHash: string
  txHash: string
  logIndex: number
}

/** Narrow port over the log query. A real implementation wraps an RPC client. */
export interface PoolFeesSweptReader {
  read(fromUnix: number, toUnixExclusive: number): Promise<PoolFeesSweptLog[]>
}

export interface PoolTokenMap {
  /** Undefined means unknown, which is a refusal. Never treat it as "no fees". */
  tokenForPool(poolId: string): Address | undefined
}

export interface AssetRegistry {
  /** Undefined means the asset is not approved. */
  asset(address: AssetAddress): Asset | undefined
}

export interface PinnedPrice {
  asset: AssetAddress
  usdPerWholeUnit: number
  source: string
  pricedAtUnix: number
}

export interface PriceOracle {
  /** Throws when no price is pinned for that asset at that time. */
  usdPerWholeUnit(asset: AssetAddress, atUnix: number): Promise<PinnedPrice>
}

export interface FeeCreditSource {
  creditsForToken(token: Address, fromUnix: number, toUnixExclusive: number): Promise<FeeCredit[]>
}

export interface BuyerSource {
  /** Addresses whose FIRST ever buy of this token falls inside the window. */
  uniqueNewBuyers(token: Address, fromUnix: number, toUnixExclusive: number): Promise<number>
}

export interface MembershipSource {
  delta(chatRef: string, fromUnix: number, toUnixExclusive: number): Promise<MembershipDelta>
}

/**
 * Digests only. The pilot never reads a raw message, so the backlog secondary
 * is carried by the closed-enum topic code `unanswered_backlog` and nothing else.
 */
export interface DigestSource {
  digestsInWindow(coinRef: string, fromUnix: number, toUnixExclusive: number): Promise<unknown[]>
}

/**
 * Did the desk actually run the arm the draw assigned?
 *
 * REQUIRED, and deliberately not defaulted: an operator with no delivery log has
 * no evidence the trial ran as assigned, and "assume we did" is the failure this
 * port exists to make visible. Use `AssumeDeliveredSource` to state that
 * assumption out loud when you genuinely have no log - a fixture, a dry run -
 * rather than letting silence stand in for it.
 */
export interface DeliverySource {
  deliveredAsAssigned(coinRef: string, blockIndex: number): Promise<boolean>
}

export interface PilotSources {
  fees: FeeCreditSource
  buyers: BuyerSource
  membership: MembershipSource
  digests: DigestSource
  assets: AssetRegistry
  prices: PriceOracle
  delivery: DeliverySource
}

// ---------------------------------------------------------------------------
// Real implementation shapes
// ---------------------------------------------------------------------------

/**
 * Attributes hook sweeps to a single token. Dedupes on (txHash, logIndex) so a
 * reorg-driven re-read cannot double count, and refuses unknown pools.
 */
export class HookFeeCreditSource implements FeeCreditSource {
  constructor(
    private readonly reader: PoolFeesSweptReader,
    private readonly pools: PoolTokenMap,
  ) {}

  async creditsForToken(
    token: Address,
    fromUnix: number,
    toUnixExclusive: number,
  ): Promise<FeeCredit[]> {
    assertWindow(fromUnix, toUnixExclusive)
    const logs = await this.reader.read(fromUnix, toUnixExclusive)
    const seen = new Set<string>()
    const credits: FeeCredit[] = []

    for (const log of logs) {
      const owner = this.pools.tokenForPool(log.poolId)
      if (owner === undefined) {
        throw new MeasurementError(
          `pool ${log.poolId} is not in the registry; per-coin attribution would be a guess`,
        )
      }
      if (owner.toLowerCase() !== token.toLowerCase()) continue
      if (log.occurredAtUnix < fromUnix || log.occurredAtUnix >= toUnixExclusive) continue
      if (log.amountMinor < 0n) {
        throw new MeasurementError('negative fee credit; the reader is wrong or the log is forged')
      }

      const dedupeKey = `${log.txHash}:${log.logIndex}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      credits.push({
        asset: log.asset,
        minor: log.amountMinor,
        occurredAtUnix: log.occurredAtUnix,
        blockHash: log.blockHash,
        txHash: log.txHash,
        logIndex: log.logIndex,
        source: 'pool_fees_swept',
      })
    }
    return credits
  }
}

export interface BuyLog {
  token: Address
  buyer: Address
  occurredAtUnix: number
}

export interface BuyLogReader {
  read(token: Address, fromUnix: number, toUnixExclusive: number): Promise<BuyLog[]>
}

/**
 * Novelty needs history. This source is seeded with the timestamp from which
 * buy history is complete and refuses any window that starts earlier, because
 * "first ever buy" is unanswerable before that point.
 *
 * History is loaded forward once per token and cached, so measuring 60 windows
 * costs one scan rather than sixty.
 */
export class HistoricalBuyerSource implements BuyerSource {
  private readonly firstSeen = new Map<string, Map<string, number>>()
  private readonly loadedThrough = new Map<string, number>()

  constructor(
    private readonly reader: BuyLogReader,
    private readonly historyCompleteFromUnix: number,
  ) {}

  async uniqueNewBuyers(
    token: Address,
    fromUnix: number,
    toUnixExclusive: number,
  ): Promise<number> {
    assertWindow(fromUnix, toUnixExclusive)
    if (fromUnix < this.historyCompleteFromUnix) {
      throw new MeasurementError(
        `buy history is only complete from ${this.historyCompleteFromUnix}; cannot judge novelty at ${fromUnix}`,
      )
    }
    const key = token.toLowerCase()
    const loadedThrough = this.loadedThrough.get(key) ?? this.historyCompleteFromUnix
    let buyers = this.firstSeen.get(key)
    if (!buyers) {
      buyers = new Map<string, number>()
      this.firstSeen.set(key, buyers)
    }

    if (toUnixExclusive > loadedThrough) {
      for (const log of await this.reader.read(token, loadedThrough, toUnixExclusive)) {
        const buyer = log.buyer.toLowerCase()
        const prior = buyers.get(buyer)
        if (prior === undefined || log.occurredAtUnix < prior) {
          buyers.set(buyer, log.occurredAtUnix)
        }
      }
      this.loadedThrough.set(key, toUnixExclusive)
    }

    let count = 0
    for (const at of buyers.values()) {
      if (at >= fromUnix && at < toUnixExclusive) count += 1
    }
    return count
  }
}

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

export class InMemoryPoolFeesSweptReader implements PoolFeesSweptReader {
  constructor(private readonly logs: PoolFeesSweptLog[]) {}
  async read(fromUnix: number, toUnixExclusive: number): Promise<PoolFeesSweptLog[]> {
    return this.logs.filter((l) => l.occurredAtUnix >= fromUnix && l.occurredAtUnix < toUnixExclusive)
  }
}

export class InMemoryPoolTokenMap implements PoolTokenMap {
  constructor(private readonly map: ReadonlyMap<string, Address>) {}
  static fromCoins(coins: PilotCoin[]): InMemoryPoolTokenMap {
    return new InMemoryPoolTokenMap(new Map(coins.map((c) => [c.poolId, c.token])))
  }
  tokenForPool(poolId: string): Address | undefined {
    return this.map.get(poolId)
  }
}

export class InMemoryAssetRegistry implements AssetRegistry {
  private readonly byAddress: Map<string, Asset>
  constructor(assets: Asset[]) {
    this.byAddress = new Map(assets.map((a) => [a.address.toLowerCase(), a]))
  }
  asset(address: AssetAddress): Asset | undefined {
    return this.byAddress.get(address.toLowerCase())
  }
}

export class FixedPriceOracle implements PriceOracle {
  private readonly prices: Map<string, number>
  constructor(
    prices: Record<AssetAddress, number>,
    private readonly source = 'fixture:pinned',
  ) {
    this.prices = new Map(Object.entries(prices).map(([k, v]) => [k.toLowerCase(), v]))
  }
  async usdPerWholeUnit(asset: AssetAddress, atUnix: number): Promise<PinnedPrice> {
    const usdPerWholeUnit = this.prices.get(asset.toLowerCase())
    if (usdPerWholeUnit === undefined) {
      throw new MeasurementError(`no pinned price for ${asset}; refusing to value the window`)
    }
    return { asset, usdPerWholeUnit, source: this.source, pricedAtUnix: atUnix }
  }
}

export class InMemoryBuyerSource implements BuyerSource {
  constructor(private readonly counts: ReadonlyMap<string, number>) {}
  static keyOf(token: Address, fromUnix: number): string {
    return `${token.toLowerCase()}:${fromUnix}`
  }
  async uniqueNewBuyers(token: Address, fromUnix: number): Promise<number> {
    return this.counts.get(InMemoryBuyerSource.keyOf(token, fromUnix)) ?? 0
  }
}

export class InMemoryMembershipSource implements MembershipSource {
  constructor(private readonly deltas: ReadonlyMap<string, MembershipDelta>) {}
  static keyOf(chatRef: string, fromUnix: number): string {
    return `${chatRef}:${fromUnix}`
  }
  async delta(chatRef: string, fromUnix: number): Promise<MembershipDelta> {
    return (
      this.deltas.get(InMemoryMembershipSource.keyOf(chatRef, fromUnix)) ?? {
        joins: 0,
        leaves: 0,
        membersEnd: 0,
      }
    )
  }
}

/**
 * "We have no delivery log and are assuming the desk ran every assigned block."
 *
 * Named so that the assumption appears in the wiring rather than in nobody's
 * head. A real pilot supplies `InMemoryDeliverySource` built from the desk's
 * own coverage log, and a run that used this class is not evidence about
 * delivery either way.
 */
export class AssumeDeliveredSource implements DeliverySource {
  async deliveredAsAssigned(): Promise<boolean> {
    return true
  }
}

export class InMemoryDeliverySource implements DeliverySource {
  constructor(private readonly failures: ReadonlySet<string>) {}
  static keyOf(coinRef: string, blockIndex: number): string {
    return `${coinRef}:${blockIndex}`
  }
  async deliveredAsAssigned(coinRef: string, blockIndex: number): Promise<boolean> {
    return !this.failures.has(InMemoryDeliverySource.keyOf(coinRef, blockIndex))
  }
}

export class InMemoryDigestSource implements DigestSource {
  constructor(private readonly digests: ReadonlyMap<string, unknown[]>) {}
  static keyOf(coinRef: string, fromUnix: number): string {
    return `${coinRef}:${fromUnix}`
  }
  async digestsInWindow(coinRef: string, fromUnix: number): Promise<unknown[]> {
    return this.digests.get(InMemoryDigestSource.keyOf(coinRef, fromUnix)) ?? []
  }
}

// ---------------------------------------------------------------------------
// Valuation and assembly
// ---------------------------------------------------------------------------

function assertWindow(fromUnix: number, toUnixExclusive: number): void {
  if (!Number.isInteger(fromUnix) || !Number.isInteger(toUnixExclusive)) {
    throw new MeasurementError('window bounds must be integer unix timestamps')
  }
  if (toUnixExclusive <= fromUnix) {
    throw new MeasurementError('window must be non-empty and forward in time')
  }
}

/** Exact split so a bigint larger than 2^53 does not lose its whole part. */
export function minorToWhole(minor: bigint, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new MeasurementError(`implausible decimals ${decimals}`)
  }
  const scale = 10n ** BigInt(decimals)
  const whole = minor / scale
  const remainder = minor % scale
  return Number(whole) + Number(remainder) / Number(scale)
}

export interface ValuedCredits {
  usd: UsdValue
  byAsset: Array<{ asset: AssetAddress; minor: bigint }>
  /** Largest single credit, in USD. Drives the whale flag, which never excludes. */
  largestCreditUsd: number
  /** USD of the credits matching the caller's subset predicate. Zero without one. */
  subsetUsd: number
}

export interface ValueCreditsOptions {
  /**
   * Credits matching this are additionally totalled and returned as `subsetUsd`.
   * The anti-snipe subtotal is computed this way rather than by a second pass,
   * so it is priced with exactly the same pinned prices as the window total.
   */
  subset?: (credit: FeeCredit) => boolean
}

/**
 * Fails closed on: an unapproved asset, a kill-switched asset, and a missing
 * price. Any of those means the window is unmeasured, and an unmeasured window
 * must not enter the dataset as a zero.
 */
export async function valueCredits(
  credits: FeeCredit[],
  assets: AssetRegistry,
  prices: PriceOracle,
  pricedAtUnix: number,
  options: ValueCreditsOptions = {},
): Promise<ValuedCredits> {
  const totals = new Map<string, { asset: AssetAddress; minor: bigint }>()
  for (const credit of credits) {
    const key = credit.asset.toLowerCase()
    const running = totals.get(key) ?? { asset: credit.asset, minor: 0n }
    running.minor += credit.minor
    totals.set(key, running)
  }

  let usd = 0
  const sources: string[] = []
  const rates = new Map<string, { decimals: number; usdPerWholeUnit: number }>()
  for (const entry of totals.values()) {
    const asset = assets.asset(entry.asset)
    if (!asset) {
      throw new MeasurementError(`asset ${entry.asset} is not an approved quote asset`)
    }
    if (!asset.enabled) {
      throw new MeasurementError(
        `asset ${asset.symbol} is kill-switched; the window cannot be valued and must not be recorded as zero`,
      )
    }
    const price = await prices.usdPerWholeUnit(entry.asset, pricedAtUnix)
    if (!Number.isFinite(price.usdPerWholeUnit) || price.usdPerWholeUnit < 0) {
      throw new MeasurementError(`implausible price for ${asset.symbol}`)
    }
    usd += minorToWhole(entry.minor, asset.decimals) * price.usdPerWholeUnit
    rates.set(entry.asset.toLowerCase(), {
      decimals: asset.decimals,
      usdPerWholeUnit: price.usdPerWholeUnit,
    })
    sources.push(`${asset.symbol}@${price.source}`)
  }

  // Per-credit USD goes through minorToWhole for the same reason the window
  // total does: Number() on a minor-unit bigint above 2^53 loses the whole part,
  // and an 18-decimal asset gets there easily.
  let largestCreditUsd = 0
  let subsetUsd = 0
  for (const credit of credits) {
    const rate = rates.get(credit.asset.toLowerCase())
    if (!rate) continue
    const creditUsd = minorToWhole(credit.minor, rate.decimals) * rate.usdPerWholeUnit
    if (creditUsd > largestCreditUsd) largestCreditUsd = creditUsd
    if (options.subset?.(credit) === true) subsetUsd += creditUsd
  }

  const last = credits.reduce<FeeCredit | undefined>(
    (acc, c) => (acc === undefined || c.occurredAtUnix > acc.occurredAtUnix ? c : acc),
    undefined,
  )

  const value: UsdValue = {
    usd,
    priceSource: sources.length > 0 ? sources.sort().join(',') : 'none:no_credits',
    pricedAtUnix,
  }
  if (last) value.blockHash = last.blockHash

  return {
    usd: value,
    byAsset: [...totals.values()].sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0)),
    largestCreditUsd,
    subsetUsd,
  }
}

/** Sum of the closed-enum backlog topic across every Digest in the window. */
export function backlogFromDigests(raw: unknown[]): number {
  let total = 0
  for (const candidate of raw) {
    // Fails closed via AirlockViolation on anything that is not a valid Digest.
    const digest = validateDigest(candidate)
    total += digest.topicCounts.unanswered_backlog ?? 0
  }
  return total
}

export interface CollectOptions {
  /** Collect only the randomized phase unless explicitly told otherwise. */
  includeFullCoveragePhase?: boolean
  /**
   * The classification window for the anti-snipe tax. Defaults to
   * ANTI_SNIPE_WINDOW_SECONDS; pass the committed plan's parameter so the
   * measurement and the exclusion agree by construction.
   */
  antiSnipeWindowSeconds?: number
  /**
   * Abort the whole collection when a window cannot be valued, instead of
   * recording it as UNMEASURED.
   *
   * The default is to record it. That is not a softening of fail-closed: the
   * unmeasured window's endpoint is NaN, the registered `unvalued_window`
   * exclusion removes it, and if that exclusion ever fails to fire the analysis
   * throws on the non-finite value rather than averaging in a false zero.
   * Aborting sixty days of collection because one quote asset paused for an hour
   * is the behaviour that gets a dataset hand-patched, which is far worse.
   */
  haltOnUnvaluedWindow?: boolean
}

/**
 * Collection options taken FROM the committed plan.
 *
 * Use this rather than the defaults. The anti-snipe subtotal recorded at
 * measurement time is the input to the registered exclusion, so measuring with
 * one window and excluding with another would leave a gap exactly the width of
 * the difference - and nothing downstream could see it, because by then the
 * subtotal is just a number.
 */
export function collectOptionsFromPlan(plan: AnalysisPlan): CollectOptions {
  return { antiSnipeWindowSeconds: plan.exclusionParameters.antiSnipeWindowSeconds }
}

/**
 * Build the analysis dataset. The primary endpoint window is the 12 hours
 * FOLLOWING each block, per the registered plan.
 */
export async function collectBlockOutcomes(
  assignment: PilotAssignment,
  coins: PilotCoin[],
  sources: PilotSources,
  collectedAtUnix: number,
  options: CollectOptions = {},
): Promise<PilotDataset> {
  const byRef = new Map(coins.map((c) => [c.coinRef, c]))
  const outcomes: BlockOutcome[] = []
  let firstObservationUnix = Number.POSITIVE_INFINITY

  for (const coinAssignment of assignment.coins) {
    const coin = byRef.get(coinAssignment.coinRef)
    if (!coin) {
      throw new MeasurementError(`assignment references unenrolled coin ${coinAssignment.coinRef}`)
    }
    const wanted = coinAssignment.blocks.filter(
      (b) => options.includeFullCoveragePhase === true || b.phase === 'RANDOMIZED',
    )
    for (const block of wanted) {
      const outcome = await measureBlock(
        coin,
        block,
        nextArm(coinAssignment, block),
        sources,
        options,
      )
      if (outcome.followWindowStartUnix < firstObservationUnix) {
        firstObservationUnix = outcome.followWindowStartUnix
      }
      outcomes.push(outcome)
    }
  }

  if (outcomes.length === 0) throw new MeasurementError('no blocks measured')

  return {
    pilotId: assignment.pilotId,
    assignmentHash: assignment.assignmentHash,
    outcomes,
    firstObservationUnix,
    collectedAtUnix,
  }
}

function nextArm(coinAssignment: CoinAssignment, block: BlockAssignment): Arm | null {
  const next = coinAssignment.blocks.find((b) => b.blockIndex === block.blockIndex + 1)
  return next ? next.arm : null
}

/** Which rail carried the window's credits, for the graduation exclusion. */
export function resolveFeeMechanism(
  credits: readonly FeeCredit[],
  coin: PilotCoin,
  windowStartUnix: number,
): FeeMechanism {
  if (credits.length === 0) return 'NONE'
  let curve = false
  let sweep = false
  let unknown = false
  for (const credit of credits) {
    if (credit.source === 'curve_event') curve = true
    else if (credit.source === 'pool_fees_swept') sweep = true
    else unknown = true
  }
  if (curve && sweep) return 'MIXED'
  if (curve) return 'PRE_GRADUATION_CURVE'
  if (sweep && !unknown) return 'POST_GRADUATION_SWEEP'
  // No source labels: fall back to the coin's own graduation timestamp.
  if (coin.graduatedAtUnix === undefined) return 'PRE_GRADUATION_CURVE'
  return windowStartUnix >= coin.graduatedAtUnix ? 'POST_GRADUATION_SWEEP' : 'MIXED'
}

/** An unmeasured window: NaN endpoint, and the exclusion engine must remove it. */
function unmeasuredValuation(pricedAtUnix: number, reason: string): ValuedCredits {
  return {
    usd: { usd: Number.NaN, priceSource: `unmeasured:${reason}`, pricedAtUnix },
    byAsset: [],
    largestCreditUsd: 0,
    subsetUsd: 0,
  }
}

export async function measureBlock(
  coin: PilotCoin,
  block: BlockAssignment,
  nextBlockArm: Arm | null,
  sources: PilotSources,
  options: CollectOptions = {},
): Promise<BlockOutcome> {
  const windowSeconds = block.endUnixExclusive - block.startUnix
  const from = block.endUnixExclusive
  const to = from + windowSeconds
  const antiSnipeWindow = options.antiSnipeWindowSeconds ?? ANTI_SNIPE_WINDOW_SECONDS

  const credits = await sources.fees.creditsForToken(coin.token, from, to)

  // A credit is anti-snipe when the classifying source says so, or when it
  // landed inside the padded window after launch. Both are checked, because a
  // source that can see the trade knows better than a boundary can - and a
  // source that cannot see the trade still must not miss the windfall.
  const isAntiSnipe = (credit: FeeCredit): boolean =>
    credit.classification === 'anti_snipe_window' ||
    (credit.classification === undefined &&
      credit.occurredAtUnix - coin.launchedAtUnix <= antiSnipeWindow)

  let valued: ValuedCredits
  let valuationComplete = true
  try {
    valued = await valueCredits(credits, sources.assets, sources.prices, from, {
      subset: isAntiSnipe,
    })
  } catch (error: unknown) {
    if (options.haltOnUnvaluedWindow === true || !(error instanceof MeasurementError)) throw error
    valuationComplete = false
    valued = unmeasuredValuation(from, error.message)
  }

  const uniqueNewBuyers = await sources.buyers.uniqueNewBuyers(coin.token, from, to)
  const membership = coin.telegramChatRef
    ? await sources.membership.delta(coin.telegramChatRef, from, to)
    : { joins: 0, leaves: 0, membersEnd: 0 }
  const unansweredBacklog = backlogFromDigests(
    await sources.digests.digestsInWindow(coin.coinRef, from, to),
  )
  const deliveredAsAssigned = await sources.delivery.deliveredAsAssigned(
    coin.coinRef,
    block.blockIndex,
  )

  if (valuationComplete && valued.usd.usd < 0) {
    throw new MeasurementError('negative fee total; refusing to log1p a negative')
  }

  const integrity: BlockIntegrity = {
    secondsSinceLaunch: from - coin.launchedAtUnix,
    antiSnipeUsd: valued.subsetUsd,
    feeMechanism: resolveFeeMechanism(credits, coin, from),
    valuationComplete,
    largestCreditShare:
      valuationComplete && valued.usd.usd > 0 ? valued.largestCreditUsd / valued.usd.usd : 0,
    deliveredAsAssigned,
  }
  if (coin.graduatedAtUnix !== undefined) {
    integrity.graduationAgeSeconds = from - coin.graduatedAtUnix
  }
  if (coin.recipientChangedAtUnix !== undefined) {
    integrity.recipientChangedAtUnix = coin.recipientChangedAtUnix
  }

  return {
    coinRef: coin.coinRef,
    blockIndex: block.blockIndex,
    arm: block.arm,
    phase: block.phase,
    hourOfDay: block.hourOfDay,
    dayOfWeek: block.dayOfWeek,
    followWindowStartUnix: from,
    followWindowEndUnixExclusive: to,
    primaryLog1pFeesUsd: valuationComplete ? Math.log1p(valued.usd.usd) : Number.NaN,
    feesUsd: valued.usd,
    feesMinorByAsset: valued.byAsset,
    uniqueNewBuyers,
    membership,
    unansweredBacklog,
    nextBlockArm,
    integrity,
  }
}

/**
 * Per-coin fee attribution.
 *
 * THE PROBLEM. Post-graduation, every client of ours shares one depositor in the
 * Venue V2 fee escrow, credits commingle by (recipient, quoteAsset), and no escrow
 * event carries a coin identifier. Reading escrow events therefore tells us how
 * much money arrived and nothing about whose it is. Splitting a shared balance by
 * guesswork would mean paying one dev out of another dev's fees.
 *
 * THE SWITCH.
 *   pre-graduation  - CurveBuy / CurveSell, emitted by the PER-LAUNCH curve
 *                     contract. The emitting address is the coin, so attribution
 *                     is exact and free. The parameter names are pinned from live
 *                     chain evidence (abi.ts CURVE_BUY, tools/artifacts/CURVE-SHAPE.md);
 *                     any other shape REFUSES rather than guess which word is the fee.
 *   post-graduation - PoolFeesSwept(poolId, ...) from the shared hook, mapped
 *                     back to a token through the PoolRegistered binding. The
 *                     poolId is the only per-coin key that survives graduation.
 *
 * Escrow credits and ERC-20 transfers are deliberately NOT sources of income
 * here. They are the same money moving again, and recognising them a second time
 * is the silent triple-count the ledger contract exists to prevent.
 */

import type { Address, PoolId } from '@fee-split-vaults/core'
import {
  CURVE_BUY,
  CURVE_SELL,
  POOL_FEES_SWEPT,
  POOL_REGISTERED,
  TOKEN_LAUNCHED,
  curveTradeShapePinned,
  decodeEventLog,
  requireAddress,
  requireBigInt,
  requireHash32,
} from './abi.js'
import { CurveShapeUnpinnedError, DecodeError } from './errors.js'
import { addressEquals, normalizeAddress, normalizeHash32, type Hex } from './hex.js'
import type { CoinBinding, FeePosting, IssuedVault, LaunchFacts } from './model.js'
import { creatorNetBps, VENUE } from './protocol.js'
import type { BlockRef, RpcLog } from './rpc.js'

/**
 * The anti-snipe tax is 99% at t=0 and decays over roughly three seconds. Block
 * timestamps have second granularity and the launch timestamp itself comes from
 * a block, so the window is padded rather than cut fine. Anything inside it is
 * classified as a windfall, not as trade flow.
 */
export const ANTI_SNIPE_WINDOW_SECONDS = 5

/** Effective fee rate above this multiple of the hook fee reads as anti-snipe. */
const ANTI_SNIPE_RATE_MULTIPLE = 2n

const RATE_SCALE = 1_000_000n

/**
 * The creator's share of an observed protocol fee.
 *
 * The rate BRANCHES on the token's own buyback setting and is never a literal:
 * buyback off is 0.70% of volume, buyback on is 0.35%, and the creator tax adds
 * its own slice of the same hook fee. All of that lives in creatorNetBps().
 *
 * Division floors, so the credit is always at or below the true share. Under-
 * crediting shows up as a reconciliation variance; over-crediting would hand a
 * client budget authority over money that was never theirs.
 */
export function creatorShareOfFee(
  feeMinor: bigint,
  buybackEnabled: boolean,
  creatorTaxBps: number,
): bigint {
  if (feeMinor < 0n) throw new DecodeError(`negative fee: ${feeMinor}`)
  const netBps = creatorNetBps(buybackEnabled, creatorTaxBps)
  if (!Number.isFinite(netBps) || netBps <= 0) {
    throw new DecodeError(`creatorNetBps resolved to ${netBps}; refusing to attribute`)
  }
  const numerator = BigInt(Math.round(netBps * Number(RATE_SCALE)))
  const denominator = BigInt(VENUE.hookFeeBps) * RATE_SCALE
  return (feeMinor * numerator) / denominator
}

export interface ClassifyInput {
  readonly feeMinor: bigint
  readonly volumeMinor: bigint
  readonly occurredAtUnix: number
  readonly launchedAtUnix: number
  readonly windowSeconds?: number
}

export function classifyFee(input: ClassifyInput): 'trade' | 'anti_snipe_window' {
  const window = input.windowSeconds ?? ANTI_SNIPE_WINDOW_SECONDS
  if (input.occurredAtUnix - input.launchedAtUnix <= window) return 'anti_snipe_window'
  if (input.volumeMinor > 0n) {
    const effectiveBps = (input.feeMinor * 10_000n) / input.volumeMinor
    if (effectiveBps > BigInt(VENUE.hookFeeBps) * ANTI_SNIPE_RATE_MULTIPLE) return 'anti_snipe_window'
  }
  return 'trade'
}

export function postingId(log: RpcLog): string {
  return `${normalizeHash32(log.transactionHash)}:${log.logIndex}`
}

export interface AttributionOptions {
  readonly antiSnipeWindowSeconds?: number
}

/**
 * Pre-graduation credit from one curve trade. Reads the NAMED fields
 * trader/amountIn/amountOut/fee/creatorTax and refuses any shape that lacks one:
 * a wrong mapping here changes a money figure without ever breaking a decode,
 * which is the one failure this plane must not have.
 *
 * Volume is the gross quote leg on both sides: amountIn on a buy, and on a sell
 * amountOut + fee + creatorTax, since amountOut is what the trader received NET
 * of both. The fee is 1.00% of that gross on every observed ordinary trade,
 * which is what classifyFee's rate test assumes.
 */
export function attributeCurveLog(
  log: RpcLog,
  binding: CoinBinding,
  block: BlockRef,
  options: AttributionOptions = {},
): FeePosting {
  const topic0 = log.topics[0]
  const isBuy = topic0 !== undefined && normalizeHash32(topic0) === CURVE_BUY.topic0
  const shape = isBuy ? CURVE_BUY : CURVE_SELL
  if (!curveTradeShapePinned(shape)) throw new CurveShapeUnpinnedError(shape.name)
  const decoded = decodeEventLog(shape, log)

  const feeMinor = requireBigInt(decoded, 'fee')
  const amountIn = requireBigInt(decoded, 'amountIn')
  const amountOut = requireBigInt(decoded, 'amountOut')
  const creatorTax = requireBigInt(decoded, 'creatorTax')
  const volumeMinor = isBuy ? amountIn : amountOut + feeMinor + creatorTax
  const counterparty = requireAddress(decoded, 'trader')

  const classification = classifyFee({
    feeMinor,
    volumeMinor,
    occurredAtUnix: block.timestampUnix,
    launchedAtUnix: binding.launchedAtUnix,
    windowSeconds: options.antiSnipeWindowSeconds,
  })

  return {
    id: postingId(log),
    vault: binding.vault,
    token: binding.token,
    asset: binding.quoteAsset,
    creditedMinor: creatorShareOfFee(feeMinor, binding.buybackEnabled, binding.creatorTaxBps),
    grossFeeMinor: feeMinor,
    derivation: 'creator_share_of_fee',
    volumeMinor,
    source: 'curve_event',
    phase: 'pre_graduation',
    classification,
    side: isBuy ? 'buy' : 'sell',
    counterparty,
    blockNumber: log.blockNumber,
    blockHash: normalizeHash32(log.blockHash),
    txHash: normalizeHash32(log.transactionHash),
    logIndex: log.logIndex,
    occurredAtUnix: block.timestampUnix,
    finalized: false,
  }
}

/**
 * Post-graduation the hook reports the creator leg explicitly, so no rate is
 * applied and no branch on buyback is needed: the chain already did the split.
 * The event names no asset; the binding's quote asset (TokenLaunched.pairToken)
 * is the one every leg is denominated in.
 */
export function attributeSweptLog(log: RpcLog, binding: CoinBinding, block: BlockRef): FeePosting {
  const decoded = decodeEventLog(POOL_FEES_SWEPT, log)
  const protocolAmount = requireBigInt(decoded, 'protocolAmount')
  const buybackAmount = requireBigInt(decoded, 'buybackAmount')
  const creatorAmount = requireBigInt(decoded, 'creatorAmount')
  const tokensLocked = requireBigInt(decoded, 'tokensLocked')

  return {
    id: postingId(log),
    vault: binding.vault,
    token: binding.token,
    asset: binding.quoteAsset,
    creditedMinor: creatorAmount,
    grossFeeMinor: protocolAmount + buybackAmount + creatorAmount,
    derivation: 'explicit',
    volumeMinor: 0n,
    source: 'pool_fees_swept',
    phase: 'post_graduation',
    classification: 'trade',
    side: 'sweep',
    buybackAmountMinor: buybackAmount,
    tokensLocked,
    blockNumber: log.blockNumber,
    blockHash: normalizeHash32(log.blockHash),
    txHash: normalizeHash32(log.transactionHash),
    logIndex: log.logIndex,
    occurredAtUnix: block.timestampUnix,
    finalized: false,
  }
}

export interface LaunchBindingFields extends LaunchFacts {
  readonly token: Address
  readonly deployer: Address
  readonly launchConfigId: bigint
  readonly graduationThreshold: bigint
}

export function decodeLaunch(log: RpcLog, block: BlockRef): LaunchBindingFields {
  const decoded = decodeEventLog(TOKEN_LAUNCHED, log)
  return {
    token: requireAddress(decoded, 'token'),
    deployer: requireAddress(decoded, 'deployer'),
    curve: requireAddress(decoded, 'curve'),
    quoteAsset: requireAddress(decoded, 'pairToken'),
    launchConfigId: requireBigInt(decoded, 'launchConfigId'),
    graduationThreshold: requireBigInt(decoded, 'graduationThreshold'),
    launchedAtUnix: block.timestampUnix,
    launchBlockNumber: log.blockNumber,
  }
}

export interface PoolRegistration {
  readonly poolId: PoolId
  readonly memecoin: Address
  readonly quoteToken: Address
  readonly creator: Address
}

export function decodePoolRegistration(log: RpcLog): PoolRegistration {
  const decoded = decodeEventLog(POOL_REGISTERED, log)
  return {
    poolId: requireHash32(decoded, 'poolId'),
    memecoin: requireAddress(decoded, 'memecoin'),
    quoteToken: requireAddress(decoded, 'quoteToken'),
    creator: requireAddress(decoded, 'creator'),
  }
}

/**
 * The join that turns a candidate pool id into an attribution key. The
 * registration was fetched under OUR candidate id; if the hook says that pool
 * belongs to a different memecoin, our PoolKey derivation is wrong and every
 * sweep under it would be someone else's money. That is a refusal, not a skip.
 */
export function confirmPoolRegistration(binding: CoinBinding, registration: PoolRegistration): CoinBinding {
  if (!addressEquals(registration.memecoin, binding.token)) {
    throw new DecodeError(
      `PoolRegistered ${registration.poolId} names memecoin ${registration.memecoin}, ` +
        `not ${binding.token}; the derived pool id is wrong and must not attribute`,
    )
  }
  if (binding.candidatePoolId === undefined || normalizeHash32(binding.candidatePoolId) !== normalizeHash32(registration.poolId)) {
    throw new DecodeError(
      `PoolRegistered ${registration.poolId} for ${binding.token} does not match its ` +
        `candidate ${String(binding.candidatePoolId)}`,
    )
  }
  if (!addressEquals(registration.quoteToken, binding.quoteAsset)) {
    throw new DecodeError(
      `PoolRegistered ${registration.poolId} quotes in ${registration.quoteToken}, ` +
        `binding expects ${binding.quoteAsset}`,
    )
  }
  return { ...binding, poolId: normalizeHash32(registration.poolId) }
}

/**
 * Join what consent issuance knew to what the chain reported at launch. Until
 * this join exists, a coin's fees have no attribution key at all.
 */
export function bindingFromLaunch(issued: IssuedVault, launch: LaunchFacts): CoinBinding {
  return {
    token: issued.token,
    vault: issued.vault,
    curve: launch.curve,
    ...(launch.poolId === undefined ? {} : { poolId: normalizeHash32(launch.poolId) }),
    quoteAsset: launch.quoteAsset,
    launchedAtUnix: launch.launchedAtUnix,
    launchBlockNumber: launch.launchBlockNumber,
    buybackEnabled: issued.buybackEnabled,
    creatorTaxBps: issued.creatorTaxBps,
    coverageStartUnix: issued.coverageStartUnix,
  }
}

export interface FeeAttributionContext {
  bindingByCurve(curve: Address): Promise<CoinBinding | undefined>
  bindingByPoolId(poolId: string): Promise<CoinBinding | undefined>
  blockFor(blockHash: Hex): BlockRef | undefined
  readonly options?: AttributionOptions
}

export interface FeeAttributionResult {
  readonly postings: readonly FeePosting[]
  /** First PoolFeesSwept for a coin is the observable moment of graduation. */
  readonly graduations: ReadonlyArray<{ token: Address; atUnix: number; blockNumber: bigint }>
  readonly warnings: readonly string[]
}

/**
 * Turn fee logs into postings, choosing the attribution key by event type.
 *
 * A log we cannot attribute is an ERROR, not a skip. Our queries are filtered to
 * our own curve addresses and our own pool ids, so an unattributable log means
 * the node returned something we did not ask for - and silently dropping a fee
 * event is exactly the failure that loses a client's money without a trace.
 */
export async function attributeFeeLogs(
  logs: readonly RpcLog[],
  context: FeeAttributionContext,
): Promise<FeeAttributionResult> {
  const postings: FeePosting[] = []
  const graduations: Array<{ token: Address; atUnix: number; blockNumber: bigint }> = []
  const warnings: string[] = []

  for (const log of logs) {
    if (log.removed) {
      warnings.push(`log ${postingId(log)} arrived flagged removed and was not posted`)
      continue
    }

    const topic0 = log.topics[0]
    if (topic0 === undefined) throw new DecodeError(`log ${postingId(log)} has no topics`)
    const topic = normalizeHash32(topic0)

    const block = context.blockFor(normalizeHash32(log.blockHash))
    if (block === undefined) {
      throw new DecodeError(`no hydrated block for ${log.blockHash}; refusing to invent a timestamp`)
    }

    if (topic === CURVE_BUY.topic0 || topic === CURVE_SELL.topic0) {
      const binding = await context.bindingByCurve(normalizeAddress(log.address))
      if (!binding) {
        throw new DecodeError(`curve ${log.address} is not in the watch set; refusing to drop a fee event`)
      }
      if (binding.graduatedAtUnix !== undefined && block.timestampUnix > binding.graduatedAtUnix) {
        warnings.push(
          `curve event for ${binding.token} at ${block.timestampUnix} is after recorded graduation`,
        )
      }
      postings.push(attributeCurveLog(log, binding, block, context.options ?? {}))
      continue
    }

    if (topic === POOL_FEES_SWEPT.topic0) {
      const poolId = requireHash32(decodeEventLog(POOL_FEES_SWEPT, log), 'poolId')
      const binding = await context.bindingByPoolId(poolId)
      if (!binding) {
        throw new DecodeError(`poolId ${poolId} is not in the watch set; refusing to drop a fee event`)
      }
      if (binding.graduatedAtUnix === undefined) {
        graduations.push({
          token: binding.token,
          atUnix: block.timestampUnix,
          blockNumber: log.blockNumber,
        })
      }
      postings.push(attributeSweptLog(log, binding, block))
      continue
    }

    throw new DecodeError(`log ${postingId(log)} has unexpected topic0 ${topic} in a fee query`)
  }

  return { postings, graduations, warnings }
}

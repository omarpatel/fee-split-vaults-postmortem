/**
 * Test fixtures. Not a spec file: the vitest include pattern only picks up
 * *.spec.ts, so this compiles as a plain module.
 */

import type { Asset } from '@fee-split-vaults/core'
import {
  CREATOR_FEE_RECIPIENT_CHANGE_CANCELLED,
  CREATOR_FEE_RECIPIENT_CHANGE_PROPOSED,
  CREATOR_FEE_RECIPIENT_UPDATED,
  CURVE_BUY,
  CURVE_SELL,
  GET_LAUNCHED_TOKEN_SELECTOR,
  POOL_FEES_SWEPT,
  POOL_REGISTERED,
  TOKEN_LAUNCHED,
  derivePoolId,
  encodeAddressArgCall,
  type LaunchedToken,
} from '../abi.js'
import type { FakeLogInput } from '../fake-rpc.js'
import { FakeChain } from '../fake-rpc.js'
import { addressToTopic, type Hex } from '../hex.js'
import type { CoinBinding, FeePosting, IssuedVault } from '../model.js'
import type { PinnedPrice } from '../prices.js'
import { VENUE } from '../protocol.js'

export const FACTORY = VENUE.contracts.v2Factory
export const HOOK = VENUE.contracts.v2MemeHook

export const USDG: Asset = {
  address: '0x00000000000000000000000000000000000000a1',
  symbol: 'USDG',
  decimals: 18,
  isPausableProxy: true,
  enabled: true,
}

export const ASSETS = new Map<string, Asset>([[USDG.address.toLowerCase(), USDG]])

export function assetsWith(overrides: Partial<Asset>): Map<string, Asset> {
  const asset = { ...USDG, ...overrides }
  return new Map([[asset.address.toLowerCase(), asset]])
}

export const PRICE_ONE_DOLLAR: PinnedPrice = {
  asset: USDG.address,
  usdPerWholeUnit: 1,
  source: 'test-pin',
  pricedAtUnix: 0,
}

/**
 * A price pinned at the start of each UTC day, which is the shape a real oracle
 * takes: prices that were decided and recorded daily, not fetched at gate time.
 */
export function dailyDollarPins(fromDay: number, toDay: number): PinnedPrice[] {
  const pins: PinnedPrice[] = []
  for (let day = fromDay; day <= toDay; day++) {
    pins.push({ ...PRICE_ONE_DOLLAR, pricedAtUnix: day * 86_400 })
  }
  return pins
}

export function addr(seed: number): string {
  return `0x${seed.toString(16).padStart(40, '0')}`
}

export function hash32(seed: number): Hex {
  return `0x${seed.toString(16).padStart(64, '0')}` as Hex
}

function word(value: bigint | string): string {
  if (typeof value === 'bigint') return value.toString(16).padStart(64, '0')
  return value.toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

export function encodeData(...values: Array<bigint | string>): Hex {
  return `0x${values.map(word).join('')}` as Hex
}

/** A curve trade in the pinned shape (abi.ts CURVE_BUY). sender defaults to the trader. */
export interface CurveTradeInput {
  readonly curve: string
  readonly trader: string
  readonly sender?: string
  readonly amountIn: bigint
  readonly amountOut: bigint
  readonly fee: bigint
  readonly creatorTax?: bigint
  readonly side?: 'buy' | 'sell'
  readonly transactionHash?: Hex
}

export function curveTradeLog(input: CurveTradeInput): FakeLogInput {
  const isBuy = (input.side ?? 'buy') === 'buy'
  return {
    address: input.curve,
    topics: [
      isBuy ? CURVE_BUY.topic0 : CURVE_SELL.topic0,
      addressToTopic(input.sender ?? input.trader),
      addressToTopic(input.trader),
    ],
    data: encodeData(input.amountIn, input.amountOut, input.fee, input.creatorTax ?? 0n),
    transactionHash: input.transactionHash,
  }
}

export function poolFeesSweptLog(input: {
  readonly poolId: Hex
  readonly protocolAmount: bigint
  readonly buybackAmount?: bigint
  readonly creatorAmount: bigint
  readonly tokensLocked?: bigint
  readonly hook?: string
}): FakeLogInput {
  return {
    address: input.hook ?? HOOK,
    topics: [POOL_FEES_SWEPT.topic0, input.poolId],
    data: encodeData(
      input.protocolAmount,
      input.buybackAmount ?? 0n,
      input.creatorAmount,
      input.tokensLocked ?? 0n,
    ),
  }
}

export function poolRegisteredLog(input: {
  readonly poolId: Hex
  readonly memecoin: string
  readonly quoteToken?: string
  readonly creator?: string
  readonly hook?: string
}): FakeLogInput {
  return {
    address: input.hook ?? HOOK,
    topics: [POOL_REGISTERED.topic0, input.poolId],
    data: encodeData(input.memecoin, input.quoteToken ?? USDG.address, input.creator ?? addr(1)),
  }
}

export function tokenLaunchedLog(input: {
  readonly token: string
  readonly curve: string
  readonly deployer?: string
  readonly pairToken?: string
  readonly launchConfigId?: bigint
  readonly graduationThreshold?: bigint
}): FakeLogInput {
  return {
    address: FACTORY,
    topics: [
      TOKEN_LAUNCHED.topic0,
      addressToTopic(input.token),
      addressToTopic(input.curve),
      addressToTopic(input.deployer ?? addr(1)),
    ],
    data: encodeData(
      input.pairToken ?? USDG.address,
      input.launchConfigId ?? 1n,
      input.graduationThreshold ?? usdg(10_000),
    ),
  }
}

export function recipientProposedLog(input: {
  readonly token: string
  readonly currentRecipient: string
  readonly proposedRecipient: string
  readonly effectiveAtUnix: number
  readonly expiresAtUnix: number
}): FakeLogInput {
  return {
    address: FACTORY,
    topics: [
      CREATOR_FEE_RECIPIENT_CHANGE_PROPOSED.topic0,
      addressToTopic(input.token),
      addressToTopic(input.currentRecipient),
      addressToTopic(input.proposedRecipient),
    ],
    data: encodeData(BigInt(input.effectiveAtUnix), BigInt(input.expiresAtUnix)),
  }
}

export function recipientCancelledLog(input: {
  readonly token: string
  readonly proposedRecipient: string
}): FakeLogInput {
  return {
    address: FACTORY,
    topics: [
      CREATOR_FEE_RECIPIENT_CHANGE_CANCELLED.topic0,
      addressToTopic(input.token),
      addressToTopic(input.proposedRecipient),
    ],
    data: '0x',
  }
}

export function recipientUpdatedLog(input: {
  readonly token: string
  readonly previousRecipient: string
  readonly newRecipient: string
}): FakeLogInput {
  return {
    address: FACTORY,
    topics: [
      CREATOR_FEE_RECIPIENT_UPDATED.topic0,
      addressToTopic(input.token),
      addressToTopic(input.previousRecipient),
      addressToTopic(input.newRecipient),
    ],
    data: '0x',
  }
}

/** The pool key every launched fixture uses unless it says otherwise. */
export const POOL_FEE = 10_000
export const TICK_SPACING = 200

export interface LaunchedTokenInput extends Partial<LaunchedToken> {
  readonly token: string
  readonly curve: string
  readonly creatorFeeRecipient: string
}

export function launchedToken(input: LaunchedTokenInput): LaunchedToken {
  return {
    deployer: addr(1),
    pairToken: USDG.address,
    graduationThreshold: usdg(10_000),
    poolFee: POOL_FEE,
    tickSpacing: TICK_SPACING,
    creatorTaxBps: 0,
    buybackEnabled: false,
    phase: 0,
    sweptQuote: 0n,
    sweptTokens: 0n,
    sweptAt: 0n,
    exists: true,
    ...input,
  }
}

export function encodeLaunchedToken(launched: LaunchedToken): Hex {
  const tick = launched.tickSpacing < 0 ? (1n << 256n) + BigInt(launched.tickSpacing) : BigInt(launched.tickSpacing)
  return encodeData(
    launched.token,
    launched.curve,
    launched.deployer,
    launched.creatorFeeRecipient,
    launched.pairToken,
    launched.graduationThreshold,
    BigInt(launched.poolFee),
    tick,
    BigInt(launched.creatorTaxBps),
    launched.buybackEnabled ? 1n : 0n,
    BigInt(launched.phase),
    launched.sweptQuote,
    launched.sweptTokens,
    launched.sweptAt,
    launched.exists ? 1n : 0n,
  )
}

/** Teach the fake chain what factory.getLaunchedToken(token) returns, at every block. */
export function pinLaunchedToken(chain: FakeChain, input: LaunchedTokenInput): LaunchedToken {
  const launched = launchedToken(input)
  chain.setCallResultAnyBlock(
    FACTORY,
    encodeAddressArgCall(GET_LAUNCHED_TOKEN_SELECTOR, launched.token),
    encodeLaunchedToken(launched),
  )
  return launched
}

/** The pool id the indexer will derive for a fixture launched with the defaults. */
export function poolIdFor(token: string, pairToken: string = USDG.address): Hex {
  return derivePoolId({ token, pairToken, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: HOOK })
}

/**
 * Launch a coin in one step: pins getLaunchedToken to agree with the log it
 * returns, so the indexer's bind-time verification passes. Add the returned log
 * to a block.
 */
export function launchCoin(
  chain: FakeChain,
  input: { token: string; curve: string; recipient: string } & Partial<LaunchedToken>,
): FakeLogInput {
  const { recipient, ...rest } = input
  const launched = pinLaunchedToken(chain, { ...rest, creatorFeeRecipient: recipient })
  return tokenLaunchedLog({ token: launched.token, curve: launched.curve, pairToken: launched.pairToken })
}

export function issuedVault(overrides: Partial<IssuedVault> = {}): IssuedVault {
  return {
    token: addr(0x100),
    vault: addr(0x200),
    buybackEnabled: false,
    creatorTaxBps: 0,
    coverageStartUnix: 0,
    spendAuthorityActive: true,
    ...overrides,
  }
}

export function binding(overrides: Partial<CoinBinding> = {}): CoinBinding {
  return {
    token: addr(0x100),
    vault: addr(0x200),
    curve: addr(0x300),
    poolId: hash32(0x400),
    candidatePoolId: hash32(0x400),
    quoteAsset: USDG.address,
    launchedAtUnix: 0,
    launchBlockNumber: 1n,
    buybackEnabled: false,
    creatorTaxBps: 0,
    coverageStartUnix: 0,
    ...overrides,
  }
}

let postingSequence = 0

export function posting(overrides: Partial<FeePosting> = {}): FeePosting {
  postingSequence++
  return {
    id: `0x${postingSequence.toString(16).padStart(64, '0')}:0`,
    vault: addr(0x200),
    token: addr(0x100),
    asset: USDG.address,
    creditedMinor: 0n,
    grossFeeMinor: 0n,
    derivation: 'creator_share_of_fee',
    volumeMinor: 0n,
    source: 'curve_event',
    phase: 'pre_graduation',
    classification: 'trade',
    side: 'buy',
    blockNumber: 1n,
    blockHash: hash32(1),
    txHash: hash32(postingSequence),
    logIndex: 0,
    occurredAtUnix: 0,
    finalized: true,
    ...overrides,
  }
}

export const DAY = 86_400

/** Whole USDG units as minor units. */
export function usdg(whole: number): bigint {
  return BigInt(whole) * 10n ** 18n
}

export function newChain(): FakeChain {
  // Ten minutes a block: far enough apart that ordinary trades fall outside
  // the anti-snipe window, which is measured in seconds.
  const chain = new FakeChain({ genesisUnix: 0, blockSeconds: 600 })
  chain.addBlock()
  return chain
}

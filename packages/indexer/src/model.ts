/**
 * What the ingestion plane produces.
 *
 * A FeePosting is one observed accrual of creator fees to one coin. Its id is a
 * pure function of chain position (tx hash + log index), so re-scanning a range
 * after a restart or a reorg re-derives identical ids and replay is idempotent.
 * That property is what lets the poller be careless about overlap and careful
 * about correctness.
 */

import type { Address, AssetAddress, LedgerEntry, PoolId, TxHash } from '@fee-split-vaults/core'
import type { Hex } from './hex.js'

/**
 * A coin we are entitled to index: one issued consent, one vault, one token.
 *
 * The curve address and the pool id are the two per-coin attribution keys, and
 * which one applies depends on graduation. The curve comes from TokenLaunched.
 * The pool id does NOT: TokenLaunched carries none, and the hook registers the
 * pool only at graduation. Until the hook's PoolRegistered names this token as
 * memecoin under a pool id we derived from getLaunchedToken(), the coin has no
 * post-graduation key and its sweeps are not attributed - escrow credits
 * commingle by (recipient, quoteAsset) and carry no coin identifier at all.
 */
export interface CoinBinding {
  readonly token: Address
  readonly vault: Address
  /** Per-launch curve contract. Pre-graduation, its logs ARE the attribution. */
  readonly curve: Address
  /** Post-graduation key, set only once PoolRegistered confirmed memecoin == token. */
  readonly poolId?: PoolId
  /** PoolKey-derived id from getLaunchedToken(); allowlists the PoolRegistered scan. */
  readonly candidatePoolId?: PoolId
  /** TokenLaunched.pairToken. PoolFeesSwept carries no asset; this is the one applied. */
  readonly quoteAsset: AssetAddress
  readonly launchedAtUnix: number
  readonly launchBlockNumber: bigint
  /** Per-token setting read from getLaunchedToken(). Halves the creator rate when true. */
  readonly buybackEnabled: boolean
  /** Per-token, immutable, 0..1000. Read from getLaunchedToken(). */
  readonly creatorTaxBps: number
  /** When we began observing. Days before this are unknown, not zero. */
  readonly coverageStartUnix: number
  readonly graduatedAtUnix?: number
}

/**
 * What consent issuance knows before the chain is consulted.
 *
 * THIS IS THE BOUND ON THE WATCH SET. Venue launches are permissionless and run
 * at roughly 25,000 a day; we index the coins we issued a consent for and
 * nothing else. Everything the poller watches is derived from this list, so the
 * cost of the whole ingestion plane scales with our customer count rather than
 * with the chain.
 *
 * curve and poolId are absent here on purpose: the curve is learned from
 * TokenLaunched, the poolId from the hook's PoolRegistered at graduation, and
 * until each is learned the corresponding fees are unattributable and must not
 * be guessed at. buybackEnabled and creatorTaxBps are what the consent CLAIMS;
 * the binding carries what getLaunchedToken() REPORTS, and a difference is
 * surfaced as a warning with the chain applied.
 */
export interface IssuedVault {
  readonly token: Address
  readonly vault: Address
  readonly buybackEnabled: boolean
  readonly creatorTaxBps: number
  /** When we began observing. Earlier days are unknown, never zero. */
  readonly coverageStartUnix: number
  /** True while this vault can authorise spending. Forces the watch cadence floor. */
  readonly spendAuthorityActive: boolean
  /**
   * Launch facts supplied at onboarding, for the RETROFIT path: a coin that
   * launched long before our start block, whose TokenLaunched we will therefore
   * never see in a scan. Without this the coin has no attribution key and its
   * fees are silently invisible.
   */
  readonly launch?: LaunchFacts
}

/** What TokenLaunched tells us, and what a retrofit onboarding must supply. */
export interface LaunchFacts {
  readonly curve: Address
  /** Operator-supplied for a retrofit coin that already graduated; otherwise learned. */
  readonly poolId?: PoolId
  readonly quoteAsset: AssetAddress
  readonly launchedAtUnix: number
  readonly launchBlockNumber: bigint
}

/**
 * The minimum a watcher needs: which coin, and which vault we expect to be paid.
 * Deliberately narrower than CoinBinding so a coin whose TokenLaunched we have
 * not yet resolved is still watched - an unresolved binding must not become an
 * unwatched recipient.
 */
export interface WatchTarget {
  readonly token: Address
  readonly vault: Address
}

export type FeePhase = 'pre_graduation' | 'post_graduation'

/**
 * The anti-snipe tax is 99% at t=0 decaying over roughly three seconds, and it
 * reaches the fee recipient along the ordinary rails. It is real money and it is
 * posted, but it is not sustainable flow: counting it toward a 7-day median
 * would let any launch clear a tier on its first block.
 */
export type FeeClassification = 'trade' | 'anti_snipe_window'

/** Constrained to the two sources the ledger recognises for fee accrual. */
export type FeeSource = Extract<LedgerEntry['source'], 'curve_event' | 'pool_fees_swept'>

export interface FeePosting {
  /** `${txHash}:${logIndex}`. Deterministic, hence replay-safe. */
  readonly id: string
  readonly vault: Address
  readonly token: Address
  readonly asset: AssetAddress
  /** The creator's share in minor units. Floor-rounded: never over-credits. */
  readonly creditedMinor: bigint
  /** Total fee observed on the trade or sweep, before any split. */
  readonly grossFeeMinor: bigint
  /** 'explicit' means the chain reported the creator leg; no ratio was applied. */
  readonly derivation: 'explicit' | 'creator_share_of_fee'
  /** Quote-side trade volume. Zero for aggregated sweeps, which carry no trade. */
  readonly volumeMinor: bigint
  readonly source: FeeSource
  readonly phase: FeePhase
  readonly classification: FeeClassification
  readonly side: 'buy' | 'sell' | 'sweep'
  /** Trader address, when the event carries one. Breadth signal only. */
  readonly counterparty?: Address
  /** Sweeps only: the buyback leg the hook took, in quote minor units. */
  readonly buybackAmountMinor?: bigint
  /** Sweeps only: memecoin units the hook locked, raw token units. */
  readonly tokensLocked?: bigint
  readonly blockNumber: bigint
  readonly blockHash: Hex
  readonly txHash: TxHash
  readonly logIndex: number
  readonly occurredAtUnix: number
  /** Only finalized postings may back budget authority. */
  readonly finalized: boolean
}

/** One trade, for breadth and wash metrics. Derived from curve or pool events. */
export interface TradeObservation {
  readonly token: Address
  readonly trader: Address
  readonly side: 'buy' | 'sell'
  readonly asset: AssetAddress
  readonly quoteVolumeMinor: bigint
  readonly occurredAtUnix: number
  readonly blockHash: Hex
  readonly finalized: boolean
}

export function tradesFromPostings(postings: readonly FeePosting[]): TradeObservation[] {
  const trades: TradeObservation[] = []
  for (const posting of postings) {
    if (posting.side === 'sweep' || posting.counterparty === undefined) continue
    trades.push({
      token: posting.token,
      trader: posting.counterparty,
      side: posting.side,
      asset: posting.asset,
      quoteVolumeMinor: posting.volumeMinor,
      occurredAtUnix: posting.occurredAtUnix,
      blockHash: posting.blockHash,
      finalized: posting.finalized,
    })
  }
  return trades
}

/**
 * The accrual entry for a posting.
 *
 * Income is recognised EXACTLY ONCE, here, at accrual, from the declared
 * precedence source for the coin's phase. Every later movement of the same money
 * - the escrow credit, the sweep, the claim, the split, the budget pull - is a
 * transfer between asset accounts and must never be recognised as income again.
 * Triple-counting one fee that appears as a curve event, an escrow credit and an
 * ERC-20 transfer is the most likely silent-money bug in this system.
 */
export function toAccrualLedgerEntry(posting: FeePosting): LedgerEntry {
  return {
    id: `accrual:${posting.id}`,
    vault: posting.vault,
    asset: posting.asset,
    debit: 'asset:escrow',
    credit: 'income:fees',
    amountMinor: posting.creditedMinor,
    occurredAtUnix: posting.occurredAtUnix,
    blockHash: posting.blockHash,
    txHash: posting.txHash,
    logIndex: posting.logIndex,
    source: posting.source,
    memo: `${posting.phase}/${posting.classification}`,
  }
}

/**
 * Pending owner override of a coin's fee recipient. Executable from
 * effectiveAtUnix, lapses at expiresAtUnix, cancellable before either.
 */
export interface PendingOverride {
  readonly token: Address
  readonly currentRecipient: Address
  readonly newRecipient: Address
  readonly effectiveAtUnix: number
  readonly expiresAtUnix: number
  readonly proposedAtUnix: number
  readonly txHash: TxHash
  readonly blockHash: Hex
  readonly blockNumber: bigint
}

/** Last confirmed answer to "who does the protocol pay for this coin?" */
export interface RecipientObservation {
  readonly token: Address
  readonly recipient: Address
  readonly expected: Address
  readonly matches: boolean
  readonly blockHash: Hex
  readonly blockNumber: bigint
  readonly observedAtUnix: number
}

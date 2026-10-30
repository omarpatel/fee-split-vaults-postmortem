/**
 * Shared domain types. This file is the contract between every package.
 *
 * Money rule, enforced everywhere: amounts are BIGINT MINOR UNITS of a named
 * asset, never floating point. USD figures used for tier gating and reporting
 * are derived at a pinned price and always carry the price source with them.
 */

import type { TierId } from '../../../config/protocol.js'

// ---------------------------------------------------------------------------
// Assets and money
// ---------------------------------------------------------------------------

/** A quote asset address on chain 4663. Fees are charged in these on V2. */
export type AssetAddress = string
export type Address = string
export type TxHash = string
export type PoolId = string

export interface Asset {
  address: AssetAddress
  symbol: string
  decimals: number
  /**
   * Every approved quote asset on this chain is an upgradeable, pausable,
   * issuer-controlled proxy. Safe today by transfer simulation, but a pause
   * strands escrow - hence the per-asset kill switch.
   */
  isPausableProxy: boolean
  /** Set false to stop accepting or claiming this asset without a deploy. */
  enabled: boolean
  /** Some equity quote assets impose per-transfer caps. Claim in bounded chunks. */
  maxTransferMinor?: bigint
}

export interface Money {
  asset: AssetAddress
  /** Minor units. Never a float. */
  amount: bigint
}

/** A USD valuation, always carrying its provenance. */
export interface UsdValue {
  usd: number
  priceSource: string
  pricedAtUnix: number
  /** Block hash the underlying balance was read at, for reproducibility. */
  blockHash?: string
}

// ---------------------------------------------------------------------------
// Consent and onboarding
// ---------------------------------------------------------------------------

/**
 * The EIP-712 payload the dev signs. Every economic term is in here, and the
 * whole struct is the CREATE2 salt preimage - so a different rate is a
 * different vault address, and an existing customer cannot be repriced.
 */
export interface Consent {
  devSigner: Address
  /** Sole withdrawer of the dev leg. No operator key ever reaches it. */
  devPayout: Address
  /** Known and bound at deploy on the retrofit path. */
  token: Address
  /** keccak of the versioned MSA + content policy. */
  termsHash: string
  /** Immutable. In the salt preimage. */
  operatorBps: number
  /** Ceiling, immutable. In the salt preimage. */
  budgetBpsMax: number
  /** Pinned Venue integration shim. In the salt preimage. */
  adapter: Address
  referrer: Address
  /** Share OF operatorBps, paid on realized revenue only. */
  referrerBps: number
  expiryUnix: number
  nonce: string
}

export type VaultState =
  | 'UNBOUND'
  | 'PASSTHROUGH'
  | 'BOUND'
  | 'PENDING'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'POISONED'
  | 'TERMINATED'

export interface Vault {
  address: Address
  token: Address
  consent: Consent
  state: VaultState
  tier: TierId
  /** Dev-elected procurement dial, 0..budgetBpsMax. */
  budgetBps: number
  /** Per-token setting read on-chain. Determines creator net: 0.70% vs 0.35%. */
  buybackEnabled: boolean
  /** Per-token, immutable, 0..1000. Paid 100% to creator, never split. */
  creatorTaxBps: number
  deployedAtUnix: number
  activatedAtUnix?: number
}

// ---------------------------------------------------------------------------
// Fee measurement
// ---------------------------------------------------------------------------

/**
 * QF: quote-denominated creator fees credited to the coin's own vault, USD,
 * gross, before any split, as a trailing 7-day MEDIAN of daily credits.
 *
 * A median, not a mean: a mean is farmable with one day of wash volume.
 *
 * Excludes the launch token entirely, and excludes volume in any pool other
 * than the Venue pool. CASHCAT showed a 122x gap between headline volume and
 * fee-bearing Venue-pool volume; that gap is the normal state of a winner.
 */
export interface QfMeasurement {
  vault: Address
  /** Trailing 7-day median of daily credits, USD. */
  qfPerDay: number
  /** Days of history actually available. Below 7, the tier cannot be granted. */
  observedDays: number
  /** Consecutive days at or above the current tier gate. */
  sustainedDays: number
  measuredAtUnix: number
  perAsset: Array<{ asset: AssetAddress; creditedMinor: bigint; usd: UsdValue }>
}

/**
 * Qualification conjuncts beyond raw QF. Wash trading can manufacture fee flow;
 * it cannot cheaply manufacture breadth or deconcentration.
 */
export interface QualificationSignals {
  uniqueBuyers7d: number
  top10HolderSharePct: number
  deployerSupplySharePct: number
  selfTradeSharePct: number
  /** Venue-pool volume as a share of total observed volume. Migration warning. */
  venuePoolVolumeSharePct: number
  coinAgeDays: number
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type LedgerAccount =
  | 'income:fees'
  | 'asset:escrow'
  | 'asset:vault'
  | 'liability:dev_claimable'
  | 'liability:budget'
  | 'liability:operator_claimable'
  /** Carved out of the operator's slice on chain, never the client's. */
  | 'liability:referrer_claimable'
  | 'expense:procurement'
  | 'expense:cogs'

/**
 * Double-entry, append-only, balancing per asset, integers in minor units.
 *
 * Income is recognised EXACTLY ONCE, at accrual, from a declared precedence
 * source. Every sweep, claim, split and budget pull is a TRANSFER between
 * asset accounts, never income. That rule is what prevents the most likely
 * silent-money-loss bug: triple-counting a fee that appears as a curve event,
 * an escrow credit, and an ERC-20 transfer.
 */
export interface LedgerEntry {
  /** Deterministic. Replay is idempotent because the id is a pure function. */
  id: string
  vault: Address
  asset: AssetAddress
  debit: LedgerAccount
  credit: LedgerAccount
  amountMinor: bigint
  occurredAtUnix: number
  /** Chain provenance. Reads are pinned by blockHash, never blockNumber. */
  blockHash?: string
  txHash?: TxHash
  logIndex?: number
  /** Which observation produced this. Used for precedence and dedupe. */
  source: 'curve_event' | 'pool_fees_swept' | 'escrow_credit' | 'erc20_transfer' | 'manual'
  memo?: string
}

export interface ReconciliationVariance {
  vault: Address
  asset: AssetAddress
  ledgerBalanceMinor: bigint
  chainBalanceMinor: bigint
  deltaMinor: bigint
  severity: 'info' | 'warn' | 'critical'
  detectedAtUnix: number
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

export interface Vendor {
  id: string
  displayName: string
  /** Allowlisted payout address. Never supplied by a model or by user content. */
  payoutAddress?: Address
  kybVerifiedAtUnix?: number
  ofacScreenedAtUnix?: number
  /** Operator-affiliated vendors are capped and require per-dev opt-in. */
  isRelatedParty: boolean
  /** Rolling delivery reliability, an input to the spend gate. */
  reliabilityScore: number
  enabled: boolean
}

/** Catalog SKUs. The planner selects a SKU id; it never names a price or payee. */
export interface Sku {
  id: string
  vendorId: string
  description: string
  /** Public list price. Charged at cost, ZERO markup, reconciled daily. */
  unitCostUsd: number
  category: 'listing' | 'boost' | 'trending' | 'kol' | 'moderation' | 'build' | 'creative'
  /** How delivery is machine-verified. No predicate, no purchase. */
  predicate: DeliveryPredicateSpec
  /** Tiers at which this SKU may be offered at all. */
  availableAtTiers: TierId[]
}

export interface DeliveryPredicateSpec {
  kind: 'eti_listing' | 'boost_delta' | 'trending_rank' | 'kol_post' | 'manual_attestation'
  /** Re-check offsets in seconds. KOL posts are checked at T+24h AND T+7d. */
  verifyAtOffsetsSeconds: number[]
  params: Record<string, string | number>
}

export interface SpendProposal {
  vault: Address
  skuId: string
  quantity: number
  /** Planner-supplied rationale. Advisory text only; never parsed for values. */
  rationale: string
  proposedAtUnix: number
}

export interface SpendDecision {
  approved: boolean
  /** First failing gate. Gates are ordered and evaluated deterministically. */
  failedGate?: string
  reason: string
  /** Set when approval requires a human. */
  requiresHumanApproval: boolean
  quotedCostUsd?: number
}

export interface Disbursement {
  id: string
  vault: Address
  skuId: string
  vendorId: string
  costUsd: number
  invoiceHash: string
  /** Countersigned by the vendor. Funds move only to the operator treasury. */
  vendorCountersig?: string
  disbursedAtUnix: number
  predicateResults: PredicateResult[]
}

export interface PredicateResult {
  checkedAtUnix: number
  offsetSeconds: number
  passed: boolean
  evidenceUri?: string
  evidenceHash?: string
  note?: string
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export type Channel = 'telegram' | 'x_operator' | 'x_client_delegated' | 'site'

export interface PublishRequest {
  vault: Address
  channel: Channel
  /** Model-authored body. Disclosure is NOT part of this and never trusted from it. */
  body: string
  /** Classified by a rule engine, not by the model. Decides disclosure strings. */
  isPromotional: boolean
  /** Allowlisted links only. Any other 0x address in the body is a hard reject. */
  links: string[]
  imageRefs?: string[]
}

export interface PublishResult {
  published: boolean
  rejectedReason?: string
  externalId?: string
  /** Disclosure verified present by re-fetching the live post. */
  readBackVerified?: boolean
  publishedAtUnix?: number
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

export type ScreeningVerdict = 'CLEAR' | 'RESTRICTED' | 'BLOCKED'

export interface ScreeningResult {
  token: Address
  verdict: ScreeningVerdict
  /** Union of flags across stages. No stage may clear a prior stage's hit. */
  flags: string[]
  stagesRun: Array<'lexicon' | 'trademark' | 'perceptual' | 'adjudication' | 'human'>
  screenedAtUnix: number
  /** RESTRICTED permits organic operations but no paid media. */
  paidMediaPermitted: boolean
  note?: string
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export interface Receipt {
  id: string
  vault: Address
  disbursementId?: string
  kind: 'procurement' | 'operations' | 'refund' | 'fee'
  amountUsd: number
  description: string
  /** Published on a 72h lag for unexecuted commitments, so it is not a
   *  front-runnable purchase calendar. */
  publishAfterUnix: number
  occurredAtUnix: number
  evidenceUri?: string
}

export interface WeeklyReport {
  vault: Address
  periodStartUnix: number
  periodEndUnix: number
  qfReceivedUsd: number
  devLegUsd: number
  budgetSpentUsd: number
  operatorFeeUsd: number
  /** The referrer's cut, already carved out of the operator's slice on chain. */
  referrerFeeUsd: number
  lineItems: Receipt[]
  verifiedReachSummary: string
  attributedNewBuyers?: number
  costPerAttributedBuyerUsd?: number
  withheldPayments: Array<{ vendorId: string; amountUsd: number; reason: string }>
  /** A fixed section. Saying what we did NOT do is part of the product. */
  whatWeDidNotDo: string[]
}

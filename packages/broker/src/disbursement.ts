/**
 * DISBURSEMENT. There is no third-party payee anywhere in this file.
 *
 * The operator buys all media as PRINCIPAL, in its own name, with its own
 * money. What the budget leg then performs is a REIMBURSEMENT PULL into the
 * operator's own treasury against a countersigned invoice. There is deliberately
 * no function here that accepts a destination address, and the one destination
 * that exists is asserted against every payout address in the catalog before it
 * is returned. A client's money never travels to a vendor, so the arrangement
 * is not money transmission and cannot be argued into becoming it by a config
 * change.
 *
 * The invoice amount must equal the quoted charge EXACTLY. That is the same
 * zero-spread invariant the catalog enforces at the price level, re-asserted at
 * the moment money actually moves, because a spread introduced between quote
 * and settlement would be invisible to a rate-card reconciliation.
 */
import type {
  Asset,
  AssetAddress,
  Address,
  Disbursement,
  SpendDecision,
  SpendProposal,
} from '@fee-split-vaults/core'
import type { CatalogEntry, VendorCatalog } from './catalog.js'
import { BrokerError } from './errors.js'
import { sha256Hex } from './hash.js'
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  PRICE_MAX_AGE_SECONDS,
  exactCentsFromUsd,
  usdFromCents,
} from './money.js'

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/
/** bytes32, lowercase. What CoinVault.pullBudget takes as invoiceHash. */
const INVOICE_HASH_PATTERN = /^0x[0-9a-f]{64}$/
/** Non-empty bytes. CoinVault.pullBudget requires countersig.length > 0. */
const COUNTERSIG_PATTERN = /^0x(?:[0-9a-fA-F]{2})+$/

/** The operator's own treasury. The only destination this module can produce. */
export interface OperatorTreasury {
  address: Address
  label: string
}

export interface VendorInvoice {
  vendorId: string
  skuId: string
  quantity: number
  amountUsd: number
  /** `invoiceHashFor(this)`. bytes32; the on-chain replay key for the pull. */
  invoiceHash: string
  /** Countersigned by the vendor. An uncountersigned invoice is not evidence. 0x-hex bytes. */
  vendorCountersig: string
  issuedAtUnix: number
  /**
   * Captured by the operator BEFORE the purchase so a delta predicate has
   * something to measure against. Part of the hashed invoice body.
   */
  baseline?: { boosts?: number; rank?: number }
}

/**
 * The invoice's identity: sha256 over the canonical JSON of every field except
 * the hash itself and the countersignature, as `0x` + 64 lowercase hex. It is
 * a bytes32 for CoinVault.pullBudget, which refuses a reused one, so the same
 * purchase can never be reimbursed twice. sha256 rather than keccak because
 * this package depends on core alone and core carries no keccak; the chain
 * treats the value as opaque.
 */
export function invoiceHashFor(invoice: Omit<VendorInvoice, 'invoiceHash' | 'vendorCountersig'>): string {
  const body: Record<string, unknown> = {
    amountUsd: invoice.amountUsd,
    issuedAtUnix: invoice.issuedAtUnix,
    quantity: invoice.quantity,
    skuId: invoice.skuId,
    vendorId: invoice.vendorId,
  }
  if (invoice.baseline !== undefined) {
    const baseline: Record<string, number> = {}
    if (invoice.baseline.boosts !== undefined) baseline.boosts = invoice.baseline.boosts
    if (invoice.baseline.rank !== undefined) baseline.rank = invoice.baseline.rank
    body.baseline = baseline
  }
  return `0x${sha256Hex(JSON.stringify(body))}`
}

export interface HumanApprovalRecord {
  approver: string
  approvedAtUnix: number
  /** Binds the approval to one specific decision, not to a class of them. */
  decisionDigest: string
}

export interface ReimbursementPull {
  vault: Address
  /** ALWAYS the operator treasury. Never a vendor. Never model-supplied. */
  destination: Address
  asset: AssetAddress
  amountMinor: bigint
  /** Bounded chunks, because some quote assets impose per-transfer caps. */
  transfers: bigint[]
  amountUsdCents: bigint
  /** bytes32. The vault's replay key. */
  invoiceHash: string
  /** 0x-hex bytes. Evidence handed to pullBudget, not authority. */
  vendorCountersig: string
  memo: string
}

export interface AssetUsdPrice {
  asset: AssetAddress
  decimals: number
  /** USD cents per one whole unit of the asset. Integer, never a float. */
  centsPerWholeUnit: bigint
  source: string
  pricedAtUnix: number
}

/** How long a human approval remains attached to its decision. */
export const HUMAN_APPROVAL_MAX_AGE_SECONDS = 24 * 60 * 60

/**
 * Binds an approval to one decision. A human approving a $400 listing has not
 * approved a $400 KOL post, and this digest is what makes that true in code.
 */
export function decisionDigest(proposal: SpendProposal, quoteCents: bigint): string {
  return sha256Hex(
    JSON.stringify({
      vault: proposal.vault.toLowerCase(),
      skuId: proposal.skuId,
      quantity: proposal.quantity,
      quoteCents: quoteCents.toString(),
    }),
  )
}

/** Rounds DOWN, so rounding always favours the client, never the operator. */
export function minorFromUsdCents(
  cents: bigint,
  price: AssetUsdPrice,
  nowUnix: number,
  maxAgeSeconds: number,
): bigint {
  if (price.centsPerWholeUnit <= 0n) {
    throw new BrokerError('solvency', 'bad_price', 'asset price must be positive')
  }
  if (!Number.isInteger(price.decimals) || price.decimals < 0 || price.decimals > 36) {
    throw new BrokerError('solvency', 'bad_price', 'asset decimals are implausible')
  }
  // money.ts owns the skew tolerance as well as the staleness window. Both
  // bounds on this timestamp come from there; neither is restated here.
  if (
    price.pricedAtUnix > nowUnix + CLOCK_SKEW_TOLERANCE_SECONDS ||
    price.pricedAtUnix < nowUnix - maxAgeSeconds
  ) {
    throw new BrokerError('solvency', 'stale_price', 'asset price is stale; refusing to settle')
  }
  return (cents * 10n ** BigInt(price.decimals)) / price.centsPerWholeUnit
}

/**
 * Some approved quote assets cap a single transfer. A pull larger than the cap
 * is split rather than attempted and reverted.
 */
export function splitBoundedTransfers(amountMinor: bigint, maxTransferMinor?: bigint): bigint[] {
  if (amountMinor <= 0n) {
    throw new BrokerError('solvency', 'empty_transfer', 'transfer amount must be positive')
  }
  if (maxTransferMinor === undefined) return [amountMinor]
  if (maxTransferMinor <= 0n) {
    throw new BrokerError('asset_kill_switch', 'zero_cap', 'asset has a zero per-transfer cap')
  }
  const chunks: bigint[] = []
  let remaining = amountMinor
  while (remaining > 0n) {
    const chunk = remaining > maxTransferMinor ? maxTransferMinor : remaining
    chunks.push(chunk)
    remaining -= chunk
    if (chunks.length > 512) {
      throw new BrokerError(
        'asset_kill_switch',
        'too_many_chunks',
        'per-transfer cap would require an unreasonable number of transfers',
      )
    }
  }
  return chunks
}

/**
 * THE NO-THIRD-PARTY-PAYEE ASSERTION. Called on every constructed pull.
 * A destination that matches any allowlisted vendor payout address is a bug
 * severe enough to abort settlement.
 */
export function assertNoThirdPartyPayee(
  destination: Address,
  treasury: OperatorTreasury,
  catalog: VendorCatalog,
): void {
  if (!ADDRESS_PATTERN.test(destination)) {
    throw new BrokerError('disbursement', 'bad_destination', 'destination is not an address')
  }
  if (destination.toLowerCase() !== treasury.address.toLowerCase()) {
    throw new BrokerError(
      'disbursement',
      'non_treasury_destination',
      'the only permitted destination is the operator treasury',
    )
  }
  if (catalog.payoutAddresses.includes(destination.toLowerCase())) {
    throw new BrokerError(
      'disbursement',
      'vendor_destination',
      'the operator treasury address collides with a vendor payout address',
    )
  }
}

export interface BuildDisbursementArgs {
  proposal: SpendProposal
  decision: SpendDecision
  entry: CatalogEntry
  catalog: VendorCatalog
  invoice: VendorInvoice
  treasury: OperatorTreasury
  asset: Asset
  price: AssetUsdPrice
  quoteCents: bigint
  disbursementId: string
  nowUnix: number
  approval?: HumanApprovalRecord
  priceMaxAgeSeconds?: number
}

export interface BuiltDisbursement {
  disbursement: Disbursement
  pull: ReimbursementPull
}

export function buildDisbursement(args: BuildDisbursementArgs): BuiltDisbursement {
  const { proposal, decision, entry, invoice, treasury, asset, quoteCents } = args

  if (!decision.approved) {
    throw new BrokerError('disbursement', 'not_approved', 'the gate chain refused this proposal')
  }
  if (decision.requiresHumanApproval) {
    const approval = args.approval
    if (approval === undefined) {
      throw new BrokerError(
        'human_approval',
        'approval_missing',
        'this decision requires human approval and none was recorded',
      )
    }
    if (typeof approval.approver !== 'string' || approval.approver.length === 0) {
      throw new BrokerError('human_approval', 'approval_unattributed', 'approval names no approver')
    }
    if (
      approval.approvedAtUnix > args.nowUnix + CLOCK_SKEW_TOLERANCE_SECONDS ||
      approval.approvedAtUnix < args.nowUnix - HUMAN_APPROVAL_MAX_AGE_SECONDS
    ) {
      throw new BrokerError('human_approval', 'approval_stale', 'the human approval has expired')
    }
    if (approval.decisionDigest !== decisionDigest(proposal, quoteCents)) {
      throw new BrokerError(
        'human_approval',
        'approval_mismatch',
        'the approval was given for a different decision',
      )
    }
  }

  if (invoice.vendorId !== entry.sku.vendorId) {
    throw new BrokerError('disbursement', 'invoice_vendor_mismatch', 'invoice names another vendor')
  }
  if (invoice.skuId !== proposal.skuId || invoice.quantity !== proposal.quantity) {
    throw new BrokerError('disbursement', 'invoice_line_mismatch', 'invoice does not match the line')
  }
  if (!COUNTERSIG_PATTERN.test(invoice.vendorCountersig)) {
    throw new BrokerError(
      'disbursement',
      'invoice_uncountersigned',
      'the invoice carries no vendor countersignature (expected 0x-hex bytes)',
    )
  }
  if (!INVOICE_HASH_PATTERN.test(invoice.invoiceHash)) {
    throw new BrokerError(
      'disbursement',
      'invoice_hash_malformed',
      'invoiceHash must be bytes32 as 0x + 64 lowercase hex',
    )
  }
  if (invoice.invoiceHash !== invoiceHashFor(invoice)) {
    // A hash that does not cover the invoice body is a replay key detached
    // from what it is supposed to identify; the vault would accept it once.
    throw new BrokerError(
      'disbursement',
      'invoice_hash_mismatch',
      'invoiceHash does not equal invoiceHashFor(invoice)',
    )
  }
  const invoiceCents = exactCentsFromUsd(invoice.amountUsd, 'invoice.amountUsd')
  if (invoiceCents !== quoteCents) {
    // A spread introduced between quote and settlement would never show up in a
    // rate-card reconciliation, so it is caught here.
    throw new BrokerError(
      'disbursement',
      'spread_detected',
      `invoice ${invoiceCents} does not equal the quoted ${quoteCents}; the operator earns no spread`,
    )
  }
  if (!asset.enabled) {
    throw new BrokerError('asset_kill_switch', 'asset_disabled', `asset ${asset.symbol} is disabled`)
  }
  if (args.price.asset.toLowerCase() !== asset.address.toLowerCase()) {
    throw new BrokerError('disbursement', 'price_asset_mismatch', 'price is for a different asset')
  }

  assertNoThirdPartyPayee(treasury.address, treasury, args.catalog)

  // money.ts owns the price-staleness window. Restating it as a literal here
  // would let settlement keep accepting a price the rest of the broker has
  // already declared too old, and settlement is precisely where a stale price
  // costs someone money.
  const amountMinor = minorFromUsdCents(
    quoteCents,
    args.price,
    args.nowUnix,
    args.priceMaxAgeSeconds ?? PRICE_MAX_AGE_SECONDS,
  )
  const pull: ReimbursementPull = {
    vault: proposal.vault,
    destination: treasury.address,
    asset: asset.address,
    amountMinor,
    transfers: splitBoundedTransfers(amountMinor, asset.maxTransferMinor),
    amountUsdCents: quoteCents,
    invoiceHash: invoice.invoiceHash,
    vendorCountersig: invoice.vendorCountersig,
    memo: `reimbursement to ${treasury.label} for invoice ${invoice.invoiceHash}`,
  }

  const disbursement: Disbursement = {
    id: args.disbursementId,
    vault: proposal.vault,
    skuId: proposal.skuId,
    vendorId: entry.sku.vendorId,
    costUsd: usdFromCents(quoteCents),
    invoiceHash: invoice.invoiceHash,
    vendorCountersig: invoice.vendorCountersig,
    disbursedAtUnix: args.nowUnix,
    predicateResults: [],
  }

  return { disbursement, pull }
}

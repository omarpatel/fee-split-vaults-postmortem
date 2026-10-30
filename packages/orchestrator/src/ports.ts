/**
 * The seams between the tick loop and everything it does not own.
 *
 * A port is here for one of exactly two reasons:
 *
 *   1. Nobody built it. Fleet-wide spend counters, the receipt store, the human
 *      approval store and the settlement submitter are named as followups by
 *      three separate packages and exist nowhere.
 *   2. It is a trust boundary and the narrowness IS the control. The settlement
 *      port cannot express a destination; the message source hands over opaque
 *      records the orchestrator never reads.
 *
 * Everything else - the ledger, the broker, the publisher, the runtime, the
 * indexer store - is consumed as its real class, so a shape change in any of
 * them is a compile error here rather than a runtime surprise in production.
 */

import type {
  Address,
  Asset,
  AssetAddress,
  DeliveryPredicateSpec,
  Receipt,
  ScreeningResult,
  TxHash,
  Vault,
} from '@fee-split-vaults/core'
import type { ReimbursementPull, SkuCategory, VendorInvoice } from '@fee-split-vaults/broker'
import type { HumanApprovalRecord } from '@fee-split-vaults/broker'
import type { CoinBinding, FeePosting, HaltNotice } from '@fee-split-vaults/indexer'
import type { RawMessage } from '@fee-split-vaults/runtime'
import type { TierId } from '../../../config/protocol.js'

/** Injected so a replay of a disputed tick reproduces byte-identically. */
export interface Clock {
  nowUnix(): number
}

export const systemClock: Clock = {
  nowUnix: () => Math.floor(Date.now() / 1000),
}

export function fixedClock(startUnix: number): Clock & { set(unix: number): void } {
  let t = startUnix
  return {
    nowUnix: () => t,
    set: (unix: number) => {
      t = unix
    },
  }
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/**
 * One canonical pinned price shape. The three consuming packages each want a
 * different one - the indexer a float per whole unit, the ledger a quote with a
 * source, the broker integer cents - so the adapters live in prices.ts and this
 * is the single thing an operator has to supply.
 */
export interface PinnedUsdPrice {
  asset: AssetAddress
  /** USD CENTS per one whole unit of the asset. Integer. Never a float. */
  centsPerWholeUnit: bigint
  source: string
  pricedAtUnix: number
  blockHash?: string
}

export interface UsdPriceBook {
  /** The price in force at an instant, or undefined. Undefined means REFUSE. */
  priceAt(asset: AssetAddress, atUnix: number): PinnedUsdPrice | undefined
}

// ---------------------------------------------------------------------------
// Registries the tick loop reads
// ---------------------------------------------------------------------------

export interface AssetRegistry {
  /**
   * The per-asset kill switch lives here. Every approved quote asset on this
   * chain is an upgradeable, pausable, issuer-controlled proxy, so `enabled`
   * has to be flippable without a deploy.
   */
  get(asset: AssetAddress): Asset | undefined
  all(): readonly Asset[]
}

export interface VaultRepository {
  get(vault: Address): Promise<Vault | undefined>
  /** Persist a state or tier change. The orchestrator never writes chain state. */
  put(vault: Vault): Promise<void>
  list(): Promise<Vault[]>
}

export interface ScreeningStore {
  /** Latest verdict for a token, or undefined. Undefined means no paid media. */
  latest(token: Address): Promise<ScreeningResult | undefined>
  put(result: ScreeningResult): Promise<void>
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Trusted ingest. The messages are attacker-authored; the BINDING is not.
 *
 * The orchestrator never reads a field of a RawMessage. It hands the array to
 * CoinRuntime.runWindow, which assembles the corpus deterministically and
 * throws on a cross-coin binding. isolation.spec.ts asserts that this package
 * contains no read of `.text`.
 */
export interface MessageSource {
  since(coinRef: string, fromUnix: number, toUnix: number): Promise<readonly RawMessage[]>
}

// ---------------------------------------------------------------------------
// Desk
// ---------------------------------------------------------------------------

/**
 * The support desk, as a port. It lives on the READER plane: it consumes the
 * same opaque messages the corpus assembler does and returns a BODY the tick
 * hands to the publisher - which owns disclosure, the outbound refusal
 * classifier, and the link allowlist - as a reply to the message it answers.
 *
 * The tick never reads a field of the message; the desk implementation does,
 * on its own plane, and the only thing that comes back is a body, a machine
 * code and a closed set of escalations. There is no tool on this port that can
 * move money, sign, or publish: the tick publishes, through the same gates
 * every planner post goes through.
 */
export interface DeskWindowRef {
  windowId: string
  startUnix: number
  endUnix: number
}

export interface DeskAnswerInput {
  coinRef: string
  vault: Address
  token: Address
  tier: TierId
  /**
   * The coin's own chat - the account the reply goes out from. Configuration
   * the operator wrote, never something read out of the message.
   */
  chatId: string
  window: DeskWindowRef
  /** Opaque to the tick. Bound to `coinRef` by trusted ingest. */
  message: RawMessage
  /**
   * False once the window's model-call cap is spent: the desk may still
   * answer deterministically (commands, the anti-snipe explainer, templates)
   * but must not call a model for this message.
   */
  modelPermitted: boolean
  nowUnix: number
}

/** Something a human should look at, raised by the desk. Code-authored text only. */
export interface DeskEscalation {
  reason: string
  summary: string
  priority: 'low' | 'normal' | 'high' | 'critical'
}

interface DeskOutcomeBase {
  /** True when a model produced or was asked for the answer. Counts against the window cap. */
  modelCalled: boolean
  escalations: readonly DeskEscalation[]
}

export type DeskOutcome =
  | (DeskOutcomeBase & {
      kind: 'reply'
      /** Undisclosed body. The publisher appends the canonical disclosure. */
      body: string
      /** FactSheet field ids the answer was grounded on. Audit only. */
      citedFields: readonly string[]
      modelAuthored: boolean
    })
  | (DeskOutcomeBase & {
      kind: 'refused'
      code: string
      /** A fixed refusal template to send as the reply, when the desk has one. */
      body?: string
    })
  | (DeskOutcomeBase & {
      kind: 'moderated'
      /** Actions applied, by kind. */
      actions: readonly string[]
      /** Actions that could not be applied, with a machine code each. */
      failed: readonly { action: string; code: string }[]
      /** A fixed, code-authored warning to send as the reply, when the verdict carries one. */
      body?: string
    })
  | (DeskOutcomeBase & { kind: 'ignore' })

export interface DeskPort {
  answer(input: DeskAnswerInput): Promise<DeskOutcome>
}

// ---------------------------------------------------------------------------
// Things three packages named as followups and nobody owns
// ---------------------------------------------------------------------------

/**
 * Fleet-wide counters. Two of the broker's gates - fleetVendorDailyCapUsd and
 * the daily disbursement cap - are about the WHOLE client book, so no per-coin
 * state can answer them. This is deliberately the only fleet-scoped read in the
 * per-coin path, and it returns numbers, never another coin's identity.
 */
export interface FleetCounters {
  disbursementsToday(nowUnix: number): Promise<number>
  vendorSpendTodayCents(vendorId: string, nowUnix: number): Promise<bigint>
  vendorDisbursementsTodayForVault(vault: Address, vendorId: string, nowUnix: number): Promise<number>
  proposalsLastHour(vault: Address, nowUnix: number): Promise<number>
  disbursementsTodayForVault(vault: Address, nowUnix: number): Promise<number>
  relatedPartySpend30dCents(vault: Address, nowUnix: number): Promise<bigint>
  /**
   * One vault's procurement spend over the trailing 30 days - the sub-cap
   * period - broken down by SKU category.
   *
   * THIS EXISTS BECAUSE THE SUB-CAP WAS INERT. `categorySubcapGate` compares
   * `spent + quote` against a percentage of the period budget, and `spent` was
   * fed from a map the live tick path hardcoded to `{}` - so every purchase was
   * checked as though it were the first one in its category, and a coin could
   * clear the listing sub-cap once per tick, forever. The accumulating figure
   * has to come from somewhere that outlives a tick, and the disbursement
   * counters are already that place: written on the same path, in the same unit
   * the gate reads, and surviving a restart.
   *
   * IT RETURNS THE WHOLE BREAKDOWN, not one category, because the same gate
   * also sums every category against the procurement budget. Asking per
   * category would make that total the sum of whichever categories the caller
   * remembered to ask about, and a forgotten one is an under-count, and an
   * under-count on a spend counter OPENS the cap. One call cannot forget.
   *
   * An absent category means a measured zero - nothing was bought in it. A
   * store that cannot be reached THROWS, as its neighbours do; a zero returned
   * for "I could not look" would open every sub-cap at once.
   */
  categorySpend30dCents(
    vault: Address,
    nowUnix: number,
  ): Promise<Partial<Record<SkuCategory, bigint>>>
  /** Called after a disbursement lands so the next tick sees it. */
  recordDisbursement(entry: FleetDisbursementRecord): Promise<void>
  recordProposal(vault: Address, atUnix: number): Promise<void>
}

export interface FleetDisbursementRecord {
  vault: Address
  vendorId: string
  amountCents: bigint
  isRelatedParty: boolean
  /**
   * The SKU's category, so the per-category sub-cap can accumulate.
   *
   * REQUIRED, with no default. A default would have to be some category, and
   * whichever one it was would under-count every other - which is the exact
   * failure this field was added to end.
   */
  category: SkuCategory
  atUnix: number
}

export interface ReceiptStore {
  /**
   * Upsert by id. Receipt ids are content-derived, so the delivered re-issue
   * of a procurement receipt (publishDeliveredReceipt) replaces the withheld
   * row rather than sitting beside it.
   */
  put(receipt: Receipt): Promise<void>
  /** Ordered oldest first. `publishedOnly` applies the publishAfterUnix lag. */
  list(vault: Address, options?: ReceiptQuery): Promise<Receipt[]>
  get(id: string): Promise<Receipt | undefined>
}

export interface ReceiptQuery {
  fromUnix?: number
  toUnix?: number
  /** Hide receipts still inside their publication lag. Default true. */
  publishedOnly?: boolean
  nowUnix?: number
}

export interface ApprovalStore {
  /**
   * A human approval bound to one decision digest. The broker verifies the
   * binding; this only has to find it.
   */
  find(vault: Address, decisionDigest: string): Promise<HumanApprovalRecord | undefined>
  put(vault: Address, record: HumanApprovalRecord): Promise<void>
}

export interface InvoiceSource {
  /**
   * The countersigned invoice for a purchase the operator has ALREADY made as
   * principal. Absence means no reimbursement: the operator buys first and is
   * reimbursed against evidence, which is what keeps the client's money from
   * ever pointing at a vendor.
   */
  find(vault: Address, skuId: string, quantity: number, nowUnix: number): Promise<VendorInvoice | undefined>
}

/**
 * Where the operator's invoices live. `put` is the onboarding side recording a
 * purchase it made; `find` (inherited) returns only invoices whose
 * reimbursement has not settled; `markSettled` is the tick loop closing one
 * out once the pull landed, so the same purchase is never reimbursed twice
 * even before the vault's own replay check sees it.
 */
export interface InvoiceRegistry extends InvoiceSource {
  /** Refuses a second invoice with the same invoiceHash for the vault. */
  put(vault: Address, invoice: VendorInvoice): Promise<void>
  /** Invoices recorded for the vault and not yet settled. Oldest first. */
  listPending(vault: Address): Promise<readonly VendorInvoice[]>
  markSettled(vault: Address, invoiceHash: string, txHash: TxHash): Promise<void>
}

/**
 * A purchase the broker approved that the operator has not yet evidenced.
 *
 * The spend path is: the planner proposes, the broker approves, the operator
 * BUYS AS PRINCIPAL in its own name, and only then - against a countersigned
 * invoice - is the operator reimbursed from the vault. Between "approved" and
 * "invoiced" a purchase is a to-do for a human, and this is the list of them.
 *
 * It is a port because the fact is produced by the tick loop (an
 * `awaiting_invoice` SpendOutcome) and consumed by the API, in a process that
 * holds no fleet. The ApprovalStore cannot answer it: it is keyed by a digest
 * that does not decode back to a SKU.
 */
export interface PendingPurchase {
  vault: Address
  vendorId: string
  skuId: string
  quantity: number
  /** The catalog quote the broker approved, in USD cents. */
  quoteCents: bigint
  proposedAtUnix: number
}

export interface PendingPurchaseSource {
  /** Oldest proposal first. */
  awaitingInvoice(vault: Address): Promise<readonly PendingPurchase[]>
}

export interface PendingPurchaseStore extends PendingPurchaseSource {
  /**
   * Idempotent on (vault, skuId, quantity): the tick loop re-reports every
   * window, and the FIRST proposal's time is the one kept - a re-report is
   * the same to-do, not a newer one.
   */
  record(purchase: PendingPurchase): Promise<void>
  /** Called once the purchase is evidenced: an invoice is on file, or the pull settled. */
  clear(vault: Address, skuId: string, quantity: number): Promise<void>
}

/**
 * One funded disbursement's delivery checks, scheduled. The queue expands
 * `spec.verifyAtOffsetsSeconds` into one due check per offset from
 * `fundedAtUnix`; the ops verifier job drains it and re-issues the receipt as
 * delivered on the first pass.
 */
export interface PredicateSchedule {
  disbursementId: string
  vault: Address
  token: Address
  skuId: string
  vendorId: string
  spec: DeliveryPredicateSpec
  fundedAtUnix: number
  costUsd: number
  /** From the invoice: captured by the operator before the purchase. */
  baseline?: { boosts?: number; rank?: number }
}

export interface PredicateQueue {
  /** Idempotent on disbursementId: re-enqueuing a known disbursement is a no-op. */
  enqueue(schedule: PredicateSchedule): Promise<void>
}

/**
 * Submits a reimbursement pull on chain.
 *
 * RULE 3 IS THE SIGNATURE. There is no parameter here that can hold a payee.
 * The only thing this port accepts is a ReimbursementPull, whose destination
 * field is written by the broker's buildDisbursement() and is always the
 * operator treasury. An implementation that reads a destination from anywhere
 * else is not implementing this interface.
 */
export interface SettlementPort {
  submit(pull: ReimbursementPull): Promise<SettlementReceipt>
}

export interface SettlementReceipt {
  txHash: TxHash
  blockHash?: string
  /** What actually moved, summed over the bounded transfer chunks. */
  settledMinor: bigint
  settledAtUnix: number
}

/** Anything a human has to look at. Escalations are not a log line. */
export interface EscalationSink {
  raise(escalation: Escalation): Promise<void>
}

export interface Escalation {
  coinRef: string
  vault: Address
  kind:
    | 'planner_escalation'
    | 'indexer_halt'
    | 'ledger_freeze'
    | 'screening_blocked'
    | 'screening_missing'
    | 'tier_downgrade'
    | 'settlement_failed'
    | 'divergence_freeze'
    | 'desk_escalation'
  /** Machine code. Never free text from a model or from message content. */
  code: string
  detail: string
  raisedAtUnix: number
}

// ---------------------------------------------------------------------------
// Read-side of the chain, as the tick loop needs it
// ---------------------------------------------------------------------------

/**
 * What the orchestrator needs from the indexer. Narrower than IndexerStore on
 * purpose: the tick loop reads postings and bindings and writes neither.
 */
export interface ChainReadModel {
  binding(token: Address): Promise<CoinBinding | undefined>
  postings(vault: Address, fromUnix: number, toUnix: number): Promise<readonly FeePosting[]>
  /** Open halt notices for this vault's token. Any halt suspends spending. */
  halts(token: Address): Promise<readonly HaltNotice[]>
  /**
   * The vault's own claim() / claimToken() calls, in the bounded chunks the
   * quote asset's per-transfer cap forces. One chunk, one observation.
   */
  claims(vault: Address, fromUnix: number, toUnix: number): Promise<readonly ClaimObservation[]>
  /**
   * The vault's settle() split. This is the ONLY thing that puts money in the
   * budget leg, so without it a coin accrues income forever and can never
   * spend a cent - which is the correct failure, not a bug to route around.
   */
  allocations(
    vault: Address,
    fromUnix: number,
    toUnix: number,
  ): Promise<readonly AllocationObservation[]>
}

export interface ClaimObservation {
  vault: Address
  asset: AssetAddress
  amountMinor: bigint
  occurredAtUnix: number
  txHash: TxHash
  logIndex: number
  blockHash?: string
}

/**
 * One settle(). The four legs must sum to the credited amount; the on-chain
 * split gives the rounding remainder to the DEV leg, so integer division can
 * only ever favour the client.
 *
 * The referrer is a real fourth leg with its own pull (CoinVault.withdrawReferrer).
 * Its share is carved out of the OPERATOR's slice, never the client's, so
 * operatorMinor is the operator's take NET of the referrer, exactly as the
 * Credited event reports it.
 */
export interface AllocationObservation {
  vault: Address
  asset: AssetAddress
  devMinor: bigint
  budgetMinor: bigint
  operatorMinor: bigint
  referrerMinor: bigint
  occurredAtUnix: number
  txHash: TxHash
  logIndex: number
  blockHash?: string
}

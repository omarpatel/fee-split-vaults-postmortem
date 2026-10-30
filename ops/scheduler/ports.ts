/**
 * The operations plane's view of the rest of the system.
 *
 * Every port here is NARROW BY CONSTRUCTION: it exposes the smallest surface a
 * job needs and nothing else. Three consequences that are the point rather than
 * a side effect:
 *
 *   - No port accepts a free-form payee, address string, or amount from anything
 *     a model touched. Sweeps name a vault and an asset; settlements name bps
 *     that came from the signed consent; purchases are not in this file at all.
 *   - Every money-moving port has findByRunKey(). That is what makes a crash
 *     between "broadcast the claim" and "write the record" recoverable: the
 *     retry finds its own prior work instead of doing it again.
 *   - No port carries untrusted text. Token metadata crosses as an opaque ref
 *     plus a content hash; only the screening package ever dereferences it.
 */

import type {
  Address,
  Asset,
  AssetAddress,
  Channel,
  DeliveryPredicateSpec,
  PredicateResult,
  QfMeasurement,
  QualificationSignals,
  ReconciliationVariance,
  ScreeningResult,
  TxHash,
  UsdValue,
  VaultState,
  WeeklyReport,
} from '@fee-split-vaults/core'
import type { ReceiptStore } from '@fee-split-vaults/orchestrator'
import type { ChannelHealthProbe, ChannelHealthRecord } from '@fee-split-vaults/publisher'
import type { AlertId } from '../monitoring/ids.js'
import type { OpsSignals } from '../monitoring/types.js'
import type { TierId } from '../lib/protocol.js'

// ---------------------------------------------------------------------------
// Vault directory
// ---------------------------------------------------------------------------

/**
 * The slim projection ops needs. Deliberately not the full Vault: the scheduler
 * has no business reading a consent signature, and a port that cannot return one
 * cannot leak one into a log line.
 */
export interface VaultRef {
  address: Address
  token: Address
  state: VaultState
  tier: TierId
  budgetBps: number
  /**
   * The operator's share, IN BPS, taken from this vault's signed consent - which
   * is part of the CREATE2 salt preimage, so it is immutable for the life of the
   * vault. Deliberately carried per vault rather than read from TERMS: TERMS is
   * the rate for a vault signed TODAY, and repricing an existing customer by
   * changing a config constant is exactly what the salt design forbids.
   */
  operatorBps: number
  /** Read on-chain per token. Decides the creator rate branch. Never assumed. */
  buybackEnabled: boolean
  creatorTaxBps: number
  /** Sole withdrawer of the dev leg. Present so jobs can assert nothing else is. */
  devPayout: Address
  activatedAtUnix?: number
}

export interface VaultDirectory {
  /** Vaults in any of the given states. Ordered by address for determinism. */
  listByState(states: readonly VaultState[]): Promise<VaultRef[]>
  get(vault: Address): Promise<VaultRef | undefined>
}

export interface AssetRegistry {
  get(asset: AssetAddress): Promise<Asset | undefined>
  list(): Promise<Asset[]>
}

// ---------------------------------------------------------------------------
// Escrow and sweeping
// ---------------------------------------------------------------------------

export interface EscrowCredit {
  vault: Address
  asset: AssetAddress
  /** Minor units. Never a float. */
  creditedMinor: bigint
  /** USD valuation with provenance, for the value-threshold trigger only. */
  usd: UsdValue
  /** The pinned block the credit was read at. */
  blockHash: string
}

export interface EscrowReader {
  /**
   * Unclaimed escrow credits for a vault. The Venue V2 escrow is msg.sender-only
   * and its credits key by (recipient, quoteAsset) with NO coin identifier, so
   * the per-coin attribution behind these numbers comes from the indexer, not
   * from the escrow. This port returns what is claimable, not what is owed.
   */
  listPending(vault: Address): Promise<EscrowCredit[]>
}

export interface SweepRequest {
  vault: Address
  asset: AssetAddress
  expectedMinor: bigint
  /**
   * Some approved quote assets impose a per-transfer cap, so a claim is issued
   * in chunks. Absent means unchunked.
   */
  maxChunkMinor?: bigint
  /** Idempotency key. The executor must return the prior receipt for a repeat. */
  runKey: string
}

export interface SweepReceipt {
  sweepId: string
  /** The run key that produced it. Carried so a lost run can be reconstructed. */
  runKey: string
  vault: Address
  asset: AssetAddress
  /** What actually landed. May be less than expected; the three-way match cares. */
  claimedMinor: bigint
  chunks: number
  txHashes: TxHash[]
  blockHash: string
  completedAtUnix: number
}

export interface SweepExecutor {
  sweep(request: SweepRequest): Promise<SweepReceipt>
  /** The re-entry check. Returns the receipt a prior attempt already produced. */
  findByRunKey(runKey: string): Promise<SweepReceipt | undefined>
  /**
   * Receipts the executor holds that the ledger has not acknowledged.
   *
   * This is the OUTBOX, and it closes the one hole that findByRunKey alone
   * cannot: a crash between the broadcast and the ledger write leaves the escrow
   * already drained, so the value trigger and the forced interval both see
   * nothing to do and the sweep is never posted. Draining this list is how the
   * money gets onto the books.
   */
  unrecorded(limit: number): Promise<SweepReceipt[]>
  /** Called after ledger.recordSweep succeeds. Idempotent. */
  confirmRecorded(sweepId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export interface SettlementRequest {
  vault: Address
  asset: AssetAddress
  amountMinor: bigint
  /** From the signed consent, which is in the CREATE2 salt. Never from config. */
  operatorBps: number
  /** The dev's current dial. */
  budgetBps: number
  runKey: string
}

/**
 * The split, as credited.
 *
 * devLegMinor is CREDITED, not transferred: the dev leg is pull-only and no
 * operator key can move it. A settlement that transferred to devPayout would be
 * a custody event and is not something this port can express.
 */
export interface SettlementReceipt {
  settlementId: string
  vault: Address
  asset: AssetAddress
  devLegMinor: bigint
  budgetMinor: bigint
  /** The operator's take net of the referrer, as Credited reports it. */
  operatorMinor: bigint
  /** Carved out of the operator's gross slice on chain; zero without a referrer. */
  referrerMinor: bigint
  txHash?: TxHash
  settledAtUnix: number
}

export interface SettlementExecutor {
  settle(request: SettlementRequest): Promise<SettlementReceipt>
  findByRunKey(runKey: string): Promise<SettlementReceipt | undefined>
  /** Unsettled swept balance per asset for a vault. Drives the settle job. */
  unsettled(vault: Address): Promise<Array<{ asset: AssetAddress; amountMinor: bigint }>>
}

// ---------------------------------------------------------------------------
// Ledger and reconciliation
// ---------------------------------------------------------------------------

export interface StructuralCheckReport {
  checkedAtUnix: number
  entriesChecked: number
  /** Each failure names the invariant, not just "mismatch". */
  failures: Array<{ invariant: string; vault?: Address; asset?: AssetAddress; detail: string }>
}

export type MatchLegName = 'swept' | 'escrow_credited' | 'received' | 'ledger_recognized'

export interface ThreeWayMatchReport {
  sweepId: string
  vault: Address
  asset: AssetAddress
  matched: boolean
  /** A MISSING leg is a failure, not an unknown. Absent evidence is not evidence. */
  missingLegs: MatchLegName[]
  legs: Array<{ name: MatchLegName; amountMinor: bigint | null }>
  worstSeverity: ReconciliationVariance['severity']
  varianceIds: string[]
}

export interface TrialBalanceReport {
  asOfUnix: number
  vaultsChecked: number
  /** Recompute from ledger_entry vs the materialized ledger_balance table. */
  mismatches: Array<{
    vault: Address
    asset: AssetAddress
    account: string
    materializedMinor: bigint
    recomputedMinor: bigint
  }>
}

export interface CleanRoomReport {
  asOfUnix: number
  /** Which vaults were recomputed from raw chain logs by the independent path. */
  vaultsChecked: Address[]
  /** Vaults selected because they are top-tier, as opposed to sampled. */
  topTierVaults: Address[]
  disagreements: Array<{
    vault: Address
    asset: AssetAddress
    primaryMinor: bigint
    cleanRoomMinor: bigint
  }>
}

export interface LedgerOps {
  /** Idempotent by sweepId. Posts the sweep as a TRANSFER, never as income. */
  recordSweep(receipt: SweepReceipt): Promise<void>
  /** Idempotent by settlementId. Also a transfer between asset accounts. */
  recordSettlement(receipt: SettlementReceipt): Promise<void>

  structuralChecks(input: { asOfUnix: number }): Promise<StructuralCheckReport>
  threeWayMatch(input: { sweepId: string }): Promise<ThreeWayMatchReport>
  recomputeTrialBalance(input: { asOfUnix: number }): Promise<TrialBalanceReport>
  cleanRoomRecompute(input: { asOfUnix: number; vaults: readonly Address[] }): Promise<CleanRoomReport>

  /** Sweeps awaiting a three-way match, oldest first. */
  unmatchedSweeps(limit: number): Promise<Array<{ sweepId: string; vault: Address; sweptAtUnix: number }>>

  recordVariance(variance: ReconciliationVariance & { note?: string }): Promise<string>
  /**
   * Freeze NEW authorizations for a scope. Reconciliation keeps running: a
   * freeze that stopped the checks could never be lifted.
   */
  freezeAuthorizations(input: { scope: 'global' | Address; reason: string; varianceId?: string }): Promise<void>

  /** Every vault the ledger knows about, for sampling. */
  allVaults(): Promise<Address[]>
}

// ---------------------------------------------------------------------------
// Tiering
// ---------------------------------------------------------------------------

export interface QfSource {
  /** Trailing 7-day MEDIAN of daily credits. Never a mean. */
  measure(vault: Address, asOfUnix: number): Promise<QfMeasurement>
  signals(vault: Address, asOfUnix: number): Promise<QualificationSignals>
}

export interface TierDecision {
  vault: Address
  from: TierId
  to: TierId
  direction: 'up' | 'down' | 'hold'
  qfPerDay: number
  observedDays: number
  sustainedDays: number
  reason: string
  decidedAtUnix: number
}

export interface TierRegistry {
  current(vault: Address): Promise<TierId>
  /**
   * Consecutive daily evaluations in which QF sat below the CURRENT tier's gate.
   * The registry keeps this, not the job: a job that recomputed it from scratch
   * each run would have to re-read a week of history to answer one question.
   */
  daysBelowGate(vault: Address): Promise<number>
  /** Record today's evaluation so daysBelowGate advances or resets. Idempotent per day. */
  observe(input: { vault: Address; atUnix: number; qfPerDay: number; belowGate: boolean }): Promise<void>
  apply(decision: TierDecision): Promise<void>
}

// ---------------------------------------------------------------------------
// Delivery predicates
// ---------------------------------------------------------------------------

export interface DuePredicateCheck {
  disbursementId: string
  vault: Address
  token: Address
  skuId: string
  vendorId: string
  spec: DeliveryPredicateSpec
  /** Which of spec.verifyAtOffsetsSeconds this check is. */
  offsetSeconds: number
  fundedAtUnix: number
  dueAtUnix: number
  costUsd: number
  /** From the invoice: what the operator observed before the purchase. */
  baseline?: { boosts?: number; rank?: number }
}

export interface PredicateQueue {
  /** Checks whose dueAtUnix has passed and which have no recorded result yet. */
  listDue(nowUnix: number, limit: number): Promise<DuePredicateCheck[]>
  recordResult(input: { disbursementId: string; offsetSeconds: number; result: PredicateResult }): Promise<void>
  /** A failed predicate withholds the vendor payment. It does not refund silently. */
  withholdPayment(input: { disbursementId: string; vendorId: string; reason: string }): Promise<void>
  /** Downgrade a vendor's rolling reliability after a failed check. */
  penalizeVendor(input: { vendorId: string; reason: string }): Promise<void>
}

export interface PredicateVerifier {
  /**
   * Fails closed: transport failure, malformed evidence and negative evidence
   * are all "not delivered". Never throws to signal non-delivery.
   */
  verify(check: DuePredicateCheck): Promise<PredicateResult>
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface ReportBuilder {
  build(input: { vault: Address; periodStartUnix: number; periodEndUnix: number }): Promise<WeeklyReport>
}

export interface ReportDelivery {
  /**
   * Disclosure is composed by CODE on the way out - the publisher's own
   * renderer, naming the operator from config - never by the builder and never
   * from the report body. A delivery that cannot name an operator refuses.
   */
  deliver(report: WeeklyReport): Promise<{ delivered: boolean; channel: string; externalId?: string }>
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

/** What changed. A closed vocabulary - never the changed text itself. */
export type MetadataField = 'name' | 'symbol' | 'image' | 'description' | 'links' | 'socials'

export interface MetadataChange {
  token: Address
  vault: Address
  /** Opaque handle the screening package dereferences. Ops never reads it. */
  metadataRef: string
  /** Content hash of the new metadata. Changes here are what make the job idempotent. */
  metadataHash: string
  changedFields: MetadataField[]
  observedAtUnix: number
  blockHash: string
}

export interface MetadataWatcher {
  /** Changes observed strictly after the cursor, oldest first. */
  changedSince(cursorUnix: number, limit: number): Promise<MetadataChange[]>
  /** Persisted so a restart does not re-screen the whole book. */
  cursor(): Promise<number>
  advanceCursor(toUnix: number): Promise<void>
}

export interface ScreeningService {
  rescreen(input: { token: Address; vault: Address; metadataRef: string }): Promise<ScreeningResult>
  /** Last recorded verdict, so a re-screen can be compared rather than just stored. */
  lastResult(token: Address): Promise<ScreeningResult | undefined>
  record(result: ScreeningResult & { metadataHash: string }): Promise<void>
}

/** Actions a worsening verdict triggers. Each is a state change, not a message. */
export interface EnforcementActions {
  suspendPaidMedia(input: { vault: Address; reason: string }): Promise<void>
  suspendVault(input: { vault: Address; reason: string }): Promise<void>
  escalateToHuman(input: { vault: Address; reason: string; severity: 'high' | 'critical' }): Promise<void>
}

// ---------------------------------------------------------------------------
// Operator liveness
// ---------------------------------------------------------------------------

/**
 * CoinVault's dead-man switch: after TERMS.deadManDays without an operator
 * transaction the dev may release the operator leg. Every operator call resets
 * it, so a fleet whose vaults all need nothing for months still has to be seen
 * on chain. That is what heartbeat() is - a no-op operator transaction.
 */
export interface VaultHeartbeat {
  lastOperatorActionUnix(vault: Address): Promise<number>
  heartbeat(vault: Address): Promise<{ txHash: TxHash; blockHash: string }>
}

// ---------------------------------------------------------------------------
// Publishing account health
// ---------------------------------------------------------------------------

/** An X account bound to a coin, as the health job enumerates it. */
export interface PublishingAccountRef {
  channel: Extract<Channel, 'x_operator' | 'x_client_delegated'>
  accountId: string
  vault: Address
}

/**
 * The platform standing of every account we post from, probed out of band.
 *
 * `probe` never throws: a credential the transport refused is `unauthorized`,
 * a network fault is `unreachable`. `record` APPENDS to the health log the
 * publisher's gate and the monitoring collector read; the job does not record
 * `unreachable` (see packages/publisher/src/health.ts), it fails the run so
 * the scheduler retries.
 */
export interface PublishingHealth {
  listAccounts(): Promise<readonly PublishingAccountRef[]>
  probe(account: PublishingAccountRef): Promise<ChannelHealthProbe>
  record(record: ChannelHealthRecord): Promise<void>
}

// ---------------------------------------------------------------------------
// The fleet: one agent team per coin
// ---------------------------------------------------------------------------

/**
 * A coin the fleet holds. Three fields, because that is all the scheduler needs
 * to decide whether to wake a coin's team, and because a wider projection here
 * would put one coin's operating state on the path of every other coin's
 * due-scope computation.
 */
export interface FleetCoinRef {
  /** Operator-assigned, opaque, [A-Za-z0-9_-]. Never the token address. */
  coinRef: string
  vault: Address
  /**
   * Earliest instant this coin has work again, as its own last tick reported
   * it. The cadence belongs to the coin (CoinTicker decides it from the vault's
   * age, its sweep interval and its window boundaries); the scheduler only
   * honours it. Absent history reads as "due now", so a cold start catches up.
   */
  nextDueUnix: number
}

/** Where the model output in a run came from. A fake never reads as live. */
export type ModelProvenance = 'live' | 'fake' | 'unknown'

/**
 * What one coin's team did in one tick, as COUNTS AND MACHINE CODES.
 *
 * Deliberately not the tick result. A CoinTickResult holds a digest with
 * model-authored gists, proposal bodies and broker internals, and none of that
 * belongs in a scheduler's log line or its dead-letter record. The full record
 * is projected and persisted by the runner, on the other side of this port.
 *
 * REFUSALS ARE FIRST CLASS. A tick that refused every phase is a successful
 * run of a fail-closed system, so refusals are carried as data rather than
 * raised as failures - the job only fails when the tick itself could not run.
 */
export interface FleetTickSummary {
  coinRef: string
  vault: Address
  tier: TierId
  atUnix: number
  /**
   * True when this run key had already ticked and the stored record was
   * returned instead of ticking again. The whole point of the run key: a retry
   * of a tick that already authorized a reimbursement must not authorize a
   * second one.
   */
  replayed: boolean
  ranChainPoll: boolean
  ranCognition: boolean
  /** Absent when this tick ran no cognition window at all. */
  windowId?: string
  /** Messages the reader actually saw. Absent means NOT MEASURED, never zero. */
  admittedMessages?: number
  proposals: number
  suppressed: number
  /** `phase:code` per refusal. Closed vocabulary on both halves. */
  refusals: string[]
  disbursed: number
  spendsRefused: number
  published: number
  publishRejected: number
  /** Integer micro-USD. This is money, so it is never carried as a float. */
  inferenceMicroUsd: number
  degradeLevel: string
  modelProvenance: ModelProvenance
  nextDueUnix: number
}

/**
 * The fleet, as the scheduler reaches it.
 *
 * The implementation lives outside ops (see main.ts on OPS_PORTS_MODULE): it
 * owns the Orchestrator, the per-coin runtimes, the model client and the
 * projection into the agent-run store. This port exposes none of that, so the
 * job cannot reach a runtime, cannot see another coin's state, and cannot
 * accidentally tick the whole fleet when it meant to tick one coin.
 *
 * ONE COIN PER CALL, ON PURPOSE. Orchestrator.tickAll is sequential because the
 * ledger store does not row-lock yet, and a job that handed it the whole book
 * would hold one lease over every coin - so one coin's slow chain read would
 * expire the lease for all of them, and one coin's failure would dead-letter
 * the fleet. A scope per coin is what keeps those failures separate.
 */
export interface FleetRunner {
  /**
   * Coins whose next tick is due at `nowUnix`. Ordered by coinRef so two
   * schedulers compute the same list in the same order.
   */
  dueCoins(nowUnix: number): Promise<FleetCoinRef[]>
  /**
   * Tick one coin's team. MUST be idempotent per runKey: a repeat of a run key
   * that already completed returns the stored summary with `replayed: true` and
   * does not tick again.
   */
  tick(input: { coinRef: string; nowUnix: number; runKey: string }): Promise<FleetTickSummary>
  /**
   * The re-entry check, same contract as the sweeper's. Returns what a prior
   * attempt already did under this run key, so a crash between the tick and the
   * scheduler's own bookkeeping is recoverable rather than repeatable.
   */
  findByRunKey(runKey: string): Promise<FleetTickSummary | undefined>
  /**
   * The earliest nextDueUnix any coin last reported, or undefined when no
   * coin has reported one yet (cold start, empty fleet). The scheduler loop
   * sleeps until then rather than for a fixed tick, so a coin due in three
   * seconds is not kept waiting for a thirty-second timer. Synchronous on
   * purpose: it reads what the last tick already learned and never the store.
   */
  earliestDueUnix(): number | undefined
}

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

export interface OpsAlert {
  /**
   * Constrained to the catalog in ops/monitoring. A job cannot raise an alert
   * that has no definition, and therefore cannot raise one that has no runbook.
   */
  alertId: AlertId
  severity: 'page' | 'ticket' | 'info'
  scope: string
  summary: string
  /** Repo-relative path to the runbook. Verified to exist by the monitoring tests. */
  runbook: string
  facts: Record<string, string | number | boolean>
  raisedAtUnix: number
}

export interface AlertSink {
  raise(alert: OpsAlert): Promise<void>
}

/**
 * The alert catalog's inputs and outputs, as the monitoring job reaches them.
 *
 * `collect` gathers the signal snapshot from the stores (a pure read); the
 * evaluator in ops/monitoring is a pure function of it; `raise` records and
 * pages a firing AS THE MONITOR'S, so that `clearResolved` can close it when
 * the condition stops holding - and only it. A page a job raised directly is
 * a human's to clear.
 */
export interface Monitoring {
  collect(nowUnix: number): Promise<OpsSignals>
  raise(alert: OpsAlert): Promise<void>
  /** `active` holds `${alertId}#${scope}` keys. Returns how many firings were cleared. */
  clearResolved(active: ReadonlySet<string>, nowUnix: number): Promise<number>
}

// ---------------------------------------------------------------------------
// The bundle every job is constructed with
// ---------------------------------------------------------------------------

export interface OpsPorts {
  vaults: VaultDirectory
  assets: AssetRegistry
  escrow: EscrowReader
  sweeper: SweepExecutor
  settlement: SettlementExecutor
  ledger: LedgerOps
  qf: QfSource
  tiers: TierRegistry
  predicates: PredicateQueue
  predicateVerifier: PredicateVerifier
  /**
   * The orchestrator's receipt store. The delivery job re-issues a procurement
   * receipt as delivered on its first passing check; that is the only write
   * ops makes to it.
   */
  receipts: ReceiptStore
  reports: ReportBuilder
  reportDelivery: ReportDelivery
  metadata: MetadataWatcher
  screening: ScreeningService
  enforcement: EnforcementActions
  heartbeat: VaultHeartbeat
  publishingHealth: PublishingHealth
  alerts: AlertSink
  monitoring: Monitoring
  /** The per-coin agent teams. See FleetRunner. */
  fleet: FleetRunner
}

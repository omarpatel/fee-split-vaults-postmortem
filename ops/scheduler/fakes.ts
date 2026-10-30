/**
 * In-memory implementations of every port.
 *
 * These are not mocks with recorded expectations. They are small working
 * implementations that hold the same invariants the real ones must hold - the
 * sweeper really does return the same receipt for a repeated runKey, the
 * settlement really does refuse to move the dev leg, the screening store really
 * is monotonic - so a test that passes against them is a test of the job's
 * logic rather than of a stub's convenience.
 *
 * They are also what `npm run scheduler:local` runs against, so the operations
 * plane can be exercised end to end without a chain, a database, or a vendor.
 */

import type {
  Address,
  Asset,
  AssetAddress,
  PredicateResult,
  QfMeasurement,
  QualificationSignals,
  ReconciliationVariance,
  ScreeningResult,
  TxHash,
  WeeklyReport,
} from '@fee-split-vaults/core'
import { InMemoryReceiptStore } from '@fee-split-vaults/orchestrator'
import { InMemoryChannelHealthStore, type ChannelHealthProbe, type ChannelHealthRecord, type ChannelHealthStatus } from '@fee-split-vaults/publisher'
import { canonicalDigest } from '../lib/ids.js'
import type { Clock } from '../lib/time.js'
import type { TierId } from '../lib/protocol.js'
import { emptySignals, type OpsSignals } from '../monitoring/types.js'
import { splitAmount } from './jobs/settle.js'
import type {
  AlertSink,
  AssetRegistry,
  Monitoring,
  CleanRoomReport,
  DuePredicateCheck,
  EnforcementActions,
  EscrowCredit,
  EscrowReader,
  FleetCoinRef,
  FleetRunner,
  FleetTickSummary,
  LedgerOps,
  MetadataChange,
  MetadataWatcher,
  OpsAlert,
  OpsPorts,
  PredicateQueue,
  PublishingAccountRef,
  PublishingHealth,
  PredicateVerifier,
  QfSource,
  ReportBuilder,
  ReportDelivery,
  ScreeningService,
  SettlementExecutor,
  SettlementReceipt,
  SettlementRequest,
  StructuralCheckReport,
  SweepExecutor,
  SweepReceipt,
  SweepRequest,
  ThreeWayMatchReport,
  TierDecision,
  TierRegistry,
  TrialBalanceReport,
  VaultDirectory,
  VaultHeartbeat,
  VaultRef,
} from './ports.js'

// ---------------------------------------------------------------------------

export class FakeVaultDirectory implements VaultDirectory {
  readonly vaults = new Map<Address, VaultRef>()

  add(vault: VaultRef): this {
    this.vaults.set(vault.address, vault)
    return this
  }

  async listByState(states: readonly string[]): Promise<VaultRef[]> {
    return [...this.vaults.values()]
      .filter((v) => states.includes(v.state))
      .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
  }

  async get(vault: Address): Promise<VaultRef | undefined> {
    return this.vaults.get(vault)
  }
}

export class FakeAssetRegistry implements AssetRegistry {
  readonly assets = new Map<AssetAddress, Asset>()

  add(asset: Asset): this {
    this.assets.set(asset.address, asset)
    return this
  }

  async get(asset: AssetAddress): Promise<Asset | undefined> {
    return this.assets.get(asset)
  }

  async list(): Promise<Asset[]> {
    return [...this.assets.values()]
  }
}

// ---------------------------------------------------------------------------

export class FakeEscrowReader implements EscrowReader {
  readonly credits = new Map<string, EscrowCredit>()
  /** Set to make listPending throw, so the "one bad vault does not blind the sweep" path is testable. */
  failFor = new Set<Address>()

  credit(credit: EscrowCredit): this {
    this.credits.set(`${credit.vault}#${credit.asset}`, credit)
    return this
  }

  clear(vault: Address, asset: AssetAddress): void {
    this.credits.delete(`${vault}#${asset}`)
  }

  async listPending(vault: Address): Promise<EscrowCredit[]> {
    if (this.failFor.has(vault)) throw new Error('escrow read failed')
    return [...this.credits.values()].filter((c) => c.vault === vault)
  }
}

export class FakeSweepExecutor implements SweepExecutor {
  readonly byRunKey = new Map<string, SweepReceipt>()
  readonly calls: SweepRequest[] = []
  /** The outbox: receipts the ledger has not acknowledged. */
  readonly pendingRecord = new Map<string, SweepReceipt>()
  #seq = 0

  constructor(
    private readonly clock: Clock,
    private readonly escrow: FakeEscrowReader,
    /** Simulates a short claim, in minor units. */
    public shortfallMinor = 0n,
  ) {}

  async sweep(request: SweepRequest): Promise<SweepReceipt> {
    const prior = this.byRunKey.get(request.runKey)
    if (prior) return prior
    this.calls.push(request)
    this.#seq += 1
    const claimedMinor = request.expectedMinor - this.shortfallMinor
    const receipt: SweepReceipt = {
      sweepId: `sweep-${String(this.#seq).padStart(6, '0')}`,
      runKey: request.runKey,
      vault: request.vault,
      asset: request.asset,
      claimedMinor: claimedMinor < 0n ? 0n : claimedMinor,
      chunks: request.maxChunkMinor === undefined ? 1 : Number((request.expectedMinor + request.maxChunkMinor - 1n) / request.maxChunkMinor),
      txHashes: [`0xtx${String(this.#seq).padStart(4, '0')}`],
      blockHash: `0xblock${String(this.#seq).padStart(4, '0')}`,
      completedAtUnix: this.clock.nowUnix(),
    }
    this.byRunKey.set(request.runKey, receipt)
    this.pendingRecord.set(receipt.sweepId, receipt)
    // The claim really does drain the escrow, so a second run finds nothing.
    const remaining = this.escrow.credits.get(`${request.vault}#${request.asset}`)
    if (remaining) {
      const left = remaining.creditedMinor - receipt.claimedMinor
      if (left > 0n) {
        this.escrow.credit({ ...remaining, creditedMinor: left, usd: { ...remaining.usd, usd: 0 } })
      } else {
        this.escrow.clear(request.vault, request.asset)
      }
    }
    return receipt
  }

  async findByRunKey(runKey: string): Promise<SweepReceipt | undefined> {
    return this.byRunKey.get(runKey)
  }

  async unrecorded(limit: number): Promise<SweepReceipt[]> {
    return [...this.pendingRecord.values()].slice(0, limit)
  }

  async confirmRecorded(sweepId: string): Promise<void> {
    this.pendingRecord.delete(sweepId)
  }
}

export class FakeSettlementExecutor implements SettlementExecutor {
  readonly byRunKey = new Map<string, SettlementReceipt>()
  readonly unsettledBalances = new Map<string, bigint>()
  /** Every dev-leg amount this fake has credited. Never transferred - asserted in tests. */
  readonly devLegCredits: Array<{ vault: Address; asset: AssetAddress; amountMinor: bigint }> = []
  #seq = 0

  constructor(private readonly clock: Clock) {}

  seedUnsettled(vault: Address, asset: AssetAddress, amountMinor: bigint): this {
    this.unsettledBalances.set(`${vault}#${asset}`, amountMinor)
    return this
  }

  async unsettled(vault: Address): Promise<Array<{ asset: AssetAddress; amountMinor: bigint }>> {
    const out: Array<{ asset: AssetAddress; amountMinor: bigint }> = []
    for (const [key, amountMinor] of this.unsettledBalances) {
      const [owner, asset] = key.split('#')
      if (owner === vault && asset !== undefined && amountMinor > 0n) out.push({ asset, amountMinor })
    }
    return out
  }

  async settle(request: SettlementRequest): Promise<SettlementReceipt> {
    const prior = this.byRunKey.get(request.runKey)
    if (prior) return prior
    const split = splitAmount(request.amountMinor, request.operatorBps, request.budgetBps)
    this.#seq += 1
    const receipt: SettlementReceipt = {
      settlementId: `settle-${String(this.#seq).padStart(6, '0')}`,
      vault: request.vault,
      asset: request.asset,
      devLegMinor: split.devLegMinor,
      budgetMinor: split.budgetMinor,
      operatorMinor: split.operatorMinor,
      referrerMinor: 0n,
      settledAtUnix: this.clock.nowUnix(),
    }
    this.byRunKey.set(request.runKey, receipt)
    this.unsettledBalances.set(`${request.vault}#${request.asset}`, 0n)
    this.devLegCredits.push({ vault: request.vault, asset: request.asset, amountMinor: split.devLegMinor })
    return receipt
  }

  async findByRunKey(runKey: string): Promise<SettlementReceipt | undefined> {
    return this.byRunKey.get(runKey)
  }
}

// ---------------------------------------------------------------------------

export class FakeLedgerOps implements LedgerOps {
  readonly sweeps = new Map<string, SweepReceipt>()
  readonly settlements = new Map<string, SettlementReceipt>()
  readonly variances: Array<ReconciliationVariance & { id: string }> = []
  readonly freezes: Array<{ scope: string; reason: string; varianceId?: string }> = []
  readonly matchedSweeps = new Set<string>()

  structuralFailures: StructuralCheckReport['failures'] = []
  trialBalanceMismatches: TrialBalanceReport['mismatches'] = []
  cleanRoomDisagreements: CleanRoomReport['disagreements'] = []
  matchOverrides = new Map<string, Partial<ThreeWayMatchReport>>()
  vaultList: Address[] = []

  async recordSweep(receipt: SweepReceipt): Promise<void> {
    this.sweeps.set(receipt.sweepId, receipt)
  }

  async recordSettlement(receipt: SettlementReceipt): Promise<void> {
    this.settlements.set(receipt.settlementId, receipt)
  }

  async structuralChecks(input: { asOfUnix: number }): Promise<StructuralCheckReport> {
    return {
      checkedAtUnix: input.asOfUnix,
      entriesChecked: this.sweeps.size + this.settlements.size,
      failures: this.structuralFailures,
    }
  }

  async unmatchedSweeps(limit: number): Promise<Array<{ sweepId: string; vault: Address; sweptAtUnix: number }>> {
    return [...this.sweeps.values()]
      .filter((s) => !this.matchedSweeps.has(s.sweepId))
      .slice(0, limit)
      .map((s) => ({ sweepId: s.sweepId, vault: s.vault, sweptAtUnix: s.completedAtUnix }))
  }

  async threeWayMatch(input: { sweepId: string }): Promise<ThreeWayMatchReport> {
    const sweep = this.sweeps.get(input.sweepId)
    if (!sweep) throw new Error(`unknown sweep ${input.sweepId}`)
    this.matchedSweeps.add(input.sweepId)
    const base: ThreeWayMatchReport = {
      sweepId: sweep.sweepId,
      vault: sweep.vault,
      asset: sweep.asset,
      matched: true,
      missingLegs: [],
      legs: [
        { name: 'swept', amountMinor: sweep.claimedMinor },
        { name: 'escrow_credited', amountMinor: sweep.claimedMinor },
        { name: 'received', amountMinor: sweep.claimedMinor },
        { name: 'ledger_recognized', amountMinor: sweep.claimedMinor },
      ],
      worstSeverity: 'info',
      varianceIds: [],
    }
    return { ...base, ...(this.matchOverrides.get(input.sweepId) ?? {}) }
  }

  async recomputeTrialBalance(input: { asOfUnix: number }): Promise<TrialBalanceReport> {
    return {
      asOfUnix: input.asOfUnix,
      vaultsChecked: this.vaultList.length,
      mismatches: this.trialBalanceMismatches,
    }
  }

  async cleanRoomRecompute(input: { asOfUnix: number; vaults: readonly Address[] }): Promise<CleanRoomReport> {
    return {
      asOfUnix: input.asOfUnix,
      vaultsChecked: [...input.vaults],
      topTierVaults: [],
      disagreements: this.cleanRoomDisagreements,
    }
  }

  async recordVariance(variance: ReconciliationVariance & { note?: string }): Promise<string> {
    const id = canonicalDigest({
      vault: variance.vault,
      asset: variance.asset,
      delta: variance.deltaMinor,
      at: variance.detectedAtUnix,
    }).slice(0, 16)
    this.variances.push({ ...variance, id })
    return id
  }

  async freezeAuthorizations(input: { scope: 'global' | Address; reason: string; varianceId?: string }): Promise<void> {
    this.freezes.push({
      scope: input.scope,
      reason: input.reason,
      ...(input.varianceId === undefined ? {} : { varianceId: input.varianceId }),
    })
  }

  async allVaults(): Promise<Address[]> {
    return [...this.vaultList]
  }
}

// ---------------------------------------------------------------------------

export class FakeQfSource implements QfSource {
  readonly measurements = new Map<Address, QfMeasurement>()
  readonly signalsByVault = new Map<Address, QualificationSignals>()

  set(vault: Address, qf: QfMeasurement, signals: QualificationSignals): this {
    this.measurements.set(vault, qf)
    this.signalsByVault.set(vault, signals)
    return this
  }

  async measure(vault: Address, asOfUnix: number): Promise<QfMeasurement> {
    const found = this.measurements.get(vault)
    if (found) return found
    return { vault, qfPerDay: 0, observedDays: 0, sustainedDays: 0, measuredAtUnix: asOfUnix, perAsset: [] }
  }

  async signals(vault: Address): Promise<QualificationSignals> {
    return (
      this.signalsByVault.get(vault) ?? {
        uniqueBuyers7d: 0,
        top10HolderSharePct: 100,
        deployerSupplySharePct: 100,
        selfTradeSharePct: 100,
        venuePoolVolumeSharePct: 0,
        coinAgeDays: 0,
      }
    )
  }
}

export class FakeTierRegistry implements TierRegistry {
  readonly tiers = new Map<Address, TierId>()
  readonly below = new Map<Address, number>()
  readonly applied: TierDecision[] = []
  readonly observations: Array<{ vault: Address; atUnix: number; qfPerDay: number; belowGate: boolean }> = []

  set(vault: Address, tier: TierId, daysBelowGate = 0): this {
    this.tiers.set(vault, tier)
    this.below.set(vault, daysBelowGate)
    return this
  }

  async current(vault: Address): Promise<TierId> {
    return this.tiers.get(vault) ?? 'T0'
  }

  async daysBelowGate(vault: Address): Promise<number> {
    return this.below.get(vault) ?? 0
  }

  async observe(input: { vault: Address; atUnix: number; qfPerDay: number; belowGate: boolean }): Promise<void> {
    this.observations.push(input)
    const current = this.below.get(input.vault) ?? 0
    this.below.set(input.vault, input.belowGate ? current + 1 : 0)
  }

  async apply(decision: TierDecision): Promise<void> {
    this.applied.push(decision)
    this.tiers.set(decision.vault, decision.to)
    this.below.set(decision.vault, 0)
  }
}

// ---------------------------------------------------------------------------

export class FakePredicateQueue implements PredicateQueue {
  due: DuePredicateCheck[] = []
  readonly recorded: Array<{ disbursementId: string; offsetSeconds: number; result: PredicateResult }> = []
  readonly withheld: Array<{ disbursementId: string; vendorId: string; reason: string }> = []
  readonly penalties: Array<{ vendorId: string; reason: string }> = []

  async listDue(nowUnix: number, limit: number): Promise<DuePredicateCheck[]> {
    return this.due.filter((c) => c.dueAtUnix <= nowUnix).slice(0, limit)
  }

  async recordResult(input: {
    disbursementId: string
    offsetSeconds: number
    result: PredicateResult
  }): Promise<void> {
    this.recorded.push(input)
    this.due = this.due.filter(
      (c) => !(c.disbursementId === input.disbursementId && c.offsetSeconds === input.offsetSeconds),
    )
  }

  async withholdPayment(input: { disbursementId: string; vendorId: string; reason: string }): Promise<void> {
    this.withheld.push(input)
  }

  async penalizeVendor(input: { vendorId: string; reason: string }): Promise<void> {
    this.penalties.push(input)
  }
}

/** Fails closed: anything not explicitly marked delivered is not delivered. */
export class FakePredicateVerifier implements PredicateVerifier {
  readonly passing = new Set<string>()

  pass(disbursementId: string, offsetSeconds: number): this {
    this.passing.add(`${disbursementId}@${offsetSeconds}`)
    return this
  }

  async verify(check: DuePredicateCheck): Promise<PredicateResult> {
    const passed = this.passing.has(`${check.disbursementId}@${check.offsetSeconds}`)
    return {
      checkedAtUnix: check.dueAtUnix,
      offsetSeconds: check.offsetSeconds,
      passed,
      evidenceHash: `sha256:${check.disbursementId}`,
      ...(passed ? {} : { note: 'no evidence of delivery' }),
    }
  }
}

// ---------------------------------------------------------------------------

export class FakeReportBuilder implements ReportBuilder {
  reports = new Map<Address, WeeklyReport>()

  set(vault: Address, report: WeeklyReport): this {
    this.reports.set(vault, report)
    return this
  }

  async build(input: { vault: Address; periodStartUnix: number; periodEndUnix: number }): Promise<WeeklyReport> {
    const found = this.reports.get(input.vault)
    if (found) return { ...found, periodStartUnix: input.periodStartUnix, periodEndUnix: input.periodEndUnix }
    return {
      vault: input.vault,
      periodStartUnix: input.periodStartUnix,
      periodEndUnix: input.periodEndUnix,
      qfReceivedUsd: 0,
      devLegUsd: 0,
      budgetSpentUsd: 0,
      operatorFeeUsd: 0,
      referrerFeeUsd: 0,
      lineItems: [],
      verifiedReachSummary: 'no verified reach this period',
      withheldPayments: [],
      whatWeDidNotDo: ['No paid promotion was purchased this period.'],
    }
  }
}

export class FakeReportDelivery implements ReportDelivery {
  readonly delivered: WeeklyReport[] = []
  shouldFail = false

  async deliver(report: WeeklyReport): Promise<{ delivered: boolean; channel: string; externalId?: string }> {
    if (this.shouldFail) return { delivered: false, channel: 'telegram' }
    this.delivered.push(report)
    return { delivered: true, channel: 'telegram', externalId: `msg-${this.delivered.length}` }
  }
}

// ---------------------------------------------------------------------------

export class FakeMetadataWatcher implements MetadataWatcher {
  changes: MetadataChange[] = []
  #cursor = 0

  async changedSince(cursorUnix: number, limit: number): Promise<MetadataChange[]> {
    return this.changes
      .filter((c) => c.observedAtUnix > cursorUnix)
      .sort((a, b) => a.observedAtUnix - b.observedAtUnix)
      .slice(0, limit)
  }

  async cursor(): Promise<number> {
    return this.#cursor
  }

  async advanceCursor(toUnix: number): Promise<void> {
    this.#cursor = Math.max(this.#cursor, toUnix)
  }
}

export class FakeScreeningService implements ScreeningService {
  readonly results = new Map<Address, ScreeningResult & { metadataHash?: string }>()
  nextVerdict: ScreeningResult['verdict'] = 'CLEAR'
  nextFlags: string[] = []

  seed(token: Address, result: ScreeningResult & { metadataHash?: string }): this {
    this.results.set(token, result)
    return this
  }

  async rescreen(input: { token: Address; vault: Address; metadataRef: string }): Promise<ScreeningResult> {
    return {
      token: input.token,
      verdict: this.nextVerdict,
      flags: [...this.nextFlags],
      stagesRun: ['lexicon', 'trademark'],
      screenedAtUnix: 0,
      paidMediaPermitted: this.nextVerdict === 'CLEAR',
    }
  }

  async lastResult(token: Address): Promise<ScreeningResult | undefined> {
    return this.results.get(token)
  }

  async record(result: ScreeningResult & { metadataHash: string }): Promise<void> {
    this.results.set(result.token, result)
  }
}

export class FakeEnforcementActions implements EnforcementActions {
  readonly paidMediaSuspensions: Array<{ vault: Address; reason: string }> = []
  readonly vaultSuspensions: Array<{ vault: Address; reason: string }> = []
  readonly escalations: Array<{ vault: Address; reason: string; severity: string }> = []

  async suspendPaidMedia(input: { vault: Address; reason: string }): Promise<void> {
    this.paidMediaSuspensions.push(input)
  }

  async suspendVault(input: { vault: Address; reason: string }): Promise<void> {
    this.vaultSuspensions.push(input)
  }

  async escalateToHuman(input: { vault: Address; reason: string; severity: 'high' | 'critical' }): Promise<void> {
    this.escalations.push(input)
  }
}

export class FakeVaultHeartbeat implements VaultHeartbeat {
  readonly lastAction = new Map<Address, number>()
  readonly sent: Array<{ vault: Address; atUnix: number }> = []

  constructor(private readonly clock: Clock) {}

  set(vault: Address, lastOperatorActionUnix: number): this {
    this.lastAction.set(vault, lastOperatorActionUnix)
    return this
  }

  async lastOperatorActionUnix(vault: Address): Promise<number> {
    const found = this.lastAction.get(vault)
    if (found === undefined) throw new Error(`unknown vault ${vault}`)
    return found
  }

  async heartbeat(vault: Address): Promise<{ txHash: TxHash; blockHash: string }> {
    const atUnix = this.clock.nowUnix()
    this.sent.push({ vault, atUnix })
    this.lastAction.set(vault, atUnix)
    const digest = canonicalDigest({ vault, atUnix, kind: 'heartbeat' })
    return { txHash: `0x${digest.padEnd(64, '0').slice(0, 64)}`, blockHash: `0x${digest.padEnd(64, 'f').slice(0, 64)}` }
  }
}

/**
 * Bound X accounts with a scripted standing. `probed` records every probe so
 * a test can assert the job asked exactly once per interval; the store is the
 * publisher's own in-memory one, so the same rows gate a publisher in a test.
 */
export class FakePublishingHealth implements PublishingHealth {
  readonly accounts: PublishingAccountRef[] = []
  readonly standing = new Map<string, ChannelHealthStatus>()
  readonly probed: Array<{ accountId: string; atUnix: number }> = []
  readonly store = new InMemoryChannelHealthStore()

  constructor(private readonly clock: Clock) {}

  bind(account: PublishingAccountRef, status: ChannelHealthStatus = 'ok'): this {
    this.accounts.push(account)
    this.standing.set(account.accountId, status)
    return this
  }

  setStanding(accountId: string, status: ChannelHealthStatus): this {
    this.standing.set(accountId, status)
    return this
  }

  async listAccounts(): Promise<readonly PublishingAccountRef[]> {
    return [...this.accounts]
  }

  async probe(account: PublishingAccountRef): Promise<ChannelHealthProbe> {
    const atUnix = this.clock.nowUnix()
    this.probed.push({ accountId: account.accountId, atUnix })
    const status = this.standing.get(account.accountId) ?? 'ok'
    return { status, observedAtUnix: atUnix, detail: `fake ${status}` }
  }

  record(record: ChannelHealthRecord): Promise<void> {
    return this.store.put(record)
  }
}

export class FakeAlertSink implements AlertSink {
  readonly raised: OpsAlert[] = []

  async raise(alert: OpsAlert): Promise<void> {
    this.raised.push(alert)
  }

  byId(alertId: string): OpsAlert[] {
    return this.raised.filter((a) => a.alertId === alertId)
  }
}

/** Signals are whatever the test set; firings and clears are recorded. */
export class FakeMonitoring implements Monitoring {
  signals: OpsSignals | undefined
  readonly raised: OpsAlert[] = []
  readonly open = new Set<string>()
  readonly cleared: string[] = []

  async collect(nowUnix: number): Promise<OpsSignals> {
    return this.signals ?? emptySignals(nowUnix)
  }

  async raise(alert: OpsAlert): Promise<void> {
    this.raised.push(alert)
    this.open.add(`${alert.alertId}#${alert.scope}`)
  }

  async clearResolved(active: ReadonlySet<string>): Promise<number> {
    let n = 0
    for (const key of [...this.open]) {
      if (active.has(key)) continue
      this.open.delete(key)
      this.cleared.push(key)
      n += 1
    }
    return n
  }
}

/**
 * A fleet with no coins in it, and the machinery to put some there.
 *
 * The important behaviour it really implements is the run-key contract: a
 * repeat of a run key returns the stored summary and does NOT tick again. That
 * is the property the fleet-tick job's whole safety argument rests on, so a
 * test that passes against this fake is testing the job's re-entry handling
 * rather than a stub's convenience.
 *
 * modelProvenance defaults to 'fake' here for the obvious reason: nothing
 * behind this object has ever spoken to a model, and a fake that reported
 * 'live' would put a lie in the run record.
 */
export class FakeFleetRunner implements FleetRunner {
  readonly coins = new Map<string, FleetCoinRef>()
  readonly ticks: Array<{ coinRef: string; nowUnix: number; runKey: string }> = []
  readonly #byRunKey = new Map<string, FleetTickSummary>()
  /** Coin refs whose tick throws, so the per-coin dead-letter path is testable. */
  readonly failFor = new Set<string>()
  /** Overrides merged into the summary a tick returns, per coin. */
  readonly summaries = new Map<string, Partial<FleetTickSummary>>()

  add(coin: FleetCoinRef): this {
    this.coins.set(coin.coinRef, coin)
    return this
  }

  async dueCoins(nowUnix: number): Promise<FleetCoinRef[]> {
    return [...this.coins.values()]
      .filter((coin) => nowUnix >= 0)
      .sort((a, b) => (a.coinRef < b.coinRef ? -1 : a.coinRef > b.coinRef ? 1 : 0))
  }

  async tick(input: { coinRef: string; nowUnix: number; runKey: string }): Promise<FleetTickSummary> {
    const replay = this.#byRunKey.get(input.runKey)
    if (replay !== undefined) return { ...replay, replayed: true }
    if (this.failFor.has(input.coinRef)) throw new Error(`fleet tick failed for ${input.coinRef}`)
    const coin = this.coins.get(input.coinRef)
    if (coin === undefined) throw new Error(`no coin ${input.coinRef} in the fleet`)

    this.ticks.push(input)
    const summary: FleetTickSummary = {
      coinRef: coin.coinRef,
      vault: coin.vault,
      tier: 'T1',
      atUnix: input.nowUnix,
      replayed: false,
      ranChainPoll: true,
      ranCognition: true,
      windowId: `${coin.coinRef}:${String(input.nowUnix)}`,
      admittedMessages: 6,
      proposals: 1,
      suppressed: 0,
      refusals: [],
      disbursed: 0,
      spendsRefused: 0,
      published: 1,
      publishRejected: 0,
      inferenceMicroUsd: 1_200,
      degradeLevel: 'full',
      modelProvenance: 'fake',
      nextDueUnix: input.nowUnix + 1_800,
      ...this.summaries.get(input.coinRef),
    }
    this.#byRunKey.set(input.runKey, summary)
    this.coins.set(coin.coinRef, { ...coin, nextDueUnix: summary.nextDueUnix })
    return summary
  }

  async findByRunKey(runKey: string): Promise<FleetTickSummary | undefined> {
    const held = this.#byRunKey.get(runKey)
    return held === undefined ? undefined : { ...held, replayed: true }
  }

  earliestDueUnix(): number | undefined {
    let earliest: number | undefined
    for (const coin of this.coins.values()) {
      if (earliest === undefined || coin.nextDueUnix < earliest) earliest = coin.nextDueUnix
    }
    return earliest
  }
}

// ---------------------------------------------------------------------------

export interface FakePorts extends OpsPorts {
  vaults: FakeVaultDirectory
  assets: FakeAssetRegistry
  escrow: FakeEscrowReader
  sweeper: FakeSweepExecutor
  settlement: FakeSettlementExecutor
  ledger: FakeLedgerOps
  qf: FakeQfSource
  tiers: FakeTierRegistry
  predicates: FakePredicateQueue
  predicateVerifier: FakePredicateVerifier
  receipts: InMemoryReceiptStore
  reports: FakeReportBuilder
  reportDelivery: FakeReportDelivery
  metadata: FakeMetadataWatcher
  screening: FakeScreeningService
  enforcement: FakeEnforcementActions
  heartbeat: FakeVaultHeartbeat
  publishingHealth: FakePublishingHealth
  alerts: FakeAlertSink
  monitoring: FakeMonitoring
  fleet: FakeFleetRunner
}

export function makeFakePorts(clock: Clock): FakePorts {
  const escrow = new FakeEscrowReader()
  return {
    vaults: new FakeVaultDirectory(),
    assets: new FakeAssetRegistry(),
    escrow,
    sweeper: new FakeSweepExecutor(clock, escrow),
    settlement: new FakeSettlementExecutor(clock),
    ledger: new FakeLedgerOps(),
    qf: new FakeQfSource(),
    tiers: new FakeTierRegistry(),
    predicates: new FakePredicateQueue(),
    predicateVerifier: new FakePredicateVerifier(),
    receipts: new InMemoryReceiptStore(),
    reports: new FakeReportBuilder(),
    reportDelivery: new FakeReportDelivery(),
    metadata: new FakeMetadataWatcher(),
    screening: new FakeScreeningService(),
    enforcement: new FakeEnforcementActions(),
    heartbeat: new FakeVaultHeartbeat(clock),
    publishingHealth: new FakePublishingHealth(clock),
    alerts: new FakeAlertSink(),
    monitoring: new FakeMonitoring(),
    fleet: new FakeFleetRunner(),
  }
}

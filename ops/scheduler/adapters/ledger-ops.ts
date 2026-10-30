/**
 * The ledger, as the reconciliation and money jobs reach it.
 *
 * WHO WRITES A MOVEMENT. The ledger's claim and allocation entries are posted
 * by the chain scan (orchestrator `recordChainMovements`), keyed on the
 * transaction and log the movement landed in. That is the one door for a
 * transfer, and this adapter does not open a second one: `recordSweep` and
 * `recordSettlement` record the EXECUTOR'S RECEIPT - what the ops plane says it
 * did - in ops_sweep_match / ops_settlement_record, and the three-way match
 * then compares that receipt with what the chain scan saw and what the book
 * holds. A second writer keyed on the sweep id would post the same claim
 * twice, once per key, which is the double-count the ledger exists to prevent.
 *
 * THE FOUR LEGS of a sweep match, and where each comes from:
 *
 *   swept              the receipt: what the executor claimed.
 *   escrow_credited    the indexer's fee postings for the vault and asset that
 *                      fell between the previous sweep and this one, recognised
 *                      per UTC day under the declared source precedence - the
 *                      same rule the tick's accrual applies, computed here from
 *                      the postings rather than read off the ledger.
 *   received           the chain scan's claim observations whose transaction is
 *                      one of the receipt's. The ERC-20 that actually moved.
 *   ledger_recognized  the ledger's own claim entries for those transactions.
 *
 * A leg that has no observation is null, and null is CRITICAL (the ledger's
 * default policy says so). Sweeps are offered to the match only after
 * RECONCILIATION.sweepMatchGraceSeconds, so a scan that is merely behind does
 * not read as money that never arrived.
 *
 * Variances are written through the ledger facade, so a critical one freezes
 * its scope on the way in; the jobs freeze again explicitly on the report and
 * the freeze id is deterministic, so that is one row rather than two.
 */

import type { Address, AssetAddress, ReconciliationVariance } from '@fee-split-vaults/core'
import type { FeePosting } from '@fee-split-vaults/indexer'
import {
  assertSignRule,
  dailyAccrualKey,
  freezeIdFor,
  freezeScopeKey,
  incomeSummary,
  sweepVarianceId,
  threeWayMatch,
  winningSource,
  type FreezeRecord,
  type FreezeScope,
  type IncomeSource,
  type Ledger,
  type LedgerStore,
  type PerSourceTotals,
  type StoredVariance,
} from '@fee-split-vaults/ledger'
import type { ChainReadModel } from '@fee-split-vaults/orchestrator'
import { canonicalDigest } from '../../lib/ids.js'
import { HOUR } from '../../lib/time.js'
import type { Clock } from '../../lib/time.js'
import type { SqlDriver } from '../../migrations/driver.js'
import { RECONCILIATION } from '../config.js'
import type {
  CleanRoomReport,
  LedgerOps,
  SettlementReceipt,
  StructuralCheckReport,
  SweepReceipt,
  ThreeWayMatchReport,
  TrialBalanceReport,
} from '../ports.js'
import { OpsAdapterError, bigIntOf, intOf, strOf } from './errors.js'

export interface SqlLedgerOpsDeps {
  driver: SqlDriver
  store: LedgerStore
  ledger: Ledger
  chain: Pick<ChainReadModel, 'claims' | 'postings'>
  /**
   * USD of |delta| minor units of an asset at an instant, or undefined when no
   * price is pinned. Undefined classifies as critical - the ledger's rule, not
   * this file's - so a missing price cannot make a variance look small.
   */
  usdOf(asset: AssetAddress, amountMinor: bigint, atUnix: number): number | undefined
  clock: Clock
  /** Overrides RECONCILIATION.sweepMatchGraceSeconds. Tests only. */
  matchGraceSeconds?: number
}

interface SweepRow {
  sweep_id: string
  run_key: string
  vault: string
  asset: string
  claimed_minor: string
  chunks: number | string
  tx_hashes: string
  block_hash: string
  swept_at_unix: number | string
}

/** How far before a sweep's completion its claim transactions may have landed. */
const CLAIM_LOOKBACK_SECONDS = 6 * HOUR

/**
 * Income recognised from postings under the declared precedence, per UTC day:
 * the winning source's total for each accrual key, summed. Pure, and
 * independent of the ledger's own rows.
 */
export function recognizedFromPostings(postings: readonly FeePosting[]): Map<string, bigint> {
  const perKey = new Map<string, { asset: string; totals: PerSourceTotals }>()
  for (const posting of postings) {
    if (posting.creditedMinor <= 0n) continue
    const asset = posting.asset.toLowerCase()
    const key = dailyAccrualKey(posting.vault.toLowerCase(), asset, posting.occurredAtUnix)
    const bucket = perKey.get(key) ?? { asset, totals: {} }
    const source: IncomeSource = posting.source
    bucket.totals[source] = (bucket.totals[source] ?? 0n) + posting.creditedMinor
    perKey.set(key, bucket)
  }
  const byAsset = new Map<string, bigint>()
  for (const { asset, totals } of perKey.values()) {
    const winner = winningSource(totals)
    if (winner === undefined) continue
    byAsset.set(asset, (byAsset.get(asset) ?? 0n) + (totals[winner] ?? 0n))
  }
  return byAsset
}

export class SqlLedgerOps implements LedgerOps {
  constructor(private readonly deps: SqlLedgerOpsDeps) {}

  // -- receipts ---------------------------------------------------------------

  async recordSweep(receipt: SweepReceipt): Promise<void> {
    await this.deps.driver.execute(
      `INSERT INTO ops_sweep_match
           (sweep_id, run_key, vault, asset, claimed_minor, chunks, tx_hashes, block_hash, swept_at_unix, recorded_at_unix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (sweep_id) DO NOTHING`,
      [
        receipt.sweepId,
        receipt.runKey,
        receipt.vault.toLowerCase(),
        receipt.asset.toLowerCase(),
        receipt.claimedMinor.toString(),
        receipt.chunks,
        receipt.txHashes.map((h) => h.toLowerCase()).join(','),
        receipt.blockHash,
        receipt.completedAtUnix,
        this.deps.clock.nowUnix(),
      ],
    )
  }

  async recordSettlement(receipt: SettlementReceipt): Promise<void> {
    await this.deps.driver.execute(
      `INSERT INTO ops_settlement_record
           (settlement_id, vault, asset, dev_leg_minor, budget_minor, operator_minor, referrer_minor, tx_hash, settled_at_unix, recorded_at_unix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (settlement_id) DO NOTHING`,
      [
        receipt.settlementId,
        receipt.vault.toLowerCase(),
        receipt.asset.toLowerCase(),
        receipt.devLegMinor.toString(),
        receipt.budgetMinor.toString(),
        receipt.operatorMinor.toString(),
        receipt.referrerMinor.toString(),
        receipt.txHash ?? null,
        receipt.settledAtUnix,
        this.deps.clock.nowUnix(),
      ],
    )
  }

  // -- structural ------------------------------------------------------------

  /**
   * Invariants the materialized tables must hold on their own, with no chain
   * read and no recompute: every asset scope nets to zero, every account sits
   * on its own side of zero, and every recognition row's figure is the figure
   * its winning source reported.
   */
  async structuralChecks(input: { asOfUnix: number }): Promise<StructuralCheckReport> {
    const failures: StructuralCheckReport['failures'] = []
    const balances = await this.deps.store.listAccountBalances()
    let entriesChecked = 0
    const residual = new Map<string, { vault: Address; asset: AssetAddress; minor: bigint }>()
    for (const row of balances) {
      entriesChecked += row.entryCount
      const key = `${row.vault}|${row.asset}`
      const acc = residual.get(key) ?? { vault: row.vault, asset: row.asset, minor: 0n }
      acc.minor += row.balanceMinor
      residual.set(key, acc)
      try {
        assertSignRule(row.account, row.balanceMinor, { vault: row.vault, asset: row.asset })
      } catch (error) {
        failures.push({
          invariant: 'sign_rule',
          vault: row.vault,
          asset: row.asset,
          detail: `${row.account} balance ${row.balanceMinor.toString()}: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    for (const { vault, asset, minor } of residual.values()) {
      if (minor !== 0n) {
        failures.push({ invariant: 'balanced', vault, asset, detail: `debits minus credits is ${minor.toString()}` })
      }
    }
    for (const recognition of await this.deps.store.listRecognitions()) {
      const winner = winningSource(recognition.perSource)
      const expected = winner === undefined ? undefined : recognition.perSource[winner]
      if (winner !== recognition.recognizedSource || expected !== recognition.recognizedMinor) {
        failures.push({
          invariant: 'recognition_precedence',
          vault: recognition.vault,
          asset: recognition.asset,
          detail:
            `${recognition.accrualKey} recognised ${recognition.recognizedMinor.toString()} from ` +
            `${recognition.recognizedSource}; precedence says ${String(winner)}=${expected?.toString() ?? 'none'}`,
        })
      }
    }
    return { checkedAtUnix: input.asOfUnix, entriesChecked, failures }
  }

  // -- three-way match ----------------------------------------------------------

  async unmatchedSweeps(limit: number): Promise<Array<{ sweepId: string; vault: Address; sweptAtUnix: number }>> {
    const grace = this.deps.matchGraceSeconds ?? RECONCILIATION.sweepMatchGraceSeconds
    const rows = await this.deps.driver.query<Pick<SweepRow, 'sweep_id' | 'vault' | 'swept_at_unix'>>(
      `SELECT sweep_id, vault, swept_at_unix FROM ops_sweep_match
        WHERE matched_at_unix IS NULL AND swept_at_unix <= $1
        ORDER BY swept_at_unix, sweep_id
        LIMIT $2`,
      [this.deps.clock.nowUnix() - grace, limit],
    )
    return rows.map((row) => ({
      sweepId: strOf(row.sweep_id, 'ops_sweep_match.sweep_id'),
      vault: strOf(row.vault, 'ops_sweep_match.vault'),
      sweptAtUnix: intOf(row.swept_at_unix, 'ops_sweep_match.swept_at_unix'),
    }))
  }

  async threeWayMatch(input: { sweepId: string }): Promise<ThreeWayMatchReport> {
    const rows = await this.deps.driver.query<SweepRow>(
      `SELECT sweep_id, run_key, vault, asset, claimed_minor, chunks, tx_hashes, block_hash, swept_at_unix
         FROM ops_sweep_match WHERE sweep_id = $1`,
      [input.sweepId],
    )
    const row = rows[0]
    if (row === undefined) throw new OpsAdapterError('sweep_unknown', `no recorded sweep ${input.sweepId}`)
    const f = 'ops_sweep_match'
    const vault = strOf(row.vault, `${f}.vault`)
    const asset = strOf(row.asset, `${f}.asset`)
    const sweptAtUnix = intOf(row.swept_at_unix, `${f}.swept_at_unix`)
    const sweptMinor = bigIntOf(row.claimed_minor, `${f}.claimed_minor`)
    const txHashes = new Set(
      strOf(row.tx_hashes, `${f}.tx_hashes`)
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0),
    )
    const nowUnix = this.deps.clock.nowUnix()

    // received: the chain scan's own observation of the claim transactions.
    const claims = await this.deps.chain.claims(vault, sweptAtUnix - CLAIM_LOOKBACK_SECONDS, nowUnix)
    let receivedMinor: bigint | undefined
    for (const claim of claims) {
      if (claim.asset.toLowerCase() !== asset || !txHashes.has(claim.txHash.toLowerCase())) continue
      receivedMinor = (receivedMinor ?? 0n) + claim.amountMinor
    }

    // ledger_recognized: the book's claim entries for those same transactions.
    let ledgerMinor: bigint | undefined
    let cursor: string | undefined
    do {
      const page = await this.deps.store.listEntries(
        { vault, asset, fromUnix: sweptAtUnix - CLAIM_LOOKBACK_SECONDS, toUnix: nowUnix },
        cursor,
      )
      for (const entry of page.entries) {
        if (entry.debit !== 'asset:vault' || entry.credit !== 'asset:escrow') continue
        if (entry.txHash === undefined || !txHashes.has(entry.txHash.toLowerCase())) continue
        ledgerMinor = (ledgerMinor ?? 0n) + entry.amountMinor
      }
      cursor = page.cursor
    } while (cursor !== undefined)

    // escrow_credited: what the indexer says accrued to this vault in this
    // asset since the previous recorded sweep. Absent postings are a zero
    // credit, not an unknown: the indexer's coverage is the ledger's coverage.
    const previous = await this.deps.driver.query<{ swept_at_unix: number | string }>(
      `SELECT swept_at_unix FROM ops_sweep_match
        WHERE vault = $1 AND asset = $2 AND swept_at_unix < $3
        ORDER BY swept_at_unix DESC LIMIT 1`,
      [vault, asset, sweptAtUnix],
    )
    const previousRow = previous[0]
    const windowStart = previousRow === undefined ? 0 : intOf(previousRow.swept_at_unix, `${f}.swept_at_unix`)
    const postings = await this.deps.chain.postings(vault, windowStart, sweptAtUnix)
    const credited = recognizedFromPostings(
      postings.filter((p) => p.asset.toLowerCase() === asset && p.occurredAtUnix > windowStart),
    )
    const escrowCreditedMinor = credited.get(asset) ?? 0n

    const result = threeWayMatch({
      sweepId: input.sweepId,
      vault,
      asset,
      observedAtUnix: nowUnix,
      sweptMinor,
      escrowCreditedMinor,
      ...(receivedMinor === undefined ? {} : { receivedMinor }),
      ...(ledgerMinor === undefined ? {} : { ledgerRecognizedMinor: ledgerMinor }),
      usdOfDelta: (deltaMinor) => this.deps.usdOf(asset, deltaMinor, nowUnix),
    })

    const varianceIds: string[] = []
    for (let i = 0; i < result.pairwise.length; i += 1) {
      const pair = result.pairwise[i]
      const variance = result.variances[i]
      if (pair === undefined || variance === undefined) continue
      const id = sweepVarianceId(input.sweepId, pair.a, pair.b)
      await this.deps.ledger.recordVariance({ ...variance, id, note: `sweep ${input.sweepId}: ${pair.a} vs ${pair.b}` })
      varianceIds.push(id)
    }

    await this.deps.driver.execute(
      `UPDATE ops_sweep_match SET matched_at_unix = $2, match_status = $3, variance_ids = $4 WHERE sweep_id = $1`,
      [input.sweepId, nowUnix, result.status, varianceIds.length === 0 ? null : varianceIds.join(',')],
    )

    return {
      sweepId: input.sweepId,
      vault,
      asset,
      matched: result.status === 'matched',
      missingLegs: result.missingLegs,
      legs: result.legs.map((leg) => ({ name: leg.name, amountMinor: leg.amountMinor })),
      worstSeverity: result.worstSeverity,
      varianceIds,
    }
  }

  // -- recomputes ---------------------------------------------------------------

  async recomputeTrialBalance(input: { asOfUnix: number }): Promise<TrialBalanceReport> {
    const verification = await this.deps.ledger.verifyBalances()
    const vaults = new Set<string>()
    for (const row of await this.deps.store.listAccountBalances()) vaults.add(row.vault)
    return {
      asOfUnix: input.asOfUnix,
      vaultsChecked: vaults.size,
      mismatches: verification.balanceDiffs.map((diff) => ({
        vault: diff.vault,
        asset: diff.asset,
        account: diff.account,
        materializedMinor: diff.materializedMinor ?? 0n,
        recomputedMinor: diff.recomputedMinor ?? 0n,
      })),
    }
  }

  /**
   * Income per vault and asset, twice: once from the ledger's flow totals,
   * once from the indexer's postings under the precedence rule. The two share
   * the rule and nothing else - not the store, not the accrual code path.
   */
  async cleanRoomRecompute(input: { asOfUnix: number; vaults: readonly Address[] }): Promise<CleanRoomReport> {
    const disagreements: CleanRoomReport['disagreements'] = []
    for (const vault of input.vaults) {
      const key = vault.toLowerCase()
      const primary = new Map<string, bigint>()
      for (const row of incomeSummary(await this.deps.store.listFlowTotals({ vault: key }))) {
        primary.set(row.asset.toLowerCase(), row.recognizedMinor)
      }
      const cleanRoom = recognizedFromPostings(await this.deps.chain.postings(key, 0, input.asOfUnix))
      const assets = new Set([...primary.keys(), ...cleanRoom.keys()])
      for (const asset of [...assets].sort()) {
        const primaryMinor = primary.get(asset) ?? 0n
        const cleanRoomMinor = cleanRoom.get(asset) ?? 0n
        if (primaryMinor !== cleanRoomMinor) disagreements.push({ vault: key, asset, primaryMinor, cleanRoomMinor })
      }
    }
    return { asOfUnix: input.asOfUnix, vaultsChecked: [...input.vaults], topTierVaults: [], disagreements }
  }

  // -- variances and freezes --------------------------------------------------

  async recordVariance(variance: ReconciliationVariance & { note?: string }): Promise<string> {
    const id = `vr_${canonicalDigest({
      vault: variance.vault,
      asset: variance.asset,
      ledger: variance.ledgerBalanceMinor.toString(),
      chain: variance.chainBalanceMinor.toString(),
      at: variance.detectedAtUnix,
    }).slice(0, 32)}`
    const stored: StoredVariance = {
      id,
      vault: variance.vault,
      asset: variance.asset,
      ledgerBalanceMinor: variance.ledgerBalanceMinor,
      chainBalanceMinor: variance.chainBalanceMinor,
      deltaMinor: variance.deltaMinor,
      severity: variance.severity,
      detectedAtUnix: variance.detectedAtUnix,
      ...(variance.note === undefined ? {} : { note: variance.note }),
    }
    await this.deps.ledger.recordVariance(stored)
    return id
  }

  async freezeAuthorizations(input: { scope: 'global' | Address; reason: string; varianceId?: string }): Promise<void> {
    const scope: FreezeScope = input.scope === 'global' ? { kind: 'global' } : { kind: 'vault', vault: input.scope }
    // One freeze per live cause. A check that finds the same breach every
    // five minutes must not write sixty rows a day, and a breach that recurs
    // after a human cleared the first freeze must freeze again - so the
    // dedupe is against the ACTIVE freezes, not against an id.
    const all = await this.deps.store.listFreezes(false)
    const sameCause = all.filter(
      (f) =>
        freezeScopeKey(f.scope) === freezeScopeKey(scope) &&
        (input.varianceId === undefined ? f.reason === input.reason : f.varianceId === input.varianceId),
    )
    if (sameCause.some((f) => f.clearedAtUnix === undefined)) return
    const nowUnix = this.deps.clock.nowUnix()
    // The sequence number is what makes a re-freeze after clearance a new row
    // rather than the cleared one found again by id.
    const cause = `${input.varianceId ?? canonicalDigest({ reason: input.reason }).slice(0, 16)}_${String(sameCause.length)}`
    const freeze: FreezeRecord = {
      id: freezeIdFor(scope, cause),
      scope,
      reason: input.reason,
      frozenAtUnix: nowUnix,
      ...(input.varianceId === undefined ? {} : { varianceId: input.varianceId }),
    }
    await this.deps.store.putFreeze(freeze)
  }

  async allVaults(): Promise<Address[]> {
    const vaults = new Set<string>()
    for (const row of await this.deps.store.listAccountBalances()) vaults.add(row.vault)
    return [...vaults].sort()
  }
}

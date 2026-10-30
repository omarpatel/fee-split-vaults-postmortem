/**
 * The signal collector: one snapshot of everything the alert catalog reads,
 * gathered from the stores the jobs already write.
 *
 * A pure read. Nothing here decides anything - the catalog in alerts.ts does,
 * and it only ever sees this plain object. Each signal names its source:
 *
 *   ledger      ledger_variance / ledger_freeze via the ledger store, and the
 *               three-way match backlog in ops_sweep_match.
 *   chain       the indexer's halt notices (recipient transfers), its pending
 *               owner overrides, the quote_asset kill switch, and the gas
 *               subsidy expiry from config.
 *   spend       spend outcomes in the tick run records (ops_agent_run).
 *   publishing  the publisher's own post registry (publication), and the
 *               account health log (publisher_account_health) the
 *               publishing.health job appends to: the newest row per bound X
 *               account, when it is not `ok`, is a suspended channel.
 *   security    reader gists trusted code rejected + planner violations, from
 *               the run records.
 *   tiers       ops_tier_history.
 *   cost        cost_micro_usd per vault per day against the tier's COGS.
 *   sweeps      ops_sweep_match / ops_settlement_record ages, with the
 *               pending escrow value read live.
 *   ops         ops_dead_letter and ops_job_run.
 *
 * Nothing is zeroed to hide an unreadable store: a query failure propagates
 * and the monitoring job fails visibly.
 */

import type { LedgerStore } from '@fee-split-vaults/ledger'
import type { ChainReadModel } from '@fee-split-vaults/orchestrator'
import { OpsAdapterError, floatOf, intOf, strOf } from '../scheduler/adapters/errors.js'
import type { PgAlertLog } from '../scheduler/adapters/alerts.js'
import { GAS_SUBSIDY_EXPIRY_UNIX, OBSERVED_STATES } from '../scheduler/config.js'
import type { AlertSink, EscrowReader, Monitoring, OpsAlert, VaultDirectory } from '../scheduler/ports.js'
import { DAY, HOUR } from '../lib/time.js'
import { TIERS, type TierId } from '../lib/protocol.js'
import type { SqlDriver } from '../migrations/driver.js'
import type { OpsSignals } from './types.js'

export const MONITOR_ID = 'monitoring.evaluate'

export interface PgSignalCollectorDeps {
  driver: SqlDriver
  ledgerStore: LedgerStore
  vaults: VaultDirectory
  /** The indexer's halt notices for a token. */
  halts: Pick<ChainReadModel, 'halts'>
  /** Pending escrow per vault, priced. Absent means `sweeps.stalest.pendingUsd` refuses. */
  escrow: EscrowReader
}

interface CountRow {
  n: number | string
}

export class PgSignalCollector {
  constructor(private readonly deps: PgSignalCollectorDeps) {}

  async collect(nowUnix: number): Promise<OpsSignals> {
    const { driver } = this.deps
    const vaults = await this.deps.vaults.listByState(OBSERVED_STATES)

    // ---- ledger
    const freezes = await this.deps.ledgerStore.listFreezes(true)
    const frozenVarianceIds = new Set(freezes.map((f) => f.varianceId).filter((id): id is string => id !== undefined))
    const activeFreezeScopes = [...new Set(freezes.map((f) => (f.scope.kind === 'global' ? 'global' : 'vault' in f.scope ? f.scope.vault : f.scope.asset)))]
    const openCriticalVariances = (await this.deps.ledgerStore.listVariances())
      .filter((v) => v.severity === 'critical' && frozenVarianceIds.has(v.id))
      .map((v) => ({ vault: v.vault, asset: v.asset, deltaMinor: v.deltaMinor.toString(), detectedAtUnix: v.detectedAtUnix }))
    const oldestUnmatched = await driver.query<{ oldest: number | string | null }>(
      `SELECT MIN(swept_at_unix) AS oldest FROM ops_sweep_match WHERE matched_at_unix IS NULL`,
    )
    const oldest = oldestUnmatched[0]?.oldest
    const unmatchedSweepsOlderThanSeconds = oldest === null || oldest === undefined ? 0 : nowUnix - intOf(oldest, 'ops_sweep_match.swept_at_unix')

    // ---- chain
    const recipientTransfersOnActiveVaults: OpsSignals['chain']['recipientTransfersOnActiveVaults'] = []
    for (const vault of vaults) {
      for (const halt of await this.deps.halts.halts(vault.token)) {
        if (halt.reason !== 'recipient_transferred') continue
        recipientTransfersOnActiveVaults.push({
          vault: vault.address,
          token: vault.token,
          observedAtUnix: halt.detectedAtUnix,
          blockHash: halt.evidence?.blockHash ?? 'unknown',
        })
      }
    }
    const overrides = await driver.query<{ token: string; effective_at_unix: number | string; proposed_at_unix: number | string | null }>(
      `SELECT token, effective_at_unix, proposed_at_unix FROM indexer_pending_override`,
    )
    const pendingRecipientChangeProposals = overrides.map((row) => ({
      token: strOf(row.token, 'indexer_pending_override.token'),
      effectiveAtUnix: intOf(row.effective_at_unix, 'indexer_pending_override.effective_at_unix'),
      proposedAtUnix: row.proposed_at_unix === null || row.proposed_at_unix === undefined ? 0 : intOf(row.proposed_at_unix, 'indexer_pending_override.proposed_at_unix'),
    }))
    const disabledAssets = await driver.query<{ address: string; symbol: string; disabled_at_unix: number | string | null }>(
      `SELECT address, symbol, disabled_at_unix FROM quote_asset WHERE enabled = FALSE`,
    )
    const pausedQuoteAssets: OpsSignals['chain']['pausedQuoteAssets'] = []
    for (const row of disabledAssets) {
      const asset = strOf(row.address, 'quote_asset.address').toLowerCase()
      let strandedEscrowUsd = 0
      for (const vault of vaults) {
        for (const credit of await this.deps.escrow.listPending(vault.address)) {
          if (credit.asset.toLowerCase() === asset) strandedEscrowUsd += credit.usd.usd
        }
      }
      pausedQuoteAssets.push({
        asset,
        symbol: strOf(row.symbol, 'quote_asset.symbol'),
        strandedEscrowUsd,
        pausedAtUnix: row.disabled_at_unix === null || row.disabled_at_unix === undefined ? nowUnix : intOf(row.disabled_at_unix, 'quote_asset.disabled_at_unix'),
      })
    }

    // ---- spend, security, cost: from the tick run records
    const runs = await driver.query<{
      vault: string
      tier: string
      at_unix: number | string
      spends_json: string
      rejected_gist_count: number | string | null
      violation_count: number | string
      cost_micro_usd: number | string
    }>(
      `SELECT vault, tier, at_unix, spends_json, rejected_gist_count, violation_count, cost_micro_usd
         FROM ops_agent_run WHERE at_unix > $1`,
      [nowUnix - DAY],
    )
    let denialsLastHour = 0
    let denialsDay = 0
    const denialsByGate: Record<string, number> = {}
    let tripsLastHour = 0
    let tripsDay = 0
    const costByVault = new Map<string, { tier: TierId; microUsd: bigint }>()
    for (const row of runs) {
      const atUnix = intOf(row.at_unix, 'ops_agent_run.at_unix')
      const lastHour = atUnix > nowUnix - HOUR
      const spends: unknown = JSON.parse(strOf(row.spends_json, 'ops_agent_run.spends_json'))
      if (!Array.isArray(spends)) throw new OpsAdapterError('row_malformed', 'ops_agent_run.spends_json is not an array')
      for (const spend of spends as Array<Record<string, unknown>>) {
        if (spend.approved === true) continue
        denialsDay += 1
        if (!lastHour) continue
        denialsLastHour += 1
        const gate = typeof spend.failedGate === 'string' ? spend.failedGate : 'unknown'
        denialsByGate[gate] = (denialsByGate[gate] ?? 0) + 1
      }
      const trips = intOf(row.rejected_gist_count ?? 0, 'ops_agent_run.rejected_gist_count') + intOf(row.violation_count, 'ops_agent_run.violation_count')
      tripsDay += trips
      if (lastHour) tripsLastHour += trips
      const tier = strOf(row.tier, 'ops_agent_run.tier')
      if (!(tier in TIERS)) throw new OpsAdapterError('row_malformed', `ops_agent_run.tier ${tier} is not a tier`)
      const vault = strOf(row.vault, 'ops_agent_run.vault')
      const cost = costByVault.get(vault) ?? { tier: tier as TierId, microUsd: 0n }
      cost.microUsd += BigInt(intOf(row.cost_micro_usd, 'ops_agent_run.cost_micro_usd'))
      costByVault.set(vault, cost)
    }
    const perCoin = [...costByVault.entries()].map(([vault, c]) => ({
      vault,
      tier: c.tier,
      inferenceUsdPerDay: Number(c.microUsd) / 1_000_000,
      tierCogsPerDay: TIERS[c.tier].cogsPerDay,
    }))

    // ---- publishing
    const publishes = await driver.query<CountRow>(`SELECT count(*) AS n FROM publication WHERE published_at_unix > $1`, [nowUnix - HOUR])
    const readBackFailures = await driver.query<CountRow>(
      `SELECT count(*) AS n FROM publication WHERE read_back_verified = FALSE AND read_back_at_unix > $1`,
      [nowUnix - HOUR],
    )
    // The newest verdict per account; a non-ok one is a channel we cannot post
    // from. detected_at is the onset of the current non-ok run (the first row
    // after the last ok), so the alert's scope and timestamp hold still while
    // the probe keeps re-confirming. Affected vaults are the bindings that
    // still name the account: one ticker per account, so usually one.
    const unhealthy = await driver.query<{ channel: string; account_id: string; status: string; detected_at_unix: number | string; affected: number | string }>(
      `SELECT latest.channel, latest.account_id, latest.status,
              (SELECT MIN(h.observed_at_unix) FROM publisher_account_health h
                WHERE h.channel = latest.channel AND h.account_id = latest.account_id
                  AND h.observed_at_unix > COALESCE((SELECT MAX(o.observed_at_unix) FROM publisher_account_health o
                                                       WHERE o.channel = latest.channel AND o.account_id = latest.account_id
                                                         AND o.status = 'ok'), 0)) AS detected_at_unix,
              (SELECT count(*) FROM publisher_account_binding b
                WHERE b.channel = latest.channel AND b.account_id = latest.account_id) AS affected
         FROM (SELECT DISTINCT ON (channel, account_id) channel, account_id, status
                 FROM publisher_account_health
                ORDER BY channel, account_id, observed_at_unix DESC, id DESC) latest
        WHERE latest.status <> 'ok'
        ORDER BY latest.channel, latest.account_id`,
    )
    const suspendedChannels: OpsSignals['publishing']['suspendedChannels'] = unhealthy.map((row) => ({
      channel: strOf(row.channel, 'publisher_account_health.channel'),
      accountRef: strOf(row.account_id, 'publisher_account_health.account_id'),
      detectedAtUnix: intOf(row.detected_at_unix, 'publisher_account_health.observed_at_unix'),
      affectedVaults: intOf(row.affected, 'publisher_account_binding.count'),
    }))

    // ---- tiers
    const downgrades = await driver.query<{ vault: string; from_tier: string; to_tier: string; qf_per_day_usd: number | string }>(
      `SELECT vault, from_tier, to_tier, qf_per_day_usd FROM ops_tier_history WHERE direction = 'down' AND decided_at_unix > $1`,
      [nowUnix - DAY],
    )

    // ---- sweeps
    const stalest: OpsSignals['sweeps']['stalest'] = []
    let oldestUnsettledSeconds = 0
    for (const vault of vaults) {
      const credits = await this.deps.escrow.listPending(vault.address)
      for (const credit of credits) {
        const asset = credit.asset.toLowerCase()
        const last = await driver.query<{ swept_at_unix: number | string }>(
          `SELECT MAX(swept_at_unix) AS swept_at_unix FROM ops_sweep_match WHERE vault = $1 AND asset = $2`,
          [vault.address.toLowerCase(), asset],
        )
        const lastSwept = last[0]?.swept_at_unix
        const since = lastSwept === null || lastSwept === undefined ? nowUnix - (vault.activatedAtUnix ?? nowUnix) : nowUnix - intOf(lastSwept, 'ops_sweep_match.swept_at_unix')
        stalest.push({ scope: `${vault.address}#${asset}`, secondsSinceLastSweep: since, pendingUsd: credit.usd.usd })
      }
    }
    const unsettled = await driver.query<{ swept_at_unix: number | string }>(
      `SELECT s.swept_at_unix FROM ops_sweep_match s
        WHERE NOT EXISTS (
          SELECT 1 FROM ops_settlement_record r
           WHERE r.vault = s.vault AND r.asset = s.asset AND r.settled_at_unix >= s.swept_at_unix)
        ORDER BY s.swept_at_unix LIMIT 1`,
    )
    const oldestUnsettled = unsettled[0]?.swept_at_unix
    if (oldestUnsettled !== undefined && oldestUnsettled !== null) {
      oldestUnsettledSeconds = nowUnix - intOf(oldestUnsettled, 'ops_sweep_match.swept_at_unix')
    }

    // ---- the scheduler itself
    const deadLetters = await driver.query<{ job_id: string; n: number | string }>(
      `SELECT job_id, count(*) AS n FROM ops_dead_letter WHERE resolved_at_unix IS NULL GROUP BY job_id`,
    )
    const deadLettersByJob: Record<string, number> = {}
    let openDeadLetters = 0
    for (const row of deadLetters) {
      const n = intOf(row.n, 'ops_dead_letter.count')
      deadLettersByJob[strOf(row.job_id, 'ops_dead_letter.job_id')] = n
      openDeadLetters += n
    }
    const lastTick = await driver.query<{ t: number | string | null }>(`SELECT MAX(updated_at_unix) AS t FROM ops_job_run`)
    const t = lastTick[0]?.t
    const lastTickUnix = t === null || t === undefined ? nowUnix : intOf(t, 'ops_job_run.updated_at_unix')

    return {
      atUnix: nowUnix,
      ledger: { openCriticalVariances, activeFreezeScopes, unmatchedSweepsOlderThanSeconds },
      chain: { recipientTransfersOnActiveVaults, pendingRecipientChangeProposals, pausedQuoteAssets, gasSubsidyExpiryUnix: GAS_SUBSIDY_EXPIRY_UNIX },
      spend: { denialsLastHour, denialsPerHourBaseline: denialsDay / 24, denialsByGate },
      publishing: {
        publishesLastHour: intOf(publishes[0]?.n ?? 0, 'publication.count'),
        readBackFailuresLastHour: intOf(readBackFailures[0]?.n ?? 0, 'publication.count'),
        suspendedChannels,
      },
      security: { injectionDetectorTripsLastHour: tripsLastHour, injectionTripsBaselinePerHour: tripsDay / 24 },
      tiers: {
        downgradesLastDay: downgrades.map((row) => ({
          vault: strOf(row.vault, 'ops_tier_history.vault'),
          from: strOf(row.from_tier, 'ops_tier_history.from_tier'),
          to: strOf(row.to_tier, 'ops_tier_history.to_tier'),
          qfPerDay: floatOf(row.qf_per_day_usd, 'ops_tier_history.qf_per_day_usd'),
        })),
      },
      cost: { perCoin },
      sweeps: { stalest, oldestUnsettledSeconds },
      ops: { openDeadLetters, deadLettersByJob, lastTickUnix },
    }
  }
}

/** The Monitoring port: collector in, log-then-page out, clears only its own. */
export class PgMonitoring implements Monitoring {
  constructor(
    private readonly collector: PgSignalCollector,
    private readonly log: PgAlertLog,
    private readonly webhook: AlertSink,
  ) {}

  collect(nowUnix: number): Promise<OpsSignals> {
    return this.collector.collect(nowUnix)
  }

  async raise(alert: OpsAlert): Promise<void> {
    await this.log.record(alert, MONITOR_ID)
    await this.webhook.raise(alert)
  }

  clearResolved(active: ReadonlySet<string>, nowUnix: number): Promise<number> {
    return this.log.clearResolved(MONITOR_ID, active, nowUnix)
  }
}

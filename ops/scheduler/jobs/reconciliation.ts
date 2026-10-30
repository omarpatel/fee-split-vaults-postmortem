/**
 * THE RECONCILIATION SUITE.
 *
 * Four jobs at four cadences, because they catch four different failures and a
 * single "reconcile" job would run at the speed of its slowest check:
 *
 *   structural    every 5 min   in-process invariants over the ledger itself.
 *                               Catches an unbalanced entry or an income
 *                               recognised twice, seconds after it is written.
 *   sweep match   every 2 min   the three-way match for each new sweep: the
 *                               hook's PoolFeesSwept, the escrow credit, and the
 *                               ERC-20 that actually landed - plus the ledger's
 *                               own figure as a fourth leg. A MISSING leg is a
 *                               failure. Absent evidence is not evidence.
 *   trial balance daily 02:00   recompute every balance from ledger_entry and
 *                               diff against the materialized table. This is the
 *                               only check that catches a broken incremental
 *                               maintainer, because it does not use it.
 *   clean room    weekly Sun    an independent recompute from raw chain logs
 *                               over a 5% sample PLUS 100% of top-tier coins.
 *                               Catches a shared bug that both the ledger and
 *                               its own recompute would agree about.
 *
 * NONE OF THESE MOVE MONEY, and all four are exempt from the authorization
 * freeze. A freeze that stopped reconciliation could never be lifted, because
 * lifting it requires knowing the books are right.
 */

import type { Address } from '@fee-split-vaults/core'
import { sha256Hex } from '../../lib/ids.js'
import { RECONCILIATION } from '../config.js'
import type { OpsPorts } from '../ports.js'
import { dailyDue, intervalDue, weeklyDue } from '../triggers.js'
import { FLEET_SCOPE } from './scope.js'
import type { DueScopeInput, JobContext, JobDefinition, JobOutcome, ScheduledRun } from '../types.js'

// ---------------------------------------------------------------------------
// 1. Continuous structural checks
// ---------------------------------------------------------------------------

export function reconStructuralJob(ports: OpsPorts): JobDefinition {
  return {
    id: 'recon.structural',
    description: 'Runs the ledger’s structural invariants continuously and freezes authorizations on a breach.',
    triggers: [{ kind: 'interval', everySeconds: RECONCILIATION.structuralEverySeconds }],
    maxAttempts: 3,
    leaseSeconds: 300,
    timeoutSeconds: 120,
    retryBaseSeconds: 20,
    movesMoney: false,

    async dueScopes(input: DueScopeInput): Promise<ScheduledRun[]> {
      const last = await input.lastSuccessUnix(FLEET_SCOPE)
      const due = intervalDue(input.nowUnix, last, RECONCILIATION.structuralEverySeconds)
      if (!due.due) return []
      return [
        {
          jobId: 'recon.structural',
          scope: FLEET_SCOPE,
          period: due.period,
          reason: { kind: 'interval', sinceLastSeconds: due.sinceLastSeconds },
        },
      ]
    },

    async run(ctx: JobContext): Promise<JobOutcome> {
      const report = await ports.ledger.structuralChecks({ asOfUnix: ctx.nowUnix })
      if (report.failures.length === 0) {
        return { ok: true, code: 'clean', facts: { entries_checked: report.entriesChecked } }
      }

      // A structural failure is always critical: the ledger disagrees with
      // itself, so every downstream number is suspect until it is resolved.
      for (const failure of report.failures) {
        await ports.ledger.freezeAuthorizations({
          scope: failure.vault ?? 'global',
          reason: `structural invariant ${failure.invariant}`,
        })
      }
      await ports.alerts.raise({
        alertId: 'ledger_variance_critical',
        severity: 'page',
        scope: ctx.scope,
        summary: `Ledger structural invariant breached (${report.failures.length})`,
        runbook: 'ops/runbooks/ledger-variance-critical.md',
        facts: {
          failures: report.failures.length,
          first_invariant: report.failures[0]?.invariant ?? 'unknown',
          entries_checked: report.entriesChecked,
        },
        raisedAtUnix: ctx.nowUnix,
      })
      ctx.log.error('recon.structural.breach', {
        failures: report.failures.length,
        invariants: report.failures.map((f) => f.invariant).join(','),
      })
      // The job itself SUCCEEDED - it checked, and it found something. Returning
      // a failure here would retry the same check and re-raise the same page.
      return { ok: true, code: 'breach_detected', facts: { failures: report.failures.length } }
    },
  }
}

// ---------------------------------------------------------------------------
// 2. Per-sweep three-way match
// ---------------------------------------------------------------------------

export function reconSweepMatchJob(ports: OpsPorts): JobDefinition {
  return {
    id: 'recon.sweep_match',
    description: 'Three-way matches each sweep against the hook, the escrow and the token contract.',
    triggers: [
      { kind: 'interval', everySeconds: RECONCILIATION.sweepMatchEverySeconds },
      { kind: 'event', event: 'sweep_completed' },
    ],
    maxAttempts: 4,
    leaseSeconds: 300,
    timeoutSeconds: 180,
    retryBaseSeconds: 30,
    movesMoney: false,

    async dueScopes(input: DueScopeInput): Promise<ScheduledRun[]> {
      const last = await input.lastSuccessUnix(FLEET_SCOPE)
      const due = intervalDue(input.nowUnix, last, RECONCILIATION.sweepMatchEverySeconds)
      if (!due.due && input.events.length === 0) return []
      return [
        {
          jobId: 'recon.sweep_match',
          scope: FLEET_SCOPE,
          period: input.events.length > 0 ? `e${Math.floor(input.nowUnix / 60)}` : due.period,
          reason:
            input.events.length > 0
              ? { kind: 'event', event: 'sweep_completed' }
              : { kind: 'interval', sinceLastSeconds: due.sinceLastSeconds },
        },
      ]
    },

    async run(ctx: JobContext): Promise<JobOutcome> {
      const pending = await ports.ledger.unmatchedSweeps(RECONCILIATION.sweepMatchBatch)
      let matched = 0
      let mismatched = 0
      let critical = 0

      for (const sweep of pending) {
        const report = await ports.ledger.threeWayMatch({ sweepId: sweep.sweepId })
        if (report.matched && report.missingLegs.length === 0) {
          matched += 1
          continue
        }
        mismatched += 1

        const isCritical = report.worstSeverity === 'critical' || report.missingLegs.length > 0
        if (isCritical) {
          critical += 1
          await ports.ledger.freezeAuthorizations({
            scope: report.vault,
            reason: `three-way match failed for sweep ${report.sweepId}`,
            ...(report.varianceIds[0] === undefined ? {} : { varianceId: report.varianceIds[0] }),
          })
          await ports.alerts.raise({
            alertId: 'ledger_variance_critical',
            severity: 'page',
            scope: report.vault,
            summary: `Three-way match failed for sweep ${report.sweepId}`,
            runbook: 'ops/runbooks/ledger-variance-critical.md',
            facts: {
              sweep_id: report.sweepId,
              vault: report.vault,
              asset: report.asset,
              missing_legs: report.missingLegs.join(','),
              legs: report.legs.map((l) => `${l.name}=${l.amountMinor === null ? 'null' : l.amountMinor}`).join(' '),
            },
            raisedAtUnix: ctx.nowUnix,
          })
        }
        ctx.log.warn('recon.sweep_match.mismatch', {
          sweep_id: report.sweepId,
          vault: report.vault,
          severity: report.worstSeverity,
          missing_legs: report.missingLegs.join(','),
        })
      }

      return {
        ok: true,
        code: mismatched === 0 ? 'all_matched' : 'mismatches_found',
        facts: { checked: pending.length, matched, mismatched, critical },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 3. Daily trial-balance recompute
// ---------------------------------------------------------------------------

export function reconTrialBalanceJob(ports: OpsPorts): JobDefinition {
  return {
    id: 'recon.trial_balance',
    description: 'Recomputes every balance from ledger_entry and diffs it against the materialized table.',
    triggers: [
      {
        kind: 'daily',
        atUtcHour: RECONCILIATION.trialBalanceAtUtcHour,
        atUtcMinute: RECONCILIATION.trialBalanceAtUtcMinute,
      },
    ],
    maxAttempts: 3,
    leaseSeconds: 2 * 3600,
    timeoutSeconds: 3600,
    retryBaseSeconds: 300,
    movesMoney: false,

    async dueScopes(input: DueScopeInput): Promise<ScheduledRun[]> {
      const last = await input.lastSuccessUnix(FLEET_SCOPE)
      const due = dailyDue(
        input.nowUnix,
        RECONCILIATION.trialBalanceAtUtcHour,
        RECONCILIATION.trialBalanceAtUtcMinute,
        last,
      )
      if (!due.due) return []
      return [
        {
          jobId: 'recon.trial_balance',
          scope: FLEET_SCOPE,
          period: due.period,
          reason: { kind: 'daily', dayKey: due.period },
        },
      ]
    },

    async run(ctx: JobContext): Promise<JobOutcome> {
      const report = await ports.ledger.recomputeTrialBalance({ asOfUnix: ctx.nowUnix })
      if (report.mismatches.length === 0) {
        return { ok: true, code: 'balanced', facts: { vaults_checked: report.vaultsChecked } }
      }

      const vaults = new Set(report.mismatches.map((m) => m.vault))
      for (const vault of vaults) {
        await ports.ledger.freezeAuthorizations({
          scope: vault,
          reason: 'trial balance disagrees with the materialized balance table',
        })
      }
      await ports.alerts.raise({
        alertId: 'ledger_variance_critical',
        severity: 'page',
        scope: ctx.scope,
        summary: `Trial balance mismatch on ${vaults.size} vault(s)`,
        runbook: 'ops/runbooks/ledger-variance-critical.md',
        facts: {
          vaults_checked: report.vaultsChecked,
          mismatches: report.mismatches.length,
          vaults_frozen: vaults.size,
        },
        raisedAtUnix: ctx.nowUnix,
      })
      return {
        ok: true,
        code: 'mismatch_detected',
        facts: { mismatches: report.mismatches.length, vaults_frozen: vaults.size },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 4. Weekly clean-room recompute
// ---------------------------------------------------------------------------

export function reconCleanRoomJob(ports: OpsPorts): JobDefinition {
  return {
    id: 'recon.clean_room',
    description: 'Independently recomputes a 5% sample plus 100% of top-tier coins from raw chain logs.',
    triggers: [
      {
        kind: 'weekly',
        dayOfWeekUtc: RECONCILIATION.cleanRoomDayOfWeekUtc,
        atUtcHour: RECONCILIATION.cleanRoomAtUtcHour,
      },
    ],
    maxAttempts: 2,
    leaseSeconds: 6 * 3600,
    timeoutSeconds: 4 * 3600,
    retryBaseSeconds: 900,
    movesMoney: false,

    async dueScopes(input: DueScopeInput): Promise<ScheduledRun[]> {
      const last = await input.lastSuccessUnix(FLEET_SCOPE)
      const due = weeklyDue(
        input.nowUnix,
        RECONCILIATION.cleanRoomDayOfWeekUtc,
        RECONCILIATION.cleanRoomAtUtcHour,
        last,
      )
      if (!due.due) return []
      return [
        {
          jobId: 'recon.clean_room',
          scope: FLEET_SCOPE,
          period: due.period,
          reason: { kind: 'weekly', weekKey: due.period },
        },
      ]
    },

    async run(ctx: JobContext): Promise<JobOutcome> {
      const all = await ports.ledger.allVaults()
      const topTier: Address[] = []
      for (const vault of all) {
        const ref = await ports.vaults.get(vault)
        if (ref && ref.tier === RECONCILIATION.cleanRoomTopTier) topTier.push(vault)
      }
      const sampled = deterministicSample(all, RECONCILIATION.cleanRoomSamplePct, ctx.period)
      // Union, not "sample OR top tier". A 5% sample of 200 coins is 10 coins,
      // and the coins that matter most are exactly the ones a sample misses.
      const selected = [...new Set([...sampled, ...topTier])].sort()

      const report = await ports.ledger.cleanRoomRecompute({ asOfUnix: ctx.nowUnix, vaults: selected })
      if (report.disagreements.length === 0) {
        return {
          ok: true,
          code: 'agreed',
          facts: { vaults_checked: selected.length, sampled: sampled.length, top_tier: topTier.length },
        }
      }

      const vaults = new Set(report.disagreements.map((d) => d.vault))
      for (const vault of vaults) {
        await ports.ledger.freezeAuthorizations({
          scope: vault,
          reason: 'clean-room recompute disagrees with the primary ledger',
        })
      }
      await ports.alerts.raise({
        alertId: 'ledger_variance_critical',
        severity: 'page',
        scope: ctx.scope,
        summary: `Clean-room recompute disagrees on ${vaults.size} vault(s)`,
        runbook: 'ops/runbooks/ledger-variance-critical.md',
        facts: {
          vaults_checked: selected.length,
          disagreements: report.disagreements.length,
          vaults_frozen: vaults.size,
        },
        raisedAtUnix: ctx.nowUnix,
      })
      return {
        ok: true,
        code: 'disagreement_detected',
        facts: { disagreements: report.disagreements.length, vaults_frozen: vaults.size },
      }
    },
  }
}

/**
 * Deterministic sample.
 *
 * Seeded by the period, so the same week always picks the same coins - a run
 * that is retried after a crash checks the same set - while a different week
 * picks a different set, so the sample rotates over the book rather than
 * examining the same lucky 5% forever.
 */
export function deterministicSample<T extends string>(items: readonly T[], pct: number, seed: string): T[] {
  if (pct <= 0 || items.length === 0) return []
  if (pct >= 100) return [...items]
  const target = Math.max(1, Math.ceil((items.length * pct) / 100))
  const scored = items.map((item) => ({ item, score: sha256Hex(`${seed}:${item}`) }))
  scored.sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : 0))
  return scored.slice(0, target).map((s) => s.item)
}

export function reconciliationJobs(ports: OpsPorts): JobDefinition[] {
  return [
    reconStructuralJob(ports),
    reconSweepMatchJob(ports),
    reconTrialBalanceJob(ports),
    reconCleanRoomJob(ports),
  ]
}

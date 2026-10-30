/**
 * TIER RE-EVALUATION.
 *
 * Runs daily per vault on the trailing 7-day MEDIAN of daily QF credits. A
 * median rather than a mean is the whole design: a mean is farmable with a
 * single day of wash volume, and the tier controls how much of the client's
 * money we are allowed to spend.
 *
 * ASYMMETRIC BY DESIGN.
 *   Upgrading requires the gate to hold for the tier's sustainedDays, at least
 *   seven days of observed history, the qualification conjuncts to clear, and
 *   the procurement dial to fund the cheapest real deliverable.
 *   Downgrading requires the gate to be missed for downgradeGraceDays. One quiet
 *   day is not a tier change; yo-yoing a client's service level is worse than
 *   being briefly generous.
 *
 * THE FLOOR IS NOT COSMETIC. A coin's monthly procurement budget is its QF/day
 * times its own dial times 30 days, and a Dexscreener Enhanced Token Info
 * listing is 299 USD one-time. Below QUALIFICATION_FLOOR_MONTHLY_USD the paid
 * tier cannot buy even its cheapest deliverable, so offering it would be selling
 * something we cannot deliver.
 *
 * The floor is a constraint on the DIAL, not a restatement of the gate. It used
 * to be true that a coin exactly on the T1 gate at the default dial landed
 * exactly on the floor; after the T1 gate moved to 1,000 USD/day that
 * coincidence is gone, and the floor now binds only on a client who has turned
 * the dial well below the default. Both numbers are read from config below and
 * neither is written down here.
 */

import type { Address, QfMeasurement, QualificationSignals } from '@fee-split-vaults/core'
import { QUALIFICATION_FLOOR_MONTHLY_USD, TIERS, TIER_ORDER, type TierId } from '../../lib/protocol.js'
import { OBSERVED_STATES, TIERING } from '../config.js'
import type { OpsPorts, TierDecision } from '../ports.js'
import { staggeredIntervalDue } from '../triggers.js'
import type { DueScopeInput, JobContext, JobDefinition, JobOutcome, ScheduledRun } from '../types.js'

export interface TierEvaluationInput {
  vault: Address
  current: TierId
  budgetBps: number
  qf: QfMeasurement
  signals: QualificationSignals
  daysBelowGate: number
  atUnix: number
}

/** Monthly procurement budget implied by a QF/day and a dial, in USD. */
export function monthlyBudgetUsd(qfPerDay: number, budgetBps: number): number {
  return (qfPerDay * budgetBps * 30) / 10_000
}

/** The highest tier whose QF gate and sustain requirement the measurement clears. */
export function highestClearedTier(qf: QfMeasurement): TierId {
  let best: TierId = 'T0'
  for (const id of TIER_ORDER) {
    const tier = TIERS[id]
    if (qf.qfPerDay < tier.gateQfPerDay) continue
    if (qf.sustainedDays < tier.sustainedDays) continue
    // Seven days of history is the minimum for a median to mean anything, and
    // no paid tier is granted on less.
    if (tier.gateQfPerDay > 0 && qf.observedDays < Math.max(7, tier.sustainedDays)) continue
    best = id
  }
  return best
}

export function conjunctFailures(signals: QualificationSignals): string[] {
  const c = TIERING.upgradeConjuncts
  const failures: string[] = []
  if (signals.uniqueBuyers7d < c.minUniqueBuyers7d) failures.push('unique_buyers_too_low')
  if (signals.top10HolderSharePct > c.maxTop10HolderSharePct) failures.push('holder_concentration')
  if (signals.deployerSupplySharePct > c.maxDeployerSupplySharePct) failures.push('deployer_supply_share')
  if (signals.selfTradeSharePct > c.maxSelfTradeSharePct) failures.push('self_trade_share')
  if (signals.venuePoolVolumeSharePct < c.minVenuePoolVolumeSharePct) failures.push('venue_pool_volume_share')
  if (signals.coinAgeDays < c.minCoinAgeDays) failures.push('coin_too_young')
  return failures
}

/**
 * The decision. Pure: same inputs, same output, no clock and no I/O, so the
 * rule that decides how much of a client's money we may spend can be replayed
 * from the audit log by someone who does not trust us.
 */
export function decideTier(input: TierEvaluationInput): TierDecision {
  const cleared = highestClearedTier(input.qf)
  const currentIndex = TIER_ORDER.indexOf(input.current)
  const clearedIndex = TIER_ORDER.indexOf(cleared)

  const base = {
    vault: input.vault,
    from: input.current,
    qfPerDay: input.qf.qfPerDay,
    observedDays: input.qf.observedDays,
    sustainedDays: input.qf.sustainedDays,
    decidedAtUnix: input.atUnix,
  }

  if (clearedIndex > currentIndex) {
    const target = TIER_ORDER[clearedIndex]
    if (target === undefined) {
      return { ...base, to: input.current, direction: 'hold', reason: 'tier_order_lookup_failed' }
    }
    const failures = conjunctFailures(input.signals)
    if (failures.length > 0) {
      return { ...base, to: input.current, direction: 'hold', reason: `conjuncts_failed:${failures.join('+')}` }
    }
    const budget = monthlyBudgetUsd(input.qf.qfPerDay, input.budgetBps)
    if (TIERS[target].paidMedia && budget < QUALIFICATION_FLOOR_MONTHLY_USD) {
      return {
        ...base,
        to: input.current,
        direction: 'hold',
        reason: `below_qualification_floor:${budget.toFixed(0)}usd_month`,
      }
    }
    // One step at a time. A coin that jumps three tiers in a day is a coin
    // whose measurement we should not be trusting yet.
    const next = TIER_ORDER[currentIndex + 1]
    if (next === undefined) {
      return { ...base, to: input.current, direction: 'hold', reason: 'already_top_tier' }
    }
    return { ...base, to: next, direction: 'up', reason: 'gate_cleared' }
  }

  if (clearedIndex < currentIndex) {
    if (input.daysBelowGate < TIERING.downgradeGraceDays) {
      return {
        ...base,
        to: input.current,
        direction: 'hold',
        reason: `downgrade_grace:${input.daysBelowGate}of${TIERING.downgradeGraceDays}`,
      }
    }
    const next = TIER_ORDER[Math.max(0, currentIndex - 1)]
    if (next === undefined) {
      return { ...base, to: input.current, direction: 'hold', reason: 'tier_order_lookup_failed' }
    }
    return { ...base, to: next, direction: 'down', reason: 'gate_missed_beyond_grace' }
  }

  return { ...base, to: input.current, direction: 'hold', reason: 'at_tier' }
}

export function tierReevaluateJob(ports: OpsPorts): JobDefinition {
  return {
    id: 'tier.reevaluate',
    description: 'Re-evaluates a coin’s service tier on the trailing 7-day median of daily QF credits.',
    triggers: [{ kind: 'interval', everySeconds: TIERING.evaluateEverySeconds }],
    maxAttempts: 3,
    leaseSeconds: 600,
    timeoutSeconds: 180,
    retryBaseSeconds: 120,
    movesMoney: false,

    async dueScopes(input: DueScopeInput): Promise<ScheduledRun[]> {
      const vaults = await ports.vaults.listByState(OBSERVED_STATES)
      const out: ScheduledRun[] = []
      for (const vault of vaults) {
        const last = await input.lastSuccessUnix(vault.address)
        const due = staggeredIntervalDue(input.nowUnix, vault.address, last, TIERING.evaluateEverySeconds)
        if (!due.due) continue
        out.push({
          jobId: 'tier.reevaluate',
          scope: vault.address,
          period: due.period,
          reason: { kind: 'interval', sinceLastSeconds: due.sinceLastSeconds },
        })
      }
      return out
    },

    async run(ctx: JobContext): Promise<JobOutcome> {
      const vault = await ports.vaults.get(ctx.scope)
      if (!vault) return { ok: false, code: 'unknown_vault' }

      const qf = await ports.qf.measure(vault.address, ctx.nowUnix)
      const signals = await ports.qf.signals(vault.address, ctx.nowUnix)
      const current = await ports.tiers.current(vault.address)

      const currentGate = TIERS[current].gateQfPerDay
      const belowGate = qf.qfPerDay < currentGate
      await ports.tiers.observe({ vault: vault.address, atUnix: ctx.nowUnix, qfPerDay: qf.qfPerDay, belowGate })
      const daysBelowGate = await ports.tiers.daysBelowGate(vault.address)

      const decision = decideTier({
        vault: vault.address,
        current,
        budgetBps: vault.budgetBps,
        qf,
        signals,
        daysBelowGate,
        atUnix: ctx.nowUnix,
      })

      const facts: Record<string, string | number | boolean> = {
        from: decision.from,
        to: decision.to,
        direction: decision.direction,
        qf_per_day: Number(decision.qfPerDay.toFixed(2)),
        observed_days: decision.observedDays,
        sustained_days: decision.sustainedDays,
        days_below_gate: daysBelowGate,
        reason: decision.reason,
      }

      if (decision.direction === 'hold') {
        return { ok: true, code: 'hold', facts }
      }

      await ports.tiers.apply(decision)

      if (decision.direction === 'down') {
        // A downgrade is a commercial event with a service consequence, so it is
        // alerted rather than merely logged: someone tells the dev before they
        // notice the desk got quieter.
        await ports.alerts.raise({
          alertId: 'tier_gate_crossed_downward',
          severity: 'ticket',
          scope: vault.address,
          summary: `Coin dropped from ${decision.from} to ${decision.to}`,
          runbook: 'ops/runbooks/tier-downgrade.md',
          facts,
          raisedAtUnix: ctx.nowUnix,
        })
      }

      return { ok: true, code: decision.direction === 'up' ? 'upgraded' : 'downgraded', facts }
    },
  }
}

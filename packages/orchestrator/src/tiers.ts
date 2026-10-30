/**
 * Tier evaluation. Deterministic, pure, and replayable from stored rows.
 *
 * Four things gate a tier, and every one of them is a conjunct:
 *
 *   QF          - the trailing 7-day MEDIAN of daily credits, from the indexer.
 *                 A median, not a mean, because a mean is farmable with one day
 *                 of wash volume.
 *   SUSTAIN     - the gate must have held for TIERS[t].sustainedDays.
 *   BREADTH     - wash trading can manufacture fee flow; it cannot cheaply
 *                 manufacture unique buyers or deconcentrate a holder table.
 *   AFFORDANCE  - below QUALIFICATION_FLOOR_MONTHLY_USD the procurement slice
 *                 cannot buy the tier's cheapest deliverable, so the tier is not
 *                 offered rather than sold and then not delivered.
 *
 * ASYMMETRY, on purpose: an UPGRADE needs every conjunct, a DOWNGRADE needs only
 * the QF gate to fail. Service the client cannot pay for stops immediately;
 * service they can pay for starts only after the evidence is in.
 *
 * The volume that clears a gate is NOT universal - it depends on the token's own
 * buyback setting, which halves the creator rate. volumeForQf() is called with
 * the per-token flags and nothing here ever assumes a single creator rate.
 */

import type { QfMeasurement, QualificationSignals, ScreeningResult } from '@fee-split-vaults/core'
import { QUALIFICATION_CONJUNCTS } from '@fee-split-vaults/broker'
import {
  QUALIFICATION_FLOOR_MONTHLY_USD,
  TERMS,
  TIERS,
  TIER_ORDER,
  volumeForQf,
} from '../../../config/protocol.js'
import type { TierId } from '../../../config/protocol.js'

export interface TierInput {
  currentTier: TierId
  qf: QfMeasurement
  signals?: QualificationSignals
  screening?: ScreeningResult
  /** The dev's procurement dial, in bps. Decides whether a tier is affordable. */
  budgetBps: number
  /** Per-token, read on chain. Halves the creator rate when true. */
  buybackEnabled: boolean
  /** Per-token, immutable, 0..1000. */
  creatorTaxBps: number
  nowUnix: number
}

export interface TierDecision {
  tier: TierId
  previousTier: TierId
  direction: 'hold' | 'upgrade' | 'downgrade'
  /** Machine codes, ordered. The first is the binding one. */
  reasons: string[]
  /** Highest tier the QF gate alone would allow. Diagnostic; never granted. */
  qfOnlyTier: TierId
  paidMediaPermitted: boolean
  /** True while operations may run at all. False under a BLOCKED screening. */
  operationsPermitted: boolean
  /** Daily Venue-pool volume this tier needs FOR THIS TOKEN's configuration. */
  volumeForCurrentGate: number
}

function tierIndex(tier: TierId): number {
  const i = TIER_ORDER.indexOf(tier)
  if (i < 0) throw new Error(`unknown tier ${tier}`)
  return i
}

/** Monthly procurement budget the dial implies at the measured QF. */
export function monthlyProcurementUsd(qfPerDay: number, budgetBps: number): number {
  return (qfPerDay * budgetBps * 30) / 10_000
}

/** Highest tier the QF number alone clears. Ignores sustain and breadth. */
export function qfOnlyTier(qfPerDay: number): TierId {
  let best: TierId = 'T0'
  for (const id of TIER_ORDER) {
    if (qfPerDay >= TIERS[id].gateQfPerDay) best = id
  }
  return best
}

/**
 * Whether a candidate tier is affordable at this QF and dial.
 *
 * T0 is always affordable: it costs a cent a day and buys nothing.
 */
export function affordable(candidate: TierId, qfPerDay: number, budgetBps: number): boolean {
  if (!TIERS[candidate].paidMedia) return true
  return monthlyProcurementUsd(qfPerDay, budgetBps) >= QUALIFICATION_FLOOR_MONTHLY_USD
}

function breadthFailures(signals: QualificationSignals | undefined): string[] {
  // Absent signals are not "clean". They are unknown, and unknown is a refusal
  // to UPGRADE - the indexer raises SignalsUnavailableError rather than
  // reporting a confident zero, and that refusal has to survive to here.
  if (signals === undefined) return ['signals_unavailable']
  const out: string[] = []
  const c = QUALIFICATION_CONJUNCTS
  if (signals.uniqueBuyers7d < c.minUniqueBuyers7d) out.push('unique_buyers_below_floor')
  if (signals.top10HolderSharePct > c.maxTop10HolderSharePct) out.push('holders_too_concentrated')
  if (signals.deployerSupplySharePct > c.maxDeployerSupplySharePct) out.push('deployer_share_too_high')
  if (signals.selfTradeSharePct > c.maxSelfTradeSharePct) out.push('self_trade_share_too_high')
  if (signals.venuePoolVolumeSharePct < c.minVenuePoolVolumeSharePct) out.push('venue_pool_volume_dead')
  if (signals.coinAgeDays < c.minCoinAgeDays) out.push('coin_too_young')
  return out
}

export function evaluateTier(input: TierInput): TierDecision {
  const { qf, currentTier, nowUnix } = input
  const reasons: string[] = []

  const screeningVerdict = input.screening?.verdict
  const operationsPermitted = screeningVerdict !== 'BLOCKED'
  // No screening at all is not RESTRICTED-by-default, it is paid-media-denied.
  // Publishing organic operations under an unknown verdict is the desk's
  // deterministic surface, which is why operations survive a missing screen.
  const screeningPermitsPaidMedia = input.screening?.paidMediaPermitted === true

  const gateOnly = qfOnlyTier(qf.qfPerDay)
  const volumeForCurrentGate = volumeForQf(
    TIERS[currentTier].gateQfPerDay,
    input.buybackEnabled,
    input.creatorTaxBps,
  )

  if (!operationsPermitted) {
    return {
      tier: 'T0',
      previousTier: currentTier,
      direction: currentTier === 'T0' ? 'hold' : 'downgrade',
      reasons: ['screening_blocked'],
      qfOnlyTier: gateOnly,
      paidMediaPermitted: false,
      operationsPermitted: false,
      volumeForCurrentGate,
    }
  }

  const qfAge = nowUnix - qf.measuredAtUnix
  const qfStale = qfAge < 0 || qfAge > QUALIFICATION_CONJUNCTS.maxQfAgeSeconds

  // ---- DOWNGRADE. One failing conjunct is enough, and it applies at once. ----
  if (qfStale) {
    reasons.push('qf_measurement_stale')
  }
  if (qf.observedDays < QUALIFICATION_CONJUNCTS.minObservedDays && currentTier !== 'T0') {
    reasons.push('insufficient_observed_days')
  }
  if (tierIndex(gateOnly) < tierIndex(currentTier)) {
    reasons.push('qf_below_current_gate')
  }
  if (!affordable(currentTier, qf.qfPerDay, input.budgetBps)) {
    reasons.push('below_qualification_floor')
  }

  if (reasons.length > 0) {
    // Fall to the highest tier that is both cleared and affordable. When the
    // measurement itself is stale we fall to T0: a tier granted on a number
    // nobody has checked is exactly what the fail-closed rule forbids.
    let target: TierId = 'T0'
    if (!qfStale && qf.observedDays >= QUALIFICATION_CONJUNCTS.minObservedDays) {
      for (const id of TIER_ORDER) {
        if (qf.qfPerDay >= TIERS[id].gateQfPerDay && affordable(id, qf.qfPerDay, input.budgetBps)) {
          target = id
        }
      }
    }
    if (tierIndex(target) > tierIndex(currentTier)) target = currentTier
    return {
      tier: target,
      previousTier: currentTier,
      direction: target === currentTier ? 'hold' : 'downgrade',
      reasons,
      qfOnlyTier: gateOnly,
      paidMediaPermitted: TIERS[target].paidMedia && screeningPermitsPaidMedia,
      operationsPermitted: true,
      volumeForCurrentGate,
    }
  }

  // ---- UPGRADE. Every conjunct, or the tier is held. ----
  const nextIndex = tierIndex(currentTier) + 1
  const next = TIER_ORDER[nextIndex]
  const hold = (): TierDecision => ({
    tier: currentTier,
    previousTier: currentTier,
    direction: 'hold',
    reasons: reasons.length > 0 ? reasons : ['gates_hold'],
    qfOnlyTier: gateOnly,
    paidMediaPermitted: TIERS[currentTier].paidMedia && screeningPermitsPaidMedia,
    operationsPermitted: true,
    volumeForCurrentGate,
  })

  if (next === undefined) return hold()

  const spec = TIERS[next]
  if (qf.qfPerDay < spec.gateQfPerDay) {
    reasons.push('qf_below_next_gate')
    return hold()
  }
  if (qf.sustainedDays < spec.sustainedDays) {
    reasons.push('sustain_not_met')
    return hold()
  }
  if (!affordable(next, qf.qfPerDay, input.budgetBps)) {
    reasons.push('next_tier_below_qualification_floor')
    return hold()
  }
  const breadth = breadthFailures(input.signals)
  if (breadth.length > 0) {
    reasons.push(...breadth)
    return hold()
  }
  if (spec.paidMedia && !screeningPermitsPaidMedia) {
    // A tier whose whole value is paid media is not granted to a coin that
    // cannot buy any. The client is told why rather than sold a hollow tier.
    reasons.push('screening_denies_paid_media')
    return hold()
  }

  return {
    tier: next,
    previousTier: currentTier,
    direction: 'upgrade',
    reasons: ['all_conjuncts_met'],
    qfOnlyTier: gateOnly,
    paidMediaPermitted: spec.paidMedia && screeningPermitsPaidMedia,
    operationsPermitted: true,
    volumeForCurrentGate: volumeForQf(spec.gateQfPerDay, input.buybackEnabled, input.creatorTaxBps),
  }
}

/**
 * The dev's break-even multiple at the current dial, for the weekly report.
 *
 * Re-exported through here rather than imported ad hoc so there is one path
 * from config/protocol into the operating plane.
 */
export const DIAL_LOWER_NOTICE_SECONDS = TERMS.dialLowerNoticeDays * 24 * 60 * 60

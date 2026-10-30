/**
 * THE GATE CHAIN.
 *
 * Ordered. Deterministic. First failure wins. NO MODEL RUNS HERE.
 *
 * Every gate is a pure function from a fully resolved GateContext to a
 * SpendDecision. No gate reads a clock, performs I/O, allocates a random
 * number, or touches a float. Given the same context, the chain returns the
 * same decision forever, which is what lets a disputed spend be replayed from
 * the audit log and re-adjudicated by someone who does not trust us.
 *
 * A gate may do exactly three things:
 *   REFUSE    - approved: false, and the chain stops here.
 *   PASS      - approved: true, the chain continues.
 *   ESCALATE  - approved: true with requiresHumanApproval, chain continues.
 *
 * The ordering is not cosmetic. Solvency and the commitment rule run before
 * anything that could be argued about, so that the cheapest, hardest, least
 * negotiable constraints are the ones a compromised planner meets first.
 */
import type { SpendDecision } from '@fee-split-vaults/core'
import type { GateContext } from './context.js'
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  applyBps,
  exactCentsFromUsd,
  usdFromCents,
} from './money.js'
import { isPredicateKind } from './predicates.js'
import {
  CATEGORY_SUBCAP_BPS,
  KOL_CHECK_OFFSETS_SECONDS,
  KYB_MAX_AGE_SECONDS,
  MANUAL_ATTESTATION_MAX_USD,
  OFAC_MAX_AGE_SECONDS,
  QUALIFICATION_CONJUNCTS,
  RATE_LIMITS,
  ROLLING_WINDOW_DAYS,
  SCREENING_MAX_AGE_SECONDS,
  VENDOR_RELIABILITY,
} from './limits.js'
import { COMMITMENT_RULE, QUALIFICATION_FLOOR_MONTHLY_USD } from './protocol.js'

export interface Gate {
  readonly name: string
  readonly evaluate: (ctx: GateContext) => SpendDecision
}

function pass(reason: string): SpendDecision {
  return { approved: true, reason, requiresHumanApproval: false }
}

function escalate(reason: string): SpendDecision {
  return { approved: true, reason, requiresHumanApproval: true }
}

function refuse(gate: string, reason: string): SpendDecision {
  return { approved: false, failedGate: gate, reason, requiresHumanApproval: false }
}

/**
 * Load-time tripwire. The pressure to relax the commitment rule will come from
 * the best client, and it will arrive as a one-line config change rather than
 * as an argument. If that line is ever written, the spend gate refuses to load
 * rather than quietly permitting forward commitments.
 */
export function assertCommitmentRuleIntact(): void {
  if (
    !COMMITMENT_RULE.requireFullyBankedAtSigning ||
    COMMITMENT_RULE.allowCrossCoinSubsidy ||
    COMMITMENT_RULE.allowForwardFinancing
  ) {
    throw new Error(
      'broker: COMMITMENT_RULE has been relaxed in config/protocol.ts; refusing to load the spend gate',
    )
  }
}

assertCommitmentRuleIntact()

// ---------------------------------------------------------------------------
// Derived caps. Exported so reports and tests can state the arithmetic.
// ---------------------------------------------------------------------------

/**
 * The rolling cap is a WINDOW cap: the median daily accrual extended over the
 * window, times the configured fraction. Taking the median first is the whole
 * point - one day of wash volume moves a mean and does not move a median, so
 * manufactured flow cannot buy a bigger budget.
 */
export function rollingCapCents(ctx: GateContext): bigint {
  return applyBps(
    ctx.budget.medianDailyAccrualCents * BigInt(ROLLING_WINDOW_DAYS),
    ctx.limits.rollingCapOfMedianBps,
  )
}

export function lifetimeCapCents(ctx: GateContext): bigint {
  return applyBps(ctx.budget.cumulativeRealizedFeesCents, ctx.limits.lifetimeCapOfRealizedFeesBps)
}

export function categoryCapCents(ctx: GateContext): bigint {
  const bps = CATEGORY_SUBCAP_BPS[ctx.category]
  return applyBps(ctx.budget.procurementBudgetCents, bps)
}

export function relatedPartyCapCents(ctx: GateContext): bigint {
  return applyBps(ctx.budget.budget30dCents, ctx.limits.relatedPartyCapOf30dBudgetBps)
}

// ---------------------------------------------------------------------------
// Gates, in evaluation order
// ---------------------------------------------------------------------------

const policyTokenGate: Gate = {
  name: 'policy_token',
  evaluate: (ctx) => {
    if (ctx.policy.verifiedAtUnix !== ctx.nowUnix) {
      return refuse('policy_token', 'the policy token was verified for a different instant')
    }
    if (ctx.policy.claims.expiresAtUnix <= ctx.nowUnix) {
      return refuse('policy_token', 'the policy token has expired')
    }
    if (!ctx.policy.claims.spendEnabled) {
      return refuse('policy_token', 'spend is disabled by the signed policy object')
    }
    return pass('policy token is valid and spend is enabled')
  },
}

const assetKillSwitchGate: Gate = {
  name: 'asset_kill_switch',
  evaluate: (ctx) => {
    const asset = ctx.asset
    if (asset === undefined || typeof asset.address !== 'string' || asset.address.length === 0) {
      return refuse('asset_kill_switch', 'no settlement asset was supplied')
    }
    if (!asset.enabled) {
      return refuse('asset_kill_switch', `asset ${asset.symbol} is disabled locally`)
    }
    if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) {
      return refuse('asset_kill_switch', `asset ${asset.symbol} has implausible decimals`)
    }
    const allowed = ctx.policy.claims.enabledAssets.some(
      (a) => a.toLowerCase() === asset.address.toLowerCase(),
    )
    if (!allowed) {
      // Every approved quote asset here is an upgradeable, pausable,
      // issuer-controlled proxy. Absence from the allowlist is how a paused or
      // newly suspect asset is stopped without a deploy.
      return refuse(
        'asset_kill_switch',
        `asset ${asset.symbol} is not on the signed policy allowlist`,
      )
    }
    if (asset.maxTransferMinor !== undefined && asset.maxTransferMinor <= 0n) {
      return refuse('asset_kill_switch', `asset ${asset.symbol} has a zero per-transfer cap`)
    }
    return pass('settlement asset is enabled')
  },
}

const vaultStateGate: Gate = {
  name: 'vault_state',
  evaluate: (ctx) => {
    if (ctx.vault.state !== 'ACTIVE') {
      return refuse('vault_state', `vault is ${ctx.vault.state}, not ACTIVE`)
    }
    return pass('vault is active')
  },
}

const catalogGate: Gate = {
  name: 'catalog',
  evaluate: (ctx) => {
    if (!ctx.entry.enabled) {
      return refuse('catalog', `sku ${ctx.entry.sku.id} is disabled`)
    }
    if (!ctx.entry.sku.availableAtTiers.includes(ctx.vault.tier)) {
      return refuse('catalog', `sku ${ctx.entry.sku.id} is not offered at tier ${ctx.vault.tier}`)
    }
    if (!ctx.tier.paidMedia) {
      return refuse('catalog', `tier ${ctx.tier.id} buys nothing; it is deterministic by design`)
    }
    if (ctx.proposal.quantity > ctx.entry.maxQuantity) {
      return refuse('catalog', `quantity exceeds the per-sku maximum of ${ctx.entry.maxQuantity}`)
    }
    if (ctx.quoteCents <= 0n) {
      return refuse('catalog', 'quoted cost resolved to zero')
    }
    return pass('sku resolves and is offered at this tier')
  },
}

const screeningGate: Gate = {
  name: 'screening',
  evaluate: (ctx) => {
    const screening = ctx.screening
    if (screening === undefined) {
      return refuse('screening', 'no screening result is on file')
    }
    if (
      screening.verdict !== 'CLEAR' &&
      screening.verdict !== 'RESTRICTED' &&
      screening.verdict !== 'BLOCKED'
    ) {
      return refuse('screening', `unknown screening verdict "${String(screening.verdict)}"`)
    }
    if (screening.verdict === 'BLOCKED') {
      return refuse('screening', 'token is BLOCKED by content screening')
    }
    if (!Array.isArray(screening.stagesRun) || screening.stagesRun.length === 0) {
      return refuse('screening', 'screening record names no stages run')
    }
    if (screening.screenedAtUnix < ctx.nowUnix - SCREENING_MAX_AGE_SECONDS) {
      return refuse('screening', 'screening has expired and must be re-run before paid media')
    }
    if (!screening.paidMediaPermitted) {
      return refuse('screening', 'screening permits organic operations only, not paid media')
    }
    return pass('screening permits paid media')
  },
}

const solvencyGate: Gate = {
  name: 'solvency',
  evaluate: (ctx) => {
    // FINALIZED ONLY. ctx.budget.unfinalizedCents is deliberately not read here
    // and must never be: a reorg would turn a spend into an overdraft.
    if (ctx.quoteCents > ctx.budget.availableCents) {
      return refuse(
        'solvency',
        `quote ${ctx.quoteCents} exceeds the finalized budget available (${ctx.budget.availableCents} = finalized ${ctx.budget.finalizedCents} less outstanding ${ctx.budget.outstandingObligationsCents})`,
      )
    }
    return pass('funded from finalized budget')
  },
}

const commitmentRuleGate: Gate = {
  name: 'commitment_rule',
  evaluate: (ctx) => {
    const obligation = ctx.obligation
    if (obligation.fundingSource !== 'own_banked_budget') {
      // Credit lines, other vaults, and projected flow are all refused
      // outright. This single rule resolves the hold-up problem, forward
      // commitments, and cross-subsidy together, and it does not have an
      // exception for the best client.
      return refuse(
        'commitment_rule',
        `obligation would be funded from "${obligation.fundingSource}"; only this coin's own banked budget may fund it`,
      )
    }
    if (obligation.totalCents > ctx.budget.availableCents) {
      return refuse(
        'commitment_rule',
        `total obligation ${obligation.totalCents} exceeds the banked budget available at signing (${ctx.budget.availableCents}); no obligation may be part-funded`,
      )
    }
    if (obligation.forwardCents > 0n && obligation.servicePeriodEndUnix === undefined) {
      return refuse(
        'commitment_rule',
        'a deferred portion was declared without a service period end',
      )
    }
    return pass('obligation is fully banked at signing')
  },
}

const rollingCapGate: Gate = {
  name: 'rolling_cap',
  evaluate: (ctx) => {
    const cap = rollingCapCents(ctx)
    const projected = ctx.budget.rollingWindowSpendCents + ctx.quoteCents
    if (projected > cap) {
      return refuse(
        'rolling_cap',
        `window spend would reach ${projected} against a cap of ${cap} (median daily accrual ${ctx.budget.medianDailyAccrualCents} over ${ROLLING_WINDOW_DAYS} days)`,
      )
    }
    return pass('within the rolling cap')
  },
}

const lifetimeCapGate: Gate = {
  name: 'lifetime_cap',
  evaluate: (ctx) => {
    const cap = lifetimeCapCents(ctx)
    const projected = ctx.budget.lifetimeSpendCents + ctx.quoteCents
    if (projected > cap) {
      return refuse(
        'lifetime_cap',
        `lifetime spend would reach ${projected} against a cap of ${cap} (${ctx.limits.lifetimeCapOfRealizedFeesBps}bps of ${ctx.budget.cumulativeRealizedFeesCents} realized fees)`,
      )
    }
    return pass('within the lifetime cap')
  },
}

const qualifiedFeeGate: Gate = {
  name: 'qualified_fee',
  evaluate: (ctx) => {
    const qf = ctx.qf
    const signals = ctx.signals
    if (qf === undefined || signals === undefined) {
      return refuse('qualified_fee', 'no qualification measurement is on file')
    }
    if (qf.measuredAtUnix < ctx.nowUnix - QUALIFICATION_CONJUNCTS.maxQfAgeSeconds) {
      return refuse('qualified_fee', 'the QF measurement is stale')
    }
    if (qf.observedDays < QUALIFICATION_CONJUNCTS.minObservedDays) {
      return refuse(
        'qualified_fee',
        `only ${qf.observedDays} days observed; QF is a ${QUALIFICATION_CONJUNCTS.minObservedDays}-day median`,
      )
    }
    if (qf.qfPerDay < ctx.tier.gateQfPerDay) {
      return refuse(
        'qualified_fee',
        `QF ${qf.qfPerDay}/day is below the ${ctx.tier.id} gate of ${ctx.tier.gateQfPerDay}/day`,
      )
    }
    if (qf.sustainedDays < ctx.tier.sustainedDays) {
      return refuse(
        'qualified_fee',
        `gate held for ${qf.sustainedDays} days, ${ctx.tier.sustainedDays} required`,
      )
    }

    // The floor below which the procurement slice cannot buy the cheapest
    // deliverable at all. Floored, never rounded up.
    const monthlyBudgetUsd = Math.floor((qf.qfPerDay * ctx.vault.budgetBps * 30) / 10_000)
    if (monthlyBudgetUsd < QUALIFICATION_FLOOR_MONTHLY_USD) {
      return refuse(
        'qualified_fee',
        `monthly procurement budget of ~$${monthlyBudgetUsd} is below the $${QUALIFICATION_FLOOR_MONTHLY_USD} qualification floor`,
      )
    }

    // Wash trading manufactures fee flow. It does not cheaply manufacture
    // breadth or deconcentration, so these conjuncts are the real gate.
    if (signals.uniqueBuyers7d < QUALIFICATION_CONJUNCTS.minUniqueBuyers7d) {
      return refuse(
        'qualified_fee',
        `${signals.uniqueBuyers7d} unique buyers in 7d, ${QUALIFICATION_CONJUNCTS.minUniqueBuyers7d} required`,
      )
    }
    if (signals.top10HolderSharePct > QUALIFICATION_CONJUNCTS.maxTop10HolderSharePct) {
      return refuse('qualified_fee', `top-10 holders control ${signals.top10HolderSharePct}%`)
    }
    if (signals.deployerSupplySharePct > QUALIFICATION_CONJUNCTS.maxDeployerSupplySharePct) {
      return refuse('qualified_fee', `deployer holds ${signals.deployerSupplySharePct}% of supply`)
    }
    if (signals.selfTradeSharePct > QUALIFICATION_CONJUNCTS.maxSelfTradeSharePct) {
      return refuse('qualified_fee', `self-trade share is ${signals.selfTradeSharePct}%`)
    }
    if (signals.coinAgeDays < QUALIFICATION_CONJUNCTS.minCoinAgeDays) {
      return refuse('qualified_fee', `coin is ${signals.coinAgeDays} days old`)
    }
    if (signals.venuePoolVolumeSharePct < QUALIFICATION_CONJUNCTS.minVenuePoolVolumeSharePct) {
      return refuse(
        'qualified_fee',
        `Venue-pool volume share of ${signals.venuePoolVolumeSharePct}% indicates the fee-bearing pool is dead`,
      )
    }
    if (signals.venuePoolVolumeSharePct < QUALIFICATION_CONJUNCTS.escalateVenuePoolVolumeSharePct) {
      // A wide gap between headline and Venue-pool volume is the normal state of
      // a winner, so this is an escalation and not a refusal.
      return escalate(
        `Venue-pool volume share is ${signals.venuePoolVolumeSharePct}%; confirm liquidity has not migrated`,
      )
    }
    return pass('qualification conjuncts hold')
  },
}

const categorySubcapGate: Gate = {
  name: 'category_subcap',
  evaluate: (ctx) => {
    if (!Object.prototype.hasOwnProperty.call(CATEGORY_SUBCAP_BPS, ctx.category)) {
      return refuse('category_subcap', `unknown sku category "${String(ctx.category)}"`)
    }
    if (ctx.budget.procurementBudgetCents <= 0n) {
      // Inference is charged FIRST. If it consumed the period budget there is
      // nothing left to procure with, and that is the honest answer.
      return refuse(
        'category_subcap',
        `inference of ${ctx.budget.inferenceChargedCents} has consumed the period budget of ${ctx.budget.periodBudgetCents}`,
      )
    }
    const spent = ctx.budget.categorySpentCents[ctx.category] ?? 0n
    const cap = categoryCapCents(ctx)
    if (spent + ctx.quoteCents > cap) {
      return refuse(
        'category_subcap',
        `${ctx.category} spend would reach ${spent + ctx.quoteCents} against a sub-cap of ${cap}`,
      )
    }
    if (ctx.budget.totalCategorySpentCents + ctx.quoteCents > ctx.budget.procurementBudgetCents) {
      return refuse(
        'category_subcap',
        `total procurement would reach ${ctx.budget.totalCategorySpentCents + ctx.quoteCents} against a procurement budget of ${ctx.budget.procurementBudgetCents}`,
      )
    }
    return pass('within the category sub-cap')
  },
}

const payeeAllowlistGate: Gate = {
  name: 'payee_allowlist',
  evaluate: (ctx) => {
    const vendor = ctx.vendor
    if (vendor.id !== ctx.entry.sku.vendorId) {
      return refuse('payee_allowlist', 'resolved vendor does not match the sku')
    }
    if (!vendor.enabled) {
      return refuse('payee_allowlist', `vendor ${vendor.id} is disabled`)
    }
    if (vendor.kybVerifiedAtUnix === undefined) {
      return refuse('payee_allowlist', `vendor ${vendor.id} has no KYB record`)
    }
    if (vendor.kybVerifiedAtUnix > ctx.nowUnix + CLOCK_SKEW_TOLERANCE_SECONDS) {
      return refuse('payee_allowlist', `vendor ${vendor.id} has a KYB record dated in the future`)
    }
    if (vendor.kybVerifiedAtUnix < ctx.nowUnix - KYB_MAX_AGE_SECONDS) {
      return refuse('payee_allowlist', `vendor ${vendor.id} KYB is out of date`)
    }
    if (vendor.ofacScreenedAtUnix === undefined) {
      return refuse('payee_allowlist', `vendor ${vendor.id} has never been sanctions screened`)
    }
    if (vendor.ofacScreenedAtUnix > ctx.nowUnix + CLOCK_SKEW_TOLERANCE_SECONDS) {
      return refuse('payee_allowlist', `vendor ${vendor.id} screening is dated in the future`)
    }
    if (vendor.ofacScreenedAtUnix < ctx.nowUnix - OFAC_MAX_AGE_SECONDS) {
      return refuse(
        'payee_allowlist',
        `vendor ${vendor.id} sanctions screen is ${ctx.nowUnix - vendor.ofacScreenedAtUnix}s old, limit ${OFAC_MAX_AGE_SECONDS}s`,
      )
    }
    return pass('vendor is allowlisted, KYB current, sanctions screen fresh')
  },
}

const relatedPartyGate: Gate = {
  name: 'related_party',
  evaluate: (ctx) => {
    if (!ctx.vendor.isRelatedParty) {
      return pass('vendor is not a related party')
    }
    if (ctx.entry.pricing === 'operator_service') {
      // The operator's own labour, billed at a published coin-independent rate
      // that no client-specific expression can alter. Disclosed, not capped as
      // a third-party purchase, and bounded by the category sub-cap.
      return pass('operator service at a published coin-independent rate')
    }
    if (!ctx.relatedPartyOptIn) {
      return refuse(
        'related_party',
        `vendor ${ctx.vendor.id} is operator-affiliated and this dev has not opted in`,
      )
    }
    const cap = relatedPartyCapCents(ctx)
    const projected = ctx.counters.relatedPartySpend30dCents + ctx.quoteCents
    if (projected > cap) {
      return refuse(
        'related_party',
        `related-party spend would reach ${projected} against a cap of ${cap} (${ctx.limits.relatedPartyCapOf30dBudgetBps}bps of the 30-day budget)`,
      )
    }
    return escalate(`related-party purchase from ${ctx.vendor.id} requires sign-off`)
  },
}

const vendorReliabilityGate: Gate = {
  name: 'vendor_reliability',
  evaluate: (ctx) => {
    const score = ctx.vendor.reliabilityScore
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
      return refuse('vendor_reliability', `vendor ${ctx.vendor.id} has no usable reliability score`)
    }
    if (score < VENDOR_RELIABILITY.minScore) {
      return refuse(
        'vendor_reliability',
        `vendor ${ctx.vendor.id} reliability ${score} is below the floor of ${VENDOR_RELIABILITY.minScore}`,
      )
    }
    // Reliability scales exposure: an unproven vendor may take a smaller slice
    // of the window cap than a proven one, and the score is produced only by
    // observed delivery outcomes.
    const exposureCap = applyBps(rollingCapCents(ctx), Math.round(score * 10_000))
    if (ctx.quoteCents > exposureCap) {
      return refuse(
        'vendor_reliability',
        `quote ${ctx.quoteCents} exceeds the ${score} reliability-scaled exposure cap of ${exposureCap}`,
      )
    }
    if (ctx.entry.observedDeliveries < VENDOR_RELIABILITY.probationDeliveries) {
      const probationCap = exactCentsFromUsd(
        VENDOR_RELIABILITY.probationMaxUsd,
        'probationMaxUsd',
      )
      if (ctx.quoteCents > probationCap) {
        return refuse(
          'vendor_reliability',
          `sku ${ctx.entry.sku.id} has ${ctx.entry.observedDeliveries} observed deliveries; probation caps a purchase at ${probationCap}`,
        )
      }
      return escalate(`sku ${ctx.entry.sku.id} is on delivery probation`)
    }
    return pass('vendor reliability is sufficient')
  },
}

const fleetVendorDailyCapGate: Gate = {
  name: 'fleet_vendor_daily_cap',
  evaluate: (ctx) => {
    const projected = ctx.counters.vendorSpendTodayFleetCents + ctx.quoteCents
    if (projected > ctx.limits.fleetVendorDailyCapCents) {
      // Fleet-wide, not per-coin: the concentration risk is the operator
      // sending the whole book's budget to one vendor in one day.
      return refuse(
        'fleet_vendor_daily_cap',
        `vendor ${ctx.vendor.id} would take ${projected} across the book today against a cap of ${ctx.limits.fleetVendorDailyCapCents}`,
      )
    }
    return pass('within the fleet-wide per-vendor daily cap')
  },
}

const measurabilityGate: Gate = {
  name: 'measurability',
  evaluate: (ctx) => {
    const spec = ctx.entry.sku.predicate
    if (spec === undefined) {
      return refuse('measurability', `sku ${ctx.entry.sku.id} has no delivery predicate`)
    }
    if (!isPredicateKind(spec.kind)) {
      return refuse('measurability', `unknown predicate kind "${String(spec.kind)}"`)
    }
    if (!ctx.verifiableKinds.has(spec.kind)) {
      return refuse('measurability', `no verifier is registered for "${spec.kind}"`)
    }
    const offsets = spec.verifyAtOffsetsSeconds
    if (!Array.isArray(offsets) || offsets.length === 0) {
      return refuse('measurability', `predicate for ${ctx.entry.sku.id} schedules no checks`)
    }
    for (const offset of offsets) {
      if (!Number.isSafeInteger(offset) || offset <= 0) {
        return refuse('measurability', 'predicate check offsets must be positive integers')
      }
    }
    if (new Set(offsets).size !== offsets.length) {
      return refuse('measurability', 'predicate check offsets contain duplicates')
    }
    if (spec.kind === 'kol_post') {
      for (const required of KOL_CHECK_OFFSETS_SECONDS) {
        if (!offsets.includes(required)) {
          // The failure mode is a post that appears, is paid for, and is
          // deleted. One check cannot catch it.
          return refuse(
            'measurability',
            `kol_post must be verified at +${required}s; both T+24h and T+7d are mandatory`,
          )
        }
      }
    }
    if (spec.kind === 'manual_attestation') {
      const cap = exactCentsFromUsd(MANUAL_ATTESTATION_MAX_USD, 'MANUAL_ATTESTATION_MAX_USD')
      if (ctx.quoteCents > cap) {
        return refuse(
          'measurability',
          `manual attestation is capped at ${cap}; ${ctx.quoteCents} needs a machine-verifiable predicate`,
        )
      }
      return escalate('delivery rests on a manual attestation')
    }
    return pass('delivery is machine-verifiable')
  },
}

const rateLimitGate: Gate = {
  name: 'rate_limit',
  evaluate: (ctx) => {
    const c = ctx.counters
    if (c.proposalsLastHourForVault >= RATE_LIMITS.proposalsPerHourPerVault) {
      return refuse(
        'rate_limit',
        `${c.proposalsLastHourForVault} proposals in the last hour for this vault`,
      )
    }
    if (c.disbursementsTodayForVault >= RATE_LIMITS.disbursementsPerDayPerVault) {
      return refuse('rate_limit', `${c.disbursementsTodayForVault} disbursements today for this vault`)
    }
    if (c.vendorDisbursementsTodayForVault >= RATE_LIMITS.disbursementsPerDayPerVendorPerVault) {
      return refuse(
        'rate_limit',
        `${c.vendorDisbursementsTodayForVault} disbursements to ${ctx.vendor.id} today for this vault`,
      )
    }
    if (c.disbursementsTodayFleet >= RATE_LIMITS.disbursementsPerDayFleet) {
      return refuse('rate_limit', `${c.disbursementsTodayFleet} disbursements across the book today`)
    }
    return pass('within rate limits')
  },
}

const humanApprovalGate: Gate = {
  name: 'human_approval',
  evaluate: (ctx) => {
    if (ctx.quoteCents > ctx.limits.humanApprovalThresholdCents) {
      return escalate(
        `quote ${ctx.quoteCents} is above the human-approval threshold of ${ctx.limits.humanApprovalThresholdCents}`,
      )
    }
    return pass('below the human-approval threshold')
  },
}

/**
 * THE CHAIN. Order is load-bearing; do not reorder without re-reading why each
 * gate sits where it does.
 */
export const GATE_CHAIN: readonly Gate[] = Object.freeze([
  policyTokenGate,
  assetKillSwitchGate,
  vaultStateGate,
  catalogGate,
  screeningGate,
  solvencyGate,
  commitmentRuleGate,
  rollingCapGate,
  lifetimeCapGate,
  qualifiedFeeGate,
  categorySubcapGate,
  payeeAllowlistGate,
  relatedPartyGate,
  vendorReliabilityGate,
  fleetVendorDailyCapGate,
  measurabilityGate,
  rateLimitGate,
  humanApprovalGate,
])

export const GATE_NAMES: readonly string[] = Object.freeze(GATE_CHAIN.map((g) => g.name))

/**
 * Runs the chain. First refusal wins and stops evaluation; escalations
 * accumulate and are reported together so a human sees every reason at once.
 */
export function evaluateGates(ctx: GateContext): SpendDecision {
  // Re-run the tripwire at DECISION TIME, not only at import. config/protocol.ts
  // is deep-frozen now, so a post-load mutation throws rather than succeeding -
  // but a tripwire that fires once, when the module graph first warms, is a
  // tripwire that cannot see anything that happens afterwards, and the cost of
  // three boolean reads per decision is nothing next to that.
  assertCommitmentRuleIntact()
  const escalations: string[] = []
  for (const gate of GATE_CHAIN) {
    const decision = gate.evaluate(ctx)
    if (!decision.approved) {
      return {
        approved: false,
        failedGate: decision.failedGate ?? gate.name,
        reason: decision.reason,
        requiresHumanApproval: false,
        quotedCostUsd: quoteUsd(ctx),
      }
    }
    if (decision.requiresHumanApproval) {
      escalations.push(`${gate.name}: ${decision.reason}`)
    }
  }
  return {
    approved: true,
    reason:
      escalations.length === 0
        ? 'all gates passed'
        : `all gates passed; human approval required (${escalations.join('; ')})`,
    requiresHumanApproval: escalations.length > 0,
    quotedCostUsd: quoteUsd(ctx),
  }
}

function quoteUsd(ctx: GateContext): number {
  return usdFromCents(ctx.quoteCents)
}

/** Diagnostic: every gate's verdict, for a receipt or a dispute. */
export function traceGates(ctx: GateContext): Array<{ gate: string; decision: SpendDecision }> {
  const trace: Array<{ gate: string; decision: SpendDecision }> = []
  for (const gate of GATE_CHAIN) {
    const decision = gate.evaluate(ctx)
    trace.push({ gate: gate.name, decision })
    if (!decision.approved) break
  }
  return trace
}

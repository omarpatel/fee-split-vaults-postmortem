/**
 * Gate context assembly.
 *
 * Everything a gate needs is resolved HERE, once, into integer cents with its
 * price provenance already checked. Gates are then pure functions over a frozen
 * struct: no I/O, no clock, no floating point, no surprises. That is what makes
 * the chain replayable from an audit log, and replayability is the whole
 * determinism argument.
 *
 * Assembly fails closed. A missing price, a stale counter, a budget series of
 * the wrong length, an unknown SKU - each throws a BrokerError that decide()
 * turns into a refusal attributed to the gate that would have used it.
 */
import type {
  Asset,
  QfMeasurement,
  QualificationSignals,
  ScreeningResult,
  SpendProposal,
  UsdValue,
  Vault,
  Vendor,
} from '@fee-split-vaults/core'
import type { CatalogEntry, VendorCatalog } from './catalog.js'
import { BrokerError } from './errors.js'
import {
  CATEGORY_SUBCAP_BPS,
  RATE_LIMITS,
  ROLLING_WINDOW_DAYS,
  type SkuCategory,
} from './limits.js'
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  PRICE_MAX_AGE_SECONDS,
  exactCentsFromUsd,
  maxCents,
  medianCents,
  pinnedCents,
  sumCents,
} from './money.js'
import type { EffectiveLimits, VerifiedPolicy } from './policy.js'
import { validateSpendProposal } from './proposal.js'
import { TERMS, TIERS } from './protocol.js'
import type { Tier } from './protocol.js'

/**
 * The contractual shape of what signing creates. Defaults to the honest case -
 * the whole thing is due now, funded from this coin's own banked budget - so a
 * caller that omits it cannot accidentally describe a forward commitment.
 */
export interface ObligationTerms {
  /** Total obligation created by SIGNING, not by delivery. */
  totalObligationUsd: number
  /** Portion payable immediately. Any remainder is a forward obligation. */
  dueNowUsd: number
  fundingSource: 'own_banked_budget' | 'credit_line' | 'other_vault' | 'projected_flow'
  /** Set when the obligation runs past today. */
  servicePeriodEndUnix?: number
}

/**
 * The money facts. FINALIZED and UNFINALIZED are separate fields on purpose:
 * only the finalized figure is ever spendable, and keeping the unfinalized one
 * visible means a reviewer can see what was excluded rather than infer it.
 */
export interface BudgetLedgerView {
  /** Banked, escrowed, finalized budget for this vault. */
  finalizedBudget: UsdValue
  /** Credited but inside the reorg window. Never spendable. Reported only. */
  unfinalizedBudget: UsdValue
  /** Already-committed obligations not yet disbursed. */
  outstandingObligations: UsdValue
  /**
   * Exactly ROLLING_WINDOW_DAYS daily budget accruals, oldest first, zero-filled
   * for days with no accrual. Finalized figures only. Zero-filling biases the
   * median down, which is the conservative direction.
   */
  dailyBudgetAccrual: UsdValue[]
  /** Cumulative realized fees for this vault, all time. */
  cumulativeRealizedFees: UsdValue
  /** Lifetime procurement spend for this vault. */
  lifetimeSpend: UsdValue
  /** Procurement spend inside the rolling window. */
  rollingWindowSpend: UsdValue
  /** Budget accrued over the trailing 30 days. */
  budget30d: UsdValue
  /** Budget accrued in the current sub-cap period. */
  periodBudget: UsdValue
  /** Metered inference and COGS already charged to this period. Charged FIRST. */
  inferenceChargedThisPeriod: UsdValue
  /** Procurement spend this period, by SKU category. */
  categorySpendThisPeriod: Partial<Record<SkuCategory, UsdValue>>
}

export interface SpendCounters {
  proposalsLastHourForVault: number
  disbursementsTodayForVault: number
  disbursementsTodayFleet: number
  vendorDisbursementsTodayForVault: number
  /** This vendor's spend across the WHOLE client book today. */
  vendorSpendTodayFleet: UsdValue
  /** Related-party spend for this vault over the trailing 30 days. */
  relatedPartySpend30d: UsdValue
  countedAtUnix: number
}

export interface SpendRequest {
  proposal: SpendProposal
  vault: Vault
  /** The quote asset the budget is banked in. Subject to the kill switch. */
  asset: Asset
  ledger: BudgetLedgerView
  qf: QfMeasurement
  signals: QualificationSignals
  screening: ScreeningResult
  counters: SpendCounters
  /** Per-dev opt-in, recorded off the model path. Required for related parties. */
  relatedPartyOptIn: boolean
  obligation?: ObligationTerms
}

export interface ResolvedObligation {
  totalCents: bigint
  dueNowCents: bigint
  forwardCents: bigint
  fundingSource: ObligationTerms['fundingSource']
  servicePeriodEndUnix?: number
}

export interface ResolvedBudget {
  finalizedCents: bigint
  /**
   * Resolved so a reviewer can see what was excluded rather than infer it. NO
   * GATE MAY READ THIS. Solvency runs against the finalized figure alone.
   */
  unfinalizedCents: bigint
  outstandingObligationsCents: bigint
  availableCents: bigint
  dailyAccrualCents: bigint[]
  medianDailyAccrualCents: bigint
  cumulativeRealizedFeesCents: bigint
  lifetimeSpendCents: bigint
  rollingWindowSpendCents: bigint
  budget30dCents: bigint
  periodBudgetCents: bigint
  inferenceChargedCents: bigint
  /** Period budget net of inference. Inference is charged FIRST, always. */
  procurementBudgetCents: bigint
  categorySpentCents: Record<SkuCategory, bigint>
  totalCategorySpentCents: bigint
}

export interface ResolvedCounters {
  proposalsLastHourForVault: number
  disbursementsTodayForVault: number
  disbursementsTodayFleet: number
  vendorDisbursementsTodayForVault: number
  vendorSpendTodayFleetCents: bigint
  relatedPartySpend30dCents: bigint
  countedAtUnix: number
}

export interface GateContext {
  nowUnix: number
  proposal: SpendProposal
  vault: Vault
  asset: Asset
  tier: Tier
  entry: CatalogEntry
  vendor: Vendor
  category: SkuCategory
  quoteCents: bigint
  obligation: ResolvedObligation
  budget: ResolvedBudget
  counters: ResolvedCounters
  qf: QfMeasurement
  signals: QualificationSignals
  screening: ScreeningResult
  relatedPartyOptIn: boolean
  policy: VerifiedPolicy
  limits: EffectiveLimits
  /** Predicate kinds the runtime can actually verify. Unknown kind, no spend. */
  verifiableKinds: ReadonlySet<string>
}

function resolveObligation(
  terms: ObligationTerms | undefined,
  quoteCents: bigint,
): ResolvedObligation {
  if (terms === undefined) {
    return {
      totalCents: quoteCents,
      dueNowCents: quoteCents,
      forwardCents: 0n,
      fundingSource: 'own_banked_budget',
    }
  }
  const totalCents = exactCentsFromUsd(
    terms.totalObligationUsd,
    'obligation.totalObligationUsd',
    'commitment_rule',
  )
  const dueNowCents = exactCentsFromUsd(terms.dueNowUsd, 'obligation.dueNowUsd', 'commitment_rule')
  if (dueNowCents > totalCents) {
    throw new BrokerError(
      'commitment_rule',
      'incoherent_obligation',
      'the amount due now exceeds the total obligation',
    )
  }
  if (totalCents < quoteCents) {
    throw new BrokerError(
      'commitment_rule',
      'obligation_understates_quote',
      'the declared obligation is smaller than the quoted cost',
    )
  }
  const resolved: ResolvedObligation = {
    totalCents,
    dueNowCents,
    forwardCents: totalCents - dueNowCents,
    fundingSource: terms.fundingSource,
  }
  if (terms.servicePeriodEndUnix !== undefined) {
    resolved.servicePeriodEndUnix = terms.servicePeriodEndUnix
  }
  return resolved
}

function resolveBudget(ledger: BudgetLedgerView, nowUnix: number): ResolvedBudget {
  const fresh = { mode: 'floor', maxAgeSeconds: PRICE_MAX_AGE_SECONDS } as const
  const owed = { mode: 'ceil', maxAgeSeconds: PRICE_MAX_AGE_SECONDS } as const

  if (!Array.isArray(ledger.dailyBudgetAccrual)) {
    throw new BrokerError('rolling_cap', 'no_accrual_series', 'daily accrual series is missing')
  }
  if (ledger.dailyBudgetAccrual.length !== ROLLING_WINDOW_DAYS) {
    throw new BrokerError(
      'rolling_cap',
      'bad_accrual_series',
      `daily accrual series must hold exactly ${ROLLING_WINDOW_DAYS} zero-filled days, got ${ledger.dailyBudgetAccrual.length}`,
    )
  }
  const dailyAccrualCents = ledger.dailyBudgetAccrual.map((day, index) =>
    // Historical: each day was priced when it accrued, so no staleness bound.
    pinnedCents(day, nowUnix, `dailyBudgetAccrual[${index}]`, { mode: 'floor' }),
  )

  const finalizedCents = pinnedCents(ledger.finalizedBudget, nowUnix, 'finalizedBudget', fresh)
  const outstandingObligationsCents = pinnedCents(
    ledger.outstandingObligations,
    nowUnix,
    'outstandingObligations',
    owed,
  )
  const periodBudgetCents = pinnedCents(ledger.periodBudget, nowUnix, 'periodBudget', fresh)
  const inferenceChargedCents = pinnedCents(
    ledger.inferenceChargedThisPeriod,
    nowUnix,
    'inferenceChargedThisPeriod',
    owed,
  )

  const categorySpentCents = {} as Record<SkuCategory, bigint>
  for (const category of Object.keys(CATEGORY_SUBCAP_BPS) as SkuCategory[]) {
    categorySpentCents[category] = 0n
  }
  for (const [category, value] of Object.entries(ledger.categorySpendThisPeriod ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(CATEGORY_SUBCAP_BPS, category)) {
      throw new BrokerError(
        'category_subcap',
        'unknown_category',
        `ledger reports spend in unknown category "${category}"`,
      )
    }
    if (value === undefined) continue
    categorySpentCents[category as SkuCategory] = pinnedCents(
      value,
      nowUnix,
      `categorySpendThisPeriod.${category}`,
      owed,
    )
  }

  return {
    finalizedCents,
    unfinalizedCents: pinnedCents(ledger.unfinalizedBudget, nowUnix, 'unfinalizedBudget', fresh),
    outstandingObligationsCents,
    availableCents: maxCents(0n, finalizedCents - outstandingObligationsCents),
    dailyAccrualCents,
    medianDailyAccrualCents: medianCents(dailyAccrualCents),
    cumulativeRealizedFeesCents: pinnedCents(
      ledger.cumulativeRealizedFees,
      nowUnix,
      'cumulativeRealizedFees',
      fresh,
    ),
    lifetimeSpendCents: pinnedCents(ledger.lifetimeSpend, nowUnix, 'lifetimeSpend', owed),
    rollingWindowSpendCents: pinnedCents(
      ledger.rollingWindowSpend,
      nowUnix,
      'rollingWindowSpend',
      owed,
    ),
    budget30dCents: pinnedCents(ledger.budget30d, nowUnix, 'budget30d', fresh),
    periodBudgetCents,
    inferenceChargedCents,
    procurementBudgetCents: maxCents(0n, periodBudgetCents - inferenceChargedCents),
    categorySpentCents,
    totalCategorySpentCents: sumCents(Object.values(categorySpentCents)),
  }
}

function resolveCounters(counters: SpendCounters, nowUnix: number): ResolvedCounters {
  const count = (value: number, field: string): number => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BrokerError('rate_limit', 'bad_counter', `${field} is not a counter`)
    }
    return value
  }
  if (
    !Number.isFinite(counters.countedAtUnix) ||
    counters.countedAtUnix > nowUnix + CLOCK_SKEW_TOLERANCE_SECONDS ||
    counters.countedAtUnix < nowUnix - RATE_LIMITS.counterMaxAgeSeconds
  ) {
    throw new BrokerError(
      'rate_limit',
      'stale_counters',
      'spend counters are stale or timestamped in the future; unknown means no',
    )
  }
  return {
    proposalsLastHourForVault: count(
      counters.proposalsLastHourForVault,
      'proposalsLastHourForVault',
    ),
    disbursementsTodayForVault: count(
      counters.disbursementsTodayForVault,
      'disbursementsTodayForVault',
    ),
    disbursementsTodayFleet: count(counters.disbursementsTodayFleet, 'disbursementsTodayFleet'),
    vendorDisbursementsTodayForVault: count(
      counters.vendorDisbursementsTodayForVault,
      'vendorDisbursementsTodayForVault',
    ),
    vendorSpendTodayFleetCents: pinnedCents(
      counters.vendorSpendTodayFleet,
      nowUnix,
      'vendorSpendTodayFleet',
      { mode: 'ceil', maxAgeSeconds: RATE_LIMITS.counterMaxAgeSeconds },
    ),
    relatedPartySpend30dCents: pinnedCents(
      counters.relatedPartySpend30d,
      nowUnix,
      'relatedPartySpend30d',
      { mode: 'ceil', maxAgeSeconds: PRICE_MAX_AGE_SECONDS },
    ),
    countedAtUnix: counters.countedAtUnix,
  }
}

export function buildGateContext(
  request: SpendRequest,
  policy: VerifiedPolicy,
  catalog: VendorCatalog,
  verifiableKinds: ReadonlySet<string>,
  nowUnix: number,
): GateContext {
  if (!Number.isFinite(nowUnix) || nowUnix <= 0) {
    throw new BrokerError('policy_token', 'bad_clock', 'nowUnix must be a unix timestamp')
  }

  const proposal = validateSpendProposal(request.proposal)

  const vault = request.vault
  if (vault === undefined || typeof vault.address !== 'string') {
    throw new BrokerError('vault_state', 'no_vault', 'request carries no vault')
  }
  if (vault.address.toLowerCase() !== proposal.vault.toLowerCase()) {
    throw new BrokerError(
      'vault_state',
      'vault_mismatch',
      'the proposal names a different vault than the one supplied',
    )
  }
  if (policy.claims.vault.toLowerCase() !== vault.address.toLowerCase()) {
    throw new BrokerError(
      'policy_token',
      'wrong_vault',
      'the policy token is bound to a different vault',
    )
  }

  const tier = TIERS[vault.tier]
  if (tier === undefined) {
    throw new BrokerError('vault_state', 'unknown_tier', `unknown tier "${String(vault.tier)}"`)
  }
  if (policy.claims.tier !== vault.tier) {
    throw new BrokerError(
      'policy_token',
      'tier_mismatch',
      'the policy token was issued for a different tier',
    )
  }
  if (
    !Number.isInteger(vault.budgetBps) ||
    vault.budgetBps < 0 ||
    vault.budgetBps > TERMS.budgetBpsMax ||
    vault.budgetBps > vault.consent.budgetBpsMax
  ) {
    throw new BrokerError('vault_state', 'bad_dial', 'the procurement dial is out of bounds')
  }

  const entry = catalog.entry(proposal.skuId)
  const vendor = catalog.vendor(entry.sku.vendorId)
  const quoteCents = catalog.priceCents(proposal.skuId, proposal.quantity)

  return {
    nowUnix,
    proposal,
    vault,
    asset: request.asset,
    tier,
    entry,
    vendor,
    category: entry.sku.category,
    quoteCents,
    obligation: resolveObligation(request.obligation, quoteCents),
    budget: resolveBudget(request.ledger, nowUnix),
    counters: resolveCounters(request.counters, nowUnix),
    qf: request.qf,
    signals: request.signals,
    screening: request.screening,
    relatedPartyOptIn: request.relatedPartyOptIn === true,
    policy,
    limits: policy.limits,
    verifiableKinds,
  }
}

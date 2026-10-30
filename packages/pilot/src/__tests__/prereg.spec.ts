import { describe, expect, it } from 'vitest'

import { canonicalJson, CanonicalizationError, hashObject } from '../hash.js'
import {
  assertCovariatesRegistered,
  commitPlan,
  defaultAnalysisPlan,
  planHash,
  PlanTamperedError,
  PreRegistrationError,
  REQUIRED_EXCLUSION_RULES,
  REQUIRED_SENSITIVITY_ANALYSES,
  UnregisteredCovariateError,
  validatePlan,
  verifyPreRegistration,
} from '../prereg.js'

const PILOT = 'pilot-2026-q4'
const SEED = 'bootstrap-seed-771c'

describe('canonical serialization', () => {
  it('is insensitive to key order but sensitive to values', () => {
    expect(hashObject({ a: 1, b: [2, 3] })).toBe(hashObject({ b: [2, 3], a: 1 }))
    expect(hashObject({ a: 1 })).not.toBe(hashObject({ a: 2 }))
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('is sensitive to array order, which is meaningful in a plan', () => {
    expect(hashObject([1, 2])).not.toBe(hashObject([2, 1]))
  })

  it('refuses values whose serialization would be ambiguous', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(CanonicalizationError)
    expect(() => canonicalJson({ x: 1n })).toThrow(/bigint/)
    expect(() => canonicalJson({ x: () => 1 })).toThrow(CanonicalizationError)
  })
})

describe('plan validation', () => {
  it('accepts the registered Section 9 plan', () => {
    expect(() => validatePlan(defaultAnalysisPlan(PILOT, SEED))).not.toThrow()
  })

  it('refuses any adjustment covariate at all', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.adjustmentCovariates = ['coin_age_days']
    expect(() => validatePlan(plan)).toThrow(UnregisteredCovariateError)
  })

  it('refuses a re-declared stratification variable', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.stratification = [{ name: 'hour_of_day', role: 'covariate' as unknown as 'stratification' }]
    expect(() => validatePlan(plan)).toThrow(/may not be re-declared/)
  })

  it('refuses a weakened decision threshold', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.decisionRule = { ...plan.decisionRule, minFeeEffectPct: 2 }
    expect(() => validatePlan(plan)).toThrow(/at least \+10%/)
  })

  it('refuses a widened confidence level', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.decisionRule = { ...plan.decisionRule, ciLevel: 0.8 }
    expect(() => validatePlan(plan)).toThrow(/95%/)
  })

  it('refuses to let the ETI sub-study gate Phase 1', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.etiSubStudy = { ...plan.etiSubStudy, gatesPhase1: true as unknown as false }
    expect(() => validatePlan(plan)).toThrow(/does not gate Phase 1/)
  })

  it('refuses an unseeded bootstrap', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.estimator = { ...plan.estimator, ci: { ...plan.estimator.ci, seed: '' } }
    expect(() => validatePlan(plan)).toThrow(/seeded/)
  })
})

describe('the exclusions cannot be left out of the commitment', () => {
  it('registers every rule the engine is capable of applying', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    expect(plan.exclusionRules.map((r) => r.id).sort()).toEqual([...REQUIRED_EXCLUSION_RULES].sort())
    expect(plan.sensitivityAnalyses.map((s) => s.id).sort()).toEqual(
      [...REQUIRED_SENSITIVITY_ANALYSES].sort(),
    )
  })

  it('REFUSES a plan that forgot the anti-snipe exclusion', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.exclusionRules = plan.exclusionRules.filter((r) => r.id !== 'launch_window_anti_snipe')
    expect(() => validatePlan(plan)).toThrow(/launch_window_anti_snipe/)
    // And therefore cannot be hashed, and therefore cannot be committed.
    expect(() => planHash(plan)).toThrow(PreRegistrationError)
    expect(() => commitPlan(plan, 1_000)).toThrow(PreRegistrationError)
  })

  it('refuses a rule with no stated mechanism or justification', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.exclusionRules = plan.exclusionRules.map((r) =>
      r.id === 'recipient_change' ? { ...r, justification: '' } : r,
    )
    expect(() => validatePlan(plan)).toThrow(/mechanism, its rule and its justification/)
  })

  it('refuses a launch exclusion shortened below one sweep-batched day', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.exclusionParameters = { ...plan.exclusionParameters, launchExclusionHours: 12 }
    expect(() => validatePlan(plan)).toThrow(/at least 24 hours/)
  })

  it('refuses an anti-snipe window cut finer than block-timestamp granularity', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.exclusionParameters = { ...plan.exclusionParameters, antiSnipeWindowSeconds: 3 }
    expect(() => validatePlan(plan)).toThrow(/at least 5 seconds/)
  })

  it('refuses dropping a half-day, which would break the exact hour-of-day balance', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.exclusionParameters = { ...plan.exclusionParameters, dropWholeDayPair: false }
    expect(() => validatePlan(plan)).toThrow(/whole 24-hour day-pair/)
  })

  it('refuses a delivery-failure ceiling raised above a tenth', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.exclusionParameters = { ...plan.exclusionParameters, maxUndeliveredStaffedShare: 0.4 }
    expect(() => validatePlan(plan)).toThrow(/at most 10%/)
  })

  it('refuses a sensitivity analysis promoted into a decision gate', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.sensitivityAnalyses = plan.sensitivityAnalyses.map((s) =>
      s.id === 'whale_dominated_window' ? { ...s, gatesDecision: true as unknown as false } : s,
    )
    expect(() => validatePlan(plan)).toThrow(/may not gate the decision/)
  })

  it('refuses a plan that dropped a registered sensitivity analysis', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.sensitivityAnalyses = plan.sensitivityAnalyses.filter(
      (s) => s.id !== 'per_protocol_delivery',
    )
    expect(() => validatePlan(plan)).toThrow(/per_protocol_delivery/)
  })
})

describe('the power analysis cannot be left out either', () => {
  it('commits a derivation whose n matches the decision rule and the design', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    expect(plan.power.enrolledCoinsMin).toBe(plan.decisionRule.minCoins)
    expect(plan.power.enrolledCoinsMin).toBe(plan.design.targetCoinsMin)
    expect(plan.power.enrolledCoinsMax).toBe(plan.design.targetCoinsMax)
    // Not 100 and not 60: the draw is at the day level over 30 randomized days.
    expect(plan.power.pairsPerCoin).toBe(plan.design.randomizedDays)
  })

  it('refuses a power analysis computed at a different alpha than the test', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.power = { ...plan.power, alpha: 0.1 }
    expect(() => validatePlan(plan)).toThrow(/alpha/)
  })

  it('refuses a derivation whose sample drifted from the enrolment floor', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.power = { ...plan.power, enrolledCoinsMin: 25 }
    expect(() => validatePlan(plan)).toThrow(/may not drift apart/)
  })

  it('refuses a target power below the conventional 80%', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.power = { ...plan.power, targetPower: 0.6 }
    expect(() => validatePlan(plan)).toThrow(/at least 80%/)
  })

  it('refuses a planning SD that was never on the swept grid', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.power = { ...plan.power, plannedWithinCoinSd: 0.2 }
    expect(() => validatePlan(plan)).toThrow(/one of the swept values/)
  })

  it('refuses a plan that states no adequacy conclusion in words', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.power = { ...plan.power, adequacyStatement: '' }
    expect(() => validatePlan(plan)).toThrow(/whether the enrolled sample is adequate/)
  })

  it('refuses a power analysis with no simulation validating it', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.power = { ...plan.power, spotChecks: [] }
    expect(() => validatePlan(plan)).toThrow(/spot-checks/)
  })

  it('says in the committed statement that +10% is not detectable at any n', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    expect(plan.power.adequacyStatement).toContain('CANNOT DETECT +10% AT ANY SAMPLE SIZE')
    expect(plan.power.adequacyStatement).toContain('INSUFFICIENT')
  })
})

describe('the publication commitment', () => {
  it('refuses a plan that could withhold a null result', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.publication = {
      ...plan.publication,
      publishRegardlessOfOutcome: false as unknown as true,
    }
    expect(() => validatePlan(plan)).toThrow(/not a pre-registration/)
  })

  it('refuses a deadline pushed past a month', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.publication = { ...plan.publication, deadlineDaysAfterAnalysis: 180 }
    expect(() => validatePlan(plan)).toThrow(/at most 30 days/)
  })

  it('refuses an empty artifact list', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    plan.publication = { ...plan.publication, artifacts: [] }
    expect(() => validatePlan(plan)).toThrow(/what gets published/)
  })
})

describe('pre-registration', () => {
  it('commits a hash that survives re-serialization', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    const registration = commitPlan(plan, 1_000, 'anchor:0xdeadbeef')
    expect(registration.planHash).toBe(planHash(plan))
    expect(() => verifyPreRegistration(registration, 2_000)).not.toThrow()
  })

  it('REFUSES TO ANALYZE a plan that changed after commitment', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    const registration = commitPlan(plan, 1_000)
    registration.plan.decisionRule = { ...registration.plan.decisionRule, minFeeEffectPct: 10.0001 }
    expect(() => verifyPreRegistration(registration, 2_000)).toThrow(PlanTamperedError)
    expect(() => verifyPreRegistration(registration, 2_000)).toThrow(/refusing to analyze/)
  })

  it('detects a swapped endpoint even when the hash field is left alone', () => {
    const plan = defaultAnalysisPlan(PILOT, SEED)
    const registration = commitPlan(plan, 1_000)
    const primary = registration.plan.endpoints.find((e) => e.role === 'primary')!
    primary.description = 'log1p of total DEX volume'
    expect(() => verifyPreRegistration(registration)).toThrow(PlanTamperedError)
  })

  it('refuses a plan committed after data collection began', () => {
    const registration = commitPlan(defaultAnalysisPlan(PILOT, SEED), 5_000)
    expect(() => verifyPreRegistration(registration, 4_999)).toThrow(PreRegistrationError)
    expect(() => verifyPreRegistration(registration, 4_999)).toThrow(/after data collection began/)
  })

  it('refuses a nonsensical commitment timestamp', () => {
    expect(() => commitPlan(defaultAnalysisPlan(PILOT, SEED), 0)).toThrow(PreRegistrationError)
  })
})

describe('covariate gate', () => {
  const plan = defaultAnalysisPlan(PILOT, SEED)

  it('allows the two registered stratification variables', () => {
    expect(() => assertCovariatesRegistered(plan, ['hour_of_day', 'day_of_week'])).not.toThrow()
    expect(() => assertCovariatesRegistered(plan, [])).not.toThrow()
    expect(() => assertCovariatesRegistered(plan, undefined)).not.toThrow()
  })

  it('refuses anything discovered after the fact', () => {
    for (const fished of ['market_cap', 'coin_age_days', 'holder_count', 'weekend']) {
      expect(() => assertCovariatesRegistered(plan, [fished])).toThrow(UnregisteredCovariateError)
    }
  })
})

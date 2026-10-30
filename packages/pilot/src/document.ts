/**
 * The pre-registration document the pilot actually commits.
 *
 * It is RENDERED FROM THE PLAN, not written alongside it. That is the whole
 * design: the artifact a human reads and the object the analysis enforces are
 * the same data, so there is no version of this where the published document
 * says "we excluded the launch window" and the code does not, or where the
 * document quotes a power figure the derivation never produced.
 *
 * `commitPlan` hashes the output and `verifyPreRegistration` re-derives it, so a
 * document edited after commitment - even by one character - stops the analysis.
 *
 * Code-authored end to end. No model contributes a word of it, for the same
 * reason no model authors a disclosure line anywhere else in this repository.
 *
 * Imports from prereg.ts are TYPE-ONLY and stay that way: prereg.ts imports the
 * hash function below at runtime, and a value import in this direction would
 * close the cycle.
 */

import { sha256Hex } from './hash.js'
import type { AnalysisPlan } from './prereg.js'

const RULE = '='.repeat(78)
const THIN = '-'.repeat(78)

function pct(value: number, places = 1): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(places)}%`
}

/** Wrap at a fixed column so the committed bytes do not depend on a viewer. */
function wrap(text: string, width = 78, indent = ''): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  const lines: string[] = []
  let current = indent
  for (const word of words) {
    if (current.trim().length > 0 && current.length + 1 + word.length > width) {
      lines.push(current)
      current = indent + word
    } else {
      current = current.trim().length === 0 ? indent + word : `${current} ${word}`
    }
  }
  if (current.trim().length > 0) lines.push(current)
  return lines
}

/** "  - first line", then continuations aligned under the text, never the dash. */
function bullet(text: string, marker = '  - '): string[] {
  const continuation = ' '.repeat(marker.length)
  const wrapped = wrap(text, 78 - marker.length)
  return wrapped.map((line, i) => `${i === 0 ? marker : continuation}${line}`)
}

function section(lines: string[], title: string): void {
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  lines.push('')
  lines.push(RULE)
  lines.push(title)
  lines.push(RULE)
  lines.push('')
}

/**
 * Render the committed document. A pure function of the plan: same plan, same
 * bytes, on any machine, forever.
 */
export function renderPreRegistrationDocument(plan: AnalysisPlan): string {
  const lines: string[] = []
  const power = plan.power
  const params = plan.exclusionParameters

  lines.push(RULE)
  lines.push(`SECTION 9 PILOT - PRE-REGISTERED ANALYSIS PLAN`)
  lines.push(`pilot ${plan.pilotId}   plan ${plan.planVersion}`)
  lines.push(RULE)
  lines.push('')
  lines.push(
    ...wrap(
      'This document is committed by hash before the first block is observed. The analysis ' +
        'recomputes that hash and refuses to run if the plan moved. Everything below - the ' +
        'endpoint, the exclusions, the power derivation, the decision rule and the words that ' +
        'will be published in each outcome - is fixed at the moment of commitment and is not ' +
        'available afterwards.',
    ),
  )
  lines.push('')
  lines.push(
    ...wrap(
      'It is generated from the analysis plan itself rather than written next to it, so the ' +
        'document and the enforcing code cannot disagree.',
    ),
  )

  section(lines, '1. HYPOTHESIS')
  lines.push(...wrap(plan.hypothesis))
  lines.push('')
  lines.push(
    ...wrap(
      'This is the gate for the operations component of the service, which carries roughly 45% ' +
        'of its claimed value. If the effect is not demonstrated, that component is withdrawn ' +
        'from the offer rather than re-argued.',
    ),
  )

  section(lines, '2. DESIGN')
  lines.push(`  kind                     ${plan.design.kind}`)
  lines.push(`  total length             ${plan.design.totalDays} days`)
  lines.push(`  block length             ${plan.design.blockHours} hours`)
  lines.push(`  randomized phase         first ${plan.design.randomizedDays} days`)
  lines.push(`  second half              full coverage for every coin, every block`)
  lines.push(`  coins enrolled           ${plan.design.targetCoinsMin} to ${plan.design.targetCoinsMax}`)
  lines.push(`  matched pairs per coin   ${power.pairsPerCoin}`)
  lines.push(`  price to the client      free of charge; no fee, no budget, no vault, no contract`)
  lines.push('')
  lines.push(
    ...wrap(
      'The draw is taken at the DAY level. Each randomized day is a matched pair of two 12-hour ' +
        'blocks and exactly one of them is staffed, so the desk is never away for more than 24 ' +
        'consecutive hours and hour-of-day balances exactly rather than in expectation. Every ' +
        'coin receives full coverage for the second half: the study randomizes WHEN a free ' +
        'service arrives, never WHETHER it arrives.',
    ),
  )
  lines.push('')
  lines.push(
    ...wrap(
      'The assignment is a pure function of a seed published before enrolment, so any third ' +
        'party can recompute every arm of every block from the seed alone.',
    ),
  )

  section(lines, '3. ENDPOINTS')
  for (const endpoint of plan.endpoints) {
    lines.push(`  [${endpoint.role.toUpperCase()}] ${endpoint.id}`)
    lines.push(...wrap(endpoint.description, 78, '      '))
    lines.push(`      transform ${endpoint.transform}   window ${endpoint.window}`)
    lines.push('')
  }
  lines.push(
    ...wrap(
      'Every endpoint is measured over the 12 hours FOLLOWING the block, which is the next ' +
        "block's own span. That overlap is a property of the design and not an oversight; the " +
        'next block\'s arm is recorded as a diagnostic so the carryover can be described, and it ' +
        'is not a covariate.',
    ),
  )
  lines.push('')
  lines.push(
    ...wrap(
      'The secondaries carry no multiplicity control and cannot support the decision. They are ' +
        'reported because a positive primary with contradictory secondaries is worth knowing ' +
        'about, not because any of them can rescue a negative primary.',
    ),
  )

  section(lines, '4. STRATIFICATION AND COVARIATES')
  for (const stratum of plan.stratification) {
    lines.push(`  ${stratum.name.padEnd(24)} ${stratum.role}`)
  }
  lines.push('')
  lines.push(
    ...wrap(
      'Adjustment covariates: NONE, and the analysis refuses any covariate that is not one of ' +
        'the stratification variables above. Without that refusal, hour-of-day and day-of-week ' +
        'stop being stratification variables and become the two knobs a motivated analyst turns ' +
        'until the desk looks profitable.',
    ),
  )

  section(lines, '5. EXCLUSIONS')
  lines.push(
    ...wrap(
      'Each rule below names the physical mechanism it removes. All of them are applied by the ' +
        'analysis function itself, from this committed plan, so none can be forgotten and none ' +
        'can be added later. The analysis refuses to run if an exclusion report supplied with a ' +
        'dataset does not match the set this plan produces.',
    ),
  )
  lines.push('')
  for (const rule of plan.exclusionRules) {
    lines.push(`  ${rule.id.toUpperCase()}`)
    lines.push(`  ${THIN.slice(2)}`)
    lines.push('    MECHANISM')
    lines.push(...wrap(rule.mechanism, 78, '      '))
    lines.push('    RULE')
    lines.push(...wrap(rule.rule, 78, '      '))
    lines.push('    JUSTIFICATION')
    lines.push(...wrap(rule.justification, 78, '      '))
    lines.push('')
  }
  lines.push('  COMMITTED PARAMETERS')
  for (const [label, value] of [
    ['launch exclusion', `${params.launchExclusionHours} hours from launch`],
    ['graduation exclusion', `${params.graduationExclusionHours} hours from the first sweep`],
    ['anti-snipe classification', `${params.antiSnipeWindowSeconds} seconds from launch`],
    ['drop unit', params.dropWholeDayPair ? 'whole 24-hour day-pair' : 'single block'],
    [
      'delivery-failure ceiling',
      `${(params.maxUndeliveredStaffedShare * 100).toFixed(0)}% of staffed blocks`,
    ],
    [
      'whale flag threshold',
      `${(params.whaleShareThreshold * 100).toFixed(0)}% of a window in one credit`,
    ],
  ] as const) {
    lines.push(`    ${label.padEnd(30)}${value}`)
  }
  lines.push('')
  lines.push('  IN PROSE, AS THE PLAN CARRIES IT')
  for (const note of plan.exclusions) {
    lines.push(...bullet(note, '    - '))
  }

  section(lines, '6. SENSITIVITY ANALYSES (REPORTED, NEVER DECISIVE)')
  lines.push(
    ...wrap(
      'These two contaminants are deliberately NOT excluded from the primary. Both condition on ' +
        'something that happens after randomization, and dropping either would bias the effect ' +
        'in the direction the operator wants. They are run, printed next to the primary, and ' +
        'structurally incapable of changing the verdict.',
    ),
  )
  lines.push('')
  for (const spec of plan.sensitivityAnalyses) {
    lines.push(`  ${spec.id.toUpperCase()}   gates the decision: no`)
    lines.push(...wrap(spec.description, 78, '      '))
    lines.push('    WHY IT IS NOT AN EXCLUSION')
    lines.push(...wrap(spec.justification, 78, '      '))
    lines.push('')
  }

  section(lines, '7. POWER')
  lines.push(
    ...wrap(
      'n = 40-60 arrived from a brief. What follows is the derivation for THIS design - paired ' +
        'within coin, matched 12-hour blocks, Hodges-Lehmann with a percentile bootstrap, ' +
        'decided by the two-part rule in section 8 - and not for the between-coin trial whose ' +
        'textbook formula would flatter it.',
    ),
  )
  lines.push('')
  lines.push('  METHOD')
  lines.push(`    ${power.method}`)
  lines.push(
    ...wrap(
      'The committed rule reads only the bootstrap interval and the Hodges-Lehmann point ' +
        'estimate, both asymptotically normal, so the rule has a usable normal approximation and ' +
        'that is what the table below reports. The Wilcoxon signed-rank test has no closed-form ' +
        'power; a seeded Monte Carlo simulation that runs the real analysis functions supplies ' +
        'it, and validates the table at the spot-check points.',
      78,
      '    ',
    ),
  )
  lines.push('')
  lines.push('  ASSUMPTIONS, STATED SO THEY CAN BE ARGUED WITH')
  lines.push(`    alpha                              ${power.alpha}`)
  lines.push(`    target power                       ${(power.targetPower * 100).toFixed(0)}%`)
  lines.push(`    matched pairs per coin             ${power.pairsPerCoin}`)
  lines.push(`    within-coin SD grid (log1p)        ${power.withinCoinSdGrid.join(', ')}`)
  lines.push(`    planning within-coin SD            ${power.plannedWithinCoinSd}`)
  lines.push(`    between-coin effect SD             ${power.plannedBetweenCoinEffectSd}`)
  lines.push(`    estimator efficiency vs the mean   ${power.estimatorEfficiency.toFixed(4)}`)
  lines.push(`    coins enrolled                     ${power.enrolledCoinsMin} to ${power.enrolledCoinsMax}`)
  lines.push(`    simulation                         seed ${power.simulation.seed}, ${power.simulation.trials} trials, ${power.simulation.bootstrapIterations} bootstrap draws`)
  lines.push('')
  lines.push(
    ...wrap(
      'The within-coin SD is the SD of log1p(fees) across 12-hour windows after hour-of-day and ' +
        'day-of-week are taken out as strata. It must still include day-level shocks: the ' +
        'estimator compares a staffed Monday morning against a DIFFERENT unstaffed Monday ' +
        'morning, so a day-level shock is not differenced out by that contrast. The between-coin ' +
        'effect SD is heterogeneity in the true effect, which no number of blocks per coin ' +
        'removes - only more coins touch it.',
      78,
      '    ',
    ),
  )
  lines.push('')
  lines.push('  POWER OF THE COMMITTED RULE')
  lines.push(`    ${'coins'.padEnd(7)}${'SD'.padEnd(8)}${'true effect'.padEnd(14)}rule power`)
  for (const point of power.powerCurve) {
    lines.push(
      `    ${String(point.coins).padEnd(7)}${point.withinCoinSd.toFixed(1).padEnd(8)}` +
        `${pct(point.trueEffectPct, 0).padEnd(14)}${point.rulePower.toFixed(3).padStart(6)}`,
    )
  }
  lines.push('')
  lines.push('  SIMULATION SPOT-CHECKS (real analysis path, seeded)')
  lines.push(
    `    ${'coins'.padEnd(7)}${'SD'.padEnd(8)}${'true effect'.padEnd(14)}${'rule'.padEnd(8)}wilcoxon`,
  )
  for (const check of power.spotChecks) {
    lines.push(
      `    ${String(check.coins).padEnd(7)}${check.withinCoinSd.toFixed(1).padEnd(8)}` +
        `${pct(check.trueEffectPct, 0).padEnd(14)}${check.simulatedRulePower.toFixed(3).padEnd(8)}` +
        `${check.simulatedWilcoxonPower.toFixed(3)}`,
    )
  }
  lines.push('')
  lines.push(
    ...wrap(
      'The two agree to within about six points at every checked design, in both directions, ' +
        'which is roughly two Monte Carlo standard errors at 400 trials. Neither is tuned to the ' +
        'other. Under a true null the committed rule returns PROCEED about 3% of the time, below ' +
        'alpha, because the rule is one-sided in effect and additionally requires the point ' +
        'estimate to clear the threshold.',
      78,
      '    ',
    ),
  )
  lines.push('')
  lines.push('  MINIMUM DETECTABLE EFFECT, at the planning SD')
  lines.push(
    `    ${power.enrolledCoinsMin} coins   ${pct(power.mdePctAtMinCoins, 2)} per staffed block`,
  )
  lines.push(
    `    ${power.enrolledCoinsMax} coins   ${pct(power.mdePctAtMaxCoins, 2)} per staffed block`,
  )
  lines.push('')
  lines.push('  ADEQUACY, COMMITTED IN ADVANCE')
  lines.push(...wrap(power.adequacyStatement, 78, '    '))

  section(lines, '8. DECISION RULE')
  lines.push(
    ...wrap(
      `PROCEED TO PHASE 1 if and only if the ${(plan.decisionRule.ciLevel * 100).toFixed(0)}% ` +
        'bootstrap interval on the primary endpoint excludes zero AND the Hodges-Lehmann point ' +
        `estimate is at least ${pct(plan.decisionRule.minFeeEffectPct, 0)} per staffed block, ` +
        `over at least ${plan.decisionRule.minCoins} coins each contributing at least ` +
        `${plan.decisionRule.minPairedStrataPerCoin} stratum in which both arms were observed.`,
    ),
  )
  lines.push('')
  lines.push(
    ...wrap(
      'The rule is evaluated mechanically, with no human in the loop, and the statement it emits ' +
        'is the one committed below, verbatim. There is no branch in which a result is ' +
        'interpreted, subset or re-analysed against a different endpoint.',
    ),
  )
  lines.push('')
  for (const [label, statement] of [
    ['ON SUCCESS', plan.decisionRule.successStatement],
    ['ON FAILURE', plan.decisionRule.failureStatement],
    ['IF UNDERPOWERED', plan.decisionRule.underpoweredStatement],
    ['IF DELIVERY COMPROMISED', plan.decisionRule.deliveryCompromisedStatement],
  ] as const) {
    lines.push(`  ${label}`)
    lines.push(...wrap(statement, 78, '    '))
    lines.push('')
  }

  section(lines, '9. ETI SUB-STUDY')
  lines.push(
    `  ${plan.etiSubStudy.enabled ? 'enabled' : 'disabled'}   ${plan.etiSubStudy.coins} coins, ` +
      `${plan.etiSubStudy.lagDays}-day control lag`,
  )
  lines.push(`  endpoint ${plan.etiSubStudy.endpointId}   estimator ${plan.etiSubStudy.estimator}`)
  lines.push(`  inference ${plan.etiSubStudy.inference}, ${plan.etiSubStudy.iterations} iterations`)
  lines.push('')
  lines.push(
    ...wrap(
      'Only the ORDER of purchase is randomized; every coin gets the listing. The sub-study ' +
        'informs procurement and DOES NOT gate Phase 1. The operator buys the listing as ' +
        'principal, in its own name, out of its own money.',
    ),
  )

  section(lines, '10. WHAT IS PUBLISHED, INCLUDING IF THE RESULT IS NULL')
  lines.push(...wrap(plan.publication.nullResultStatement))
  lines.push('')
  lines.push(
    `  Published within ${plan.publication.deadlineDaysAfterAnalysis} days of the analysis date:`,
  )
  for (const artifact of plan.publication.artifacts) {
    lines.push(...bullet(artifact, '    - '))
  }

  section(lines, '11. WHAT WOULD INVALIDATE THIS TRIAL')
  for (const invalidation of [
    'Any change to this plan after commitment. The hash is checked at analysis time and a mismatch stops the analysis rather than warning about it.',
    'A dataset whose assignment hash does not match the committed assignment: the arms may have moved.',
    'An exclusion set that differs from the one this plan produces, in either direction.',
    'Any covariate introduced at analysis time, including a stratification variable re-declared as an adjustment.',
    `Delivery failure above ${(params.maxUndeliveredStaffedShare * 100).toFixed(0)}% of staffed blocks, which voids the arm contrast and returns COMPROMISED_DELIVERY.`,
    'A plan committed after the first observation. The analysis checks the commitment timestamp against the earliest observation and refuses.',
  ]) {
    lines.push(...bullet(invalidation))
  }

  lines.push('')
  lines.push(RULE)
  lines.push('END OF PRE-REGISTRATION')
  lines.push(RULE)
  return `${lines.join('\n')}\n`
}

/** The hash `commitPlan` records and `verifyPreRegistration` re-derives. */
export function preRegistrationDocumentHash(plan: AnalysisPlan): string {
  return sha256Hex(renderPreRegistrationDocument(plan))
}

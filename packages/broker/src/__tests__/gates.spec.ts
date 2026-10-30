import { describe, expect, it, vi } from 'vitest'
import {
  GATE_CHAIN,
  GATE_NAMES,
  evaluateGates,
  relatedPartyCapCents,
  rollingCapCents,
  traceGates,
} from '../gates.js'
import { VendorCatalog } from '../catalog.js'
import type { BudgetLedgerView, SpendRequest } from '../context.js'
import { RATE_LIMITS, ROLLING_WINDOW_DAYS } from '../limits.js'
import { exactCentsFromUsd } from '../money.js'
import { QUALIFICATION_FLOOR_MONTHLY_USD, SPEND_LIMITS, TIERS } from '../protocol.js'
import {
  ACTIVE_DAYS,
  DAY,
  HEALTHY_T1_QF_PER_DAY,
  KOL_SKU_ID,
  LOW_DIAL_BPS,
  NOW,
  OPERATOR_SKU_ID,
  RELATED_SKU_ID,
  dailyAccrualUsd,
  makeBroker,
  makeContext,
  makeCounters,
  makeEntries,
  makeLedger,
  makeLedgerFor,
  makeLowDialRequest,
  makeProposal,
  makeQf,
  makeRequest,
  makeScreening,
  makeSignals,
  makeVault,
  makeVendors,
  usd,
  usdCents,
} from './fixtures.js'

describe('the gate chain', () => {
  it('is ordered, unique, and starts with the constraints that are not negotiable', () => {
    expect(GATE_NAMES).toEqual([
      'policy_token',
      'asset_kill_switch',
      'vault_state',
      'catalog',
      'screening',
      'solvency',
      'commitment_rule',
      'rolling_cap',
      'lifetime_cap',
      'qualified_fee',
      'category_subcap',
      'payee_allowlist',
      'related_party',
      'vendor_reliability',
      'fleet_vendor_daily_cap',
      'measurability',
      'rate_limit',
      'human_approval',
    ])
    expect(new Set(GATE_NAMES).size).toBe(GATE_NAMES.length)
    expect(Object.isFrozen(GATE_CHAIN)).toBe(true)
  })

  it('approves a healthy T1 listing purchase', () => {
    const decision = evaluateGates(makeContext())
    expect(decision.approved).toBe(true)
    expect(decision.requiresHumanApproval).toBe(false)
    expect(decision.quotedCostUsd).toBe(299)
  })

  it('is deterministic: the wall clock cannot change the answer', () => {
    const ctx = makeContext()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2020-01-01T00:00:00Z'))
      const first = evaluateGates(ctx)
      vi.setSystemTime(new Date('2031-06-06T06:06:06Z'))
      const second = evaluateGates(ctx)
      expect(second).toEqual(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops at the first failure and reports which gate it was', () => {
    const ctx = makeContext(makeRequest({ vault: makeVault({ state: 'SUSPENDED' }) }))
    const trace = traceGates(ctx)
    expect(trace.at(-1)?.gate).toBe('vault_state')
    expect(trace.map((t) => t.gate)).not.toContain('solvency')
    expect(evaluateGates(ctx).failedGate).toBe('vault_state')
  })
})

/**
 * The fixture the rest of this file argues from. It is asserted rather than
 * assumed because a ledger that contradicts its own QF reads as a measured fact
 * and silently moves every cap derived from it - which is exactly how a cap test
 * stops binding without anyone noticing.
 */
describe('the default fixture is the money this client would actually have', () => {
  it('derives every figure from the coin QF and the dev dial', () => {
    const ctx = makeContext()
    const qf = ctx.qf.qfPerDay
    const perDayUsd = dailyAccrualUsd(qf, ctx.vault.budgetBps)
    const perDayCents = exactCentsFromUsd(perDayUsd, 'accrual')

    // The default premise lands on a whole cent, so nothing is lost to the
    // flooring inside dailyAccrualUsd and the figures below are exact.
    expect(perDayUsd).toBe((qf * ctx.vault.budgetBps) / 10_000)
    expect(ctx.budget.dailyAccrualCents).toHaveLength(ROLLING_WINDOW_DAYS)
    expect(ctx.budget.medianDailyAccrualCents).toBe(perDayCents)
    expect(ctx.budget.budget30dCents).toBe(exactCentsFromUsd(perDayUsd * 30, 'budget30d'))
    // The sub-cap period defaults to the trailing 30 days.
    expect(ctx.budget.periodBudgetCents).toBe(ctx.budget.budget30dCents)
    expect(ctx.budget.finalizedCents).toBe(
      exactCentsFromUsd(perDayUsd * ROLLING_WINDOW_DAYS, 'banked'),
    )
    const daysLive = (NOW - (ctx.vault.activatedAtUnix ?? NOW)) / DAY
    expect(daysLive).toBe(ACTIVE_DAYS)
    expect(ctx.budget.cumulativeRealizedFeesCents).toBe(exactCentsFromUsd(qf * daysLive, 'fees'))
    expect(ctx.budget.inferenceChargedCents).toBe(
      exactCentsFromUsd(TIERS.T1.cogsPerDay * 30, 'cogs'),
    )
    // Nothing bought yet, said consistently in all three places.
    expect(ctx.budget.lifetimeSpendCents).toBe(0n)
    expect(ctx.budget.rollingWindowSpendCents).toBe(0n)
    expect(ctx.budget.totalCategorySpentCents).toBe(0n)
  })

  it('carries a rolling cap no catalog line can reach, which is why the cap tests drop the dial', () => {
    const healthy = rollingCapCents(makeContext())
    const mostExpensiveLine = makeEntries()
      .map((entry) => exactCentsFromUsd(entry.sku.unitCostUsd, 'unit') * BigInt(entry.maxQuantity))
      .reduce((a, b) => (a > b ? a : b), 0n)
    expect(mostExpensiveLine).toBeLessThan(healthy)

    // Drop the dial and the same coin's cap comes back within reach, which is
    // the premise the rolling-cap tests are built on.
    expect(rollingCapCents(makeContext(makeLowDialRequest()))).toBeLessThan(mostExpensiveLine)
  })
})

describe('solvency', () => {
  it('spends only against the finalized budget', () => {
    const ctx = makeContext(
      makeRequest({
        ledger: makeLedger({ finalizedBudget: usd(100), unfinalizedBudget: usd(10_000) }),
      }),
    )
    const decision = evaluateGates(ctx)
    expect(decision.approved).toBe(false)
    expect(decision.failedGate).toBe('solvency')
  })

  it('ignores unfinalized budget entirely, however large it grows', () => {
    const small = evaluateGates(
      makeContext(
        makeRequest({ ledger: makeLedger({ finalizedBudget: usd(100), unfinalizedBudget: usd(0) }) }),
      ),
    )
    const huge = evaluateGates(
      makeContext(
        makeRequest({
          ledger: makeLedger({ finalizedBudget: usd(100), unfinalizedBudget: usd(9_000_000) }),
        }),
      ),
    )
    expect(huge).toEqual(small)
  })

  it('reserves outstanding obligations before quoting a new one', () => {
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          ledger: makeLedger({ finalizedBudget: usd(400), outstandingObligations: usd(350) }),
        }),
      ),
    )
    expect(decision.failedGate).toBe('solvency')
  })
})

/**
 * THE ROLLING CAP.
 *
 * The cap is a function of the client, not of a fixture constant: it is
 * rollingCapOfMedian x ROLLING_WINDOW_DAYS x (QF x dial). At the default dial
 * that puts the cap on today's numbers at $2,016, beyond anything the catalog
 * can quote at its maxQuantity, so these tests run the SAME coin at
 * LOW_DIAL_BPS, where the cap is $504 and a second listing breaches it. The
 * test above this one asserts that relationship rather than assuming it, so a
 * config change that brings the default client back within reach is visible
 * instead of silent. Every assertion here is computed from
 * rollingCapCents() rather than from a number written here, so the tests bind
 * wherever the cap lands - and every one of them goes red if the gate stops
 * comparing against it.
 */
describe('rolling cap', () => {
  const capContext = (
    ledger: Partial<BudgetLedgerView> = {},
    request: Partial<SpendRequest> = {},
  ) => makeContext(makeLowDialRequest(ledger, request))

  /**
   * A ledger that has already spent `cents` inside the window. Spend is not one
   * field: it leaves the banked budget, it counts against the lifetime figure,
   * and it lands in some category's sub-cap for the period. It is booked to kol
   * so that a listing proposal meets the WINDOW cap first rather than the
   * listing sub-cap, which at this dial is the tighter of the two.
   */
  const spentInWindow = (cents: bigint): Partial<BudgetLedgerView> => {
    const banked = exactCentsFromUsd(
      dailyAccrualUsd(HEALTHY_T1_QF_PER_DAY, LOW_DIAL_BPS) * ROLLING_WINDOW_DAYS,
      'banked',
    )
    return {
      rollingWindowSpend: usdCents(cents),
      lifetimeSpend: usdCents(cents),
      finalizedBudget: usdCents(banked - cents),
      categorySpendThisPeriod: { kol: usdCents(cents) },
    }
  }

  it('caps the window at the configured share of the median daily accrual, inclusive', () => {
    const base = capContext()
    const perDayCents = exactCentsFromUsd(
      dailyAccrualUsd(HEALTHY_T1_QF_PER_DAY, LOW_DIAL_BPS),
      'accrual',
    )
    expect(base.budget.medianDailyAccrualCents).toBe(perDayCents)

    const cap = rollingCapCents(base)
    expect(cap).toBe(
      BigInt(
        Math.round(Number(perDayCents) * ROLLING_WINDOW_DAYS * SPEND_LIMITS.rollingCapOfMedian),
      ),
    )

    // Exactly ON the cap is inside it. Approving here is also what proves the
    // low-dial client is a real one: it still clears the qualification floor,
    // the sub-caps and the solvency test with this spend already booked.
    const headroom = cap - base.quoteCents
    const atCap = capContext(spentInWindow(headroom))
    expect(atCap.budget.rollingWindowSpendCents + atCap.quoteCents).toBe(cap)
    expect(evaluateGates(atCap).approved).toBe(true)

    // One cent past it is outside.
    const overCap = capContext(spentInWindow(headroom + 1n))
    expect(overCap.budget.rollingWindowSpendCents + overCap.quoteCents).toBe(cap + 1n)
    expect(evaluateGates(overCap).failedGate).toBe('rolling_cap')
  })

  it('refuses a quantity the window cannot fund, with nothing spent yet', () => {
    const decision = evaluateGates(
      capContext({}, { proposal: makeProposal({ quantity: 2 }) }),
    )
    expect(decision.failedGate).toBe('rolling_cap')
  })

  it('counts spend already made inside the window, not just the new quote', () => {
    const base = capContext()
    // A dollar past the headroom. One listing on its own fits; this one does not.
    const decision = evaluateGates(
      capContext(spentInWindow(rollingCapCents(base) - base.quoteCents + 100n)),
    )
    expect(decision.failedGate).toBe('rolling_cap')
    expect(decision.reason).toContain('window spend would reach')
  })
})

describe('lifetime cap', () => {
  it('binds lifetime spend to a share of cumulative realized fees', () => {
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          ledger: makeLedger({ cumulativeRealizedFees: usd(500), lifetimeSpend: usd(100) }),
        }),
      ),
    )
    expect(decision.failedGate).toBe('lifetime_cap')
  })
})

describe('qualified fee', () => {
  it('refuses below the tier gate, and admits a client exactly on it', () => {
    const gate = TIERS.T1.gateQfPerDay
    const below = evaluateGates(makeContext(makeRequest({ qf: makeQf({ qfPerDay: gate - 1 }) })))
    expect(below.failedGate).toBe('qualified_fee')
    expect(below.reason).toContain(`below the T1 gate of ${gate}`)

    // The gate is a floor, not a strict inequality: a client sitting exactly on
    // it qualifies. Asserting both sides pins the boundary wherever the gate is.
    const onIt = evaluateGates(makeContext(makeRequest({ qf: makeQf({ qfPerDay: gate }) })))
    expect(onIt.approved).toBe(true)
  })

  it('refuses when the gate has not been sustained', () => {
    const decision = evaluateGates(
      makeContext(makeRequest({ qf: makeQf({ sustainedDays: TIERS.T1.sustainedDays - 1 }) })),
    )
    expect(decision.failedGate).toBe('qualified_fee')
    expect(decision.reason).toContain(`${TIERS.T1.sustainedDays} required`)
  })

  it('refuses a stale measurement rather than reusing it', () => {
    const decision = evaluateGates(
      makeContext(makeRequest({ qf: makeQf({ measuredAtUnix: NOW - 3 * DAY }) })),
    )
    expect(decision.failedGate).toBe('qualified_fee')
  })

  it('refuses when the monthly procurement slice cannot fund the cheapest deliverable', () => {
    // A client that CLEARS the QF gate but whose dial is one basis point below
    // what the floor needs. Constructed from the gate and the floor so the
    // refusal is always the floor and never the gate arriving first.
    const gate = TIERS.T1.gateQfPerDay
    const dialThatMeetsFloor = (QUALIFICATION_FLOOR_MONTHLY_USD * 10_000) / (gate * 30)
    const starvedDialBps = Math.ceil(dialThatMeetsFloor) - 1
    expect(starvedDialBps).toBeGreaterThan(0)

    // The ledger is derived from the same QF and dial the vault declares, so
    // this is a starved client's actual money and not a healthy client's money
    // wearing a starved dial.
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          vault: makeVault({ budgetBps: starvedDialBps }),
          qf: makeQf({ qfPerDay: gate }),
          ledger: makeLedgerFor({ qfPerDay: gate, budgetBps: starvedDialBps }),
        }),
      ),
    )
    expect(decision.failedGate).toBe('qualified_fee')
    expect(decision.reason).toContain('qualification floor')

    // One basis point more and the same client qualifies, which is what makes
    // the previous assertion a floor test rather than a gate test. It also says
    // something the floor is FOR: at the floor the procurement slice, net of
    // cost to serve, can still buy the cheapest deliverable in the catalog.
    const funded = evaluateGates(
      makeContext(
        makeRequest({
          vault: makeVault({ budgetBps: starvedDialBps + 1 }),
          qf: makeQf({ qfPerDay: gate }),
          ledger: makeLedgerFor({ qfPerDay: gate, budgetBps: starvedDialBps + 1 }),
        }),
      ),
    )
    expect(funded.approved).toBe(true)
  })

  it('refuses on wash-trading conjuncts even when QF itself clears', () => {
    const decision = evaluateGates(
      makeContext(makeRequest({ signals: makeSignals({ selfTradeSharePct: 40 }) })),
    )
    expect(decision.failedGate).toBe('qualified_fee')
    expect(decision.reason).toContain('self-trade')
  })

  it('escalates rather than refuses when Venue-pool volume share is thin', () => {
    const decision = evaluateGates(
      makeContext(makeRequest({ signals: makeSignals({ venuePoolVolumeSharePct: 2 }) })),
    )
    expect(decision.approved).toBe(true)
    expect(decision.requiresHumanApproval).toBe(true)
  })

  it('refuses when the fee-bearing pool is effectively dead', () => {
    const decision = evaluateGates(
      makeContext(makeRequest({ signals: makeSignals({ venuePoolVolumeSharePct: 0.1 }) })),
    )
    expect(decision.failedGate).toBe('qualified_fee')
  })
})

describe('category sub-caps', () => {
  it('charges inference first and refuses when it has eaten the period budget', () => {
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          ledger: makeLedger({ periodBudget: usd(40), inferenceChargedThisPeriod: usd(40) }),
        }),
      ),
    )
    expect(decision.failedGate).toBe('category_subcap')
    expect(decision.reason).toContain('inference')
  })

  it('applies the sub-cap to the budget net of inference', () => {
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          ledger: makeLedger({
            periodBudget: usd(1_000),
            inferenceChargedThisPeriod: usd(200),
            categorySpendThisPeriod: { listing: usd(200) },
          }),
        }),
      ),
    )
    // Procurement budget 80000c, listing sub-cap 24000c, already spent 20000c.
    expect(decision.failedGate).toBe('category_subcap')
  })

  it('refuses a ledger reporting spend in an unknown category', async () => {
    // Assembly fails closed, and the broker attributes the refusal to the gate
    // that would have consumed the bad input rather than throwing at a caller.
    const decision = await makeBroker().decide(
      makeRequest({
        ledger: makeLedger({ categorySpendThisPeriod: { airdrop: usd(10) } as never }),
      }),
      NOW,
    )
    expect(decision.approved).toBe(false)
    expect(decision.failedGate).toBe('category_subcap')
  })
})

describe('vendor gates', () => {
  it('refuses a related-party vendor without a per-dev opt-in', () => {
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          proposal: makeProposal({ skuId: RELATED_SKU_ID }),
          relatedPartyOptIn: false,
        }),
      ),
    )
    expect(decision.failedGate).toBe('related_party')
  })

  it('caps a related-party vendor at a share of the 30-day budget', () => {
    const base = makeContext(
      makeRequest({
        proposal: makeProposal({ skuId: RELATED_SKU_ID }),
        relatedPartyOptIn: true,
      }),
    )
    // Computed from the cap, so this binds wherever the 30-day budget lands:
    // one cent more related-party spend than this purchase has headroom for.
    const spend = relatedPartyCapCents(base) - base.quoteCents + 1n
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          proposal: makeProposal({ skuId: RELATED_SKU_ID }),
          relatedPartyOptIn: true,
          counters: makeCounters({ relatedPartySpend30d: usdCents(spend) }),
        }),
      ),
    )
    expect(decision.failedGate).toBe('related_party')
    expect(decision.reason).toContain('related-party spend would reach')
  })

  it('escalates an opted-in related-party purchase', () => {
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          proposal: makeProposal({ skuId: RELATED_SKU_ID }),
          relatedPartyOptIn: true,
        }),
      ),
    )
    expect(decision.approved).toBe(true)
    expect(decision.requiresHumanApproval).toBe(true)
  })

  it('lets the operator bill its own published rate without the related-party cap', () => {
    const decision = evaluateGates(
      makeContext(makeRequest({ proposal: makeProposal({ skuId: OPERATOR_SKU_ID }) })),
    )
    expect(decision.approved).toBe(true)
    // Escalated because delivery rests on a manual attestation, not because of
    // the related-party cap.
    expect(decision.reason).toContain('manual attestation')
  })
})

describe('fleet-wide and rate limits', () => {
  it('caps one vendor across the whole client book per day', () => {
    // $100 of headroom left in the fleet cap, against a $299 listing.
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          counters: makeCounters({
            vendorSpendTodayFleet: usd(SPEND_LIMITS.fleetVendorDailyCapUsd - 100),
          }),
        }),
      ),
    )
    expect(decision.failedGate).toBe('fleet_vendor_daily_cap')
  })

  it('refuses when proposals are arriving too fast', () => {
    // The limit is a ceiling the counter may not reach, so the boundary value
    // itself must refuse.
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          counters: makeCounters({
            proposalsLastHourForVault: RATE_LIMITS.proposalsPerHourPerVault,
          }),
        }),
      ),
    )
    expect(decision.failedGate).toBe('rate_limit')
    expect(decision.reason).toContain('proposals in the last hour')
  })

  it('treats stale counters as unknown, and unknown as no', async () => {
    const decision = await makeBroker().decide(
      makeRequest({ counters: makeCounters({ countedAtUnix: NOW - 10_000 }) }),
      NOW,
    )
    expect(decision.approved).toBe(false)
    expect(decision.failedGate).toBe('rate_limit')
  })
})

describe('measurability', () => {
  it('requires a KOL post to be checked at both T+24h and T+7d', () => {
    const request = makeRequest({ proposal: makeProposal({ skuId: KOL_SKU_ID }) })
    expect(evaluateGates(makeContext(request)).approved).toBe(true)

    // The failure mode is a post that appears, is paid for, and is deleted, so
    // a single check is not a predicate.
    const entries = makeEntries().map((entry) =>
      entry.sku.id === KOL_SKU_ID
        ? {
            ...entry,
            sku: {
              ...entry.sku,
              predicate: { ...entry.sku.predicate, verifyAtOffsetsSeconds: [DAY] },
            },
          }
        : entry,
    )
    const decision = evaluateGates(
      makeContext(request, { catalog: new VendorCatalog(makeVendors(), entries) }),
    )
    expect(decision.failedGate).toBe('measurability')
    expect(decision.reason).toContain('T+7d')
  })

  it('escalates when delivery rests on a manual attestation', () => {
    const decision = evaluateGates(
      makeContext(makeRequest({ proposal: makeProposal({ skuId: OPERATOR_SKU_ID }) })),
    )
    expect(decision.requiresHumanApproval).toBe(true)
  })
})

describe('screening and assets', () => {
  it('refuses paid media when screening permits organic operations only', () => {
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          screening: makeScreening({ verdict: 'RESTRICTED', paidMediaPermitted: false }),
        }),
      ),
    )
    expect(decision.failedGate).toBe('screening')
  })

  it('refuses an expired screening', () => {
    const decision = evaluateGates(
      makeContext(makeRequest({ screening: makeScreening({ screenedAtUnix: NOW - 60 * DAY }) })),
    )
    expect(decision.failedGate).toBe('screening')
  })

  it('refuses an asset that is off the signed allowlist', () => {
    const request = makeRequest()
    request.asset = { ...request.asset, address: '0xabababababababababababababababababababab' }
    const decision = evaluateGates(makeContext(request))
    expect(decision.failedGate).toBe('asset_kill_switch')
  })
})

describe('human approval band', () => {
  it('escalates above the threshold without refusing', () => {
    // The default client's own ledger funds a $400 KOL post; nothing has to be
    // propped up for this test, only the threshold tightened.
    const decision = evaluateGates(
      makeContext(makeRequest({ proposal: makeProposal({ skuId: KOL_SKU_ID }) }), {
        limits: { humanApprovalThresholdUsd: 100 },
      }),
    )
    expect(decision.approved).toBe(true)
    expect(decision.requiresHumanApproval).toBe(true)
    expect(decision.reason).toContain('human approval required')
  })
})

describe('T0 buys nothing', () => {
  it('refuses paid media at the deterministic tier', () => {
    const request = makeRequest({ vault: makeVault({ tier: 'T0' }) })
    const decision = evaluateGates(makeContext(request, { tier: 'T0' }))
    expect(decision.failedGate).toBe('catalog')
  })
})

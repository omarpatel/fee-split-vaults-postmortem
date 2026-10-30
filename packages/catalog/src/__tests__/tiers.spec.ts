/**
 * Tier affordability: never offer what the budget cannot buy.
 */
import { describe, expect, it } from 'vitest'
import { TierAvailabilityViolation } from '../errors.js'
import { applyBps, usdFromCents } from '../money.js'
import {
  AFFORDABILITY,
  affordableTiers,
  assertTierAvailability,
  dailyProcurementBudgetCents,
  evaluateTier,
  maxSingleLineCents,
  minViableSpendCents,
  monthlyProcurementBudgetCents,
  monthlyProcurementBudgetUsd,
} from '../tiers.js'
import { QUALIFICATION_FLOOR_MONTHLY_USD, TERMS, TIERS, TIER_ORDER } from '../protocol.js'
import type { TierId } from '../protocol.js'
import { passThroughEntry, serviceEntry } from './fixtures.js'

/**
 * The model, restated from the config rather than copied out of it: a coin
 * sitting exactly on a tier's gate accrues gate x dial x 30 days a month.
 *
 * Every worked example below is built from this, so a gate change moves the
 * expectation with the behaviour instead of turning the suite red.
 */
function monthlyUsdAtGate(tier: TierId): number {
  // Integer throughout - gate x bps x days is exact, and dividing last keeps it
  // that way for every value the tier table can hold.
  const { gateQfPerDay } = TIERS[tier]
  return (gateQfPerDay * AFFORDABILITY.modelBudgetBps * AFFORDABILITY.daysPerMonth) / 10_000
}

/** The tiers that may buy anything at all. T0 is deterministic and unfunded. */
const PAID_TIERS = TIER_ORDER.filter((tier) => TIERS[tier].gateQfPerDay > 0)

describe('the budget model', () => {
  it('models a tier at the DEFAULT dial, not the maximum', () => {
    expect(AFFORDABILITY.modelBudgetBps).toBe(TERMS.budgetBpsDefault)
    expect(AFFORDABILITY.modelBudgetBps).toBeLessThan(TERMS.budgetBpsMax)
  })

  it('keeps every paid tier at or above the qualification floor', () => {
    // QUALIFICATION_FLOOR_MONTHLY_USD is a FLOOR, not a target. It is the
    // monthly procurement below which a paid tier cannot fund its own cheapest
    // deliverable, so what must never happen is a paid tier sitting under it.
    // T1's gate used to land exactly on the floor; at $1,000/day it clears it
    // with room, and that is a healthier tier table rather than a broken one.
    for (const tier of PAID_TIERS) {
      expect(monthlyProcurementBudgetUsd(tier)).toBeGreaterThanOrEqual(
        QUALIFICATION_FLOOR_MONTHLY_USD,
      )
    }

    // And the floor is where it is because of one price: a coin sitting exactly
    // on it can still fund a $299 Dexscreener listing under the half-month rule.
    const spendableAtFloorUsd =
      (QUALIFICATION_FLOOR_MONTHLY_USD * AFFORDABILITY.maxSingleLineShareBps) / 10_000
    expect(spendableAtFloorUsd).toBeGreaterThanOrEqual(299)
  })

  it('computes each tier in integer cents', () => {
    expect(dailyProcurementBudgetCents('T0')).toBe(0n)
    expect(monthlyProcurementBudgetCents('T0')).toBe(0n)

    // The worked example, at the tier the whole menu is sized around:
    // gate x dial x 30 days, which at today's parameters is
    // $1,000/day x 20% x 30 = $6,000/month.
    expect(monthlyProcurementBudgetUsd('T1')).toBe(monthlyUsdAtGate('T1'))
    expect(monthlyProcurementBudgetCents('T1')).toBe(BigInt(monthlyUsdAtGate('T1') * 100))

    // Every tier scales with its own gate and with nothing else.
    for (const tier of TIER_ORDER) {
      expect(monthlyProcurementBudgetUsd(tier)).toBe(monthlyUsdAtGate(tier))
      expect(monthlyProcurementBudgetCents(tier)).toBe(
        dailyProcurementBudgetCents(tier) * BigInt(AFFORDABILITY.daysPerMonth),
      )
    }

    // A higher gate always buys more. If two tiers ever inverted, the menu
    // would offer a cheaper tier things the dearer one is refused.
    for (let i = 1; i < TIER_ORDER.length; i += 1) {
      const lower = TIER_ORDER[i - 1] as TierId
      const higher = TIER_ORDER[i] as TierId
      expect(monthlyProcurementBudgetCents(higher)).toBeGreaterThan(
        monthlyProcurementBudgetCents(lower),
      )
    }
  })

  it('caps a single line at half a month', () => {
    // Half is a commercial decision, stated once in AFFORDABILITY. That it is
    // half is what this asserts; the per-tier figures follow from the gates.
    expect(AFFORDABILITY.maxSingleLineShareBps).toBe(5_000)
    for (const tier of TIER_ORDER) {
      expect(maxSingleLineCents(tier)).toBe(monthlyProcurementBudgetCents(tier) / 2n)
    }
    // Worked: a $6,000 T1 month admits a $3,000 line and no more.
    expect(usdFromCents(maxSingleLineCents('T1'))).toBe(monthlyUsdAtGate('T1') / 2)
  })
})

describe('T0 can fund nothing', () => {
  it('refuses every SKU at T0, media and services alike', () => {
    expect(TIERS.T0.paidMedia).toBe(false)
    expect(evaluateTier(passThroughEntry({ unitCostUsd: 1 }), 'T0')).toMatchObject({
      available: false,
      reason: 'tier_has_no_budget',
    })
    expect(evaluateTier(serviceEntry({ unitCostUsd: 1 }), 'T0')).toMatchObject({
      available: false,
      reason: 'tier_has_no_budget',
    })
  })
})

describe('DEXTools trending at T1', () => {
  /**
   * THE ASSERTION THE WHOLE FILE EXISTS FOR. A T1 coin sitting exactly on its
   * gate accrues one month of procurement budget - $6,000 at today's gate and
   * dial. DEXTools trending is quoted in the low thousands PER DAY, and a
   * viable buy is a run of days. Offering it at T1 would sell a campaign that
   * was arithmetically impossible before anyone wrote the copy.
   */
  const TRENDING_DAY_USD = 3000
  const TRENDING_PACK_DAYS = 3
  const trending = passThroughEntry({
    id: 'dextools_trending_24h',
    vendorId: 'dextools',
    category: 'trending',
    unitCostUsd: TRENDING_DAY_USD,
    minViableQuantity: TRENDING_PACK_DAYS,
    maxQuantity: 14,
    tiers: ['T3'],
  })

  it('is unavailable at T1 by arithmetic, not by editorial choice', () => {
    const verdict = evaluateTier(trending, 'T1')
    expect(verdict.available).toBe(false)
    expect(verdict.reason).toBe('exceeds_single_line_ceiling')
    // Three days at $3,000 - the smallest buy that is a campaign rather than a
    // blip - against a T1 month halved by the single-line rule.
    expect(usdFromCents(verdict.minViableSpendCents)).toBe(TRENDING_DAY_USD * TRENDING_PACK_DAYS)
    expect(usdFromCents(verdict.maxSingleLineCents)).toBe(monthlyUsdAtGate('T1') / 2)
    // And the gap is not marginal: one viable trending buy costs more than a
    // T1 coin's ENTIRE month of procurement budget.
    expect(usdFromCents(verdict.minViableSpendCents)).toBeGreaterThan(monthlyUsdAtGate('T1'))
  })

  it('is kept off T1 by the pack floor, not by the price of a single day', () => {
    // WHAT MOVED. At the old $250/day gate a T1 month was $1,500 and a single
    // $3,000 day was twice the whole month, so the unit price alone settled it.
    // At $1,000/day the month is $6,000 and one day now sits inside the
    // half-month ceiling. What keeps trending off the T1 menu is therefore the
    // pack floor: minViableSpendCents, not unit price, is what availability is
    // judged on, and one day of trending in a seven-day window is not a
    // campaign.
    const t1Ceiling = maxSingleLineCents('T1')
    const oneDay = { ...trending, minViableQuantity: 1 }
    expect(minViableSpendCents(oneDay)).toBeLessThanOrEqual(t1Ceiling)

    expect(minViableSpendCents(trending)).toBeGreaterThan(t1Ceiling)
    expect(evaluateTier(trending, 'T1')).toMatchObject({
      available: false,
      reason: 'exceeds_single_line_ceiling',
    })
  })

  it('stays out of reach at T1 even if the dev maxes the dial', () => {
    // The menu is modelled at the default dial, but a dev who moves it to the
    // maximum still cannot fund a viable trending buy at T1:
    //   $1,000/day x 40% x 30 days = $12,000/month, half of which is $6,000,
    // and three days of trending is $9,000.
    const monthlyAtMaxDial =
      (monthlyProcurementBudgetCents('T1') * BigInt(TERMS.budgetBpsMax)) /
      BigInt(TERMS.budgetBpsDefault)
    const ceilingAtMaxDial = applyBps(monthlyAtMaxDial, AFFORDABILITY.maxSingleLineShareBps)
    expect(minViableSpendCents(trending)).toBeGreaterThan(ceilingAtMaxDial)
  })

  it('is only offered where the budget actually reaches', () => {
    expect(affordableTiers(trending)).toEqual(['T3'])
    expect(() => assertTierAvailability(trending)).not.toThrow()
  })

  it('refuses to load if someone puts it back on the T1 menu', () => {
    const oversold = {
      ...trending,
      sku: { ...trending.sku, availableAtTiers: ['T1', 'T2', 'T3'] satisfies TierId[] },
    }
    expect(() => assertTierAvailability(oversold)).toThrow(TierAvailabilityViolation)
    expect(() => assertTierAvailability(oversold)).toThrow(/exceeds_single_line_ceiling/)
    expect(() => assertTierAvailability(oversold)).toThrow(/9000\.00 USD/)
  })
})

describe('what T1 can afford', () => {
  it('affords the Dexscreener listing, which is why the floor is where it is', () => {
    const eti = passThroughEntry({ id: 'dexscreener_eti', unitCostUsd: 299 })
    expect(evaluateTier(eti, 'T1').available).toBe(true)
    expect(minViableSpendCents(eti)).toBe(29_900n)
  })

  it('does not afford the 500-boost pack at T1 but does at T2', () => {
    const boost500 = passThroughEntry({
      id: 'dexscreener_boost_500',
      category: 'boost',
      unitCostUsd: 3999,
      maxQuantity: 2,
      tiers: ['T2', 'T3'],
    })
    expect(evaluateTier(boost500, 'T1').available).toBe(false)
    expect(evaluateTier(boost500, 'T1').reason).toBe('exceeds_single_line_ceiling')
    expect(evaluateTier(boost500, 'T2').available).toBe(true)
    expect(affordableTiers(boost500)).toEqual(['T2', 'T3'])
  })

  it('now affords the 100-boost pack at T1, which the old gate did not', () => {
    // A LEGITIMATE CHANGE OF ANSWER, not a stale expectation. $899 sat above
    // the $750 half-month ceiling at the old $250/day gate and sits inside the
    // $3,000 one at $1,000/day. The shipped catalog still lists this pack at T2
    // and above, which the one-directional check permits: declaring FEWER tiers
    // than are affordable is an editorial choice, declaring more is the lie.
    const boost100 = passThroughEntry({
      id: 'dexscreener_boost_100',
      category: 'boost',
      unitCostUsd: 899,
      tiers: ['T2', 'T3'],
    })
    expect(minViableSpendCents(boost100)).toBeLessThanOrEqual(maxSingleLineCents('T1'))
    expect(evaluateTier(boost100, 'T1').available).toBe(true)
    expect(affordableTiers(boost100)).toEqual(['T1', 'T2', 'T3'])
    expect(() => assertTierAvailability(boost100)).not.toThrow()
  })

  it('judges a service on its minimum viable run, not its unit price', () => {
    // $45/hour looks affordable anywhere; a shift is eight of them, and the
    // shift is what actually gets bought.
    const shiftHours = 8
    const moderation = serviceEntry({
      unitCostUsd: 45,
      minViableQuantity: shiftHours,
      maxQuantity: 20,
    })
    expect(minViableSpendCents(moderation)).toBe(BigInt(45 * shiftHours * 100))
    expect(evaluateTier(moderation, 'T1').available).toBe(true)

    // The same shift at a rate whose single HOUR still fits under the T1
    // ceiling but whose eight-hour shift does not. Derived from the ceiling so
    // the case keeps making its point wherever the gate is set.
    const ceilingUsd = usdFromCents(maxSingleLineCents('T1'))
    const dearHourlyUsd = Math.ceil(ceilingUsd / shiftHours) + 1
    const expensive = serviceEntry({
      unitCostUsd: dearHourlyUsd,
      minViableQuantity: shiftHours,
      maxQuantity: 20,
    })
    expect(evaluateTier({ ...expensive, minViableQuantity: 1 }, 'T1').available).toBe(true)
    expect(evaluateTier(expensive, 'T1').available).toBe(false)
  })
})

describe('declared availability is checked, not trusted', () => {
  it('permits declaring FEWER tiers than are affordable', () => {
    const cheap = passThroughEntry({ unitCostUsd: 10, tiers: ['T3'] })
    expect(affordableTiers(cheap)).toEqual(['T1', 'T2', 'T3'])
    expect(() => assertTierAvailability(cheap)).not.toThrow()
  })

  it('refuses a pass-through SKU offered at a tier that forbids paid media', () => {
    const atT0 = passThroughEntry({ unitCostUsd: 1, tiers: ['T0'] })
    expect(() => assertTierAvailability(atT0)).toThrow(/tier_has_no_budget/)
  })

  it('refuses a SKU that lists no tier at all', () => {
    const nowhere = passThroughEntry({ unitCostUsd: 1, tiers: [] })
    expect(() => assertTierAvailability(nowhere)).toThrow(/no_tiers_declared/)
  })

  it('refuses a SKU whose viable quantity exceeds its own maximum', () => {
    const impossible = passThroughEntry({
      unitCostUsd: 10,
      minViableQuantity: 5,
      maxQuantity: 2,
    })
    expect(() => minViableSpendCents(impossible)).toThrow(/min_viable_over_max/)
  })
})

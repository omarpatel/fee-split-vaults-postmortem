import { describe, expect, it } from 'vitest'

import {
  breakEvenMultipleFor,
  buildFeeFlowRows,
  creatorRateBps,
  devShareBps,
  FeeSplitError,
  splitCredit,
  type SplitConfig,
} from '../fees.js'
import { creatorNetBps, devBps, TERMS } from '../../protocol.js'

const STANDARD: SplitConfig = { operatorBps: 1_000, budgetBps: 2_000, referrerBps: 0 }
const REFERRED: SplitConfig = { operatorBps: 1_000, budgetBps: 2_500, referrerBps: 1_500 }

/** The contract's own arithmetic, written out independently for comparison. */
function referenceSplit(amount: bigint, cfg: SplitConfig) {
  const opGross = (amount * BigInt(cfg.operatorBps)) / 10_000n
  const budget = (amount * BigInt(cfg.budgetBps)) / 10_000n
  const dev = amount - opGross - budget
  const referrer = (opGross * BigInt(cfg.referrerBps)) / 10_000n
  return { dev, budget, operator: opGross - referrer, referrer }
}

describe('split arithmetic', () => {
  it('matches CoinVault._splitOf across a wide range of amounts', () => {
    let amount = 1n
    for (let i = 0; i < 200; i++) {
      for (const cfg of [STANDARD, REFERRED]) {
        expect(splitCredit(amount, cfg)).toEqual(referenceSplit(amount, cfg))
      }
      amount = amount * 3n + 7n
    }
  })

  it('partitions the amount exactly, with no dust escaping', () => {
    let amount = 1n
    for (let i = 0; i < 300; i++) {
      const split = splitCredit(amount, REFERRED)
      expect(split.dev + split.budget + split.operator + split.referrer).toBe(amount)
      amount = amount * 5n + 3n
    }
  })

  it('rounds only in the dev’s favour', () => {
    for (let amount = 1n; amount < 400n; amount++) {
      const split = splitCredit(amount, REFERRED)
      const flooredDev = (amount * BigInt(devShareBps(REFERRED))) / 10_000n
      expect(split.dev >= flooredDev).toBe(true)
    }
  })

  it('takes the referrer out of the operator’s own slice, never out of the dev', () => {
    const amount = 1_000_000n
    const withReferrer = splitCredit(amount, REFERRED)
    const withoutReferrer = splitCredit(amount, { ...REFERRED, referrerBps: 0 })

    expect(withReferrer.dev).toBe(withoutReferrer.dev)
    expect(withReferrer.budget).toBe(withoutReferrer.budget)
    expect(withReferrer.operator + withReferrer.referrer).toBe(withoutReferrer.operator)
  })

  it('passes everything to the dev when the vault is not charging', () => {
    const split = splitCredit(500_000n, REFERRED, false)
    expect(split).toEqual({ dev: 500_000n, budget: 0n, operator: 0n, referrer: 0n })
  })

  it('splits zero into zeros rather than throwing', () => {
    expect(splitCredit(0n, STANDARD)).toEqual({ dev: 0n, budget: 0n, operator: 0n, referrer: 0n })
  })

  it('fails closed on nonsense', () => {
    expect(() => splitCredit(-1n, STANDARD)).toThrow(FeeSplitError)
    expect(() => splitCredit(1n, { ...STANDARD, budgetBps: 1.5 })).toThrow(FeeSplitError)
    expect(() => splitCredit(1n, { ...STANDARD, operatorBps: -1 })).toThrow(FeeSplitError)
    expect(() => splitCredit(1n, { operatorBps: 5_000, budgetBps: 5_000, referrerBps: 0 })).toThrow(
      FeeSplitError,
    )
  })
})

describe('dev share and the break-even multiple', () => {
  it('agrees with config/protocol.ts at the standard operator rate', () => {
    for (const budgetBps of [0, 1_000, 2_000, 4_000]) {
      const cfg = { operatorBps: TERMS.operatorBps, budgetBps }
      expect(devShareBps(cfg)).toBe(devBps(budgetBps))
    }
  })

  it('uses the vault’s own frozen operator rate when it differs from config', () => {
    // The rate has to DIFFER from the published one or this test compares the
    // published rate with itself and proves nothing. Derived, because the last
    // time it was written down as a literal the reprice made it equal to
    // TERMS.operatorBps and the test silently stopped testing anything.
    const frozen = TERMS.operatorBps * 2
    expect(frozen).not.toBe(TERMS.operatorBps)
    expect(devShareBps({ operatorBps: frozen, budgetBps: 2_000 })).toBe(10_000 - frozen - 2_000)
    expect(devShareBps({ operatorBps: frozen, budgetBps: 2_000 })).not.toBe(devBps(2_000))
  })

  it('quotes the hurdle at the published defaults from config, not from memory', () => {
    const multiple = breakEvenMultipleFor({
      operatorBps: TERMS.operatorBps,
      budgetBps: TERMS.budgetBpsDefault,
    })
    expect(multiple).toBeCloseTo(10_000 / devBps(TERMS.budgetBpsDefault), 10)
  })

  it('is 1.43x on a legacy vault frozen at a 10% fee and a 20% dial', () => {
    // Not the published rate. A vault signed before the reprice keeps 1,000 bps
    // for life — it is in the salt — so this arithmetic still has to be right
    // for real clients, and it is pinned here as the worked example it is.
    const multiple = breakEvenMultipleFor({ operatorBps: 1_000, budgetBps: 2_000 })
    expect(multiple).toBeCloseTo(10_000 / 7_000, 10)
    expect(multiple).toBeCloseTo(1.4286, 4)
  })

  it('rises as the dial rises', () => {
    const low = breakEvenMultipleFor({ operatorBps: 1_000, budgetBps: 0 })
    const mid = breakEvenMultipleFor({ operatorBps: 1_000, budgetBps: 2_000 })
    const high = breakEvenMultipleFor({ operatorBps: 1_000, budgetBps: 4_000 })
    expect(low).toBeCloseTo(1 / 0.9, 10)
    expect(mid).toBeGreaterThan(low)
    expect(high).toBeGreaterThan(mid)
  })

  it('refuses to quote a multiple when the dev share is zero', () => {
    expect(() => breakEvenMultipleFor({ operatorBps: 5_000, budgetBps: 5_000 })).toThrow(FeeSplitError)
  })
})

describe('the creator rate branches on the buyback setting', () => {
  it('is 0.70% of volume with buyback off', () => {
    expect(creatorRateBps(false, 0)).toBe(70)
  })

  it('is 0.35% of volume with buyback on', () => {
    expect(creatorRateBps(true, 0)).toBe(35)
  })

  it('never returns a single hardcoded rate; it delegates to config', () => {
    for (const buyback of [true, false]) {
      for (const tax of [0, 150, 1_000]) {
        expect(creatorRateBps(buyback, tax)).toBe(creatorNetBps(buyback, tax))
      }
    }
  })

  it('adds the creator tax, which is paid 100% to the creator', () => {
    expect(creatorRateBps(false, 150)).toBeCloseTo(70 + 1.5, 10)
  })
})

describe('the fee flow presentation model', () => {
  const gross = 22_050_000n

  it('shows the gross and each leg as its own row', () => {
    const rows = buildFeeFlowRows(gross, STANDARD)
    expect(rows.map((row) => row.key)).toEqual(['qf', 'dev', 'budget', 'operator'])
    expect(rows.filter((row) => row.isSource)).toHaveLength(1)
  })

  it('adds a referrer row only when there is a referrer', () => {
    expect(buildFeeFlowRows(gross, REFERRED).map((row) => row.key)).toContain('referrer')
    expect(buildFeeFlowRows(gross, STANDARD).map((row) => row.key)).not.toContain('referrer')
  })

  // The product rule: the legs are never summed into a single "you keep this"
  // figure. There is no such row and no function that produces one.
  it('never produces a combined retained figure', () => {
    const rows = buildFeeFlowRows(gross, REFERRED)
    const legs = rows.filter((row) => !row.isSource)
    const sum = legs.reduce((total, row) => total + row.amount, 0n)

    expect(sum).toBe(gross)
    for (const row of legs) {
      expect(row.label.toLowerCase()).not.toContain('retained')
      expect(row.label.toLowerCase()).not.toContain('net to you')
      expect(row.label.toLowerCase()).not.toContain('total')
      // No leg row is a rollup: none of them equals the whole gross, and none
      // equals the dev leg plus the budget - the specific misleading sum.
      expect(row.amount).not.toBe(gross)
    }

    const dev = rows.find((row) => row.key === 'dev')?.amount ?? 0n
    const budget = rows.find((row) => row.key === 'budget')?.amount ?? 0n
    expect(legs.some((row) => row.amount === dev + budget)).toBe(false)
  })

  it('reports each leg’s own bps, and the operator row excludes the referrer’s cut', () => {
    const rows = buildFeeFlowRows(gross, REFERRED)
    const operator = rows.find((row) => row.key === 'operator')
    const referrer = rows.find((row) => row.key === 'referrer')
    expect(operator?.bps).toBe(1_000 - 150)
    expect(referrer?.bps).toBe(150)
  })

  it('shows every leg at zero and the whole gross to the dev when not charging', () => {
    const rows = buildFeeFlowRows(gross, REFERRED, false)
    expect(rows.find((row) => row.key === 'dev')?.amount).toBe(gross)
    expect(rows.find((row) => row.key === 'budget')?.amount).toBe(0n)
    expect(rows.find((row) => row.key === 'operator')?.amount).toBe(0n)
  })
})

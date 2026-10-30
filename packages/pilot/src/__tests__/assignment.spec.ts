import { describe, expect, it } from 'vitest'

import {
  assertEthicalCoverage,
  assignCoin,
  generateAssignment,
  makePilotConfig,
  PilotConfigError,
  validatePilotConfig,
} from '../assignment.js'
import { syntheticCoins } from '../testing/synthetic.js'
import type { PilotConfig } from '../types.js'

const START = Date.UTC(2026, 9, 1) / 1_000 // 2026-10-01T00:00:00Z, a Thursday.

function config(overrides: Parameters<typeof makePilotConfig>[3] = {}): PilotConfig {
  return makePilotConfig('pilot-2026-q4', 'published-seed-a3f9', START, overrides)
}

describe('pilot configuration', () => {
  it('is free by construction and refuses a take rate', () => {
    const bad = { ...config(), takeBps: 250 } as unknown as PilotConfig
    expect(() => validatePilotConfig(bad)).toThrow(PilotConfigError)
    expect(() => validatePilotConfig(bad)).toThrow(/free/)
  })

  it('refuses a randomized phase that eats into the second half', () => {
    expect(() => config({ randomizedDays: 40 })).toThrow(/full coverage for the second half/)
  })

  it('refuses an odd randomized-day count that cannot split hour-of-day exactly', () => {
    expect(() => config({ randomizedDays: 29 })).toThrow(/even/)
  })

  it('refuses a start that is not UTC midnight', () => {
    expect(() => makePilotConfig('p', 's', START + 3_600, {})).toThrow(/midnight/)
  })

  it('refuses an unsatisfiable absence cap instead of looping forever', () => {
    expect(() => config({ maxConsecutiveUnstaffedBlocks: 1 })).toThrow(/unsatisfiable/)
  })

  it('refuses a block length the balancing has not been derived for', () => {
    expect(() => config({ blockHours: 6 })).toThrow(/12-hour blocks/)
  })
})

describe('assignment balance', () => {
  const coins = syntheticCoins(48, START - 86_400)
  const assignment = generateAssignment(config(), coins, START - 3_600)

  it('splits every coin exactly in half across the randomized phase', () => {
    for (const coin of assignment.coins) {
      expect(coin.balance.randomizedBlocks).toBe(60)
      expect(coin.balance.staffedRandomized).toBe(30)
      expect(coin.balance.unstaffedRandomized).toBe(30)
    }
  })

  it('balances hour-of-day EXACTLY, not just on average', () => {
    for (const coin of assignment.coins) {
      expect(coin.balance.byHourOfDay).toHaveLength(2)
      for (const hour of coin.balance.byHourOfDay) {
        expect(hour.staffed).toBe(15)
        expect(hour.unstaffed).toBe(15)
      }
      expect(coin.balance.byHourOfDay.map((h) => h.hourOfDay)).toEqual([0, 12])
    }
  })

  it('balances every day-of-week by hour-of-day cell to within one', () => {
    for (const coin of assignment.coins) {
      for (const cell of coin.balance.byHourAndDay) {
        expect(Math.abs(cell.staffed - cell.unstaffed)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('does not use the same schedule for every coin', () => {
    const schedules = new Set(
      assignment.coins.map((c) => c.blocks.map((b) => b.arm).join('')),
    )
    expect(schedules.size).toBeGreaterThan(assignment.coins.length / 2)
  })

  it('accepts the constructed draw without redrawing', () => {
    for (const coin of assignment.coins) expect(coin.drawNonce).toBe(0)
  })
})

describe('ethics enforced in code', () => {
  const coins = syntheticCoins(12, START - 86_400)
  const assignment = generateAssignment(config(), coins, START - 3_600)

  it('gives every coin full coverage for the entire second half', () => {
    for (const coin of assignment.coins) {
      const secondHalf = coin.blocks.filter((b) => b.blockIndex >= 60)
      expect(secondHalf).toHaveLength(60)
      expect(secondHalf.every((b) => b.arm === 'STAFFED')).toBe(true)
      expect(secondHalf.every((b) => b.phase === 'FULL_COVERAGE')).toBe(true)
      expect(coin.balance.fullCoverageBlocks).toBe(60)
    }
  })

  it('never leaves the desk away for more than 24 consecutive hours', () => {
    for (const coin of assignment.coins) {
      expect(coin.balance.maxConsecutiveUnstaffed).toBeLessThanOrEqual(2)
      expect(coin.balance.maxConsecutiveUnstaffed).toBeGreaterThanOrEqual(1)
    }
  })

  it('rejects a tampered schedule that unstaffs a full-coverage block', () => {
    const coin = assignment.coins[0]!
    const tampered = coin.blocks.map((b) =>
      b.blockIndex === 80 ? { ...b, arm: 'UNSTAFFED' as const } : b,
    )
    expect(() => assertEthicalCoverage(config(), tampered, coin.balance)).toThrow(
      /must be STAFFED/,
    )
  })
})

describe('reproducibility', () => {
  const coins = syntheticCoins(20, START - 86_400)

  it('is a pure function of the published seed', () => {
    const a = generateAssignment(config(), coins, START)
    const b = generateAssignment(config(), coins, START + 12_345)
    expect(b.assignmentHash).toBe(a.assignmentHash)
    expect(b.coins.map((c) => c.blocks.map((x) => x.arm).join(''))).toEqual(
      a.coins.map((c) => c.blocks.map((x) => x.arm).join('')),
    )
  })

  it('changes completely when the seed changes', () => {
    const a = generateAssignment(config(), coins, START)
    const b = generateAssignment(
      makePilotConfig('pilot-2026-q4', 'a-different-published-seed', START),
      coins,
      START,
    )
    expect(b.assignmentHash).not.toBe(a.assignmentHash)
    const differing = a.coins.filter(
      (c, i) =>
        c.blocks.map((x) => x.arm).join('') !== b.coins[i]!.blocks.map((x) => x.arm).join(''),
    )
    expect(differing.length).toBeGreaterThan(a.coins.length / 2)
  })

  it('assigns a single coin identically whether alone or in a cohort', () => {
    const alone = assignCoin(config(), coins[7]!)
    const inCohort = generateAssignment(config(), coins, START).coins.find(
      (c) => c.coinRef === coins[7]!.coinRef,
    )!
    expect(inCohort.blocks.map((b) => b.arm)).toEqual(alone.blocks.map((b) => b.arm))
  })

  it('refuses duplicate enrolments', () => {
    expect(() => generateAssignment(config(), [coins[0]!, coins[0]!], START)).toThrow(/duplicate/)
  })
})

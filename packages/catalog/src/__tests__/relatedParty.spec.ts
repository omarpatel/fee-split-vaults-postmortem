/**
 * Related-party spend: the cap and the opt-in.
 */
import { describe, expect, it } from 'vitest'
import { RelatedPartyViolation } from '../errors.js'
import {
  assertRelatedPartySpend,
  evaluateRelatedPartySpend,
  InMemoryRelatedPartyOptIns,
  relatedPartyCapCents,
  RELATED_PARTY_CAP_BPS,
} from '../relatedParty.js'
import { SPEND_LIMITS } from '../protocol.js'
import { monthlyProcurementBudgetCents } from '../tiers.js'
import { T0_UNIX } from './fixtures.js'
import type { RelatedPartyOptIn } from '../types.js'

const VAULT = '0xVaULt0000000000000000000000000000000001'
const DISCLOSURE_HASH = 'a'.repeat(64)
/**
 * A T1 coin sitting exactly on its gate, at the default dial - computed, not
 * written down. The literal that used to stand here was $1,500, which was that
 * figure at the OLD $250/day gate; at $1,000/day it is $6,000 and the comment
 * claiming a T1 coin was described by it had become false while the test went
 * on passing, because the cap arithmetic is scale-free.
 */
const BUDGET_30D = monthlyProcurementBudgetCents('T1')
const QUARTER_OF_BUDGET = BUDGET_30D / 4n

function optIn(overrides: Partial<RelatedPartyOptIn> = {}): RelatedPartyOptIn {
  return {
    vault: VAULT,
    vendorId: 'operator',
    optedInAtUnix: T0_UNIX - 86_400,
    disclosureHash: DISCLOSURE_HASH,
    ...overrides,
  }
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    vault: VAULT,
    vendorId: 'operator',
    trailing30dBudgetCents: BUDGET_30D,
    relatedPartySpentCents: 0n,
    proposedCents: 10_000n,
    nowUnix: T0_UNIX,
    ...overrides,
  } as Parameters<typeof evaluateRelatedPartySpend>[1]
}

describe('the cap', () => {
  it('is the protocol fraction, converted once to integer basis points', () => {
    expect(RELATED_PARTY_CAP_BPS).toBe(2_500)
    expect(SPEND_LIMITS.relatedPartyCapOf30dBudget).toBe(0.25)
    expect(relatedPartyCapCents(BUDGET_30D)).toBe(QUARTER_OF_BUDGET)
  })

  it('rounds the cap DOWN, never up', () => {
    // $10.03 -> 1003 cents; a quarter is 250.75, and the cap is 250.
    expect(relatedPartyCapCents(1_003n)).toBe(250n)
  })
})

describe('the opt-in', () => {
  it('refuses a related-party purchase with no opt-in on file', async () => {
    const store = new InMemoryRelatedPartyOptIns()
    const decision = await evaluateRelatedPartySpend(store, context())
    expect(decision.permitted).toBe(false)
    expect(decision.reason).toMatch(/no live per-dev opt-in/)
  })

  it('permits a purchase inside the cap once the dev has opted in', async () => {
    const store = new InMemoryRelatedPartyOptIns([optIn()])
    const decision = await evaluateRelatedPartySpend(store, context())
    expect(decision.permitted).toBe(true)
    expect(decision.capCents).toBe(QUARTER_OF_BUDGET)
    expect(decision.remainingCents).toBe(QUARTER_OF_BUDGET - 10_000n)
  })

  it('does not let one coin inherit another coin\'s opt-in', async () => {
    const store = new InMemoryRelatedPartyOptIns([optIn()])
    const other = await evaluateRelatedPartySpend(
      store,
      context({ vault: '0xVaULt0000000000000000000000000000000002' }),
    )
    expect(other.permitted).toBe(false)
  })

  it('does not let one vendor inherit another vendor\'s opt-in', async () => {
    const store = new InMemoryRelatedPartyOptIns([optIn()])
    const other = await evaluateRelatedPartySpend(store, context({ vendorId: 'affiliate_shop' }))
    expect(other.permitted).toBe(false)
  })

  it('treats a revoked opt-in as a no, not as a lapse', async () => {
    const store = new InMemoryRelatedPartyOptIns([optIn()])
    store.revoke(VAULT, 'operator', T0_UNIX - 60)
    expect((await evaluateRelatedPartySpend(store, context())).permitted).toBe(false)
    // Still permitted for the window before the revocation took effect.
    expect(
      (await evaluateRelatedPartySpend(store, context({ nowUnix: T0_UNIX - 120 }))).permitted,
    ).toBe(true)
  })

  it('ignores an opt-in dated in the future', async () => {
    const store = new InMemoryRelatedPartyOptIns([optIn({ optedInAtUnix: T0_UNIX + 3600 })])
    expect((await evaluateRelatedPartySpend(store, context())).permitted).toBe(false)
  })

  it('refuses to record an opt-in that does not commit to the disclosure text', () => {
    const store = new InMemoryRelatedPartyOptIns()
    expect(() => store.record(optIn({ disclosureHash: 'short' }))).toThrow(RelatedPartyViolation)
    expect(() => store.record(optIn({ disclosureHash: 'short' }))).toThrow(/no_disclosure_hash/)
  })
})

describe('fail closed', () => {
  it('refuses when no trailing 30-day budget is on record', async () => {
    const store = new InMemoryRelatedPartyOptIns([optIn()])
    const decision = await evaluateRelatedPartySpend(
      store,
      context({ trailing30dBudgetCents: 0n }),
    )
    expect(decision.permitted).toBe(false)
    expect(decision.reason).toMatch(/no trailing 30-day procurement budget/)
  })

  it('refuses a non-positive proposal', async () => {
    const store = new InMemoryRelatedPartyOptIns([optIn()])
    expect((await evaluateRelatedPartySpend(store, context({ proposedCents: 0n }))).permitted).toBe(
      false,
    )
  })
})

describe('the cap binds', () => {
  it('permits spend exactly up to the cap and refuses one cent more', async () => {
    const store = new InMemoryRelatedPartyOptIns([optIn()])
    const upTo = await evaluateRelatedPartySpend(store, context({ proposedCents: QUARTER_OF_BUDGET }))
    expect(upTo.permitted).toBe(true)
    expect(upTo.remainingCents).toBe(0n)

    const overBy1 = await evaluateRelatedPartySpend(
      store,
      context({ proposedCents: QUARTER_OF_BUDGET + 1n }),
    )
    expect(overBy1.permitted).toBe(false)
    // The refusal names the cap in dollars, so the message is checked against
    // the computed cap rather than against a remembered figure.
    expect(overBy1.reason).toContain(`30-day cap of $${(Number(QUARTER_OF_BUDGET) / 100).toFixed(2)}`)
  })

  it('counts what has already been spent with related parties this window', async () => {
    const store = new InMemoryRelatedPartyOptIns([optIn()])
    const decision = await evaluateRelatedPartySpend(
      store,
      // Already spent all but $75 of the cap, then proposes $100.
      context({ relatedPartySpentCents: QUARTER_OF_BUDGET - 7_500n, proposedCents: 10_000n }),
    )
    expect(decision.permitted).toBe(false)
    expect(decision.remainingCents).toBe(7_500n)
  })

  it('throws from the assert form so a caller cannot ignore the answer', async () => {
    const store = new InMemoryRelatedPartyOptIns()
    await expect(assertRelatedPartySpend(store, context())).rejects.toThrow(RelatedPartyViolation)
  })
})

describe('the operator is the related party that matters', () => {
  it('caps a T1 coin at a quarter of its own procurement budget', async () => {
    // A T1 coin accruing exactly its gate can route no more than a quarter of
    // its 30-day budget back to the operator - which is the point: the operator
    // cannot take a client's whole budget and call the result a campaign. An
    // eight-hour moderation shift at $45/hour has to fit inside that quarter,
    // and the assertion below is what says so at whatever the gate is.
    const eightHourShiftCents = 36_000n
    expect(eightHourShiftCents).toBeLessThanOrEqual(QUARTER_OF_BUDGET)

    const store = new InMemoryRelatedPartyOptIns([optIn()])
    const decision = await evaluateRelatedPartySpend(
      store,
      context({ proposedCents: eightHourShiftCents }),
    )
    expect(decision.permitted).toBe(true)
    expect(decision.remainingCents).toBe(QUARTER_OF_BUDGET - eightHourShiftCents)
  })
})

import { describe, expect, it } from 'vitest'

import { DecodeError, decodePublicCoin } from '../decode.js'
import type * as W from '../wire.js'

/**
 * The public coin record, through the decoder.
 *
 * The subject is the one part of the record a dev wrote, and the narrative
 * flag is the one that says whether a human has looked at what we say about
 * the coin. Neither may be defaulted: a page that rendered a missing subject
 * as a coin with no name, or a missing flag as "pending", would be inventing
 * a record the server never sent.
 */

const NOW = 1_780_000_000

const PERIOD: W.FeeFlowPeriodWire = {
  periodStartUnix: NOW - 7 * 86_400,
  periodEndUnix: NOW,
  perAsset: [],
  qfGrossCents: '100000',
  devLegCents: '60000',
  budgetCents: '25000',
  operatorFeeCents: '15000',
  referrerCents: '0',
}

function coinWire(overrides: Partial<W.PublicCoinWire> = {}): W.PublicCoinWire {
  return {
    identity: {
      vault: '0x1111111111111111111111111111111111111111',
      token: '0x2222222222222222222222222222222222222222',
      name: 'Hydrant',
      symbol: 'HYDR',
      graduated: true,
      launchedAtUnix: NOW - 40 * 86_400,
      buybackEnabled: false,
      creatorTaxBps: 0,
    },
    state: 'ACTIVE',
    tier: 'T2',
    operatorBps: 1_500,
    budgetBps: 2_000,
    budgetBpsMax: 4_000,
    referrerBps: 0,
    qfPerDayUsd: 400,
    observedDays: 30,
    sustainedDays: 30,
    screening: { verdict: 'CLEAR', paidMediaPermitted: true, flags: [] },
    period: PERIOD,
    lifetime: PERIOD,
    budgetBalanceCents: '12000',
    unprovenEscrowCents: '0',
    balancesObservedAtUnix: NOW - 600,
    operatedAccounts: [],
    paidPromotionInUse: false,
    lastReconciledAtUnix: NOW - 900,
    reconciliationVariance: 'none',
    subject: { name: 'Hydrant', symbol: 'HYDR', linkCount: 2, narrativeSourceCount: 1 },
    narrativeApproved: true,
    ...overrides,
  }
}

/** A body shaped however the test says, past the wire type. */
function loose(overrides: Record<string, unknown>): W.PublicCoinWire {
  return { ...coinWire(), ...overrides } as W.PublicCoinWire
}

describe('decoding the public coin record', () => {
  it('carries the subject and the narrative flag across', () => {
    const coin = decodePublicCoin(coinWire())
    expect(coin.subject).toEqual({ name: 'Hydrant', symbol: 'HYDR', linkCount: 2, narrativeSourceCount: 1 })
    expect(coin.narrativeApproved).toBe(true)
  })

  it('refuses a subject that is not the documented object', () => {
    expect(() => decodePublicCoin(loose({ subject: undefined }))).toThrow(DecodeError)
    expect(() => decodePublicCoin(loose({ subject: 'Hydrant (HYDR)' }))).toThrow(DecodeError)
    expect(() => decodePublicCoin(loose({ subject: ['Hydrant', 'HYDR'] }))).toThrow(DecodeError)
    expect(() =>
      decodePublicCoin(loose({ subject: { name: 'Hydrant', symbol: 'HYDR', linkCount: 2 } })),
    ).toThrow(DecodeError)
    expect(() =>
      decodePublicCoin(
        loose({ subject: { name: 'Hydrant', symbol: 'HYDR', linkCount: '2', narrativeSourceCount: 1 } }),
      ),
    ).toThrow(DecodeError)
    expect(() =>
      decodePublicCoin(
        loose({ subject: { name: 'Hydrant', symbol: 'HYDR', linkCount: -1, narrativeSourceCount: 1 } }),
      ),
    ).toThrow(DecodeError)
  })

  it('refuses a narrative flag that is not a boolean rather than reading it as pending', () => {
    expect(() => decodePublicCoin(loose({ narrativeApproved: undefined }))).toThrow(DecodeError)
    expect(() => decodePublicCoin(loose({ narrativeApproved: 'true' }))).toThrow(DecodeError)
    expect(() => decodePublicCoin(loose({ narrativeApproved: 1 }))).toThrow(DecodeError)
  })
})

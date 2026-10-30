/**
 * The deliberate double-count attempt.
 *
 * One fee, four observations. Every ordering must recognise the fee exactly
 * once. Both stores run the whole suite, because a store that persists entries
 * but drops the recognition record would pass every in-memory assertion and
 * re-recognise the fee on the next replay.
 */

import { describe, expect, it } from 'vitest'
import { decideRecognition, INCOME_SOURCE_PRECEDENCE, precedenceRank } from '../precedence.js'
import { PrecedenceError } from '../errors.js'
import { dailyAccrualKey, sweepAccrualKey } from '../ids.js'
import { Ledger, type FeeObservation } from '../ledger.js'
import { InMemoryLedgerStore } from '../store/memory.js'
import { InMemorySqlDriver } from '../store/fakeDriver.js'
import { SqlLedgerStore } from '../store/sql.js'
import type { LedgerStore } from '../store/types.js'
import { POOL, T0, USDG, VAULT } from './helpers.js'

const GROSS = 700_000n
const KEY = sweepAccrualKey(POOL, USDG, 42)

function obs(source: FeeObservation['source'], amountMinor = GROSS, logIndex = 0): FeeObservation {
  return {
    vault: VAULT,
    asset: USDG,
    amountMinor,
    source,
    accrualKey: KEY,
    occurredAtUnix: T0,
    txHash: `0xtx_${source}`,
    logIndex,
  }
}

const STORE_FACTORIES: Array<[string, () => LedgerStore]> = [
  ['memory', () => new InMemoryLedgerStore()],
  ['sql', () => new SqlLedgerStore(new InMemorySqlDriver())],
]

describe('precedence order', () => {
  it('ranks sources by attribution fidelity, not arrival', () => {
    expect(INCOME_SOURCE_PRECEDENCE).toEqual([
      'curve_event',
      'pool_fees_swept',
      'escrow_credit',
      'erc20_transfer',
    ])
    expect(precedenceRank('curve_event')).toBeLessThan(precedenceRank('pool_fees_swept'))
    expect(precedenceRank('pool_fees_swept')).toBeLessThan(precedenceRank('escrow_credit'))
    expect(precedenceRank('escrow_credit')).toBeLessThan(precedenceRank('erc20_transfer'))
  })

  it('refuses to recognise income from a manual assertion', () => {
    expect(() => precedenceRank('manual')).toThrow(PrecedenceError)
    expect(() =>
      decideRecognition({
        perSource: {},
        recognizedMinor: 0n,
        source: 'manual' as never,
        amountMinor: 1n,
      }),
    ).toThrow(PrecedenceError)
  })

  it('leaves recognition unchanged for a lower-precedence duplicate', () => {
    const decision = decideRecognition({
      perSource: { pool_fees_swept: GROSS },
      recognizedMinor: GROSS,
      recognizedSource: 'pool_fees_swept',
      source: 'escrow_credit',
      amountMinor: GROSS,
    })
    expect(decision.outcome).toBe('duplicate_ignored')
    expect(decision.deltaMinor).toBe(0n)
    expect(decision.winner).toBe('pool_fees_swept')
  })
})

for (const [name, makeStore] of STORE_FACTORIES) {
  describe(`double-count rejection (${name} store)`, () => {
    it('recognises one fee once across curve, sweep, escrow and transfer views', async () => {
      const store = makeStore()
      const ledger = new Ledger(store, { now: () => T0 })

      const first = await ledger.recordFeeObservation(obs('curve_event', GROSS, 0))
      expect(first.outcome).toBe('recognized')

      for (const [index, source] of (
        ['pool_fees_swept', 'escrow_credit', 'erc20_transfer'] as const
      ).entries()) {
        const later = await ledger.recordFeeObservation(obs(source, GROSS, index + 1))
        expect(later.outcome).toBe('duplicate_ignored')
        expect(later.entryIds).toHaveLength(0)
      }

      const summary = await ledger.incomeSummary({ vault: VAULT, asset: USDG })
      expect(summary).toHaveLength(1)
      expect(summary[0]?.recognizedMinor).toBe(GROSS)
      expect(await ledger.balanceOf(VAULT, USDG, 'asset:escrow')).toBe(GROSS)

      // Exactly one recognition row, and every ignored view still audited.
      const recognitions = await store.listRecognitions()
      expect(recognitions).toHaveLength(1)
      expect(recognitions[0]?.recognizedSource).toBe('curve_event')
      expect(recognitions[0]?.perSource).toEqual({
        curve_event: GROSS,
        pool_fees_swept: GROSS,
        escrow_credit: GROSS,
        erc20_transfer: GROSS,
      })
    })

    it('recognises once whichever order the four views arrive in', async () => {
      const orders: Array<Array<FeeObservation['source']>> = [
        ['erc20_transfer', 'escrow_credit', 'pool_fees_swept', 'curve_event'],
        ['escrow_credit', 'curve_event', 'erc20_transfer', 'pool_fees_swept'],
        ['pool_fees_swept', 'erc20_transfer', 'curve_event', 'escrow_credit'],
      ]
      for (const order of orders) {
        const ledger = new Ledger(makeStore(), { now: () => T0 })
        for (const [index, source] of order.entries()) {
          await ledger.recordFeeObservation(obs(source, GROSS, index))
        }
        const summary = await ledger.incomeSummary({ vault: VAULT, asset: USDG })
        expect(summary[0]?.recognizedMinor).toBe(GROSS)
        expect(await ledger.balanceOf(VAULT, USDG, 'asset:escrow')).toBe(GROSS)
      }
    })

    it('corrects downward when a higher-precedence source disagrees', async () => {
      const ledger = new Ledger(makeStore(), { now: () => T0 })

      const low = await ledger.recordFeeObservation(obs('escrow_credit', 1_000_000n, 0))
      expect(low.outcome).toBe('recognized')

      // The escrow credit was the shared depositor's, not this coin's. The
      // hook's own sweep is the only per-coin attribution and says 40%.
      const high = await ledger.recordFeeObservation(obs('pool_fees_swept', 400_000n, 1))
      expect(high.outcome).toBe('superseded')
      expect(high.recognizedSource).toBe('pool_fees_swept')
      expect(high.recognizedMinor).toBe(400_000n)

      const summary = await ledger.incomeSummary({ vault: VAULT, asset: USDG })
      expect(summary[0]?.recognizedMinor).toBe(400_000n)
      expect(await ledger.balanceOf(VAULT, USDG, 'asset:escrow')).toBe(400_000n)

      const later = await ledger.recordFeeObservation(obs('escrow_credit', 5_000n, 2))
      expect(later.outcome).toBe('duplicate_ignored')
      expect(later.recognizedMinor).toBe(400_000n)
    })

    it('accumulates several observations from the same winning source', async () => {
      const ledger = new Ledger(makeStore(), { now: () => T0 })
      const key = dailyAccrualKey(VAULT, USDG, T0)

      for (let i = 0; i < 3; i += 1) {
        const result = await ledger.recordFeeObservation({
          vault: VAULT,
          asset: USDG,
          amountMinor: 100n,
          source: 'pool_fees_swept',
          accrualKey: key,
          occurredAtUnix: T0 + i,
          txHash: '0xsweeps',
          logIndex: i,
        })
        expect(result.outcome).toBe('recognized')
      }

      const summary = await ledger.incomeSummary({ vault: VAULT, asset: USDG })
      expect(summary[0]?.recognizedMinor).toBe(300n)
    })

    it('refuses a downward correction escrow cannot absorb and freezes the scope', async () => {
      const ledger = new Ledger(makeStore(), { now: () => T0 })

      await ledger.recordFeeObservation(obs('escrow_credit', 1_000_000n, 0))
      await ledger.recordClaim({
        vault: VAULT,
        asset: USDG,
        amountMinor: 1_000_000n,
        occurredAtUnix: T0 + 10,
        batchKey: 'claim:1',
      })
      expect(await ledger.balanceOf(VAULT, USDG, 'asset:escrow')).toBe(0n)

      const corrected = await ledger.recordFeeObservation(obs('pool_fees_swept', 400_000n, 1))
      expect(corrected.outcome).toBe('refused_unbalanced')
      expect(corrected.refusal?.variance.severity).toBe('critical')

      // Recognition did not move and the book is still internally consistent.
      expect(await ledger.balanceOf(VAULT, USDG, 'asset:escrow')).toBe(0n)
      expect((await ledger.verifyBalances()).ok).toBe(true)

      await expect(
        ledger.assertSpendAuthorizationAllowed({ vault: VAULT, asset: USDG }),
      ).rejects.toThrow(/frozen/)
    })
  })
}

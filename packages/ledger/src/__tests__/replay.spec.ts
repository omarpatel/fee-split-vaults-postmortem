/**
 * Replay idempotence.
 *
 * An indexer restarts, re-reads a reorg-safe window, and re-feeds every log it
 * has already seen. The ledger must end in a byte-identical state. This is the
 * property that lets an operator re-run a backfill without auditing what it will
 * touch first.
 */

import { describe, expect, it } from 'vitest'
import { entryId, observationId, sweepAccrualKey } from '../ids.js'
import { Ledger, type FeeObservation, type MovementRequest } from '../ledger.js'
import { InMemoryLedgerStore } from '../store/memory.js'
import { InMemorySqlDriver } from '../store/fakeDriver.js'
import { SqlLedgerStore } from '../store/sql.js'
import type { LedgerStore } from '../store/types.js'
import { iterateEntries } from '../store/types.js'
import { EntryIdCollisionError } from '../errors.js'
import { POOL, T0, USDG, VAULT } from './helpers.js'

const KEY = sweepAccrualKey(POOL, USDG, 7)

const FEES: FeeObservation[] = [
  {
    vault: VAULT,
    asset: USDG,
    amountMinor: 1_400_000n,
    source: 'pool_fees_swept',
    accrualKey: KEY,
    occurredAtUnix: T0,
    blockHash: '0xblock01',
    txHash: '0xsweep01',
    logIndex: 4,
  },
  {
    vault: VAULT,
    asset: USDG,
    amountMinor: 600_000n,
    source: 'pool_fees_swept',
    accrualKey: KEY,
    occurredAtUnix: T0 + 60,
    blockHash: '0xblock02',
    txHash: '0xsweep02',
    logIndex: 1,
  },
  {
    vault: VAULT,
    asset: USDG,
    amountMinor: 2_000_000n,
    source: 'escrow_credit',
    accrualKey: KEY,
    occurredAtUnix: T0 + 90,
    blockHash: '0xblock03',
    txHash: '0xcredit01',
    logIndex: 0,
  },
]

const CLAIM: MovementRequest = {
  vault: VAULT,
  asset: USDG,
  amountMinor: 2_000_000n,
  occurredAtUnix: T0 + 120,
  batchKey: 'chain:claim:0xclaim01:2',
  blockHash: '0xblock04',
  txHash: '0xclaim01',
  logIndex: 2,
}

async function feed(ledger: Ledger): Promise<void> {
  for (const fee of FEES) await ledger.recordFeeObservation(fee)
  await ledger.recordClaim(CLAIM)
  await ledger.recordAllocation({
    vault: VAULT,
    asset: USDG,
    occurredAtUnix: T0 + 121,
    batchKey: 'chain:settle:0xsettle01:0',
    txHash: '0xsettle01',
    logIndex: 0,
    amounts: { devMinor: 1_400_000n, budgetMinor: 400_000n, operatorMinor: 160_000n, referrerMinor: 40_000n },
  })
}

async function snapshot(store: LedgerStore): Promise<string> {
  const entries: string[] = []
  for await (const entry of iterateEntries(store)) {
    entries.push(
      [entry.id, entry.debit, entry.credit, entry.amountMinor.toString(), entry.source].join('|'),
    )
  }
  const balances = (await store.listAccountBalances()).map(
    (b) => `${b.account}=${b.balanceMinor.toString()}/${b.entryCount}`,
  )
  const recognitions = (await store.listRecognitions()).map(
    (r) => `${r.accrualKey}:${r.recognizedSource}:${r.recognizedMinor.toString()}`,
  )
  return JSON.stringify({ entries: entries.sort(), balances, recognitions })
}

const STORE_FACTORIES: Array<[string, () => LedgerStore]> = [
  ['memory', () => new InMemoryLedgerStore()],
  ['sql', () => new SqlLedgerStore(new InMemorySqlDriver())],
]

describe('deterministic ids', () => {
  it('derives an entry id purely from the observation', () => {
    const input = {
      batchKey: 'b',
      index: 0,
      vault: VAULT,
      asset: USDG,
      debit: 'asset:escrow',
      credit: 'income:fees',
      amountMinor: 5n,
      occurredAtUnix: T0,
      source: 'pool_fees_swept',
    } as const
    expect(entryId(input)).toBe(entryId({ ...input }))
    expect(entryId(input)).not.toBe(entryId({ ...input, amountMinor: 6n }))
    expect(entryId(input)).not.toBe(entryId({ ...input, index: 1 }))
  })

  it('separates fields so no two field vectors share an encoding', () => {
    const a = observationId({
      vault: 'ab',
      asset: 'c',
      source: 'escrow_credit',
      amountMinor: 1n,
      occurredAtUnix: T0,
      accrualKey: 'k',
    })
    const b = observationId({
      vault: 'a',
      asset: 'bc',
      source: 'escrow_credit',
      amountMinor: 1n,
      occurredAtUnix: T0,
      accrualKey: 'k',
    })
    expect(a).not.toBe(b)
  })
})

for (const [name, makeStore] of STORE_FACTORIES) {
  describe(`replay idempotence (${name} store)`, () => {
    it('is a byte-identical no-op when the whole window is re-fed', async () => {
      const store = makeStore()
      const ledger = new Ledger(store, { now: () => T0 })

      await feed(ledger)
      const first = await snapshot(store)

      await feed(ledger)
      await feed(ledger)
      const third = await snapshot(store)

      expect(third).toBe(first)
    })

    it('reports replayed observations as replayed rather than as duplicates', async () => {
      const store = makeStore()
      const ledger = new Ledger(store, { now: () => T0 })

      const fee = FEES[0]
      if (fee === undefined) throw new Error('no fixture')
      const first = await ledger.recordFeeObservation(fee)
      expect(first.outcome).toBe('recognized')

      const again = await ledger.recordFeeObservation(fee)
      expect(again.outcome).toBe('replayed')
      expect(again.entryIds).toEqual(first.entryIds)
      expect(again.recognizedMinor).toBe(first.recognizedMinor)
    })

    it('leaves the trial balance and the materialized table in agreement', async () => {
      const store = makeStore()
      const ledger = new Ledger(store, { now: () => T0 })
      await feed(ledger)
      await feed(ledger)

      const verification = await ledger.auditIntegrity()
      expect(verification.ok).toBe(true)
      expect(verification.balanceDiffs).toEqual([])
      expect(verification.flowDiffs).toEqual([])
      for (const residual of verification.residualByAssetKey.values()) {
        expect(residual).toBe(0n)
      }
    })

    it('refuses a second entry that reuses an id with different content', async () => {
      const store = makeStore()
      const ledger = new Ledger(store, { now: () => T0 })
      await ledger.recordFeeObservation({
        vault: VAULT,
        asset: USDG,
        amountMinor: 500n,
        source: 'pool_fees_swept',
        accrualKey: KEY,
        occurredAtUnix: T0,
        txHash: '0xa',
        logIndex: 0,
      })
      const entries = (await store.listEntries()).entries
      const original = entries[0]
      if (original === undefined) throw new Error('no entry written')

      await expect(
        store.appendWrite({
          entries: [{ ...original, amountMinor: original.amountMinor + 1n }],
        }),
      ).rejects.toThrow(EntryIdCollisionError)
    })
  })
}

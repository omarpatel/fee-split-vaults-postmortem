/**
 * The trial-balance recompute, the diff, and the sign rules.
 *
 * The load-bearing case is `corruptMaterializedBalanceForTest`: it moves a
 * materialized row WITHOUT touching a posting, which is precisely what a broken
 * incremental maintainer does. Nothing except the recompute can see it.
 */

import { describe, expect, it } from 'vitest'
import {
  accumulate,
  assertBalanced,
  assertWriteIsLegal,
  diffBalances,
  incomeSummary,
  presentBalance,
} from '../balances.js'
import { classifyPair, POSTING_PAIRS, naturalBalance } from '../accounts.js'
import { IllegalPostingError, LedgerBalanceError, UnbalancedWriteError } from '../errors.js'
import { Ledger } from '../ledger.js'
import { makeEntry, type PostingContext } from '../postings.js'
import { InMemoryLedgerStore } from '../store/memory.js'
import { iterateEntries } from '../store/types.js'
import { T0, USDG, VAULT } from './helpers.js'

const CTX: PostingContext = {
  batchKey: 'test',
  vault: VAULT,
  asset: USDG,
  occurredAtUnix: T0,
  source: 'manual',
}

async function fundedLedger(): Promise<{ store: InMemoryLedgerStore; ledger: Ledger }> {
  const store = new InMemoryLedgerStore()
  const ledger = new Ledger(store, { now: () => T0 })

  await ledger.recordFeeObservation({
    vault: VAULT,
    asset: USDG,
    amountMinor: 1_000_000n,
    source: 'pool_fees_swept',
    accrualKey: 'sweep:test:1',
    occurredAtUnix: T0,
    txHash: '0xsweep',
    logIndex: 0,
  })
  await ledger.recordClaim({
    vault: VAULT,
    asset: USDG,
    amountMinor: 1_000_000n,
    occurredAtUnix: T0 + 1,
    batchKey: 'claim:1',
  })
  await ledger.recordAllocation({
    vault: VAULT,
    asset: USDG,
    occurredAtUnix: T0 + 2,
    batchKey: 'settle:1',
    amounts: { devMinor: 700_000n, budgetMinor: 200_000n, operatorMinor: 80_000n, referrerMinor: 20_000n },
  })
  return { store, ledger }
}

describe('the posting whitelist', () => {
  it('maps every legal pair to a distinct kind and refuses everything else', () => {
    const kinds = new Set(POSTING_PAIRS.map((p) => p.kind))
    expect(kinds.size).toBe(POSTING_PAIRS.length)
    for (const pair of POSTING_PAIRS) {
      expect(classifyPair(pair.debit, pair.credit)).toBe(pair.kind)
    }
  })

  it('has no posting that pays an expense account out of a client liability', () => {
    // The absence of a vendor account is the control; this pins the consequence.
    for (const pair of POSTING_PAIRS) {
      if (pair.debit.startsWith('expense:')) {
        expect(pair.credit).toBe('asset:vault')
      }
    }
  })

  it('refuses a pair that is not on the whitelist', () => {
    expect(() => classifyPair('asset:vault', 'income:fees')).toThrow(IllegalPostingError)
    expect(() => classifyPair('expense:cogs', 'expense:procurement')).toThrow(IllegalPostingError)
  })
})

describe('write legality', () => {
  it('rejects a forged entry before the residual check can even run', () => {
    // Every well-formed entry balances by construction, so the residual is zero
    // structurally. The whitelist is what actually stops a forged pair.
    const good = makeEntry(CTX, 0, 'asset:escrow', 'income:fees', 100n)
    const forged = { ...good, credit: 'liability:budget' as const, id: 'forged' }
    expect(() => assertWriteIsLegal([good, forged], () => 0n)).toThrow(IllegalPostingError)
  })

  it('reports a non-zero residual, which can only come from corrupted storage', () => {
    const good = makeEntry(CTX, 0, 'asset:escrow', 'income:fees', 100n)
    const tb = accumulate([good])
    const corrupted = {
      ...tb,
      accounts: tb.accounts.map((row) =>
        row.account === 'income:fees' ? { ...row, balanceMinor: row.balanceMinor + 7n } : row,
      ),
    }
    // assertBalanced re-derives the residual from the account rows it is given.
    const rebuilt = {
      ...corrupted,
      residualByAssetKey: new Map(
        corrupted.accounts.reduce((acc, row) => {
          const key = `${row.vault}|${row.asset}`
          acc.set(key, (acc.get(key) ?? 0n) + row.balanceMinor)
          return acc
        }, new Map<string, bigint>()),
      ),
    }
    expect(() => assertBalanced(rebuilt)).toThrow(UnbalancedWriteError)
  })

  it('rejects a payout larger than the leg it draws on', () => {
    const entry = makeEntry(CTX, 0, 'liability:dev_claimable', 'asset:vault', 100n)
    expect(() => assertWriteIsLegal([entry], () => 0n)).toThrow(LedgerBalanceError)
  })

  it('rejects a claim of escrow that was never credited', async () => {
    const store = new InMemoryLedgerStore()
    const ledger = new Ledger(store, { now: () => T0 })
    await expect(
      ledger.recordClaim({
        vault: VAULT,
        asset: USDG,
        amountMinor: 1n,
        occurredAtUnix: T0,
        batchKey: 'claim:none',
      }),
    ).rejects.toThrow(LedgerBalanceError)
    expect((await store.listEntries()).entries).toHaveLength(0)
  })

  it('rejects an allocation larger than the income recognised', async () => {
    const { ledger } = await fundedLedger()
    await expect(
      ledger.recordAllocation({
        vault: VAULT,
        asset: USDG,
        occurredAtUnix: T0 + 3,
        batchKey: 'settle:2',
        amounts: { devMinor: 1n, budgetMinor: 0n, operatorMinor: 0n, referrerMinor: 0n },
      }),
    ).rejects.toThrow(LedgerBalanceError)
  })
})

describe('trial-balance recompute', () => {
  it('nets to zero per asset and matches the maintained table', async () => {
    const { store, ledger } = await fundedLedger()
    const verification = await ledger.auditIntegrity()
    expect(verification.ok).toBe(true)

    const entries = []
    for await (const entry of iterateEntries(store)) entries.push(entry)
    const tb = accumulate(entries)
    assertBalanced(tb)
    expect(diffBalances(await store.listAccountBalances(), tb.accounts)).toEqual([])
  })

  it('catches a materialized row that drifted without a posting', async () => {
    const { store, ledger } = await fundedLedger()
    store.corruptMaterializedBalanceForTest(VAULT, USDG, 'asset:vault', 1n)

    const verification = await ledger.verifyBalances()
    expect(verification.ok).toBe(false)
    expect(verification.balanceDiffs).toHaveLength(1)
    expect(verification.balanceDiffs[0]?.reason).toBe('amount_mismatch')
    expect(verification.balanceDiffs[0]?.deltaMinor).toBe(1n)

    // The recompute itself is still internally consistent: the corruption is in
    // the derived table, not in the postings.
    for (const residual of verification.residualByAssetKey.values()) {
      expect(residual).toBe(0n)
    }
  })

  it('reads QF from flows, not from the income:fees balance', async () => {
    const { ledger } = await fundedLedger()
    await ledger.recordBudgetDisbursement({
      vault: VAULT,
      asset: USDG,
      amountMinor: 150_000n,
      occurredAtUnix: T0 + 10,
      batchKey: 'disb:1',
      invoiceHash: '0xinvoice',
      commitment: { id: 'c1', authorizedAtUnix: T0 + 5, fullyBankedAtSigning: true },
    })

    // The restricted-fund release credits income:fees again, so the raw balance
    // is not QF. incomeSummary reads the accrual flow instead.
    const incomeBalance = await ledger.balanceOf(VAULT, USDG, 'income:fees')
    expect(naturalBalance('income:fees', incomeBalance)).toBe(150_000n)

    const summary = await ledger.incomeSummary({ vault: VAULT, asset: USDG })
    expect(summary[0]?.recognizedMinor).toBe(1_000_000n)
    expect(summary[0]?.allocatedMinor).toBe(1_000_000n)
    expect(summary[0]?.unallocatedMinor).toBe(0n)
    expect(summary[0]?.releasedMinor).toBe(150_000n)

    const balances = await ledger.balances({ vault: VAULT, asset: USDG })
    const budget = balances.find((b) => b.account === 'liability:budget')
    const procurement = balances.find((b) => b.account === 'expense:procurement')
    expect(budget && presentBalance(budget)).toBe(50_000n)
    expect(procurement && presentBalance(procurement)).toBe(150_000n)
  })

  it('summarises income per asset scope', async () => {
    const { store } = await fundedLedger()
    const summary = incomeSummary(await store.listFlowTotals())
    expect(summary).toHaveLength(1)
    expect(summary[0]?.recognizedMinor).toBe(1_000_000n)
  })
})

describe('the referrer leg', () => {
  it('is carried separately from the operator leg and the books still net to zero', async () => {
    const { ledger } = await fundedLedger()
    const balances = await ledger.balances({ vault: VAULT, asset: USDG })
    const operator = balances.find((b) => b.account === 'liability:operator_claimable')
    const referrer = balances.find((b) => b.account === 'liability:referrer_claimable')
    expect(operator && presentBalance(operator)).toBe(80_000n)
    expect(referrer && presentBalance(referrer)).toBe(20_000n)

    const summary = await ledger.incomeSummary({ vault: VAULT, asset: USDG })
    expect(summary[0]?.allocatedMinor).toBe(1_000_000n)
    expect(summary[0]?.unallocatedMinor).toBe(0n)
    expect((await ledger.auditIntegrity()).ok).toBe(true)
  })

  it('pays the referrer out of its own leg only, never out of the operator leg', async () => {
    const { ledger } = await fundedLedger()
    await ledger.recordReferrerWithdrawal({
      vault: VAULT,
      asset: USDG,
      amountMinor: 20_000n,
      occurredAtUnix: T0 + 3,
      batchKey: 'withdraw:referrer:1',
      txHash: '0xreferrer',
      logIndex: 0,
    })
    const referrer = await ledger.balanceOf(VAULT, USDG, 'liability:referrer_claimable')
    expect(naturalBalance('liability:referrer_claimable', referrer)).toBe(0n)
    const operator = await ledger.balanceOf(VAULT, USDG, 'liability:operator_claimable')
    expect(naturalBalance('liability:operator_claimable', operator)).toBe(80_000n)

    // The operator leg still holds 80_000, but that is not the referrer's money.
    await expect(
      ledger.recordReferrerWithdrawal({
        vault: VAULT,
        asset: USDG,
        amountMinor: 1n,
        occurredAtUnix: T0 + 4,
        batchKey: 'withdraw:referrer:2',
      }),
    ).rejects.toThrow(LedgerBalanceError)
    expect((await ledger.auditIntegrity()).ok).toBe(true)
  })
})

describe('the anti-snipe windfall', () => {
  it('records the launch token as an unattributed inflow, never as income', async () => {
    const store = new InMemoryLedgerStore()
    const ledger = new Ledger(store, { now: () => T0 })
    const LAUNCH = '0x9999999999999999999999999999999999999999'

    await ledger.recordUnattributedInflow({
      vault: VAULT,
      asset: LAUNCH,
      amountMinor: 990_000_000_000_000_000_000n,
      occurredAtUnix: T0,
      batchKey: 'chain:antisnipe:0xtax:0',
      txHash: '0xtax',
      logIndex: 0,
      memo: 'anti-snipe tax at t=0',
    })

    const summary = await ledger.incomeSummary({ vault: VAULT, asset: LAUNCH })
    expect(summary[0]?.recognizedMinor ?? 0n).toBe(0n)

    const dev = await ledger.balanceOf(VAULT, LAUNCH, 'liability:dev_claimable')
    expect(naturalBalance('liability:dev_claimable', dev)).toBe(990_000_000_000_000_000_000n)
    expect((await ledger.auditIntegrity()).ok).toBe(true)
  })
})

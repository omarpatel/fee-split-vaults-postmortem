/**
 * Fuzz: random VALID operation sequences must keep the ledger balanced.
 *
 * The generator models the real lifecycle - fees observed from several sources
 * against shared accrual keys, chunked claims, settlement, leg payouts,
 * reimbursements, refunds and windfalls - and never proposes an amount larger
 * than the balance it draws on, so every generated operation should be accepted.
 * A refusal is therefore itself a failure, which is what makes this a test of
 * the invariants rather than of the generator.
 *
 * After every sequence:
 *   1. the recompute nets to zero per (vault, asset);
 *   2. every account is on its own side of zero;
 *   3. the materialized table equals the recompute exactly;
 *   4. allocation never exceeded recognition;
 *   5. replaying the entire sequence changes nothing.
 *
 * Seeds are fixed so a failure is reproducible from the seed alone.
 */

import { describe, expect, it } from 'vitest'
import { naturalBalance } from '../accounts.js'
import { Ledger, type FeeObservation, type MovementRequest } from '../ledger.js'
import { InMemoryLedgerStore } from '../store/memory.js'
import { InMemorySqlDriver } from '../store/fakeDriver.js'
import { SqlLedgerStore } from '../store/sql.js'
import type { LedgerStore } from '../store/types.js'
import { iterateEntries } from '../store/types.js'
import { dailyAccrualKey } from '../ids.js'
import { TERMS } from '../../../../config/protocol.js'
import { Rng, T0, USDG, VAULT, VAULT_B, WETH } from './helpers.js'

const VAULTS = [VAULT, VAULT_B] as const
const ASSETS = [USDG, WETH] as const
/** Share of the operator's gross slice carved out for a referrer, as CoinVault.REFERRER_BPS. */
const REFERRER_BPS = 2_000
const SOURCES: Array<FeeObservation['source']> = [
  'curve_event',
  'pool_fees_swept',
  'escrow_credit',
  'erc20_transfer',
]

type Op =
  | { kind: 'fee'; observation: FeeObservation }
  | { kind: 'claim'; request: MovementRequest }
  | {
      kind: 'allocate'
      request: Omit<MovementRequest, 'amountMinor'>
      amounts: { devMinor: bigint; budgetMinor: bigint; operatorMinor: bigint; referrerMinor: bigint }
    }
  | { kind: 'withdrawDev'; request: MovementRequest }
  | { kind: 'withdrawOperator'; request: MovementRequest }
  | { kind: 'withdrawReferrer'; request: MovementRequest }
  | { kind: 'disburse'; request: MovementRequest & { invoiceHash: string } }
  | { kind: 'cogs'; request: MovementRequest }
  | { kind: 'refund'; request: MovementRequest }
  | { kind: 'windfall'; request: MovementRequest }

/**
 * A model of the balances the generator needs to stay inside. It deliberately
 * does NOT reuse the ledger's own arithmetic: if both were wrong in the same
 * way, the generator would happily propose the illegal amount the ledger then
 * accepted.
 */
interface Model {
  escrow: bigint
  vaultCash: bigint
  unallocated: bigint
  dev: bigint
  budget: bigint
  operator: bigint
  referrer: bigint
  recognized: bigint
  allocated: bigint
  perSource: Map<string, bigint>
  recognizedSource?: string
  recognizedForKey: bigint
}

function newModel(): Model {
  return {
    escrow: 0n,
    vaultCash: 0n,
    unallocated: 0n,
    dev: 0n,
    budget: 0n,
    operator: 0n,
    referrer: 0n,
    recognized: 0n,
    allocated: 0n,
    perSource: new Map(),
    recognizedForKey: 0n,
  }
}

function precedenceOf(source: string): number {
  return SOURCES.indexOf(source as FeeObservation['source'])
}

function generate(seed: number, length: number): Op[] {
  const rng = new Rng(seed)
  const ops: Op[] = []
  const models = new Map<string, Model>()
  let counter = 0

  const modelOf = (vault: string, asset: string): Model => {
    const key = `${vault}|${asset}`
    let model = models.get(key)
    if (model === undefined) {
      model = newModel()
      models.set(key, model)
    }
    return model
  }

  while (ops.length < length) {
    const vault = rng.pick(VAULTS)
    const asset = rng.pick(ASSETS)
    const model = modelOf(vault, asset)
    const at = T0 + counter * 60
    const batchKey = `fuzz:${seed}:${counter}`
    counter += 1
    const roll = rng.int(100)

    if (roll < 30) {
      // A fee observation. Only ever grow the winning source's total, so the
      // generator never proposes a downward correction escrow cannot absorb -
      // that path is covered deterministically in precedence.spec.ts.
      const source = rng.pick(SOURCES)
      const amountMinor = BigInt(rng.int(50_000) + 1)
      const rank = precedenceOf(source)
      const currentRank =
        model.recognizedSource === undefined ? 99 : precedenceOf(model.recognizedSource)
      const runningForSource = (model.perSource.get(source) ?? 0n) + amountMinor
      if (rank < currentRank && runningForSource < model.recognizedForKey) continue

      ops.push({
        kind: 'fee',
        observation: {
          vault,
          asset,
          amountMinor,
          source,
          accrualKey: dailyAccrualKey(vault, asset, T0),
          occurredAtUnix: at,
          txHash: `0xfuzz${counter}`,
          logIndex: counter,
        },
      })

      model.perSource.set(source, runningForSource)
      if (rank <= currentRank) {
        const delta = runningForSource - model.recognizedForKey
        model.recognizedSource = source
        model.recognizedForKey = runningForSource
        model.recognized += delta
        model.unallocated += delta
        model.escrow += delta
      }
      continue
    }

    if (roll < 45 && model.escrow > 0n) {
      // Claims are chunked: some quote assets cap a single transfer.
      const amountMinor = BigInt(rng.int(Number(model.escrow)) + 1)
      ops.push({ kind: 'claim', request: { vault, asset, amountMinor, occurredAtUnix: at, batchKey } })
      model.escrow -= amountMinor
      model.vaultCash += amountMinor
      continue
    }

    if (roll < 65 && model.unallocated > 0n) {
      const gross = BigInt(rng.int(Number(model.unallocated)) + 1)
      const operatorGross = (gross * BigInt(TERMS.operatorBps)) / 10_000n
      const budgetMinor = (gross * BigInt(TERMS.budgetBpsDefault)) / 10_000n
      // The dev leg absorbs the remainder, exactly as CoinVault._splitOf does,
      // and the referrer is carved out of the operator's gross slice.
      const devMinor = gross - operatorGross - budgetMinor
      const referrerMinor = (operatorGross * BigInt(REFERRER_BPS)) / 10_000n
      const operatorMinor = operatorGross - referrerMinor
      ops.push({
        kind: 'allocate',
        request: { vault, asset, occurredAtUnix: at, batchKey },
        amounts: { devMinor, budgetMinor, operatorMinor, referrerMinor },
      })
      model.unallocated -= gross
      model.allocated += gross
      model.dev += devMinor
      model.budget += budgetMinor
      model.operator += operatorMinor
      model.referrer += referrerMinor
      continue
    }

    const payable = (leg: bigint): bigint => (leg < model.vaultCash ? leg : model.vaultCash)

    if (roll < 75 && payable(model.dev) > 0n) {
      const amountMinor = BigInt(rng.int(Number(payable(model.dev))) + 1)
      ops.push({ kind: 'withdrawDev', request: { vault, asset, amountMinor, occurredAtUnix: at, batchKey } })
      model.dev -= amountMinor
      model.vaultCash -= amountMinor
      continue
    }

    if (roll < 82 && payable(model.operator) > 0n) {
      const amountMinor = BigInt(rng.int(Number(payable(model.operator))) + 1)
      const op = rng.int(2) === 0 ? 'withdrawOperator' : 'cogs'
      ops.push({
        kind: op,
        request: { vault, asset, amountMinor, occurredAtUnix: at, batchKey },
      } as Op)
      model.operator -= amountMinor
      model.vaultCash -= amountMinor
      continue
    }

    if (roll < 85 && payable(model.referrer) > 0n) {
      const amountMinor = BigInt(rng.int(Number(payable(model.referrer))) + 1)
      ops.push({ kind: 'withdrawReferrer', request: { vault, asset, amountMinor, occurredAtUnix: at, batchKey } })
      model.referrer -= amountMinor
      model.vaultCash -= amountMinor
      continue
    }

    if (roll < 90 && payable(model.budget) > 0n) {
      const amountMinor = BigInt(rng.int(Number(payable(model.budget))) + 1)
      ops.push({
        kind: 'disburse',
        request: {
          vault,
          asset,
          amountMinor,
          occurredAtUnix: at,
          batchKey,
          invoiceHash: `0xinv${counter}`,
        },
      })
      model.budget -= amountMinor
      model.vaultCash -= amountMinor
      continue
    }

    if (roll < 95 && model.budget > 0n) {
      const amountMinor = BigInt(rng.int(Number(model.budget)) + 1)
      ops.push({ kind: 'refund', request: { vault, asset, amountMinor, occurredAtUnix: at, batchKey } })
      model.budget -= amountMinor
      model.dev += amountMinor
      continue
    }

    // A launch-token vest or the anti-snipe windfall. Never income.
    const amountMinor = BigInt(rng.int(100_000) + 1)
    ops.push({ kind: 'windfall', request: { vault, asset, amountMinor, occurredAtUnix: at, batchKey } })
    model.vaultCash += amountMinor
    model.dev += amountMinor
  }

  return ops
}

async function apply(ledger: Ledger, ops: readonly Op[]): Promise<void> {
  for (const op of ops) {
    switch (op.kind) {
      case 'fee':
        await ledger.recordFeeObservation(op.observation)
        break
      case 'claim':
        await ledger.recordClaim(op.request)
        break
      case 'allocate':
        await ledger.recordAllocation({ ...op.request, amounts: op.amounts })
        break
      case 'withdrawDev':
        await ledger.recordDevWithdrawal(op.request)
        break
      case 'withdrawOperator':
        await ledger.recordOperatorWithdrawal(op.request)
        break
      case 'withdrawReferrer':
        await ledger.recordReferrerWithdrawal(op.request)
        break
      case 'disburse':
        await ledger.recordBudgetDisbursement({
          ...op.request,
          commitment: {
            id: op.request.batchKey,
            authorizedAtUnix: op.request.occurredAtUnix,
            fullyBankedAtSigning: true,
          },
        })
        break
      case 'cogs':
        await ledger.recordCogs(op.request)
        break
      case 'refund':
        await ledger.recordBudgetRefund(op.request)
        break
      case 'windfall':
        await ledger.recordUnattributedInflow(op.request)
        break
    }
  }
}

async function assertInvariants(ledger: Ledger, store: LedgerStore, seed: number): Promise<void> {
  const context = `seed ${seed}`

  const verification = await ledger.auditIntegrity()
  expect(verification.balanceDiffs, context).toEqual([])
  expect(verification.flowDiffs, context).toEqual([])
  expect(verification.ok, context).toBe(true)
  for (const residual of verification.residualByAssetKey.values()) {
    expect(residual, context).toBe(0n)
  }

  for (const row of await store.listAccountBalances()) {
    expect(naturalBalance(row.account, row.balanceMinor) >= 0n, `${context} ${row.account}`).toBe(
      true,
    )
  }

  for (const summary of await ledger.incomeSummary()) {
    expect(summary.allocatedMinor <= summary.recognizedMinor, context).toBe(true)
    expect(summary.unallocatedMinor >= 0n, context).toBe(true)
  }
}

async function fingerprint(store: LedgerStore): Promise<string> {
  const ids: string[] = []
  for await (const entry of iterateEntries(store)) ids.push(entry.id)
  const balances = (await store.listAccountBalances()).map(
    (b) => `${b.vault}|${b.asset}|${b.account}=${b.balanceMinor.toString()}`,
  )
  return JSON.stringify({ ids: ids.sort(), balances })
}

const SEEDS = [1, 7, 42, 101, 1_337, 20_260_906, 8_675_309, 99_991]

const ALL_OP_KINDS: Array<Op['kind']> = [
  'fee',
  'claim',
  'allocate',
  'withdrawDev',
  'withdrawOperator',
  'withdrawReferrer',
  'disburse',
  'cogs',
  'refund',
  'windfall',
]

describe('fuzz: random valid sequences keep the ledger balanced', () => {
  it('exercises the whole lifecycle rather than one cheap operation', () => {
    const seen = new Set<Op['kind']>()
    for (const seed of SEEDS) {
      for (const op of generate(seed, 160)) seen.add(op.kind)
    }
    expect([...seen].sort()).toEqual([...ALL_OP_KINDS].sort())
  })

  for (const seed of SEEDS) {
    it(`seed ${seed}`, async () => {
      const ops = generate(seed, 160)
      const store = new InMemoryLedgerStore()
      const ledger = new Ledger(store, { now: () => T0 })

      await apply(ledger, ops)
      await assertInvariants(ledger, store, seed)

      const before = await fingerprint(store)
      await apply(ledger, ops)
      expect(await fingerprint(store), `seed ${seed} replay`).toBe(before)
      await assertInvariants(ledger, store, seed)
    })
  }

  it('produces identical books in the memory store and the SQL store', async () => {
    const ops = generate(4_242, 120)

    const memoryStore = new InMemoryLedgerStore()
    await apply(new Ledger(memoryStore, { now: () => T0 }), ops)

    const sqlStore = new SqlLedgerStore(new InMemorySqlDriver())
    await apply(new Ledger(sqlStore, { now: () => T0 }), ops)

    expect(await fingerprint(sqlStore)).toBe(await fingerprint(memoryStore))
  })
})

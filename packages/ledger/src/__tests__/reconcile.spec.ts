/**
 * Three-way match, variance severity, and the freeze.
 *
 * The freeze test is the one that matters operationally: a critical variance
 * must stop NEW spend authorization while leaving an already-signed, already-
 * banked commitment able to settle.
 */

import { describe, expect, it } from 'vitest'
import { Ledger } from '../ledger.js'
import { InMemoryLedgerStore } from '../store/memory.js'
import { reconcileChainBalance, threeWayMatch } from '../reconcile.js'
import {
  classifySeverity,
  DEFAULT_VARIANCE_POLICY,
  freezeCovers,
  isCommitmentExempt,
  type FreezeRecord,
  type VariancePolicy,
} from '../variance.js'
import { PinnedPriceOracle, minorToDecimalString, toUsdValue, tryUsd } from '../usd.js'
import { PriceUnavailableError } from '../errors.js'
import { SPEND_LIMITS } from '../../../../config/protocol.js'
import { T0, USDG, VAULT, VAULT_B } from './helpers.js'

const PRICED: VariancePolicy = { ...DEFAULT_VARIANCE_POLICY }
const usdOfDelta = (): number => 1

describe('variance severity', () => {
  it('treats integer split remainders as info', () => {
    expect(
      classifySeverity({ deltaMinor: 3n, referenceMinor: 1_000_000n, deltaUsd: 0.000001 }),
    ).toBe('info')
  })

  it('escalates by ratio', () => {
    expect(
      classifySeverity({ deltaMinor: 1_000n, referenceMinor: 1_000_000n, deltaUsd: 1 }),
    ).toBe('warn')
    expect(
      classifySeverity({ deltaMinor: 100_000n, referenceMinor: 1_000_000n, deltaUsd: 1 }),
    ).toBe('critical')
  })

  it('escalates by absolute USD regardless of ratio', () => {
    expect(
      classifySeverity({
        deltaMinor: 1n,
        referenceMinor: 10n ** 30n,
        deltaUsd: SPEND_LIMITS.humanApprovalThresholdUsd,
      }),
    ).toBe('critical')
  })

  it('fails closed when the delta cannot be priced', () => {
    expect(classifySeverity({ deltaMinor: 1n, referenceMinor: 10n ** 12n })).toBe('critical')
  })

  it('reports an exact match as info without needing a price', () => {
    expect(classifySeverity({ deltaMinor: 0n, referenceMinor: 0n })).toBe('info')
  })
})

describe('three-way match', () => {
  it('matches when the hook, the escrow and the token all agree with the book', () => {
    const result = threeWayMatch({
      sweepId: 'sweep-1',
      vault: VAULT,
      asset: USDG,
      poolId: '0xpool',
      observedAtUnix: T0,
      sweptMinor: 700_000n,
      escrowCreditedMinor: 700_000n,
      receivedMinor: 700_000n,
      ledgerRecognizedMinor: 700_000n,
      usdOfDelta,
      policy: PRICED,
    })
    expect(result.status).toBe('matched')
    expect(result.worstSeverity).toBe('info')
    expect(result.pairwise).toEqual([])
  })

  it('treats an unobserved leg as critical rather than as agreement', () => {
    const result = threeWayMatch({
      sweepId: 'sweep-2',
      vault: VAULT,
      asset: USDG,
      observedAtUnix: T0,
      sweptMinor: 700_000n,
      escrowCreditedMinor: 700_000n,
      ledgerRecognizedMinor: 700_000n,
      usdOfDelta,
      policy: PRICED,
    })
    expect(result.status).toBe('incomplete')
    expect(result.missingLegs).toEqual(['received'])
    expect(result.worstSeverity).toBe('critical')
  })

  it('names every disagreeing pair so the broken leg is identifiable', () => {
    const result = threeWayMatch({
      sweepId: 'sweep-3',
      vault: VAULT,
      asset: USDG,
      observedAtUnix: T0,
      sweptMinor: 700_000n,
      escrowCreditedMinor: 700_000n,
      receivedMinor: 350_000n,
      ledgerRecognizedMinor: 700_000n,
      usdOfDelta,
      policy: PRICED,
    })
    expect(result.status).toBe('variance')
    const involvingReceived = result.pairwise.filter(
      (p) => p.a === 'received' || p.b === 'received',
    )
    expect(involvingReceived).toHaveLength(3)
    expect(result.pairwise.every((p) => p.a === 'received' || p.b === 'received')).toBe(true)
    expect(result.worstSeverity).toBe('critical')
  })
})

describe('chain reconciliation', () => {
  it('produces a stable variance id for the same pinned read', () => {
    const input = {
      vault: VAULT,
      asset: USDG,
      ledgerBalanceMinor: 1_000n,
      chainBalanceMinor: 900n,
      detectedAtUnix: T0,
      blockHash: '0xblock',
      usdOfDelta,
    }
    expect(reconcileChainBalance(input).varianceId).toBe(reconcileChainBalance(input).varianceId)
    expect(reconcileChainBalance(input).variance.deltaMinor).toBe(100n)
  })
})

describe('the spend freeze', () => {
  it('freezes new authorization on a critical variance and leaves other vaults alone', async () => {
    const ledger = new Ledger(new InMemoryLedgerStore(), { now: () => T0 })

    await ledger.recordVariance({
      id: 'vr-1',
      vault: VAULT,
      asset: USDG,
      ledgerBalanceMinor: 1_000_000n,
      chainBalanceMinor: 400_000n,
      deltaMinor: 600_000n,
      severity: 'critical',
      detectedAtUnix: T0,
      note: 'vault holds less than the book says',
    })

    expect(await ledger.isSpendAuthorizationFrozen({ vault: VAULT, asset: USDG })).toBe(true)
    expect(await ledger.isSpendAuthorizationFrozen({ vault: VAULT_B, asset: USDG })).toBe(false)
    await expect(
      ledger.assertSpendAuthorizationAllowed({ vault: VAULT, asset: USDG }),
    ).rejects.toThrow(/frozen/)
    await ledger.assertSpendAuthorizationAllowed({ vault: VAULT_B, asset: USDG })
  })

  it('does not freeze on info or warn', async () => {
    const ledger = new Ledger(new InMemoryLedgerStore(), { now: () => T0 })
    for (const severity of ['info', 'warn'] as const) {
      await ledger.recordVariance({
        id: `vr-${severity}`,
        vault: VAULT,
        asset: USDG,
        ledgerBalanceMinor: 1_000_000n,
        chainBalanceMinor: 999_997n,
        deltaMinor: 3n,
        severity,
        detectedAtUnix: T0,
      })
    }
    expect(await ledger.isSpendAuthorizationFrozen({ vault: VAULT })).toBe(false)
    expect(await ledger.listVariances()).toHaveLength(2)
  })

  it('lets an already-banked commitment settle while the scope is frozen', async () => {
    const store = new InMemoryLedgerStore()
    const ledger = new Ledger(store, { now: () => T0 })

    await ledger.recordFeeObservation({
      vault: VAULT,
      asset: USDG,
      amountMinor: 1_000_000n,
      source: 'pool_fees_swept',
      accrualKey: 'sweep:1',
      occurredAtUnix: T0,
      txHash: '0xa',
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
      amounts: { devMinor: 700_000n, budgetMinor: 200_000n, operatorMinor: 100_000n, referrerMinor: 0n },
    })

    const signedAt = T0 + 10
    await ledger.recordVariance({
      id: 'vr-freeze',
      vault: VAULT,
      asset: USDG,
      ledgerBalanceMinor: 1_000_000n,
      chainBalanceMinor: 100_000n,
      deltaMinor: 900_000n,
      severity: 'critical',
      detectedAtUnix: signedAt + 5,
    })

    // Signed and banked BEFORE the freeze: settles.
    await ledger.recordBudgetDisbursement({
      vault: VAULT,
      asset: USDG,
      amountMinor: 120_000n,
      occurredAtUnix: signedAt + 20,
      batchKey: 'disb:before',
      invoiceHash: '0xinv1',
      commitment: { id: 'c-before', authorizedAtUnix: signedAt, fullyBankedAtSigning: true },
    })

    // Signed AFTER the freeze: refused.
    await expect(
      ledger.recordBudgetDisbursement({
        vault: VAULT,
        asset: USDG,
        amountMinor: 10_000n,
        occurredAtUnix: signedAt + 30,
        batchKey: 'disb:after',
        invoiceHash: '0xinv2',
        commitment: {
          id: 'c-after',
          authorizedAtUnix: signedAt + 10,
          fullyBankedAtSigning: true,
        },
      }),
    ).rejects.toThrow(/not exempt/)

    // Never fully banked: refused even though it predates the freeze.
    await expect(
      ledger.recordBudgetDisbursement({
        vault: VAULT,
        asset: USDG,
        amountMinor: 10_000n,
        occurredAtUnix: signedAt + 31,
        batchKey: 'disb:unbanked',
        invoiceHash: '0xinv3',
        commitment: { id: 'c-unbanked', authorizedAtUnix: signedAt, fullyBankedAtSigning: false },
      }),
    ).rejects.toThrow(/not exempt/)

    expect((await ledger.auditIntegrity()).ok).toBe(true)
  })

  it('does not resurrect a freeze a human already cleared', async () => {
    const store = new InMemoryLedgerStore()
    const ledger = new Ledger(store, { now: () => T0 })
    const variance = {
      id: 'vr-repeat',
      vault: VAULT,
      asset: USDG,
      ledgerBalanceMinor: 10n,
      chainBalanceMinor: 0n,
      deltaMinor: 10n,
      severity: 'critical' as const,
      detectedAtUnix: T0,
    }
    const freeze = await ledger.recordVariance(variance)
    if (freeze === undefined) throw new Error('expected a freeze')

    await ledger.clearFreeze(freeze.id, 'ops@operator', T0 + 100)
    expect(await ledger.isSpendAuthorizationFrozen({ vault: VAULT })).toBe(false)

    await ledger.recordVariance(variance)
    expect(await ledger.isSpendAuthorizationFrozen({ vault: VAULT })).toBe(false)
  })

  it('scopes coverage correctly', () => {
    const base = { id: 'f', reason: 'r', frozenAtUnix: T0 }
    const global: FreezeRecord = { ...base, scope: { kind: 'global' } }
    const perVault: FreezeRecord = { ...base, scope: { kind: 'vault', vault: VAULT } }
    const perAsset: FreezeRecord = { ...base, scope: { kind: 'asset', asset: USDG } }

    expect(freezeCovers(global, { vault: VAULT_B })).toBe(true)
    expect(freezeCovers(perVault, { vault: VAULT_B })).toBe(false)
    expect(freezeCovers(perAsset, { vault: VAULT_B, asset: USDG })).toBe(true)
    expect(freezeCovers({ ...global, clearedAtUnix: T0 + 1 }, { vault: VAULT })).toBe(false)
  })

  it('requires both conjuncts for a commitment exemption', () => {
    const freezes: FreezeRecord[] = [
      { id: 'f', reason: 'r', frozenAtUnix: 100, scope: { kind: 'global' } },
    ]
    expect(
      isCommitmentExempt({ id: 'a', authorizedAtUnix: 99, fullyBankedAtSigning: true }, freezes),
    ).toBe(true)
    expect(
      isCommitmentExempt({ id: 'b', authorizedAtUnix: 101, fullyBankedAtSigning: true }, freezes),
    ).toBe(false)
    expect(
      isCommitmentExempt({ id: 'c', authorizedAtUnix: 99, fullyBankedAtSigning: false }, freezes),
    ).toBe(false)
  })
})

describe('usd derivation', () => {
  const asset = { address: USDG, decimals: 6 }

  it('renders minor units exactly, past the float range', () => {
    expect(minorToDecimalString(1_234_567n, 6)).toBe('1.234567')
    expect(minorToDecimalString(1n, 18)).toBe('0.000000000000000001')
    expect(minorToDecimalString(-5n, 2)).toBe('-0.05')
  })

  it('carries provenance and refuses a stale price', () => {
    const quote = { asset: USDG, usdPerUnit: 1, source: 'pinned', asOfUnix: T0 }
    const value = toUsdValue({ asset: USDG, amount: 2_500_000n }, asset, quote, T0 + 10)
    expect(value.usd).toBeCloseTo(2.5)
    expect(value.priceSource).toBe('pinned')
    expect(value.pricedAtUnix).toBe(T0)

    expect(() => toUsdValue({ asset: USDG, amount: 1n }, asset, quote, T0 + 100_000)).toThrow(
      PriceUnavailableError,
    )
  })

  it('returns undefined rather than a guess when nothing is pinned', async () => {
    const oracle = new PinnedPriceOracle()
    expect(await tryUsd(oracle, asset, 1_000n, T0)).toBeUndefined()
    oracle.pin({ asset: USDG, usdPerUnit: 1, source: 'pinned', asOfUnix: T0 })
    expect(await tryUsd(oracle, asset, 1_000_000n, T0)).toBeCloseTo(1)
  })
})

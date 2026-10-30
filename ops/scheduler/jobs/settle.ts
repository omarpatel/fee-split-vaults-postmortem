/**
 * SETTLE - split swept fees into the three legs.
 *
 * The split is dev / procurement budget / operator, and it is not a transfer to
 * the dev. The dev leg is CREDITED and is withdrawn by the dev's own address;
 * there is no operator key that can move it, so "settle" here means "allocate",
 * and the money stays in the vault until the dev pulls it.
 *
 * THE RATE COMES FROM THE VAULT, NOT FROM CONFIG. operatorBps is in the signed
 * consent, which is in the CREATE2 salt preimage, so a different rate is a
 * different vault address. Reading TERMS.operatorBps here would silently reprice
 * every existing customer the day the pricing decision lands. That is why this
 * file computes the dev leg from the vault's own bps and does not call devBps().
 *
 * Triggered by a completed sweep, with a 6h interval as the safety net for a
 * sweep whose event was dropped.
 */

import type { AssetAddress } from '@fee-split-vaults/core'
import { MONEY_JOB_STATES, SETTLE } from '../config.js'
import type { OpsPorts } from '../ports.js'
import { staggeredIntervalDue } from '../triggers.js'
import type { DueScopeInput, JobContext, JobDefinition, JobOutcome, ScheduledRun } from '../types.js'
import { assetScope, parseAssetScope } from './scope.js'

/**
 * The split this job expects. `operatorMinor` is the operator's GROSS slice:
 * on chain the referrer's cut is carved out of it (CoinVault._splitOf), so the
 * receipt's operator plus referrer must equal it, leg by leg.
 */
export interface Split {
  operatorMinor: bigint
  budgetMinor: bigint
  devLegMinor: bigint
}

export class SplitError extends Error {
  constructor(message: string) {
    super(`split: ${message}`)
    this.name = 'SplitError'
  }
}

/**
 * Integer split. Operator and budget are floored; the DEV ABSORBS THE REMAINDER.
 *
 * Flooring the two legs we control and giving the dust to the dev makes the
 * rounding error work against the operator every time, which is the only
 * direction a rounding rule can point without becoming a way to skim.
 */
export function splitAmount(amountMinor: bigint, operatorBps: number, budgetBps: number): Split {
  if (amountMinor < 0n) throw new SplitError('negative amount')
  if (!Number.isInteger(operatorBps) || operatorBps < 0) throw new SplitError('operatorBps must be a non-negative integer')
  if (!Number.isInteger(budgetBps) || budgetBps < 0) throw new SplitError('budgetBps must be a non-negative integer')
  if (operatorBps + budgetBps > 10_000) throw new SplitError('operatorBps + budgetBps exceeds 100%')

  const operatorMinor = (amountMinor * BigInt(operatorBps)) / 10_000n
  const budgetMinor = (amountMinor * BigInt(budgetBps)) / 10_000n
  const devLegMinor = amountMinor - operatorMinor - budgetMinor
  if (devLegMinor < 0n) throw new SplitError('dev leg went negative; refusing')
  return { operatorMinor, budgetMinor, devLegMinor }
}

export function settleJob(ports: OpsPorts): JobDefinition {
  return {
    id: 'escrow.settle',
    description: 'Allocates swept fees into the dev leg, the procurement budget and the operator fee.',
    triggers: [
      { kind: 'event', event: 'sweep_completed' },
      { kind: 'interval', everySeconds: SETTLE.intervalSeconds },
    ],
    maxAttempts: 3,
    leaseSeconds: 5 * 60,
    timeoutSeconds: 120,
    retryBaseSeconds: 30,
    movesMoney: true,

    async dueScopes(input: DueScopeInput): Promise<ScheduledRun[]> {
      const eventScopes = new Set(input.events.map((e) => e.scope))
      const vaults = await ports.vaults.listByState(MONEY_JOB_STATES)
      const out: ScheduledRun[] = []

      for (const vault of vaults) {
        let unsettled: Array<{ asset: AssetAddress; amountMinor: bigint }>
        try {
          unsettled = await ports.settlement.unsettled(vault.address)
        } catch (error) {
          input.log.warn('settle.unsettled_read_failed', { vault: vault.address, error: String(error) })
          continue
        }
        for (const row of unsettled) {
          if (row.amountMinor <= 0n) continue
          const scope = assetScope(vault.address, row.asset)
          if (eventScopes.has(scope)) {
            out.push({
              jobId: 'escrow.settle',
              scope,
              // A minute-resolution bucket: prompt after a sweep, but still one
              // run per bucket if several sweep events land together.
              period: `e${Math.floor(input.nowUnix / 60)}`,
              reason: { kind: 'event', event: 'sweep_completed' },
            })
            continue
          }
          const last = await input.lastSuccessUnix(scope)
          const due = staggeredIntervalDue(input.nowUnix, scope, last, SETTLE.intervalSeconds)
          if (due.due) {
            out.push({
              jobId: 'escrow.settle',
              scope,
              period: due.period,
              reason: { kind: 'interval', sinceLastSeconds: due.sinceLastSeconds },
            })
          }
        }
      }
      return out
    },

    async run(ctx: JobContext): Promise<JobOutcome> {
      const { vault: vaultAddress, asset } = parseAssetScope(ctx.scope)

      const prior = await ports.settlement.findByRunKey(ctx.runKey)
      if (prior) {
        await ports.ledger.recordSettlement(prior)
        return {
          ok: true,
          code: 'recovered_prior_settlement',
          facts: { settlement_id: prior.settlementId },
        }
      }

      const ref = await ports.vaults.get(vaultAddress)
      if (!ref) return { ok: false, code: 'unknown_vault' }
      if (!(MONEY_JOB_STATES as readonly string[]).includes(ref.state)) {
        return { ok: true, code: 'vault_not_active', facts: { state: ref.state } }
      }
      if (ref.budgetBps < 0 || ref.operatorBps + ref.budgetBps > 10_000) {
        // A dial that does not fit inside 100% is a corrupt record, not a
        // rounding problem. Refuse rather than settle something wrong.
        return {
          ok: false,
          code: 'invalid_bps_configuration',
          facts: { operator_bps: ref.operatorBps, budget_bps: ref.budgetBps },
        }
      }

      const rows = await ports.settlement.unsettled(vaultAddress)
      const row = rows.find((r) => r.asset === asset)
      if (!row || row.amountMinor <= 0n) return { ok: true, code: 'nothing_to_settle' }

      const split = splitAmount(row.amountMinor, ref.operatorBps, ref.budgetBps)
      const receipt = await ports.settlement.settle({
        vault: vaultAddress,
        asset,
        amountMinor: row.amountMinor,
        operatorBps: ref.operatorBps,
        budgetBps: ref.budgetBps,
        runKey: ctx.runKey,
      })

      // The executor is the authority on what happened, but a split that does
      // not add up means the executor and this job disagree about the money.
      const total = receipt.devLegMinor + receipt.budgetMinor + receipt.operatorMinor + receipt.referrerMinor
      if (total !== row.amountMinor) {
        return {
          ok: false,
          code: 'settlement_does_not_balance',
          facts: {
            settlement_id: receipt.settlementId,
            expected_minor: row.amountMinor.toString(10),
            posted_minor: total.toString(10),
          },
        }
      }
      const operatorGross = receipt.operatorMinor + receipt.referrerMinor
      if (
        operatorGross !== split.operatorMinor ||
        receipt.budgetMinor !== split.budgetMinor ||
        receipt.devLegMinor !== split.devLegMinor
      ) {
        return {
          ok: false,
          code: 'settlement_split_mismatch',
          facts: {
            settlement_id: receipt.settlementId,
            expected_operator_minor: split.operatorMinor.toString(10),
            posted_operator_minor: operatorGross.toString(10),
          },
        }
      }

      await ports.ledger.recordSettlement(receipt)
      return {
        ok: true,
        code: 'settled',
        facts: {
          settlement_id: receipt.settlementId,
          asset,
          amount_minor: row.amountMinor.toString(10),
          dev_leg_minor: receipt.devLegMinor.toString(10),
          budget_minor: receipt.budgetMinor.toString(10),
          operator_minor: receipt.operatorMinor.toString(10),
          referrer_minor: receipt.referrerMinor.toString(10),
        },
      }
    },
  }
}

/**
 * ESCROW SWEEP - claim a vault's credits out of the shared Venue fee escrow.
 *
 * WHY IT IS TRIGGERED TWO WAYS. On value, because leaving fees in the escrow is
 * counterparty exposure: the escrow is a contract we do not control and every
 * approved quote asset is an upgradeable, pausable, issuer-controlled proxy. On
 * a 24h forced interval, because a quiet coin that never crosses the value
 * threshold must not accumulate an unbounded stranding risk for free.
 *
 * WHY IT IS THE MOST DANGEROUS JOB HERE. It is the only scheduled job that
 * broadcasts a transaction which moves money into our accounting. A double run
 * is a double claim. Three things stop that, in order:
 *
 *   1. the singleton lock keyed on (job, vault, asset);
 *   2. the run record, so a completed period is never re-run;
 *   3. SweepExecutor.findByRunKey(), which is the only one of the three that
 *      still works if the process dies between broadcasting and recording. The
 *      first two are optimisations; this one is the correctness argument.
 *
 * maxAttempts is 2. A claim that failed twice is a claim a human looks at.
 */

import type { Address, AssetAddress } from '@fee-split-vaults/core'
import { parseRunKey } from '../../lib/ids.js'
import type { Logger } from '../../lib/logging.js'
import { HOUR } from '../../lib/time.js'
import { MONEY_JOB_STATES, SWEEP } from '../config.js'
import type { EscrowCredit, OpsPorts, SweepReceipt } from '../ports.js'
import { staggeredIntervalDue } from '../triggers.js'
import type { DueScopeInput, JobContext, JobDefinition, JobOutcome, ScheduledRun } from '../types.js'
import { assetScope, parseAssetScope } from './scope.js'

export function escrowSweepJob(ports: OpsPorts): JobDefinition {
  return {
    id: 'escrow.sweep',
    description: 'Claims a vault’s credits out of the Venue V2 fee escrow, in per-transfer-capped chunks.',
    triggers: [
      { kind: 'threshold', thresholdName: 'escrow_value_usd' },
      { kind: 'interval', everySeconds: SWEEP.forcedIntervalSeconds },
    ],
    maxAttempts: 2,
    leaseSeconds: 10 * 60,
    timeoutSeconds: 240,
    retryBaseSeconds: 60,
    movesMoney: true,

    async dueScopes(input: DueScopeInput): Promise<ScheduledRun[]> {
      const out: ScheduledRun[] = []

      // The outbox first. A claim that was broadcast but never posted to the
      // ledger has already drained the escrow, so neither the value trigger nor
      // the forced interval would ever notice it. These runs are reconstructed
      // from the receipt's own run key, so the retry lands on the same idempotency
      // record the crashed attempt opened.
      const unrecorded = await ports.sweeper.unrecorded(SWEEP.maxChunksPerRun)
      for (const receipt of unrecorded) {
        try {
          const parsed = parseRunKey(receipt.runKey)
          if (parsed.jobId !== 'escrow.sweep') continue
          out.push({
            jobId: 'escrow.sweep',
            scope: parsed.scope,
            period: parsed.period,
            reason: { kind: 'threshold', thresholdName: 'unrecorded_sweep', detail: receipt.sweepId },
          })
        } catch (error) {
          input.log.error('escrow.sweep.unrecorded_run_key_malformed', {
            sweep_id: receipt.sweepId,
            error: String(error),
          })
        }
      }
      const claimedScopes = new Set(out.map((run) => run.scope))

      const vaults = await ports.vaults.listByState(MONEY_JOB_STATES)
      for (const vault of vaults) {
        let credits: EscrowCredit[]
        try {
          credits = await ports.escrow.listPending(vault.address)
        } catch (error) {
          // One unreadable vault must not blind the sweep for the whole book.
          input.log.warn('escrow.sweep.pending_read_failed', { vault: vault.address, error: String(error) })
          continue
        }
        for (const credit of credits) {
          if (credit.creditedMinor <= 0n) continue
          const scope = assetScope(credit.vault, credit.asset)
          if (claimedScopes.has(scope)) continue
          const last = await input.lastSuccessUnix(scope)
          const forced = staggeredIntervalDue(input.nowUnix, scope, last, SWEEP.forcedIntervalSeconds)

          if (credit.usd.usd >= SWEEP.valueThresholdUsd) {
            // Threshold runs are bucketed at the evaluation interval, so a coin
            // that keeps crossing the threshold sweeps at most once per bucket
            // rather than once per tick.
            const bucket = Math.floor(input.nowUnix / SWEEP.evaluateEverySeconds)
            out.push({
              jobId: 'escrow.sweep',
              scope,
              period: `v${bucket}`,
              reason: {
                kind: 'threshold',
                thresholdName: 'escrow_value_usd',
                detail: `usd=${credit.usd.usd.toFixed(2)} src=${credit.usd.priceSource}`,
              },
            })
            continue
          }
          if (forced.due) {
            out.push({
              jobId: 'escrow.sweep',
              scope,
              period: forced.period,
              reason: { kind: 'interval', sinceLastSeconds: forced.sinceLastSeconds },
            })
          }
        }
      }
      return out
    },

    async run(ctx: JobContext): Promise<JobOutcome> {
      const { vault: vaultAddress, asset } = parseAssetScope(ctx.scope)

      const prior = await ports.sweeper.findByRunKey(ctx.runKey)
      if (prior) {
        // A previous attempt broadcast this claim and died before recording it.
        // Re-record (idempotent by sweepId) and finish. Do NOT claim again.
        await ports.ledger.recordSweep(prior)
        await ports.sweeper.confirmRecorded(prior.sweepId)
        ctx.emit({ name: 'sweep_completed', scope: ctx.scope, detail: { sweep_id: prior.sweepId } })
        return {
          ok: true,
          code: 'recovered_prior_sweep',
          facts: { sweep_id: prior.sweepId, claimed_minor: prior.claimedMinor.toString(10) },
        }
      }

      const guard = await guardSweepable(ports, vaultAddress, asset, ctx.log)
      if (guard) return guard

      const credits = await ports.escrow.listPending(vaultAddress)
      const credit = credits.find((c) => c.asset === asset)
      if (!credit || credit.creditedMinor <= 0n) {
        return { ok: true, code: 'nothing_to_claim' }
      }

      const assetInfo = await ports.assets.get(asset)
      const cap = assetInfo?.maxTransferMinor
      const plan = planChunks(credit.creditedMinor, cap, SWEEP.maxChunksPerRun)

      const request = {
        vault: vaultAddress,
        asset,
        expectedMinor: plan.claimMinor,
        runKey: ctx.runKey,
        ...(cap === undefined ? {} : { maxChunkMinor: cap }),
      }
      const receipt = await ports.sweeper.sweep(request)
      await ports.ledger.recordSweep(receipt)
      await ports.sweeper.confirmRecorded(receipt.sweepId)
      ctx.emit({ name: 'sweep_completed', scope: ctx.scope, detail: { sweep_id: receipt.sweepId } })

      const shortfall = plan.claimMinor - receipt.claimedMinor
      const facts: Record<string, string | number | boolean> = {
        sweep_id: receipt.sweepId,
        asset,
        expected_minor: plan.claimMinor.toString(10),
        claimed_minor: receipt.claimedMinor.toString(10),
        chunks: receipt.chunks,
        deferred_minor: plan.deferredMinor.toString(10),
        block_hash: receipt.blockHash,
      }

      if (shortfall > 0n && exceedsTolerance(shortfall, plan.claimMinor, SWEEP.shortfallToleranceBps)) {
        // Not a job failure - the money that arrived did arrive - but the ledger
        // must learn about the gap now rather than at the next reconciliation.
        await ports.alerts.raise({
          alertId: 'sweep_shortfall',
          severity: 'ticket',
          scope: ctx.scope,
          summary: 'Escrow claim landed short of the credited amount',
          runbook: 'ops/runbooks/stranded-escrow-balance.md',
          facts,
          raisedAtUnix: ctx.nowUnix,
        })
        ctx.log.warn('escrow.sweep.shortfall', facts)
      }

      return { ok: true, code: 'swept', facts }
    },
  }
}

async function guardSweepable(
  ports: OpsPorts,
  vault: Address,
  asset: AssetAddress,
  log: Logger,
): Promise<JobOutcome | undefined> {
  const ref = await ports.vaults.get(vault)
  if (!ref) {
    return { ok: false, code: 'unknown_vault' }
  }
  if (!(MONEY_JOB_STATES as readonly string[]).includes(ref.state)) {
    log.info('escrow.sweep.vault_not_active', { vault, state: ref.state })
    return { ok: true, code: 'vault_not_active', facts: { state: ref.state } }
  }
  const assetInfo = await ports.assets.get(asset)
  if (!assetInfo) {
    // An asset we have no record of is an asset we will not claim. Fail closed.
    return { ok: false, code: 'unknown_asset' }
  }
  if (!assetInfo.enabled) {
    // The per-asset kill switch. Flipping it must stop claims without a deploy,
    // and a disabled asset is a deliberate no-op, not a retry.
    log.warn('escrow.sweep.asset_disabled', { asset, symbol: assetInfo.symbol })
    return { ok: true, code: 'asset_disabled', facts: { asset } }
  }
  return undefined
}

export interface ChunkPlan {
  /** What this run will attempt. */
  claimMinor: bigint
  /** What is intentionally left for a later run because of the chunk cap. */
  deferredMinor: bigint
  chunks: number
}

/**
 * Split a claim into per-transfer-capped chunks, bounded by maxChunksPerRun.
 *
 * Integer arithmetic only. The remainder stays in escrow rather than being
 * rounded away: escrow dust is recoverable, a rounding error is not.
 */
export function planChunks(totalMinor: bigint, capMinor: bigint | undefined, maxChunks: number): ChunkPlan {
  if (totalMinor <= 0n) return { claimMinor: 0n, deferredMinor: 0n, chunks: 0 }
  if (capMinor === undefined || capMinor <= 0n) {
    return { claimMinor: totalMinor, deferredMinor: 0n, chunks: 1 }
  }
  const maxThisRun = capMinor * BigInt(maxChunks)
  if (totalMinor <= maxThisRun) {
    const chunks = Number((totalMinor + capMinor - 1n) / capMinor)
    return { claimMinor: totalMinor, deferredMinor: 0n, chunks }
  }
  return { claimMinor: maxThisRun, deferredMinor: totalMinor - maxThisRun, chunks: maxChunks }
}

/** deltaMinor/expectedMinor > toleranceBps, in integers. */
export function exceedsTolerance(deltaMinor: bigint, expectedMinor: bigint, toleranceBps: number): boolean {
  if (expectedMinor <= 0n) return deltaMinor > 0n
  return deltaMinor * 10_000n > expectedMinor * BigInt(toleranceBps)
}

/** Exported for the monitoring plane, which alerts when a sweep has not run in this long. */
export const SWEEP_STALL_SECONDS = 26 * HOUR

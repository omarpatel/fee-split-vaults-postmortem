/**
 * VAULT HEARTBEAT - keep the dead-man switch from firing on a quiet fleet.
 *
 * CoinVault lets ANYONE call emergencyDevRelease after DEAD_MAN
 * (TERMS.deadManDays) of operator silence, moving the vault to PASSTHROUGH
 * for good. Every operator transaction resets the clock, so a busy vault
 * never needs this job. A vault that has nothing to claim, nothing to settle
 * and nothing to buy for months is exactly the one this job exists for: the
 * design requires the operator to be seen on chain, and heartbeat() is the
 * no-op operator transaction that does it.
 *
 * READ FROM THE CHAIN, NOT FROM OUR RECORDS. The clock is
 * lastOperatorActionUnix on the vault. A local "we sent something on Tuesday"
 * would be wrong the first time a broadcast never landed.
 *
 * NOT A REFLEX. A heartbeat is sent only when silence has reached
 * DEAD_MAN / HEARTBEAT.silenceFractionOfDeadMan; one gas-paying transaction
 * per vault every ~45 days, not one per evaluation.
 */

import { TERMS } from '../../lib/protocol.js'
import { DAY } from '../../lib/time.js'
import { HEARTBEAT, OBSERVED_STATES } from '../config.js'
import type { OpsPorts } from '../ports.js'
import { staggeredIntervalDue } from '../triggers.js'
import type { DueScopeInput, JobContext, JobDefinition, JobOutcome, ScheduledRun } from '../types.js'

/** Seconds of operator silence after which a heartbeat is sent. */
export const HEARTBEAT_AFTER_SECONDS = Math.floor((TERMS.deadManDays * DAY) / HEARTBEAT.silenceFractionOfDeadMan)

/** Pure: is a vault with this much silence due a heartbeat. */
export function heartbeatDue(nowUnix: number, lastOperatorActionUnix: number): boolean {
  return nowUnix - lastOperatorActionUnix >= HEARTBEAT_AFTER_SECONDS
}

export function vaultHeartbeatJob(ports: OpsPorts): JobDefinition {
  return {
    id: 'vault.heartbeat',
    description: 'Sends CoinVault.heartbeat() to a vault the operator has not touched for a quarter of the dead-man window.',
    triggers: [{ kind: 'interval', everySeconds: HEARTBEAT.evaluateEverySeconds }],
    maxAttempts: 3,
    leaseSeconds: 5 * 60,
    timeoutSeconds: 240,
    retryBaseSeconds: 120,
    movesMoney: false,

    async dueScopes(input: DueScopeInput): Promise<ScheduledRun[]> {
      const vaults = await ports.vaults.listByState(OBSERVED_STATES)
      const out: ScheduledRun[] = []
      for (const vault of vaults) {
        const last = await input.lastSuccessUnix(vault.address)
        const due = staggeredIntervalDue(input.nowUnix, vault.address, last, HEARTBEAT.evaluateEverySeconds)
        if (!due.due) continue
        out.push({
          jobId: 'vault.heartbeat',
          scope: vault.address,
          period: due.period,
          reason: { kind: 'interval', sinceLastSeconds: due.sinceLastSeconds },
        })
      }
      return out
    },

    async run(ctx: JobContext): Promise<JobOutcome> {
      const vault = await ports.vaults.get(ctx.scope)
      if (!vault) return { ok: false, code: 'unknown_vault' }
      if (!(OBSERVED_STATES as readonly string[]).includes(vault.state)) {
        // A terminal vault has no meter for the dead-man switch to stop.
        return { ok: true, code: 'vault_not_live', facts: { state: vault.state } }
      }

      const lastOperatorActionUnix = await ports.heartbeat.lastOperatorActionUnix(vault.address)
      const silenceSeconds = ctx.nowUnix - lastOperatorActionUnix
      const facts: Record<string, string | number | boolean> = {
        last_operator_action_unix: lastOperatorActionUnix,
        silence_seconds: silenceSeconds,
        heartbeat_after_seconds: HEARTBEAT_AFTER_SECONDS,
      }
      if (!heartbeatDue(ctx.nowUnix, lastOperatorActionUnix)) {
        return { ok: true, code: 'not_due', facts }
      }

      const sent = await ports.heartbeat.heartbeat(vault.address)
      ctx.log.info('vault.heartbeat.sent', { vault: vault.address, tx_hash: sent.txHash, ...facts })
      return { ok: true, code: 'heartbeat_sent', facts: { ...facts, tx_hash: sent.txHash, block_hash: sent.blockHash } }
    },
  }
}

/**
 * THE FLEET TICK. This is the job that makes the agent teams actually run.
 *
 * Every member coin has its own team - indexer, reader, planner, desk, broker,
 * publisher - and until this job existed the whole of it was a library with
 * tests. One scope per coin, one lease per coin, one dead letter per coin.
 *
 * WHY ONE SCOPE PER COIN AND NOT ONE 'fleet' SCOPE.
 *
 *   ISOLATION SURVIVES FAILURE. A fleet-wide scope would put every coin behind
 *   one lease and one attempt counter: one coin's chain read stalls and the
 *   lease expires for all of them; one coin's ledger write throws and the whole
 *   book dead-letters. Per-coin scoping is the same argument the runtime makes
 *   in memory, made durable.
 *   THE CADENCE IS THE COIN'S. CoinTicker.tick() computes its own nextDueUnix
 *   from the vault's age, its sweep interval and its window boundaries. This
 *   job honours that number rather than imposing a fleet-wide interval, so a
 *   young coin polling every few minutes and a mature one polling hourly are
 *   the same job with different data.
 *
 * WHY movesMoney IS TRUE. A tick can reach the spend path, and the spend path
 * can authorize a reimbursement pull against the client's budget leg. That is
 * money, so a critical ledger variance freeze must stop this job dead - and it
 * does, because the scheduler blocks money-moving jobs under a freeze. It also
 * means the retry budget is one attempt: see below.
 *
 * WHY maxAttempts IS 1. Retrying a tick that already claimed is how you claim
 * twice. The runner is idempotent per run key and the re-entry check below is
 * belt to that braces, but the cheapest correct posture is not to retry at all:
 * a failed tick dead-letters with its context, and the NEXT window is a fresh
 * run key that will pick the coin up anyway. A missed window costs one window.
 * A duplicated disbursement costs a client's money.
 *
 * WHAT THIS JOB DOES NOT DO. It does not decide anything about the coin. It
 * does not read a message, a digest, a proposal or a post body - the summary it
 * gets back is counts and machine codes. Every decision is in the tick, behind
 * the port, where it is unit-tested against real packages rather than against
 * this dispatcher.
 */

import { FLEET, MONEY_JOB_STATES } from '../config.js'
import type { FleetTickSummary, OpsPorts } from '../ports.js'
import { staggeredIntervalDue } from '../triggers.js'
import type { DueScopeInput, JobContext, JobDefinition, JobOutcome, ScheduledRun } from '../types.js'

/**
 * Flatten a summary into the fact bag the run log and any dead letter carry.
 *
 * Every value here is a count, a machine code or a closed-vocabulary string.
 * There is no path by which a holder's message, a model's prose or a vendor's
 * response text reaches a dead letter that a human will read in a terminal.
 */
export function summaryFacts(summary: FleetTickSummary): Record<string, string | number | boolean> {
  const facts: Record<string, string | number | boolean> = {
    coin_ref: summary.coinRef,
    vault: summary.vault,
    tier: summary.tier,
    replayed: summary.replayed,
    ran_chain_poll: summary.ranChainPoll,
    ran_cognition: summary.ranCognition,
    proposals: summary.proposals,
    suppressed: summary.suppressed,
    refusals: summary.refusals.length,
    disbursed: summary.disbursed,
    spends_refused: summary.spendsRefused,
    published: summary.published,
    publish_rejected: summary.publishRejected,
    inference_micro_usd: summary.inferenceMicroUsd,
    degrade_level: summary.degradeLevel,
    // Carried on every run, not only on fake ones. A field that is present when
    // something is wrong and absent otherwise trains people to skim past it.
    model_provenance: summary.modelProvenance,
    next_due_unix: summary.nextDueUnix,
  }
  if (summary.windowId !== undefined) facts.window_id = summary.windowId
  // Absent means NOT MEASURED. It is left out rather than written as 0, which
  // would read as "a window with no messages in it" - a different fact.
  if (summary.admittedMessages !== undefined) facts.admitted_messages = summary.admittedMessages
  if (summary.refusals.length > 0) facts.refusal_codes = summary.refusals.join(' ')
  return facts
}

export function fleetTickJob(ports: OpsPorts): JobDefinition {
  return {
    id: 'fleet.tick',
    description: 'Runs one coin’s agent team for one window: indexer, reader, planner, broker, publisher.',
    triggers: [{ kind: 'interval', everySeconds: FLEET.evaluateEverySeconds }],
    // One attempt. See the header: a retried tick is a repeated claim.
    maxAttempts: 1,
    leaseSeconds: FLEET.tickTimeoutSeconds * 2,
    timeoutSeconds: FLEET.tickTimeoutSeconds,
    retryBaseSeconds: FLEET.evaluateEverySeconds,
    movesMoney: true,

    async dueScopes(input: DueScopeInput): Promise<ScheduledRun[]> {
      const coins = await ports.fleet.dueCoins(input.nowUnix)
      const out: ScheduledRun[] = []
      for (const coin of coins) {
        const last = await input.lastSuccessUnix(coin.coinRef)
        // The grid is staggered by coinRef so four hundred coins do not all
        // become due on the same second and arrive at the RPC quorum as one
        // spike. The offset is a hash of the ref, so it is stable across
        // restarts: a coin does not migrate around the hour.
        const due = staggeredIntervalDue(input.nowUnix, coin.coinRef, last, FLEET.evaluateEverySeconds)
        if (!due.due) continue
        // The coin's own cadence wins over the grid. A coin that has already
        // ticked this window says so, and waking it again would spend a model
        // call to be told the window has not closed yet.
        if (last !== undefined && input.nowUnix < coin.nextDueUnix) continue
        out.push({
          jobId: 'fleet.tick',
          scope: coin.coinRef,
          period: due.period,
          reason: { kind: 'interval', sinceLastSeconds: due.sinceLastSeconds },
        })
      }
      return out
    },

    async run(ctx: JobContext): Promise<JobOutcome> {
      // RE-ENTRY FIRST. If this run key already ticked, the work is done and
      // repeating it would re-run a phase that can authorize money. The stored
      // summary is the answer, not a reason to do it again.
      const prior = await ports.fleet.findByRunKey(ctx.runKey)
      if (prior !== undefined) {
        return { ok: true, code: 'already_ticked', facts: summaryFacts(prior) }
      }

      const summary = await ports.fleet.tick({
        coinRef: ctx.scope,
        nowUnix: ctx.nowUnix,
        runKey: ctx.runKey,
      })
      const facts = summaryFacts(summary)

      // A tick that refused every phase is a SUCCESSFUL run of a fail-closed
      // system: the refusals are recorded, the coin is scheduled again, and
      // nothing about it is a job failure. The one thing worth distinguishing
      // is a tick that reached no phase at all, because that is a coin whose
      // configuration is wrong rather than a coin having a quiet window.
      if (!summary.ranChainPoll && !summary.ranCognition && summary.refusals.length > 0) {
        return { ok: true, code: 'refused', facts }
      }
      return { ok: true, code: summary.ranCognition ? 'ticked' : 'ticked_no_cognition', facts }
    },
  }
}

/**
 * The vault states a coin must be in for its team to run.
 *
 * Exported so the runner outside ops can filter its directory by the same list
 * the money-moving jobs use, rather than inventing a second opinion about which
 * coins are live.
 */
export const FLEET_TICK_STATES = MONEY_JOB_STATES

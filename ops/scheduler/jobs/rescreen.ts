/**
 * CONTINUOUS RE-SCREENING ON METADATA CHANGE.
 *
 * A coin is screened at onboarding. Nothing stops a dev from changing the name,
 * the symbol, or the image afterwards, and "clean at signup, infringing by
 * Thursday" is the obvious way to launder a paid promotion through us. So the
 * screen is not an event at onboarding; it is a standing obligation.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE HERE.
 *
 *   A VERDICT NEVER IMPROVES ON ITS OWN. Screening stages union their flags and
 *   no stage may clear a prior stage's hit; the same applies across time. A
 *   re-screen that comes back CLEAR on a token that was BLOCKED does not unblock
 *   it - it records the new result and leaves the enforcement in place, because
 *   the cheapest attack on a sticky block is to change the metadata back.
 *   Un-blocking is a human decision, out of band.
 *
 *   OPS NEVER READS THE METADATA. A change carries an opaque metadataRef and a
 *   content hash. Only the screening package dereferences the ref. Token
 *   metadata is attacker-authored text and this job runs next to things that
 *   suspend accounts.
 *
 * Event-driven, with a 30-minute sweep as the safety net for a dropped event.
 */

import type { ScreeningResult, ScreeningVerdict } from '@fee-split-vaults/core'
import { RESCREENING } from '../config.js'
import type { MetadataChange, OpsPorts } from '../ports.js'
import { intervalDue } from '../triggers.js'
import { FLEET_SCOPE } from './scope.js'
import type { DueScopeInput, JobContext, JobDefinition, JobOutcome, ScheduledRun } from '../types.js'

const VERDICT_SEVERITY: Record<ScreeningVerdict, number> = {
  CLEAR: 0,
  RESTRICTED: 1,
  BLOCKED: 2,
}

/** The worse of two verdicts. Monotonic: enforcement only ever tightens here. */
export function worstVerdict(a: ScreeningVerdict, b: ScreeningVerdict): ScreeningVerdict {
  return VERDICT_SEVERITY[a] >= VERDICT_SEVERITY[b] ? a : b
}

export function verdictWorsened(previous: ScreeningVerdict | undefined, next: ScreeningVerdict): boolean {
  if (previous === undefined) return next !== 'CLEAR'
  return VERDICT_SEVERITY[next] > VERDICT_SEVERITY[previous]
}

export function rescreenJob(ports: OpsPorts): JobDefinition {
  return {
    id: 'screening.rescreen',
    description: 'Re-screens a coin whenever its on-chain metadata changes, and tightens enforcement on a worse verdict.',
    triggers: [
      { kind: 'event', event: 'token_metadata_changed' },
      { kind: 'interval', everySeconds: RESCREENING.sweepEverySeconds },
    ],
    maxAttempts: 4,
    leaseSeconds: 900,
    timeoutSeconds: 600,
    retryBaseSeconds: 60,
    movesMoney: false,

    async dueScopes(input: DueScopeInput): Promise<ScheduledRun[]> {
      const last = await input.lastSuccessUnix(FLEET_SCOPE)
      const due = intervalDue(input.nowUnix, last, RESCREENING.sweepEverySeconds)
      if (!due.due && input.events.length === 0) return []
      return [
        {
          jobId: 'screening.rescreen',
          scope: FLEET_SCOPE,
          period: input.events.length > 0 ? `e${Math.floor(input.nowUnix / 60)}` : due.period,
          reason:
            input.events.length > 0
              ? { kind: 'event', event: 'token_metadata_changed' }
              : { kind: 'interval', sinceLastSeconds: due.sinceLastSeconds },
        },
      ]
    },

    async run(ctx: JobContext): Promise<JobOutcome> {
      const cursor = await ports.metadata.cursor()
      const changes = await ports.metadata.changedSince(cursor, RESCREENING.batchSize)
      if (changes.length === 0) return { ok: true, code: 'no_changes', facts: { cursor } }

      let screened = 0
      let unchanged = 0
      let worsened = 0
      let highWater = cursor

      for (const change of changes) {
        highWater = Math.max(highWater, change.observedAtUnix)

        const previous = await ports.screening.lastResult(change.token)
        if (previous && previousHashMatches(previous, change)) {
          unchanged += 1
          continue
        }

        const fresh = await ports.screening.rescreen({
          token: change.token,
          vault: change.vault,
          metadataRef: change.metadataRef,
        })
        screened += 1

        const effective = previous ? worstVerdict(previous.verdict, fresh.verdict) : fresh.verdict
        const flags = previous ? [...new Set([...previous.flags, ...fresh.flags])] : fresh.flags
        const recorded: ScreeningResult & { metadataHash: string } = {
          ...fresh,
          verdict: effective,
          flags,
          paidMediaPermitted: fresh.paidMediaPermitted && effective !== 'BLOCKED' && effective !== 'RESTRICTED',
          metadataHash: change.metadataHash,
        }
        await ports.screening.record(recorded)

        if (previous && VERDICT_SEVERITY[fresh.verdict] < VERDICT_SEVERITY[previous.verdict]) {
          // Recorded, not acted on. A re-screen cannot lift enforcement.
          ctx.log.warn('screening.rescreen.verdict_improved_but_sticky', {
            token: change.token,
            previous: previous.verdict,
            fresh: fresh.verdict,
            effective,
          })
        }

        if (!verdictWorsened(previous?.verdict, effective)) continue
        worsened += 1
        await enforce(ports, ctx, change, effective, flags)
      }

      if (highWater > cursor) await ports.metadata.advanceCursor(highWater)

      return {
        ok: true,
        code: worsened === 0 ? 'rescreened' : 'enforcement_tightened',
        facts: { changes: changes.length, screened, unchanged, worsened, cursor_to: highWater },
      }
    },
  }
}

function previousHashMatches(previous: ScreeningResult, change: MetadataChange): boolean {
  // The store records the hash alongside the result; the shared type does not
  // carry it, so it is read defensively rather than assumed present.
  const recorded = (previous as ScreeningResult & { metadataHash?: string }).metadataHash
  return recorded !== undefined && recorded === change.metadataHash
}

async function enforce(
  ports: OpsPorts,
  ctx: JobContext,
  change: MetadataChange,
  verdict: ScreeningVerdict,
  flags: string[],
): Promise<void> {
  const facts: Record<string, string | number | boolean> = {
    token: change.token,
    vault: change.vault,
    verdict,
    flags: flags.join(','),
    changed_fields: change.changedFields.join(','),
    metadata_hash: change.metadataHash,
    block_hash: change.blockHash,
  }

  if (verdict === 'BLOCKED') {
    await ports.enforcement.suspendVault({ vault: change.vault, reason: `screening BLOCKED: ${flags.join(',')}` })
    await ports.enforcement.escalateToHuman({
      vault: change.vault,
      reason: `metadata change produced a BLOCKED verdict`,
      severity: 'critical',
    })
    await ports.alerts.raise({
      alertId: 'screening_blocked_after_metadata_change',
      severity: 'page',
      scope: change.vault,
      summary: 'A live client changed its metadata into a BLOCKED screening verdict',
      runbook: 'ops/runbooks/client-rug-post-activation.md',
      facts,
      raisedAtUnix: ctx.nowUnix,
    })
    ctx.log.error('screening.rescreen.blocked', facts)
    return
  }

  await ports.enforcement.suspendPaidMedia({
    vault: change.vault,
    reason: `screening RESTRICTED: ${flags.join(',')}`,
  })
  await ports.alerts.raise({
    alertId: 'screening_restricted_after_metadata_change',
    severity: 'ticket',
    scope: change.vault,
    summary: 'A live client changed its metadata into a RESTRICTED screening verdict',
    runbook: 'ops/runbooks/client-rug-post-activation.md',
    facts,
    raisedAtUnix: ctx.nowUnix,
  })
  ctx.log.warn('screening.rescreen.restricted', facts)
}

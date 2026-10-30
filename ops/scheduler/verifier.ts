/**
 * The real PredicateVerifier: the broker's registry behind the ops port.
 *
 * The broker owns the verifiers (packages/broker/src/predicates.ts) and the
 * evidence source they read; ops owns the schedule. This adapter is the seam:
 * it rebuilds the broker's DeliveryRecord from a queued row - every field of
 * which was written by operator code from operator observation, none of it
 * from a model or a vendor - and asks the registry for a verdict at the row's
 * offset.
 *
 * FAILS CLOSED TWICE. The registry already converts a throwing verifier into
 * `passed: false`; this adapter does the same for anything that escapes the
 * registry itself (an unknown predicate kind is a BrokerError, not a verdict),
 * because the port's contract is that a non-delivery is never signalled by a
 * throw. A malformed check is a check that failed, with the reason in `note`.
 */

import type { PredicateResult } from '@fee-split-vaults/core'
import type { DeliveryRecord, PredicateRegistry } from '@fee-split-vaults/broker'
import type { Clock } from '../lib/time.js'
import type { DuePredicateCheck, PredicateVerifier } from './ports.js'

export class BrokerPredicateVerifier implements PredicateVerifier {
  constructor(
    private readonly registry: PredicateRegistry,
    private readonly clock: Clock,
  ) {}

  async verify(check: DuePredicateCheck): Promise<PredicateResult> {
    const delivery: DeliveryRecord = {
      disbursementId: check.disbursementId,
      vault: check.vault,
      token: check.token,
      fundedAtUnix: check.fundedAtUnix,
    }
    if (check.baseline !== undefined) delivery.baseline = check.baseline
    // checkedAtUnix is when the evidence was actually read, not when the
    // check fell due: a queue drained late records that it was drained late.
    const nowUnix = this.clock.nowUnix()
    try {
      return await this.registry.verify({ spec: check.spec, delivery, offsetSeconds: check.offsetSeconds, nowUnix })
    } catch (cause) {
      return {
        checkedAtUnix: nowUnix,
        offsetSeconds: check.offsetSeconds,
        passed: false,
        note: `verifier refused: ${String(cause)}`,
      }
    }
  }
}

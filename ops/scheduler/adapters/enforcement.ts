/**
 * What a worsening screening verdict does, for real.
 *
 * suspendVault IS THE ON-CHAIN suspend(). ACTIVE -> SUSPENDED: charging stops,
 * procurement stops, and it is reversible - resume() is one operator call
 * away once a human has decided. A vault already SUSPENDED is left as it is.
 * A vault in any other state has no meter to stop, and the contract would
 * revert BadState; that is reported as `not_possible_on_chain` rather than
 * as a suspension that happened. poison() - irreversible, operator leg
 * frozen - is deliberately NOT what a job does on its own; un-blocking is a
 * human decision and so is the kill.
 *
 * suspendPaidMedia HAS NO ON-CHAIN FORM, and this file does not pretend it
 * does. The switch the tick loop reads is screening_result.paid_media_permitted
 * (PgScreeningStore is its only writer; the re-screen job records the
 * RESTRICTED verdict before calling this). So the action here is to VERIFY
 * that the switch is off - the vault's token is read from the chain, the
 * token's latest verdict from the store - and to refuse
 * `paid_media_not_recorded` when it is not. A port that returned quietly
 * while paid media stayed permitted would be a silent success.
 *
 * escalateToHuman raises the catalogued alert for the verdict class. The
 * alert sink is the thing a human is paged by; nothing else here is.
 */

import type { Address, ScreeningResult } from '@fee-split-vaults/core'
import { VaultOpError, type VaultOperatorClient, type VaultReadClient } from '@fee-split-vaults/adapters'
import type { Clock } from '../../lib/time.js'
import type { AlertSink, EnforcementActions } from '../ports.js'
import { OpsAdapterError } from './errors.js'

export interface ChainEnforcementActionsDeps {
  operator: VaultOperatorClient
  reads: VaultReadClient
  screening: { latest(token: Address): Promise<ScreeningResult | undefined> }
  alerts: AlertSink
  clock: Clock
}

export class ChainEnforcementActions implements EnforcementActions {
  constructor(private readonly deps: ChainEnforcementActionsDeps) {}

  async suspendPaidMedia(input: { vault: Address; reason: string }): Promise<void> {
    const token = await this.deps.reads.token(input.vault)
    const latest = await this.deps.screening.latest(token)
    if (latest === undefined || latest.paidMediaPermitted) {
      throw new OpsAdapterError(
        'paid_media_not_recorded',
        `${input.vault} (${token}): screening_result ${latest === undefined ? 'is absent' : 'still permits paid media'}; ` +
          `record the verdict before suspending (${input.reason})`,
      )
    }
  }

  async suspendVault(input: { vault: Address; reason: string }): Promise<void> {
    const state = await this.deps.reads.state(input.vault)
    if (state === 'SUSPENDED') return
    if (state !== 'ACTIVE') {
      throw new OpsAdapterError(
        'not_possible_on_chain',
        `${input.vault} is ${state}; suspend() is only defined from ACTIVE (${input.reason})`,
      )
    }
    try {
      await this.deps.operator.suspend(input.vault)
    } catch (error) {
      // The state moved under us between the read and the simulation. A vault
      // that is now SUSPENDED is what was asked for; anything else is refused.
      if (error instanceof VaultOpError && error.code === 'bad_state' && error.currentState === 'SUSPENDED') return
      throw error
    }
  }

  async escalateToHuman(input: { vault: Address; reason: string; severity: 'high' | 'critical' }): Promise<void> {
    const critical = input.severity === 'critical'
    await this.deps.alerts.raise({
      alertId: critical ? 'screening_blocked_after_metadata_change' : 'screening_restricted_after_metadata_change',
      severity: critical ? 'page' : 'ticket',
      scope: input.vault,
      summary: `Human escalation for ${input.vault}: ${input.reason}`,
      runbook: 'ops/runbooks/client-rug-post-activation.md',
      facts: { vault: input.vault, reason: input.reason, severity: input.severity },
      raisedAtUnix: this.deps.clock.nowUnix(),
    })
  }
}

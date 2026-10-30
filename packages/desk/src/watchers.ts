/**
 * Sheet watchers: the things a human has to be told about even though nobody
 * asked a question.
 *
 * The fee-recipient watcher is the important one. The Venue owner holds a
 * 3-day-timelocked override that can reassign any coin's fee recipient, and
 * transferCreatorFeeRecipient is self-service by the CURRENT recipient with no
 * timelock at all. Either event silently redirects every future creator fee.
 * Three days of notice is only useful if somebody is looking, so a proposal
 * becomes a critical escalation the moment it appears on the sheet.
 *
 * The staleness watcher covers the other silent failure: a desk that keeps
 * answering /help while every fact has quietly aged out is a desk that looks
 * healthy and knows nothing.
 */

import { lookupFact, type FactSheet } from './factsheet/builder.js'
import { formatDuration, formatUnixTime } from './factsheet/render.js'
import type { EscalationItem, InMemoryEscalationQueue } from './moderation/escalation.js'

/** The Venue owner's override delay. Notice is worthless if nobody watches it. */
export const FEE_RECIPIENT_TIMELOCK_SECONDS = 3 * 86_400

export interface SheetWatchOptions {
  /** Age at which a sheet with no successful refresh becomes an escalation. */
  staleSheetSeconds?: number
  /** The recipient the operator expects. A mismatch is an escalation on its own. */
  expectedFeeRecipient?: string
}

/**
 * Run every watcher over a sheet. Idempotent by construction: the queue merges
 * identical drafts, so calling this on every refresh produces one item, not one
 * per tick.
 */
export function raiseSheetAlerts(
  sheet: FactSheet,
  queue: InMemoryEscalationQueue,
  nowUnix: number,
  options: SheetWatchOptions = {},
): EscalationItem[] {
  const raised: EscalationItem[] = []

  const proposed = lookupFact(sheet, 'fee_recipient_change_proposed_unix', nowUnix)
  if (proposed.status === 'fresh' && proposed.fact.value.kind === 'unix_time') {
    const effectiveAt = proposed.fact.value.unix + FEE_RECIPIENT_TIMELOCK_SECONDS
    const remaining = Math.max(0, effectiveAt - nowUnix)
    raised.push(
      queue.enqueue(
        {
          vault: sheet.vault,
          reason: 'fee_recipient_change_proposed',
          summary: [
            'A creator fee recipient change has been PROPOSED for this token.',
            `Proposed at ${formatUnixTime(proposed.fact.value.unix)}; it can take effect in ${formatDuration(remaining)}.`,
            'Every future creator fee follows the recipient. Confirm this was the dev, and sweep and claim to zero before any transfer of recipiency - credited balances stay stranded under the old recipient.',
          ].join(' '),
          priority: 'critical',
        },
        nowUnix,
      ),
    )
  }

  const recipient = lookupFact(sheet, 'fee_recipient', nowUnix)
  if (
    options.expectedFeeRecipient &&
    recipient.status === 'fresh' &&
    recipient.fact.value.kind === 'address' &&
    recipient.fact.value.address.toLowerCase() !== options.expectedFeeRecipient.toLowerCase()
  ) {
    raised.push(
      queue.enqueue(
        {
          vault: sheet.vault,
          reason: 'fee_recipient_change_proposed',
          summary:
            'The on-chain creator fee recipient is not the address this desk was configured with. Fees are already going somewhere else. Stop and verify before answering anything about fees.',
          priority: 'critical',
        },
        nowUnix,
      ),
    )
  }

  const staleAfter = options.staleSheetSeconds ?? 1_800
  if (nowUnix - sheet.builtAtUnix > staleAfter) {
    raised.push(
      queue.enqueue(
        {
          vault: sheet.vault,
          reason: 'factsheet_unavailable',
          summary: `No successful FactSheet refresh for ${formatDuration(nowUnix - sheet.builtAtUnix)}. Fields are ageing out one by one and the desk is answering less every minute.`,
        },
        nowUnix,
      ),
    )
  }

  return raised
}

/**
 * Stage 4: human review, at the PAID MEDIA gate only.
 *
 * WHY THE QUEUE IS SMALL - the arithmetic, asserted by
 * `estimateDailyReviewHours` and by stage4.spec.ts rather than asserted here in
 * prose:
 *
 *   The fee gate filters first. Paid media is a T1+ facility (TIERS.T1 in
 *   config/protocol is the authority for these numbers; they are quoted here to
 *   show the derivation, not to be a second source of truth). T1 needs a
 *   trailing-7-day median of TIERS.T1.gateQfPerDay of quote-denominated
 *   creator fees - 1,000 USD/day since the September reprice, up from 250 -
 *   sustained TIERS.T1.sustainedDays consecutive days. Run that through
 *   volumeForQf(): at the buyback-off creator net it is roughly 143,000 USD/day
 *   of Venue-pool volume, and with buyback enabled about twice that, every day
 *   for a week. Very few coins clear that, and the ones that do are a book
 *   measured in tens, not thousands. The gate has moved once and will move
 *   again; the figures here are a derivation, and estimateDailyReviewHours
 *   reads the gate rather than these words.
 *
 *   Take a mature book of 40 paid-media clients. Each submits ~1.5 creatives a
 *   day: 60 items. Stages 1-3 have already resolved most of them, so ~10% carry
 *   a flag needing judgement.
 *
 *     54 clean items  x 45 s  = 40.5 min
 *      6 flagged items x 4 min = 24.0 min
 *                              = 64.5 min  ~= 1.08 person-hours/day
 *
 *   The load is linear in the size of the PAID book, not in launches, mentions,
 *   or messages. If this estimate ever exceeds a shift, the fee gate has been
 *   loosened or the book has grown past one reviewer - both are decisions, not
 *   surprises, and `estimateDailyReviewHours` is what surfaces them.
 *
 * A REVIEWER CANNOT CLEAR A FLAG. Approval authorises paid media for one
 * creative; it never deletes a flag and it can never override a block-severity
 * flag - `decide` refuses that outright.
 */

import type { Flag } from './flags.js'
import { ScreeningFailClosed, makeFlag, mergeFlags, assertMonotonic } from './flags.js'
import {
  finalizeReport,
  type HumanDecision,
  type HumanReviewRecord,
  type ScreeningReport,
} from './types.js'

export interface ReviewThroughputModel {
  /** Clients at a tier that permits paid media at all. */
  activePaidMediaClients: number
  itemsPerClientPerDay: number
  /** Share of items arriving with a flag that needs judgement. */
  flaggedShare: number
  cleanReviewSeconds: number
  flaggedReviewSeconds: number
}

export const DEFAULT_THROUGHPUT_MODEL: ReviewThroughputModel = {
  activePaidMediaClients: 40,
  itemsPerClientPerDay: 1.5,
  flaggedShare: 0.1,
  cleanReviewSeconds: 45,
  flaggedReviewSeconds: 240,
}

/** Person-hours per day of stage-4 review implied by a book of this shape. */
export function estimateDailyReviewHours(
  model: ReviewThroughputModel = DEFAULT_THROUGHPUT_MODEL,
): number {
  if (model.flaggedShare < 0 || model.flaggedShare > 1) {
    throw new ScreeningFailClosed('flaggedShare must be a share between 0 and 1')
  }
  const items = model.activePaidMediaClients * model.itemsPerClientPerDay
  const flagged = items * model.flaggedShare
  const clean = items - flagged
  const seconds = clean * model.cleanReviewSeconds + flagged * model.flaggedReviewSeconds
  return seconds / 3600
}

export interface PaidMediaReviewItem {
  id: string
  vault: string
  token: string
  /** Hash of the exact creative this approval would cover. */
  creativeHash: string
  submittedAtUnix: number
  report: ScreeningReport
  claimedBy?: string
  claimedAtUnix?: number
  decision?: HumanReviewRecord
}

/**
 * FIFO with a flagged-first priority, in memory. A durable implementation
 * swaps the store; the decision rules below are the part that must not change.
 */
export class PaidMediaReviewQueue {
  private readonly items = new Map<string, PaidMediaReviewItem>()
  private readonly order: string[] = []

  /**
   * Call ONLY at the paid-media gate. Screening for organic operations never
   * enqueues, which is what keeps the queue proportional to the paid book.
   */
  enqueue(item: PaidMediaReviewItem): void {
    if (this.items.has(item.id)) return
    if (item.report.verdict === 'BLOCKED') {
      throw new ScreeningFailClosed(
        'a BLOCKED subject is never queued for review; it is declined',
        item.token,
      )
    }
    this.items.set(item.id, item)
    if (item.report.flags.length > 0) this.order.unshift(item.id)
    else this.order.push(item.id)
  }

  pending(): number {
    return this.order.length
  }

  peek(): PaidMediaReviewItem | undefined {
    const id = this.order[0]
    return id === undefined ? undefined : this.items.get(id)
  }

  claim(reviewerId: string, nowUnix: number): PaidMediaReviewItem | undefined {
    const id = this.order.shift()
    if (id === undefined) return undefined
    const item = this.items.get(id)
    if (item === undefined) return undefined
    item.claimedBy = reviewerId
    item.claimedAtUnix = nowUnix
    return item
  }

  /**
   * Record a decision. Returns the updated report.
   *
   * approve  - authorises paid media for this creative. Refused outright if any
   *            block-severity flag exists: no reviewer may override a block.
   * reject   - adds a RESTRICTED flag. Organic operations continue.
   * escalate - adds a RESTRICTED flag and returns the item to the queue.
   */
  decide(id: string, record: HumanReviewRecord): ScreeningReport {
    const item = this.items.get(id)
    if (item === undefined) throw new ScreeningFailClosed(`no review item "${id}"`)
    if (item.decision !== undefined) {
      throw new ScreeningFailClosed(`review item "${id}" already decided`)
    }

    const before = item.report.flags
    let added: Flag[] = []

    switch (record.decision) {
      case 'approve': {
        if (before.some((f) => f.severity === 'block')) {
          throw new ScreeningFailClosed(
            'a reviewer cannot approve a subject carrying a block-severity flag',
            id,
          )
        }
        break
      }
      case 'reject':
        added = [makeFlag('human_rejected_paid_media', record.decidedAtUnix, { detail: record.note })]
        break
      case 'escalate':
        added = [makeFlag('human_escalated', record.decidedAtUnix, { detail: record.note })]
        break
      default:
        throw new ScreeningFailClosed(`unknown review decision "${String(record.decision)}"`)
    }

    const flags = mergeFlags(before, added)
    assertMonotonic(before, flags)

    const stagesRun = item.report.stagesRun.includes('human')
      ? item.report.stagesRun
      : [...item.report.stagesRun, 'human' as const]

    const updated = finalizeReport({
      id: item.report.id,
      subject: item.report.subject,
      flags,
      stagesRun,
      screenedAtUnix: item.report.screenedAtUnix,
      expiresAtUnix: item.report.expiresAtUnix,
      humanReview: record,
      ...(item.report.note === undefined ? {} : { note: item.report.note }),
    })

    item.report = updated
    item.decision = record
    if (record.decision === 'escalate') {
      item.decision = undefined
      this.order.unshift(id)
    }
    return updated
  }

  get(id: string): PaidMediaReviewItem | undefined {
    return this.items.get(id)
  }
}

/**
 * The gate itself. A creative may go to paid media only when the screening is
 * CLEAR, unexpired, AND a reviewer has approved this exact creative.
 */
export function assertPaidMediaApproved(
  item: PaidMediaReviewItem,
  nowUnix: number,
  decision: HumanDecision | undefined = item.decision?.decision,
): void {
  if (item.report.verdict !== 'CLEAR') {
    throw new ScreeningFailClosed(`verdict ${item.report.verdict} does not permit paid media`)
  }
  if (nowUnix > item.report.expiresAtUnix) {
    throw new ScreeningFailClosed('screening expired; re-screen before spending')
  }
  if (decision !== 'approve') {
    throw new ScreeningFailClosed('paid media requires a recorded human approval')
  }
}

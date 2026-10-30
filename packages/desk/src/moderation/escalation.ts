/**
 * Human escalation to the dev.
 *
 * Moderation that cannot escalate is moderation that eventually bans the wrong
 * person and nobody hears about it. The queue is the product surface for
 * everything the desk deliberately will not decide: a suspected impersonator
 * who might be a real team member, a fee-recipient change proposal ticking down
 * its three-day timelock, a holder insisting they were robbed by the anti-snipe
 * window.
 *
 * Evidence is DEFANGED before it reaches the dev. The dev needs to see the host
 * that was posted in order to blocklist it; nothing in the pipeline needs it to
 * remain a working link, and a notification channel that renders live drainer
 * URLs is a phishing delivery mechanism with an audit trail.
 */

import { createHash } from 'node:crypto'
import { scrubGist } from '@fee-split-vaults/core'
import type { Address } from '@fee-split-vaults/core'
import { renderOutbound, type DeskAnswer, type OutboundOptions } from '../answer.js'
import type { TelegramClient } from '../telegram/client.js'

export type EscalationReason =
  | 'drainer_link'
  | 'impersonation'
  | 'raid'
  | 'prompt_injection'
  | 'scam_wave'
  | 'unanswered_backlog'
  | 'fee_recipient_change_proposed'
  | 'antisnipe_ticket'
  | 'refusal_probe'
  | 'factsheet_unavailable'
  | 'human_required'

export type EscalationPriority = 'low' | 'normal' | 'high' | 'critical'

const DEFAULT_PRIORITY: Readonly<Record<EscalationReason, EscalationPriority>> = {
  drainer_link: 'high',
  impersonation: 'high',
  raid: 'high',
  prompt_injection: 'normal',
  scam_wave: 'critical',
  unanswered_backlog: 'low',
  fee_recipient_change_proposed: 'critical',
  antisnipe_ticket: 'normal',
  refusal_probe: 'low',
  factsheet_unavailable: 'high',
  human_required: 'normal',
}

/** Minutes within which a human is expected to have looked. */
const SLA_MINUTES: Readonly<Record<EscalationPriority, number>> = {
  critical: 15,
  high: 60,
  normal: 240,
  low: 1_440,
}

export interface EscalationDraft {
  vault: Address
  reason: EscalationReason
  /** Code-authored. Never a model's words and never raw user text. */
  summary: string
  /** Defanged evidence fragments. */
  evidence?: string[]
  chatId?: string
  messageId?: string
  authorId?: string
  priority?: EscalationPriority
}

export interface EscalationItem extends EscalationDraft {
  id: string
  priority: EscalationPriority
  createdAtUnix: number
  lastSeenUnix: number
  /** Repeat occurrences merged into one item. */
  count: number
  notifiedAtUnix?: number
  acknowledgedAtUnix?: number
  resolvedAtUnix?: number
}

export interface EscalationQueue {
  enqueue(draft: EscalationDraft, nowUnix: number): EscalationItem
  open(): EscalationItem[]
  acknowledge(id: string, atUnix: number): boolean
  resolve(id: string, atUnix: number): boolean
}

/** example.com -> example[.]com. Unclickable, still readable, still greppable. */
export function defang(value: string): string {
  return value.replace(/\./g, '[.]').replace(/^https?:\/\//i, 'hxxp://')
}

/** User-derived text reaching a human still goes through the airlock scrubber. */
export function safeSummaryFragment(raw: string, max = 120): string {
  return scrubGist(raw).slice(0, max)
}

function fingerprintOf(draft: EscalationDraft): string {
  return createHash('sha256')
    .update(`${draft.vault}|${draft.reason}|${draft.authorId ?? ''}|${draft.summary}`)
    .digest('hex')
    .slice(0, 16)
}

export class InMemoryEscalationQueue implements EscalationQueue {
  private readonly items = new Map<string, EscalationItem>()

  /** Merge window for identical drafts, in seconds. */
  constructor(private readonly mergeWindowSeconds = 3_600) {}

  enqueue(draft: EscalationDraft, nowUnix: number): EscalationItem {
    const id = fingerprintOf(draft)
    const existing = this.items.get(id)
    if (existing && !existing.resolvedAtUnix && nowUnix - existing.lastSeenUnix <= this.mergeWindowSeconds) {
      existing.count += 1
      existing.lastSeenUnix = nowUnix
      return existing
    }
    const item: EscalationItem = {
      ...draft,
      id,
      priority: draft.priority ?? DEFAULT_PRIORITY[draft.reason],
      createdAtUnix: nowUnix,
      lastSeenUnix: nowUnix,
      count: 1,
    }
    this.items.set(id, item)
    return item
  }

  open(): EscalationItem[] {
    const order: EscalationPriority[] = ['critical', 'high', 'normal', 'low']
    return [...this.items.values()]
      .filter((item) => !item.resolvedAtUnix)
      .sort(
        (a, b) =>
          order.indexOf(a.priority) - order.indexOf(b.priority) || a.createdAtUnix - b.createdAtUnix,
      )
  }

  acknowledge(id: string, atUnix: number): boolean {
    const item = this.items.get(id)
    if (!item) return false
    item.acknowledgedAtUnix = atUnix
    return true
  }

  resolve(id: string, atUnix: number): boolean {
    const item = this.items.get(id)
    if (!item) return false
    item.resolvedAtUnix = atUnix
    return true
  }

  breachedSla(nowUnix: number): EscalationItem[] {
    return this.open().filter(
      (item) =>
        item.acknowledgedAtUnix === undefined &&
        nowUnix - item.createdAtUnix > SLA_MINUTES[item.priority] * 60,
    )
  }
}

export function renderEscalation(item: EscalationItem): DeskAnswer {
  const lines = [
    `[${item.priority.toUpperCase()}] ${item.reason.replace(/_/g, ' ')}`,
    item.summary,
  ]
  if (item.count > 1) lines.push(`Seen ${item.count} times since the first report.`)
  if (item.evidence && item.evidence.length > 0) {
    lines.push('Evidence (defanged):')
    for (const fragment of item.evidence.slice(0, 5)) lines.push(`- ${fragment}`)
  }
  if (item.chatId) lines.push(`Chat: ${item.chatId}${item.messageId ? ` msg ${item.messageId}` : ''}`)
  lines.push(`Ref: ${item.id}`)
  return {
    kind: 'escalated',
    body: lines.join('\n'),
    citations: [],
    language: 'en',
    modelAuthored: false,
  }
}

/**
 * Pushes unnotified items to the dev's chat. Separated from the queue so the
 * queue stays a pure data structure and the notifier can be rate limited.
 */
export class DevNotifier {
  constructor(
    private readonly client: TelegramClient,
    private readonly devChatId: string,
    private readonly outbound: OutboundOptions,
    private readonly maxPerFlush = 5,
  ) {}

  async flush(queue: InMemoryEscalationQueue, nowUnix: number): Promise<EscalationItem[]> {
    const pending = queue.open().filter((item) => item.notifiedAtUnix === undefined)
    const batch = pending.slice(0, this.maxPerFlush)
    for (const item of batch) {
      await this.client.sendMessage(this.devChatId, renderOutbound(renderEscalation(item), this.outbound), {
        disableLinkPreview: true,
      })
      item.notifiedAtUnix = nowUnix
    }
    return batch
  }
}

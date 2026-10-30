/**
 * Every refusal is logged. Not a sample - every one.
 *
 * Two reasons. First, a refusal is the visible edge of a High-Risk control, and
 * a control nobody can audit is a claim, not a control. Second, the refusal rate
 * per class is the only early warning that a jailbreak is being iterated on in
 * the wild: a single user producing forty refusals in an hour is a probe.
 *
 * The stored excerpt goes through the airlock's own scrubGist() first. A support
 * log that faithfully records "send 2 ETH to 0xATTACKER" is a destination store
 * with a nice UI, and it will eventually be read by something.
 */

import { createHash } from 'node:crypto'
import { scrubGist } from '@fee-split-vaults/core'
import type { Address, Channel } from '@fee-split-vaults/core'
import type { RefusalClass } from '../../../../config/protocol.js'
import type { LanguageCode } from '../text/normalize.js'
import type { ClassifierSide } from './classifier.js'

export interface RefusalLogEntry {
  /** Short id shown to the user, so a ticket maps to a log line. */
  ref: string
  atUnix: number
  vault: Address
  channel: Channel
  chatId?: string
  authorId?: string
  trippedOn: ClassifierSide | 'none'
  classes: RefusalClass[]
  ruleIds: string[]
  /** Stable across rephrasings of the identical string only. Never reversible. */
  questionFingerprint: string
  /** Scrubbed. Cannot hold an address, a link, or an amount. */
  excerpt: string
  language: LanguageCode
}

export interface RefusalLog {
  record(entry: RefusalLogEntry): void
  recent(limit?: number): RefusalLogEntry[]
  countSince(unix: number, authorId?: string): number
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function fingerprint(text: string): string {
  return sha256Hex(text).slice(0, 16)
}

/** Deterministic reference id: same coin, same question, same second, same ref. */
export function makeRefusalRef(vault: Address, question: string, atUnix: number): string {
  return 'R-' + sha256Hex(`${vault}|${fingerprint(question)}|${atUnix}`).slice(0, 10).toUpperCase()
}

export function scrubExcerpt(text: string): string {
  return scrubGist(text).slice(0, 120)
}

export class InMemoryRefusalLog implements RefusalLog {
  private readonly entries: RefusalLogEntry[] = []

  constructor(private readonly capacity = 5_000) {}

  record(entry: RefusalLogEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
  }

  recent(limit = 100): RefusalLogEntry[] {
    return this.entries.slice(-limit).reverse()
  }

  countSince(unix: number, authorId?: string): number {
    let count = 0
    for (const entry of this.entries) {
      if (entry.atUnix < unix) continue
      if (authorId !== undefined && entry.authorId !== authorId) continue
      count++
    }
    return count
  }

  /** Refusal counts by class, for the weekly report and for drift monitoring. */
  histogram(sinceUnix = 0): Record<string, number> {
    const out: Record<string, number> = {}
    for (const entry of this.entries) {
      if (entry.atUnix < sinceUnix) continue
      for (const cls of entry.classes) out[cls] = (out[cls] ?? 0) + 1
    }
    return out
  }
}

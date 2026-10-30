/**
 * The away notice.
 *
 * During an unstaffed block the bot posts an honest, disclosed "away, back at
 * HH:MM" notice and answers nothing. Two properties matter and both are
 * structural rather than editorial:
 *
 *   1. The notice is a PURE FUNCTION of the assignment and the clock. It takes
 *      no message, no handle, no link and no model output, so there is nothing
 *      for an injection to ride in on. The final string is put through the
 *      core airlock's destination assertion anyway, as a belt.
 *   2. Disclosure is INJECTED BY CODE and re-added canonically. A model never
 *      authors it, and truncation eats the body, never the disclosure.
 */

import { assertNoDestination, requireOperatorName } from '@fee-split-vaults/core'
import type { BlockAssignment, PilotAssignment } from './types.js'
import { blocksForCoin } from './assignment.js'

export class DisclosureError extends Error {
  constructor(message: string) {
    super(`disclosure: ${message}`)
    this.name = 'DisclosureError'
  }
}

/**
 * Wired from config/protocol DISCLOSURE by the caller. It is injected rather
 * than imported so that this package cannot drift from the operator's single
 * source of truth, and so a placeholder cannot ship.
 */
export interface DeskDisclosure {
  aiOperationTag: string
  operatorName: string
  /** Only used where a post is classified promotional by the rule engine. */
  paidPromotionTag?: string
}

/**
 * The tag is a short constant, not a name, so it keeps its own unanchored
 * sentinel. The NAME goes through the shared predicate in @fee-split-vaults/core:
 * this file's old rule was `/SET_ME|TODO|PLACEHOLDER/i`, which rejected any
 * operator whose name merely contains "todo" — "Todos Ltd" could never have
 * published a notice.
 */
const UNSET_TAG_SENTINEL = /SET_ME|TODO|PLACEHOLDER/i

export function assertDisclosureUsable(disclosure: DeskDisclosure): void {
  requireOperatorName(
    disclosure.operatorName,
    (message) => new DisclosureError(`${message} Refusing to publish an unattributed notice.`),
  )
  if (!disclosure.aiOperationTag || UNSET_TAG_SENTINEL.test(disclosure.aiOperationTag)) {
    throw new DisclosureError('aiOperationTag is unset; refusing to publish an unidentified bot')
  }
}

function suffixFor(disclosure: DeskDisclosure, promotional: boolean): string {
  assertDisclosureUsable(disclosure)
  const parts = [disclosure.operatorName, disclosure.aiOperationTag]
  if (promotional) {
    if (!disclosure.paidPromotionTag) {
      throw new DisclosureError('a promotional emission requires a paid-promotion tag')
    }
    parts.push(disclosure.paidPromotionTag)
  }
  return ` — ${parts.join(' · ')}`
}

function stripAuthoredDisclosure(body: string, disclosure: DeskDisclosure): string {
  const tokens = [disclosure.operatorName, disclosure.aiOperationTag, disclosure.paidPromotionTag]
  let out = body
  for (const token of tokens) {
    if (!token) continue
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(escaped, 'gi'), '')
  }
  return out.replace(/\s{2,}/g, ' ').trim()
}

/**
 * Strip any disclosure the body claims to carry, then append the canonical one.
 * The body is truncated to make room; the disclosure never is.
 */
export function withDisclosure(
  body: string,
  disclosure: DeskDisclosure,
  maxChars: number,
  promotional = false,
): string {
  const suffix = suffixFor(disclosure, promotional)
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new DisclosureError('maxChars must be a positive integer')
  }
  if (maxChars < suffix.trim().length) {
    throw new DisclosureError(
      `channel limit ${maxChars} cannot hold the disclosure; refusing to publish without it`,
    )
  }
  const cleaned = stripAuthoredDisclosure(body, disclosure)
  const room = maxChars - suffix.length
  if (room <= 0) return suffix.trim()
  const trimmed =
    cleaned.length <= room ? cleaned : `${cleaned.slice(0, Math.max(0, room - 1)).trimEnd()}…`
  return `${trimmed}${suffix}`
}

export interface AwayNotice {
  coinRef: string
  blockIndex: number
  /** Post at the start of the unstaffed block. */
  postAtUnix: number
  backAtUnix: number
  text: string
  /**
   * Carried beside the body, never inside it: a URL in the text would defeat
   * the destination assertion. The channel adapter attaches it as a link.
   */
  scheduleUri?: string
}

export interface AwayNoticeOptions {
  /** Channel character limit. Telegram 4096, X 280. */
  maxChars?: number
  /** Shown in the notice so holders can check the published schedule themselves. */
  scheduleUri?: string
}

function hhmmUtc(unix: number): string {
  const date = new Date(unix * 1_000)
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm} UTC`
}

/**
 * The notice body. Deliberately says the quiet part: the hours are randomized,
 * the study is free, and the schedule is published in advance. A holder who
 * feels experimented on is entitled to know that they are.
 */
export function buildAwayNotice(
  block: BlockAssignment,
  disclosure: DeskDisclosure,
  options: AwayNoticeOptions = {},
): AwayNotice {
  if (block.arm !== 'UNSTAFFED') {
    throw new DisclosureError('an away notice may only be built for an UNSTAFFED block')
  }
  const maxChars = options.maxChars ?? 4_096
  const sentences = [
    `The desk is away and will not be answering questions until ${hhmmUtc(block.endUnixExclusive)}.`,
    'Coverage hours during this trial are chosen at random in advance, so an away block is not a signal about this project.',
    'The service is free for the whole trial and every coin gets full coverage for the second half.',
  ]
  if (options.scheduleUri) {
    sentences.push('The full randomized schedule was published before the trial began.')
  }
  const text = withDisclosure(sentences.join(' '), disclosure, maxChars, false)
  assertNoDestination(text, 'away_notice')

  const notice: AwayNotice = {
    coinRef: block.coinRef,
    blockIndex: block.blockIndex,
    postAtUnix: block.startUnix,
    backAtUnix: block.endUnixExclusive,
    text,
  }
  if (options.scheduleUri) notice.scheduleUri = options.scheduleUri
  return notice
}

/** Every away notice a coin will receive, computable before the pilot starts. */
export function awayNoticeSchedule(
  assignment: PilotAssignment,
  coinRef: string,
  disclosure: DeskDisclosure,
  options: AwayNoticeOptions = {},
): AwayNotice[] {
  return blocksForCoin(assignment, coinRef)
    .filter((block) => block.arm === 'UNSTAFFED')
    .map((block) => buildAwayNotice(block, disclosure, options))
}

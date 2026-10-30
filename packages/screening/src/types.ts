/**
 * Screening domain types.
 *
 * A screening subject is ENTIRELY attacker-authored: a memecoin's name, symbol,
 * description and images are chosen by the person asking us to promote them.
 * Nothing in this package treats any of it as instructions, dereferences a URL,
 * or lets a value from it reach a payee, an amount, or a tool call. The package
 * holds no keys and has no spending, posting, or signing capability, which is
 * the same two-plane rule the airlock enforces for community input.
 */

import { createHash } from 'node:crypto'
import type { Address, ScreeningResult, ScreeningVerdict } from '@fee-split-vaults/core'
import { scrubGist, assertNoDestination } from '@fee-split-vaults/core'
import type { Flag, StageName } from './flags.js'
import { verdictFor, paidMediaPermitted } from './flags.js'

/**
 * An image already in our own object store, addressed by content hash. Never a
 * remote URL: screening does not fetch, and an unhashed image is unscreenable.
 */
export interface ImageRef {
  id: string
  sha256: string
  byteLength: number
  mimeType: string
}

export interface SubjectMetadata {
  token: Address
  name: string
  symbol: string
  description?: string
  /** Matched as text only. Screening never dereferences a link. */
  links?: string[]
  imageRefs?: ImageRef[]
  /**
   * True when launch metadata is still editable on chain. A mutable coin can be
   * admitted clean and changed afterwards, so it re-screens on a tighter clock.
   */
  metadataMutable: boolean
  observedAtUnix: number
}

export interface ScreeningSubject extends SubjectMetadata {
  /** Deterministic over every field above. Drives change-triggered re-screening. */
  metadataHash: string
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Canonical, order-stable serialisation. Two equal metadata sets hash equal. */
export function metadataHashOf(metadata: SubjectMetadata): string {
  const canonical = JSON.stringify([
    metadata.token.toLowerCase(),
    metadata.name,
    metadata.symbol,
    metadata.description ?? '',
    [...(metadata.links ?? [])].sort(),
    [...(metadata.imageRefs ?? [])].map((i) => i.sha256).sort(),
    metadata.metadataMutable,
  ])
  return sha256Hex(canonical)
}

export function makeSubject(metadata: SubjectMetadata): ScreeningSubject {
  return { ...metadata, metadataHash: metadataHashOf(metadata) }
}

/** Every untrusted field, concatenated once for the deterministic scanners. */
export function subjectText(subject: SubjectMetadata): string {
  return [
    subject.name,
    subject.symbol,
    subject.description ?? '',
    ...(subject.links ?? []),
  ].join('\n')
}

/**
 * Evidence crosses from untrusted text into operator dashboards, review queues
 * and model context, so it goes through the airlock's own scrubber and its
 * destination assertion. A fragment that survives scrubbing and still looks
 * like an address or a URL is dropped entirely rather than shown.
 */
export function redactEvidence(raw: string, maxChars: number): string {
  let out: string
  try {
    out = scrubGist(raw)
    assertNoDestination(out, 'screening.evidence')
  } catch {
    return '[redacted]'
  }
  if (out.length === 0) return '[redacted]'
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`
  return out
}

/**
 * Scrub a long body without losing it. `scrubGist` truncates to the airlock's
 * gist ceiling, which is right for a gist and wrong for a description the
 * adjudicator has to read, so the body is scrubbed in whitespace-aligned chunks
 * below that ceiling and rejoined. Chunks never split a token, so an address
 * cannot survive by being cut in half.
 */
export function scrubLongText(raw: string, maxChars: number): string {
  const CHUNK = 120
  const words = raw.replace(/\s+/g, ' ').trim().split(' ')
  const chunks: string[] = []
  let current = ''
  for (const word of words) {
    const bounded = word.length > CHUNK ? word.slice(0, CHUNK) : word
    const candidate = current === '' ? bounded : `${current} ${bounded}`
    if (candidate.length > CHUNK) {
      if (current !== '') chunks.push(current)
      current = bounded
    } else {
      current = candidate
    }
  }
  if (current !== '') chunks.push(current)

  const scrubbed: string[] = []
  for (const chunk of chunks) {
    try {
      const clean = scrubGist(chunk)
      assertNoDestination(clean, 'screening.body')
      scrubbed.push(clean)
    } catch {
      scrubbed.push('[redacted]')
    }
  }

  const joined = scrubbed.join(' ')
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined
}

export interface StageOutput {
  stages: StageName[]
  flags: Flag[]
}

export const EMPTY_STAGE_OUTPUT: StageOutput = { stages: [], flags: [] }

export type HumanDecision = 'approve' | 'reject' | 'escalate'

export interface HumanReviewRecord {
  reviewerId: string
  decision: HumanDecision
  decidedAtUnix: number
  /** Operator note. Never published. */
  note?: string
}

/**
 * The package's rich result. `toScreeningResult` narrows it to the shared
 * cross-package contract; nothing outside screening should need the rich form
 * except the human review UI and the decline list.
 */
export interface ScreeningReport {
  id: string
  subject: ScreeningSubject
  verdict: ScreeningVerdict
  flags: Flag[]
  stagesRun: StageName[]
  screenedAtUnix: number
  /** Past this instant the screening is expired and cannot authorise anything. */
  expiresAtUnix: number
  paidMediaPermitted: boolean
  humanReview?: HumanReviewRecord
  note?: string
}

export function reportId(subject: ScreeningSubject, screenedAtUnix: number): string {
  return sha256Hex(`${subject.token.toLowerCase()}|${subject.metadataHash}|${screenedAtUnix}`).slice(
    0,
    32,
  )
}

/** Rebuild the derived fields from the flag union. Never set them by hand. */
export function finalizeReport(
  partial: Omit<ScreeningReport, 'verdict' | 'paidMediaPermitted'>,
): ScreeningReport {
  return {
    ...partial,
    verdict: verdictFor(partial.flags),
    paidMediaPermitted: paidMediaPermitted(partial.flags),
  }
}

export function toScreeningResult(report: ScreeningReport): ScreeningResult {
  const result: ScreeningResult = {
    token: report.subject.token,
    verdict: report.verdict,
    flags: [...new Set(report.flags.map((f) => f.code))],
    stagesRun: [...report.stagesRun],
    screenedAtUnix: report.screenedAtUnix,
    paidMediaPermitted: report.paidMediaPermitted,
  }
  if (report.note !== undefined) result.note = report.note
  return result
}

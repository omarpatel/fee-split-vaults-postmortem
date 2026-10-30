/**
 * The machine-readable decline list.
 *
 * A BLOCKED coin is refused, published to this list, and LEFT WITH 100% OF ITS
 * OWN FEES. That last part is not generosity, it is the only defensible
 * position: we decline to work for the coin, so we take nothing from it, and
 * the vault stays in passthrough with the dev leg untouched. Any design where
 * the operator keeps a cut of a coin it refused to serve would make the refusal
 * look like a fee-extraction move.
 *
 * PUBLISHED CONTENT IS COARSE BY DESIGN. The list carries a token address, one
 * public code, a timestamp, and a digest - never the matched term, never the
 * excerpt, and never any detail of a child-safety hit. A public list that
 * quoted its evidence would be a searchable index of the exact strings that
 * evade or trigger the screen.
 */

import { declineCodeFor, type DeclineCode } from './flags.js'
import { sha256Hex, type ScreeningReport } from './types.js'
import { ScreeningFailClosed } from './flags.js'

export const DECLINE_LIST_SCHEMA_VERSION = 1

export interface DeclineRecord {
  schemaVersion: number
  token: string
  code: DeclineCode
  verdict: 'BLOCKED'
  screeningId: string
  declinedAtUnix: number
  /**
   * Always true. The operator takes no share of a coin it refused to serve, and
   * the vault is left in passthrough so the dev's own claim path is unaffected.
   */
  devKeepsAllFees: true
  /**
   * Commitment to the flag set and the exact metadata that was screened, so the
   * decision is reproducible without publishing what triggered it.
   */
  evidenceDigest: string
}

export interface DeclineListSink {
  publish(record: DeclineRecord): Promise<void>
  list(): Promise<DeclineRecord[]>
  has(token: string): Promise<boolean>
}

export function declineRecordFor(report: ScreeningReport): DeclineRecord {
  if (report.verdict !== 'BLOCKED') {
    throw new ScreeningFailClosed(
      `only a BLOCKED report may be declined, got ${report.verdict}`,
      report.subject.token,
    )
  }
  const codes = [...new Set(report.flags.map((f) => f.code))].sort().join(',')
  return {
    schemaVersion: DECLINE_LIST_SCHEMA_VERSION,
    token: report.subject.token.toLowerCase(),
    code: declineCodeFor(report.flags),
    verdict: 'BLOCKED',
    screeningId: report.id,
    declinedAtUnix: report.screenedAtUnix,
    devKeepsAllFees: true,
    evidenceDigest: sha256Hex(`${report.subject.metadataHash}|${codes}`),
  }
}

export class InMemoryDeclineList implements DeclineListSink {
  private readonly records = new Map<string, DeclineRecord>()

  async publish(record: DeclineRecord): Promise<void> {
    const existing = this.records.get(record.token)
    if (existing !== undefined && existing.evidenceDigest === record.evidenceDigest) return
    this.records.set(record.token, record)
  }

  async list(): Promise<DeclineRecord[]> {
    return [...this.records.values()].sort((a, b) => a.declinedAtUnix - b.declinedAtUnix)
  }

  async has(token: string): Promise<boolean> {
    return this.records.has(token.toLowerCase())
  }
}

/** Stable serialisation. Byte-identical for identical content, so it diffs. */
export function serializeDeclineList(records: readonly DeclineRecord[]): string {
  const sorted = [...records].sort((a, b) =>
    a.token === b.token ? a.declinedAtUnix - b.declinedAtUnix : a.token < b.token ? -1 : 1,
  )
  return `${JSON.stringify({ schemaVersion: DECLINE_LIST_SCHEMA_VERSION, records: sorted }, null, 2)}\n`
}

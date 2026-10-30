/**
 * The screening pipeline. Four stages, cheapest first, union of flags.
 *
 * ORDERING IS A COST DECISION, NOT A SEMANTIC ONE. Stage 1 is free and runs
 * always. Stage 2 runs only when there are images. Stage 3 costs a model call
 * and is skipped once the subject is already BLOCKED, because nothing a later
 * stage returns can lift a block. Stage 4 is a person and is reached only at
 * the paid-media gate, which is a separate entry point.
 *
 * FAIL CLOSED. A stage that throws does not skip: it becomes
 * `internal_fail_closed`, which is a block. Missing adjudicator, expired
 * screening, stale sanctions list, unreachable provider - all refuse.
 */

import type { ScreeningVerdict } from '@fee-split-vaults/core'
import {
  ScreeningFailClosed,
  assertMonotonic,
  isStickyBlock,
  makeFlag,
  mergeFlags,
  requiresOutOfBandEscalation,
  type Flag,
  type StageName,
} from './flags.js'
import type { Lexicon } from './lexicon.js'
import type { SdnScreener } from './ofac.js'
import { runStage1 } from './stage1.js'
import {
  ImageServeGate,
  runStage2,
  type CsamEscalationSink,
  type CsamHashProvider,
  type FaceMatcher,
  type LogoMatcher,
  type PerceptualThresholds,
} from './stage2.js'
import { runStage3, type Adjudicator } from './stage3.js'
import {
  finalizeReport,
  makeSubject,
  reportId,
  type ScreeningReport,
  type ScreeningSubject,
  type SubjectMetadata,
} from './types.js'

export interface ScreeningConfig {
  /** A screening older than this authorises nothing. */
  screeningTtlSeconds: number
  /**
   * Mutable launch metadata gets a shorter TTL: a clean coin can be admitted
   * and then edited, so its clearance has to age out faster.
   */
  mutableMetadataTtlSeconds: number
  maxEvidenceChars: number
  maxAdjudicationChars: number
  /** See Stage1Options. Only ever true in tests. */
  allowUnconfiguredLexicons: boolean
  /**
   * 'always'      - adjudicate every subject.
   * 'on_flag'     - adjudicate only subjects stage 1/2 flagged.
   * Either way an unavailable adjudicator is RESTRICTED, never CLEAR.
   */
  adjudicationPolicy: 'always' | 'on_flag'
}

export const DEFAULT_SCREENING_CONFIG: ScreeningConfig = {
  screeningTtlSeconds: 7 * 24 * 60 * 60,
  mutableMetadataTtlSeconds: 24 * 60 * 60,
  maxEvidenceChars: 96,
  maxAdjudicationChars: 2_000,
  allowUnconfiguredLexicons: false,
  adjudicationPolicy: 'always',
}

/**
 * Blocks follow the token, not the metadata. A coin blocked for a slur that
 * renames itself is the same coin, and re-screening the new name from scratch
 * would launder it.
 */
export interface ScreeningHistory {
  everBlocked(token: string): boolean
  recordBlocked(token: string, report: ScreeningReport): void
}

export class InMemoryScreeningHistory implements ScreeningHistory {
  private readonly blocked = new Map<string, ScreeningReport>()
  everBlocked(token: string): boolean {
    return this.blocked.has(token.toLowerCase())
  }
  recordBlocked(token: string, report: ScreeningReport): void {
    this.blocked.set(token.toLowerCase(), report)
  }
  reportFor(token: string): ScreeningReport | undefined {
    return this.blocked.get(token.toLowerCase())
  }
}

export interface PerceptualDeps {
  csam: CsamHashProvider
  escalation: CsamEscalationSink
  logos?: LogoMatcher
  faces?: FaceMatcher
  thresholds?: PerceptualThresholds
}

export interface ScreeningEngineDeps {
  lexicon: Lexicon
  sdn: SdnScreener
  /** Omit only for a deployment that never accepts images. */
  perceptual?: PerceptualDeps
  /** Omit and every subject is RESTRICTED: no adjudicator, no clearance. */
  adjudicator?: Adjudicator
  history?: ScreeningHistory
  config?: ScreeningConfig
  clock?: () => number
}

export class ScreeningEngine {
  private readonly config: ScreeningConfig
  private readonly clock: () => number
  private readonly history: ScreeningHistory
  readonly imageGate: ImageServeGate | undefined

  constructor(private readonly deps: ScreeningEngineDeps) {
    this.config = deps.config ?? DEFAULT_SCREENING_CONFIG
    this.clock = deps.clock ?? ((): number => Math.floor(Date.now() / 1000))
    this.history = deps.history ?? new InMemoryScreeningHistory()
    this.imageGate =
      deps.perceptual === undefined
        ? undefined
        : new ImageServeGate(
            deps.perceptual.csam,
            deps.perceptual.escalation,
            deps.perceptual.thresholds,
          )
  }

  async screen(metadata: SubjectMetadata): Promise<ScreeningReport> {
    const subject = makeSubject(metadata)
    const now = this.clock()
    let flags: Flag[] = []
    const stages: StageName[] = []

    try {
      if (this.history.everBlocked(subject.token)) {
        flags = mergeFlags(flags, [
          makeFlag('previously_blocked', now, {
            detail: 'token carries an earlier block under different metadata',
          }),
        ])
      }

      flags = this.applyStage(
        flags,
        stages,
        runStage1(
          subject,
          {
            lexicon: this.deps.lexicon,
            sdn: this.deps.sdn,
            options: {
              maxEvidenceChars: this.config.maxEvidenceChars,
              allowUnconfiguredLexicons: this.config.allowUnconfiguredLexicons,
            },
          },
          now,
        ),
      )

      const images = subject.imageRefs ?? []
      if (images.length > 0) {
        if (this.deps.perceptual === undefined || this.imageGate === undefined) {
          // Images with no perceptual plane is not "no images". It is unscreened.
          flags = this.applyStage(flags, stages, {
            stages: ['perceptual'],
            flags: [
              makeFlag('image_unscreened', now, {
                detail: 'no perceptual provider configured on this deployment',
              }),
            ],
          })
        } else {
          flags = this.applyStage(
            flags,
            stages,
            await runStage2(
              subject,
              {
                csam: this.deps.perceptual.csam,
                escalation: this.deps.perceptual.escalation,
                ...(this.deps.perceptual.logos === undefined
                  ? {}
                  : { logos: this.deps.perceptual.logos }),
                ...(this.deps.perceptual.faces === undefined
                  ? {}
                  : { faces: this.deps.perceptual.faces }),
                ...(this.deps.perceptual.thresholds === undefined
                  ? {}
                  : { thresholds: this.deps.perceptual.thresholds }),
                maxEvidenceChars: this.config.maxEvidenceChars,
              },
              this.imageGate,
              now,
            ),
          )
        }
      }

      const alreadyBlocked = flags.some((f) => f.severity === 'block')
      if (!alreadyBlocked && this.shouldAdjudicate(flags)) {
        if (this.deps.adjudicator === undefined) {
          flags = this.applyStage(flags, stages, {
            stages: ['adjudication'],
            flags: [
              makeFlag('adjudication_unavailable', now, {
                detail: 'no adjudicator configured on this deployment',
              }),
            ],
          })
        } else {
          flags = this.applyStage(
            flags,
            stages,
            await runStage3(
              subject,
              {
                adjudicator: this.deps.adjudicator,
                maxTextChars: this.config.maxAdjudicationChars,
              },
              now,
            ),
          )
        }
      }
    } catch (error) {
      flags = mergeFlags(flags, [
        makeFlag('internal_fail_closed', now, {
          detail: error instanceof Error ? error.message.slice(0, 160) : 'unknown failure',
        }),
      ])
    }

    const report = finalizeReport({
      id: reportId(subject, now),
      subject,
      flags,
      stagesRun: stages,
      screenedAtUnix: now,
      expiresAtUnix: now + this.ttlFor(subject),
    })

    if (report.verdict === 'BLOCKED' && isStickyBlock(report.flags)) {
      this.history.recordBlocked(subject.token, report)
    }

    return report
  }

  /** True when a child-safety hit obliges an out-of-band report. */
  needsOutOfBandEscalation(report: ScreeningReport): boolean {
    return requiresOutOfBandEscalation(report.flags)
  }

  private shouldAdjudicate(flags: readonly Flag[]): boolean {
    if (this.config.adjudicationPolicy === 'always') return true
    return flags.length > 0
  }

  private ttlFor(subject: ScreeningSubject): number {
    return subject.metadataMutable
      ? Math.min(this.config.mutableMetadataTtlSeconds, this.config.screeningTtlSeconds)
      : this.config.screeningTtlSeconds
  }

  /** The single merge point. Every stage boundary is proved monotonic here. */
  private applyStage(
    prior: Flag[],
    stages: StageName[],
    output: { stages: StageName[]; flags: Flag[] },
  ): Flag[] {
    const merged = mergeFlags(prior, output.flags)
    assertMonotonic(prior, merged)
    for (const stage of output.stages) {
      if (!stages.includes(stage)) stages.push(stage)
    }
    return merged
  }
}

export function isFresh(report: ScreeningReport, nowUnix: number): boolean {
  return nowUnix <= report.expiresAtUnix
}

export function assertFreshScreening(report: ScreeningReport, nowUnix: number): void {
  if (!isFresh(report, nowUnix)) {
    throw new ScreeningFailClosed(
      `screening ${report.id} expired at ${report.expiresAtUnix}`,
      report.subject.token,
    )
  }
}

/** Organic operations. RESTRICTED passes here; BLOCKED and expired do not. */
export function assertOperationsPermitted(report: ScreeningReport, nowUnix: number): void {
  assertFreshScreening(report, nowUnix)
  if (report.verdict === 'BLOCKED') {
    throw new ScreeningFailClosed('subject is BLOCKED; no operations permitted', report.subject.token)
  }
}

/** Paid media. Only CLEAR passes, and only while fresh. */
export function assertPaidMediaPermitted(report: ScreeningReport, nowUnix: number): void {
  assertFreshScreening(report, nowUnix)
  if (!report.paidMediaPermitted) {
    throw new ScreeningFailClosed(
      `verdict ${report.verdict} does not permit paid media`,
      report.subject.token,
    )
  }
}

export function verdictOf(report: ScreeningReport): ScreeningVerdict {
  return report.verdict
}

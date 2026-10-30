/**
 * Stage 2: perceptual matching, and the mandatory child-safety hash check.
 *
 * TWO DIFFERENT THINGS LIVE HERE. Logo and face matching are advisory: they add
 * RESTRICTED flags and inform a human. The CSAM hash check is not advisory and
 * is not part of the verdict calculation alone - it is a precondition on
 * SERVING BYTES. `ImageServeGate.assertServable` must be called by every path
 * that puts an image on our infrastructure or in a post, and it throws unless a
 * completed, unexpired, negative hash check exists for that exact content hash.
 *
 * WE DO NOT IMPLEMENT THE HASHING. Perceptual hashing against known CSAM is
 * done by a licensed matcher (an NCMEC/IWF hash-sharing participant) under a
 * data-use agreement; reimplementing it here would mean holding the hash set,
 * which we are neither licensed nor competent to do. This module defines the
 * interface, the fail-closed behaviour around it, and a fake for tests.
 *
 * A positive hit is a preservation-and-report event, not a delete-and-move-on
 * event: the bytes must be preserved for law enforcement and the detail must
 * never reach the public decline list.
 */

import type { Flag } from './flags.js'
import { makeFlag } from './flags.js'
import { redactEvidence, type ImageRef, type ScreeningSubject, type StageOutput } from './types.js'

export type HashCheckVerdict = 'match' | 'no_match'

export interface HashCheckResult {
  verdict: HashCheckVerdict
  /** Provider-side case reference. Required for the escalation record. */
  providerRef: string
  checkedAtUnix: number
}

export interface CsamHashProvider {
  /**
   * MUST be a licensed third-party matcher. Any error, timeout, or unknown
   * response is a refusal to serve, never a pass.
   */
  check(image: ImageRef): Promise<HashCheckResult>
}

export interface PerceptualMatch {
  /** Allowlisted identifier, never free text taken from the subject. */
  id: string
  /** 0..1. Compared against a configured threshold, never interpreted loosely. */
  score: number
}

export interface LogoMatcher {
  match(image: ImageRef): Promise<PerceptualMatch[]>
}

export interface FaceMatcher {
  match(image: ImageRef): Promise<PerceptualMatch[]>
}

export interface CsamEscalation {
  token: string
  imageSha256: string
  providerRef: string
  detectedAtUnix: number
}

export interface CsamEscalationSink {
  /** Out-of-band report. Never writes to any public artefact. */
  report(escalation: CsamEscalation): Promise<void>
}

export interface PerceptualThresholds {
  logoScore: number
  faceScore: number
  /** A hash check older than this is not a check any more. */
  hashCheckTtlSeconds: number
}

export const DEFAULT_PERCEPTUAL_THRESHOLDS: PerceptualThresholds = {
  logoScore: 0.85,
  faceScore: 0.9,
  hashCheckTtlSeconds: 30 * 24 * 60 * 60,
}

export interface Stage2Deps {
  csam: CsamHashProvider
  escalation: CsamEscalationSink
  logos?: LogoMatcher
  faces?: FaceMatcher
  thresholds?: PerceptualThresholds
  maxEvidenceChars: number
}

export class ImageNotServable extends Error {
  constructor(
    readonly imageSha256: string,
    readonly reason: 'unchecked' | 'expired' | 'provider_error' | 'hash_match',
  ) {
    super(`screening: image ${imageSha256.slice(0, 12)} not servable (${reason})`)
    this.name = 'ImageNotServable'
  }
}

/**
 * The serving precondition. Results are cached by CONTENT hash, so the same
 * bytes are never re-billed, and re-uploading identical bytes under a new id
 * cannot skip the check.
 */
export class ImageServeGate {
  private readonly cache = new Map<string, HashCheckResult>()

  constructor(
    private readonly provider: CsamHashProvider,
    private readonly escalation: CsamEscalationSink,
    private readonly thresholds: PerceptualThresholds = DEFAULT_PERCEPTUAL_THRESHOLDS,
  ) {}

  /** Run (or reuse) the check. Never throws on a match; returns the result. */
  async check(image: ImageRef, nowUnix: number, token: string): Promise<HashCheckResult> {
    const cached = this.cache.get(image.sha256)
    if (cached !== undefined && nowUnix - cached.checkedAtUnix <= this.thresholds.hashCheckTtlSeconds) {
      return cached
    }
    const result = await this.provider.check(image)
    this.cache.set(image.sha256, result)
    if (result.verdict === 'match') {
      await this.escalation.report({
        token,
        imageSha256: image.sha256,
        providerRef: result.providerRef,
        detectedAtUnix: result.checkedAtUnix,
      })
    }
    return result
  }

  /**
   * Call before ANY path that serves, posts, thumbnails, or mirrors an image.
   * Throws unless a completed, unexpired, negative check exists.
   */
  assertServable(image: ImageRef, nowUnix: number): void {
    const cached = this.cache.get(image.sha256)
    if (cached === undefined) throw new ImageNotServable(image.sha256, 'unchecked')
    if (cached.verdict === 'match') throw new ImageNotServable(image.sha256, 'hash_match')
    if (nowUnix - cached.checkedAtUnix > this.thresholds.hashCheckTtlSeconds) {
      throw new ImageNotServable(image.sha256, 'expired')
    }
  }

  /** Test and operator introspection. Does not perform a check. */
  cachedVerdict(sha256: string): HashCheckResult | undefined {
    return this.cache.get(sha256)
  }
}

export async function runStage2(
  subject: ScreeningSubject,
  deps: Stage2Deps,
  gate: ImageServeGate,
  nowUnix: number,
): Promise<StageOutput> {
  const images = subject.imageRefs ?? []
  if (images.length === 0) return { stages: [], flags: [] }

  const thresholds = deps.thresholds ?? DEFAULT_PERCEPTUAL_THRESHOLDS
  const flags: Flag[] = []

  for (const image of images) {
    try {
      const result = await gate.check(image, nowUnix, subject.token)
      if (result.verdict === 'match') {
        flags.push(
          makeFlag('csam_hash_match', nowUnix, {
            detail: `image ${image.sha256.slice(0, 12)} reported out of band`,
          }),
        )
        // Nothing else about this image is examined, logged, or published.
        continue
      }
    } catch (error) {
      flags.push(
        makeFlag('perceptual_unavailable', nowUnix, {
          detail: `hash provider failed for image ${image.sha256.slice(0, 12)}`,
        }),
      )
      flags.push(
        makeFlag('image_unscreened', nowUnix, {
          detail: describeError(error),
        }),
      )
      continue
    }

    if (deps.logos !== undefined) {
      try {
        for (const match of await deps.logos.match(image)) {
          if (match.score < thresholds.logoScore) continue
          flags.push(
            makeFlag('logo_match', nowUnix, {
              evidence: redactEvidence(match.id, deps.maxEvidenceChars),
              detail: `logo score ${match.score.toFixed(2)}`,
            }),
          )
        }
      } catch (error) {
        flags.push(
          makeFlag('perceptual_unavailable', nowUnix, { detail: describeError(error) }),
        )
      }
    }

    if (deps.faces !== undefined) {
      try {
        for (const match of await deps.faces.match(image)) {
          if (match.score < thresholds.faceScore) continue
          flags.push(
            makeFlag('face_match_public_figure', nowUnix, {
              evidence: redactEvidence(match.id, deps.maxEvidenceChars),
              detail: `face score ${match.score.toFixed(2)}`,
            }),
          )
        }
      } catch (error) {
        flags.push(
          makeFlag('perceptual_unavailable', nowUnix, { detail: describeError(error) }),
        )
      }
    }
  }

  return { stages: ['perceptual'], flags }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 120)
  return 'unknown provider error'
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

export class FakeCsamHashProvider implements CsamHashProvider {
  readonly checked: string[] = []

  constructor(
    private readonly knownHashes: Set<string> = new Set(),
    private readonly failFor: Set<string> = new Set(),
    private readonly clock: () => number = () => 0,
  ) {}

  async check(image: ImageRef): Promise<HashCheckResult> {
    this.checked.push(image.sha256)
    if (this.failFor.has(image.sha256)) throw new Error('provider unreachable')
    return {
      verdict: this.knownHashes.has(image.sha256) ? 'match' : 'no_match',
      providerRef: `fake-${image.sha256.slice(0, 8)}`,
      checkedAtUnix: this.clock(),
    }
  }
}

export class InMemoryCsamEscalationSink implements CsamEscalationSink {
  readonly reports: CsamEscalation[] = []
  async report(escalation: CsamEscalation): Promise<void> {
    this.reports.push(escalation)
  }
}

export class FakeMatcher implements LogoMatcher, FaceMatcher {
  constructor(private readonly bySha: Map<string, PerceptualMatch[]> = new Map()) {}
  async match(image: ImageRef): Promise<PerceptualMatch[]> {
    return this.bySha.get(image.sha256) ?? []
  }
}

/**
 * The screening flag vocabulary and the union-of-flags algebra.
 *
 * UNION SEMANTICS. Every stage may only ADD flags. No stage may remove one, and
 * no stage may lower the severity of one already raised. `mergeFlags` is the
 * only sanctioned way to combine stage output, and `assertMonotonic` is the
 * runtime proof that a later (more expensive, less trustworthy) stage did not
 * clear an earlier one. Stage 3 is a language model reading attacker-authored
 * text; the union rule is what makes its compromise survivable.
 *
 * FAIL CLOSED. An unrecognised flag code is not ignored, it throws.
 */

import type { ScreeningResult, ScreeningVerdict } from '@fee-split-vaults/core'

/** The five stages named by the shared ScreeningResult contract. */
export type StageName = ScreeningResult['stagesRun'][number]

/**
 * block    -> BLOCKED. Refuse, publish a decline, leave the dev 100% of fees.
 * restrict -> RESTRICTED. Organic operations permitted, no paid media.
 * note     -> recorded, does not move the verdict on its own.
 */
export type FlagSeverity = 'note' | 'restrict' | 'block'

const SEVERITY_RANK: Record<FlagSeverity, number> = { note: 0, restrict: 1, block: 2 }

/**
 * Codes published on the machine-readable decline list. Deliberately coarse:
 * the decline list is a public artefact and must never carry the offending
 * text, the matched term, or any detail of a child-safety hit.
 */
export const DECLINE_CODES = [
  'hate_or_harassment',
  'sexual_content',
  'child_safety',
  'tragedy_exploitation',
  'sanctions',
  'impersonation_or_trademark',
  'deceptive_or_fraudulent',
  'violence',
  'unreviewable',
  'operator_policy',
] as const

export type DeclineCode = (typeof DECLINE_CODES)[number]

/** Closed vocabulary. Adding a member is a policy review, not a refactor. */
export const FLAG_CODES = [
  // Stage 1 - deterministic lexicon
  'hate_lexicon',
  'slur_lexicon',
  'hate_numeric_code',
  'tragedy_exploitation',
  'sexual_explicit',
  'sexual_suggestive',
  'sexual_minor_context',
  'violence_incitement',
  'ofac_sdn_name_match',
  'ofac_sdn_partial_match',
  'sanctions_list_stale',
  'lexicon_unconfigured',
  // Stage 1 - trademark and public figure
  'trademark_match',
  'public_figure_name',
  'impersonation_claim',
  // Stage 2 - perceptual
  'csam_hash_match',
  'logo_match',
  'face_match_public_figure',
  'perceptual_unavailable',
  'image_unscreened',
  // Stage 3 - adjudication
  'adjudication_hate',
  'adjudication_sexual',
  'adjudication_child_safety',
  'adjudication_tragedy',
  'adjudication_impersonation',
  'adjudication_deceptive',
  'adjudication_violence',
  'adjudication_borderline',
  'adjudication_unavailable',
  // Stage 4 - human
  'human_rejected_paid_media',
  'human_escalated',
  'human_blocked',
  // Cross-cutting
  'previously_blocked',
  'internal_fail_closed',
] as const

export type FlagCode = (typeof FLAG_CODES)[number]

export interface FlagSpec {
  stage: StageName
  severity: FlagSeverity
  publicCode: DeclineCode
  /** Operator-facing description. Never contains subject content. */
  description: string
  /**
   * True when a hit obliges an out-of-band report and byte preservation, and
   * forbids publishing any detail. Only child-safety hits set this.
   */
  escalateOutOfBand?: boolean
}

export const FLAG_SPECS: Record<FlagCode, FlagSpec> = {
  hate_lexicon: {
    stage: 'lexicon',
    severity: 'block',
    publicCode: 'hate_or_harassment',
    description: 'Hate or harassment phrase matched the deterministic lexicon.',
  },
  slur_lexicon: {
    stage: 'lexicon',
    severity: 'block',
    publicCode: 'hate_or_harassment',
    description: 'Slur matched the operator-supplied slur list.',
  },
  hate_numeric_code: {
    stage: 'lexicon',
    severity: 'block',
    publicCode: 'hate_or_harassment',
    description: 'Numeric hate code present in the metadata.',
  },
  tragedy_exploitation: {
    stage: 'lexicon',
    severity: 'block',
    publicCode: 'tragedy_exploitation',
    description: 'Metadata trades on a death, disaster, or attack.',
  },
  sexual_explicit: {
    stage: 'lexicon',
    severity: 'block',
    publicCode: 'sexual_content',
    description: 'Explicit sexual content in the metadata.',
  },
  sexual_suggestive: {
    stage: 'lexicon',
    severity: 'restrict',
    publicCode: 'sexual_content',
    description: 'Suggestive sexual content. Organic only, never paid media.',
  },
  sexual_minor_context: {
    stage: 'lexicon',
    severity: 'block',
    publicCode: 'child_safety',
    description: 'Sexual term co-occurring with a reference to a minor.',
    escalateOutOfBand: true,
  },
  violence_incitement: {
    stage: 'lexicon',
    severity: 'block',
    publicCode: 'violence',
    description: 'Incitement to violence or self-harm.',
  },
  ofac_sdn_name_match: {
    stage: 'lexicon',
    severity: 'block',
    publicCode: 'sanctions',
    description: 'Full name match against the OFAC SDN list.',
  },
  ofac_sdn_partial_match: {
    stage: 'lexicon',
    severity: 'restrict',
    publicCode: 'sanctions',
    description: 'Distinctive token matched an SDN name. Needs human review.',
  },
  sanctions_list_stale: {
    stage: 'lexicon',
    severity: 'restrict',
    publicCode: 'unreviewable',
    description: 'SDN list older than policy allows. Screening cannot clear.',
  },
  lexicon_unconfigured: {
    stage: 'lexicon',
    severity: 'restrict',
    publicCode: 'unreviewable',
    description: 'A required lexicon or list is missing on this deployment.',
  },
  trademark_match: {
    stage: 'trademark',
    severity: 'restrict',
    publicCode: 'impersonation_or_trademark',
    description: 'Third-party mark present. No paid media without a human.',
  },
  public_figure_name: {
    stage: 'trademark',
    severity: 'restrict',
    publicCode: 'impersonation_or_trademark',
    description: 'Public figure named. No paid media without a human.',
  },
  impersonation_claim: {
    stage: 'trademark',
    severity: 'block',
    publicCode: 'impersonation_or_trademark',
    description: 'Claims official status, endorsement, or partnership.',
  },
  csam_hash_match: {
    stage: 'perceptual',
    severity: 'block',
    publicCode: 'child_safety',
    description: 'Image matched a known child sexual abuse material hash.',
    escalateOutOfBand: true,
  },
  logo_match: {
    stage: 'perceptual',
    severity: 'restrict',
    publicCode: 'impersonation_or_trademark',
    description: 'Image matched a protected logo.',
  },
  face_match_public_figure: {
    stage: 'perceptual',
    severity: 'restrict',
    publicCode: 'impersonation_or_trademark',
    description: 'Image matched a public figure.',
  },
  perceptual_unavailable: {
    stage: 'perceptual',
    severity: 'restrict',
    publicCode: 'unreviewable',
    description: 'A perceptual provider was unreachable. Fail closed.',
  },
  image_unscreened: {
    stage: 'perceptual',
    severity: 'restrict',
    publicCode: 'unreviewable',
    description: 'An image was presented without a completed hash check.',
  },
  adjudication_hate: {
    stage: 'adjudication',
    severity: 'block',
    publicCode: 'hate_or_harassment',
    description: 'Adjudicator labelled the subject hate or harassment.',
  },
  adjudication_sexual: {
    stage: 'adjudication',
    severity: 'block',
    publicCode: 'sexual_content',
    description: 'Adjudicator labelled the subject sexually explicit.',
  },
  adjudication_child_safety: {
    stage: 'adjudication',
    severity: 'block',
    publicCode: 'child_safety',
    description: 'Adjudicator raised a child-safety label.',
    escalateOutOfBand: true,
  },
  adjudication_tragedy: {
    stage: 'adjudication',
    severity: 'block',
    publicCode: 'tragedy_exploitation',
    description: 'Adjudicator labelled the subject tragedy exploitation.',
  },
  adjudication_impersonation: {
    stage: 'adjudication',
    severity: 'restrict',
    publicCode: 'impersonation_or_trademark',
    description: 'Adjudicator labelled the subject impersonation.',
  },
  adjudication_deceptive: {
    stage: 'adjudication',
    severity: 'block',
    publicCode: 'deceptive_or_fraudulent',
    description: 'Adjudicator labelled the subject deceptive or fraudulent.',
  },
  adjudication_violence: {
    stage: 'adjudication',
    severity: 'block',
    publicCode: 'violence',
    description: 'Adjudicator labelled the subject violent.',
  },
  adjudication_borderline: {
    stage: 'adjudication',
    severity: 'restrict',
    publicCode: 'unreviewable',
    description: 'Adjudicator could not resolve the subject against the rubric.',
  },
  adjudication_unavailable: {
    stage: 'adjudication',
    severity: 'restrict',
    publicCode: 'unreviewable',
    description: 'Adjudication failed, timed out, or returned a malformed body.',
  },
  human_rejected_paid_media: {
    stage: 'human',
    severity: 'restrict',
    publicCode: 'operator_policy',
    description: 'A reviewer refused paid media for this subject.',
  },
  human_escalated: {
    stage: 'human',
    severity: 'restrict',
    publicCode: 'unreviewable',
    description: 'A reviewer escalated rather than deciding.',
  },
  human_blocked: {
    stage: 'human',
    severity: 'block',
    publicCode: 'operator_policy',
    description: 'A reviewer blocked the subject outright.',
  },
  previously_blocked: {
    stage: 'lexicon',
    severity: 'block',
    publicCode: 'operator_policy',
    description: 'This token was blocked under earlier metadata. Renaming does not cure it.',
  },
  internal_fail_closed: {
    stage: 'lexicon',
    severity: 'block',
    publicCode: 'unreviewable',
    description: 'Screening could not complete. Refuse rather than proceed.',
  },
}

/** Thrown wherever screening refuses rather than guessing. */
export class ScreeningFailClosed extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(`screening: ${message}`)
    this.name = 'ScreeningFailClosed'
  }
}

export function isFlagCode(value: unknown): value is FlagCode {
  return typeof value === 'string' && (FLAG_CODES as readonly string[]).includes(value)
}

export function specFor(code: FlagCode): FlagSpec {
  const spec = FLAG_SPECS[code]
  if (spec === undefined) {
    throw new ScreeningFailClosed(`unknown flag code "${String(code)}"`)
  }
  return spec
}

export function severityOf(code: FlagCode): FlagSeverity {
  return specFor(code).severity
}

export interface Flag {
  code: FlagCode
  stage: StageName
  severity: FlagSeverity
  /** Scrubbed, bounded excerpt. Never raw untrusted text. */
  evidence?: string
  /** Operator-facing note. Never contains subject content. */
  detail?: string
  raisedAtUnix: number
}

/** Construct a flag with the severity and stage taken from the closed spec. */
export function makeFlag(
  code: FlagCode,
  raisedAtUnix: number,
  parts: { evidence?: string; detail?: string } = {},
): Flag {
  const spec = specFor(code)
  const flag: Flag = {
    code,
    stage: spec.stage,
    severity: spec.severity,
    raisedAtUnix,
  }
  if (parts.evidence !== undefined) flag.evidence = parts.evidence
  if (parts.detail !== undefined) flag.detail = parts.detail
  return flag
}

function flagKey(flag: Flag): string {
  return `${flag.code}\u0000${flag.evidence ?? ''}\u0000${flag.detail ?? ''}`
}

/**
 * The only sanctioned way to combine stage output. Additive by construction:
 * there is no code path here that drops an element of `prior`.
 */
export function mergeFlags(prior: readonly Flag[], added: readonly Flag[]): Flag[] {
  const seen = new Set(prior.map(flagKey))
  const out = [...prior]
  for (const flag of added) {
    specFor(flag.code)
    const key = flagKey(flag)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(flag)
  }
  return out
}

/**
 * Runtime proof that a stage did not clear or soften an earlier hit. Called on
 * every stage boundary rather than trusted to code review.
 */
export function assertMonotonic(before: readonly Flag[], after: readonly Flag[]): void {
  const worst = new Map<FlagCode, number>()
  for (const flag of after) {
    const rank = SEVERITY_RANK[flag.severity]
    const current = worst.get(flag.code)
    if (current === undefined || rank > current) worst.set(flag.code, rank)
  }
  for (const flag of before) {
    const rank = worst.get(flag.code)
    if (rank === undefined) {
      throw new ScreeningFailClosed(`stage dropped a prior flag "${flag.code}"`)
    }
    if (rank < SEVERITY_RANK[flag.severity]) {
      throw new ScreeningFailClosed(`stage softened a prior flag "${flag.code}"`)
    }
  }
}

export function worstSeverity(flags: readonly Flag[]): FlagSeverity {
  let worst: FlagSeverity = 'note'
  for (const flag of flags) {
    if (SEVERITY_RANK[flag.severity] > SEVERITY_RANK[worst]) worst = flag.severity
  }
  return worst
}

export function verdictFor(flags: readonly Flag[]): ScreeningVerdict {
  switch (worstSeverity(flags)) {
    case 'block':
      return 'BLOCKED'
    case 'restrict':
      return 'RESTRICTED'
    case 'note':
      return 'CLEAR'
  }
}

/** RESTRICTED permits organic operations. Only CLEAR permits paid media. */
export function paidMediaPermitted(flags: readonly Flag[]): boolean {
  return verdictFor(flags) === 'CLEAR'
}

/**
 * A block that should follow the token across a metadata rewrite. An internal
 * failure is a block for this run only - it must not brand a token forever.
 */
export function isStickyBlock(flags: readonly Flag[]): boolean {
  return flags.some((f) => f.severity === 'block' && f.code !== 'internal_fail_closed')
}

export function requiresOutOfBandEscalation(flags: readonly Flag[]): boolean {
  return flags.some((f) => specFor(f.code).escalateOutOfBand === true)
}

/** The single public code for a decline. The most severe flag names it. */
export function declineCodeFor(flags: readonly Flag[]): DeclineCode {
  const blocking = flags.filter((f) => f.severity === 'block')
  const first = blocking[0]
  if (first === undefined) return 'operator_policy'
  const childSafety = blocking.find((f) => specFor(f.code).publicCode === 'child_safety')
  return specFor((childSafety ?? first).code).publicCode
}

/**
 * Stage 1: deterministic lexicon, trademark and sanctions screening.
 *
 * Pure functions over folded text. No network, no model, no clock beyond the
 * timestamp stamped on each flag. This stage carries the load: it is the only
 * one cheap enough to run on every coin on every metadata change, and every
 * flag it raises is permanent for the run - stages 2, 3 and 4 can add to its
 * output and can never subtract from it.
 */

import type { Flag, FlagCode, StageName } from './flags.js'
import { makeFlag } from './flags.js'
import type { Lexicon, CategoryHit, LexiconCategory } from './lexicon.js'
import type { SdnScreener } from './ofac.js'
import { excerpt } from './normalize.js'
import { redactEvidence, subjectText, type ScreeningSubject, type StageOutput } from './types.js'

export interface Stage1Options {
  maxEvidenceChars: number
  /**
   * When false, a deployment missing the slur list or running the sample SDN
   * list raises `lexicon_unconfigured` and can never issue a CLEAR verdict.
   * Set true only in tests that are not exercising the lexicon.
   */
  allowUnconfiguredLexicons: boolean
}

export interface Stage1Deps {
  lexicon: Lexicon
  sdn: SdnScreener
  options: Stage1Options
}

const LEXICON_STAGE: StageName = 'lexicon'
const TRADEMARK_STAGE: StageName = 'trademark'

const BLOCKING_CATEGORIES: Partial<Record<LexiconCategory, FlagCode>> = {
  hate: 'hate_lexicon',
  slur: 'slur_lexicon',
  tragedy: 'tragedy_exploitation',
  sexual_explicit: 'sexual_explicit',
  violence: 'violence_incitement',
}

function firstOf(hits: readonly CategoryHit[], category: LexiconCategory): CategoryHit | undefined {
  return hits.find((h) => h.category === category)
}

function evidenceFor(raw: string, hit: CategoryHit, maxChars: number): string {
  return redactEvidence(excerpt(raw, hit.startOffset, hit.endOffset), maxChars)
}

export function runStage1(
  subject: ScreeningSubject,
  deps: Stage1Deps,
  nowUnix: number,
): StageOutput {
  const raw = subjectText(subject)
  const hits = deps.lexicon.scan(raw)
  const flags: Flag[] = []
  const stages: StageName[] = [LEXICON_STAGE, TRADEMARK_STAGE]
  const max = deps.options.maxEvidenceChars

  for (const [category, code] of Object.entries(BLOCKING_CATEGORIES)) {
    if (code === undefined) continue
    const hit = firstOf(hits, category as LexiconCategory)
    if (hit === undefined) continue
    flags.push(makeFlag(code, nowUnix, { evidence: evidenceFor(raw, hit, max) }))
  }

  const suggestive = firstOf(hits, 'sexual_suggestive')
  if (suggestive !== undefined) {
    flags.push(
      makeFlag('sexual_suggestive', nowUnix, { evidence: evidenceFor(raw, suggestive, max) }),
    )
  }

  // A sexual term next to a reference to a minor is not two RESTRICTED signals
  // that average out. It is a hard block and an out-of-band escalation.
  const minor = firstOf(hits, 'minor_reference')
  const anySexual = firstOf(hits, 'sexual_explicit') ?? suggestive
  if (minor !== undefined && anySexual !== undefined) {
    flags.push(
      makeFlag('sexual_minor_context', nowUnix, {
        evidence: evidenceFor(raw, minor, max),
        detail: 'sexual term co-occurs with a reference to a minor',
      }),
    )
  }

  const trademark = firstOf(hits, 'trademark')
  if (trademark !== undefined) {
    flags.push(makeFlag('trademark_match', nowUnix, { evidence: evidenceFor(raw, trademark, max) }))
  }
  const figure = firstOf(hits, 'public_figure')
  if (figure !== undefined) {
    flags.push(makeFlag('public_figure_name', nowUnix, { evidence: evidenceFor(raw, figure, max) }))
  }

  // Parody is defensible. "Official" parody is not: a claim of authority on top
  // of someone else's mark is impersonation, and disclosure does not cure it.
  const official = firstOf(hits, 'official_claim')
  const impersonated = trademark ?? figure
  if (official !== undefined && impersonated !== undefined) {
    flags.push(
      makeFlag('impersonation_claim', nowUnix, {
        evidence: evidenceFor(raw, official, max),
        detail: 'claim of official status alongside a third-party mark or figure',
      }),
    )
  }

  const numeric = deps.lexicon.scanNumericCodes(raw)
  const hasHateContext = flags.some(
    (f) => f.code === 'hate_lexicon' || f.code === 'slur_lexicon',
  )
  for (const code of numeric) {
    if (code.requiresCorroboration && !hasHateContext) continue
    flags.push(
      makeFlag('hate_numeric_code', nowUnix, {
        detail: `numeric code ${code.digits}${code.requiresCorroboration ? ' corroborated by a lexicon hit' : ''}`,
      }),
    )
    break
  }

  // Sanctions. The list is checked for staleness and provenance BEFORE it is
  // consulted, so an unmaintained deployment cannot silently clear a coin.
  const listStatus = deps.sdn.listStatus(nowUnix)
  if (listStatus === 'stale') {
    flags.push(
      makeFlag('sanctions_list_stale', nowUnix, { detail: 'SDN list older than policy window' }),
    )
  } else if (listStatus === 'not_authoritative' && !deps.options.allowUnconfiguredLexicons) {
    flags.push(
      makeFlag('lexicon_unconfigured', nowUnix, {
        detail: 'SDN source is the non-authoritative sample list',
      }),
    )
  }

  for (const match of deps.sdn.match(raw)) {
    const code = match.strength === 'full' ? 'ofac_sdn_name_match' : 'ofac_sdn_partial_match'
    flags.push(
      makeFlag(code, nowUnix, {
        detail: `SDN uid ${match.uid}${match.program === undefined ? '' : ` (${match.program})`}`,
      }),
    )
  }

  if (!deps.lexicon.has('slur') && !deps.options.allowUnconfiguredLexicons) {
    flags.push(
      makeFlag('lexicon_unconfigured', nowUnix, {
        detail: 'no slur list loaded; configure LexiconSource before clearing any coin',
      }),
    )
  }

  return { stages, flags }
}

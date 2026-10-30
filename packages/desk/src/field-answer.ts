/**
 * The single primitive both tiers answer through.
 *
 * A fresh fact becomes a line plus a citation. A stale or absent field becomes
 * "I don't have that, here is how to check it yourself" plus an explorer link.
 * There is no third branch, which is the whole invariant: no code path in this
 * package turns a missing observation into a number.
 *
 * T0 and T1 differ in how they choose WHICH fields to answer with - a command
 * table versus a model - never in how a field becomes text.
 */

import type { DeskAnswer } from './answer.js'
import { citeFact, lookupFact, type Citation, type FactSheet } from './factsheet/builder.js'
import { FACT_LABELS, FACT_SELF_CHECK, type FactFieldId } from './factsheet/fields.js'
import { formatDuration } from './factsheet/render.js'
import { unknownFieldBody } from './refusal/templates.js'
import type { LanguageCode } from './text/normalize.js'

export interface FieldAnswerContext {
  sheet: FactSheet
  nowUnix: number
  language: LanguageCode
}

/** "the total supply" -> "Total supply". Labels stay code-owned either way. */
export function shortLabel(field: FactFieldId): string {
  const label = FACT_LABELS[field].replace(/^(the|whether) /, '')
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function verifyLink(sheet: FactSheet, field: FactFieldId): string {
  switch (field) {
    case 'holder_count':
    case 'top10_holder_share_pct':
    case 'deployer_supply_share_pct':
    case 'total_supply':
    case 'circulating_supply':
      return sheet.explorer.tokenUrl(sheet.token)
    default:
      return sheet.explorer.addressUrl(sheet.token)
  }
}

export function unknownFieldAnswer(ctx: FieldAnswerContext, field: FactFieldId): DeskAnswer {
  const found = lookupFact(ctx.sheet, field, ctx.nowUnix)
  const staleAge = found.status === 'stale' ? formatDuration(Math.max(0, found.ageSeconds)) : undefined
  return {
    kind: 'unknown_field',
    body: unknownFieldBody(ctx.language, {
      label: FACT_LABELS[field],
      selfCheck: FACT_SELF_CHECK[field],
      link: verifyLink(ctx.sheet, field),
      staleAge,
    }),
    citations: [],
    language: ctx.language,
    modelAuthored: false,
  }
}

export interface FieldLines {
  lines: string[]
  citations: Citation[]
  missing: FactFieldId[]
}

/** Render a set of fields, keeping present and missing strictly separated. */
export function renderFields(ctx: FieldAnswerContext, fields: FactFieldId[]): FieldLines {
  const lines: string[] = []
  const citations: Citation[] = []
  const missing: FactFieldId[] = []

  for (const field of fields) {
    const found = lookupFact(ctx.sheet, field, ctx.nowUnix)
    if (found.status !== 'fresh') {
      missing.push(field)
      continue
    }
    lines.push(`${shortLabel(field)}: ${found.fact.display}`)
    citations.push(citeFact(ctx.sheet, found.fact, ctx.nowUnix))
  }

  return { lines, citations, missing }
}

/**
 * Answer one field. The result is either a cited fact or an honest gap - the
 * property the test suite pins for every field in the vocabulary.
 */
export function answerField(ctx: FieldAnswerContext, field: FactFieldId): DeskAnswer {
  const found = lookupFact(ctx.sheet, field, ctx.nowUnix)
  if (found.status !== 'fresh') return unknownFieldAnswer(ctx, field)
  return {
    kind: 'fact',
    body: `${shortLabel(field)}: ${found.fact.display}`,
    citations: [citeFact(ctx.sheet, found.fact, ctx.nowUnix)],
    language: ctx.language,
    modelAuthored: false,
  }
}

/**
 * Answer several fields at once. Present fields are listed; missing ones get
 * their own honest gap appended, so a partial sheet still produces a useful
 * message without any field being papered over.
 */
export function answerFields(
  ctx: FieldAnswerContext,
  fields: FactFieldId[],
  heading?: string,
): DeskAnswer {
  const { lines, citations, missing } = renderFields(ctx, fields)

  if (lines.length === 0) {
    if (missing.length === 1) return unknownFieldAnswer(ctx, missing[0]!)
    const bodies = missing.map((field) => unknownFieldAnswer(ctx, field).body)
    return {
      kind: 'unknown_field',
      body: bodies.join('\n\n'),
      citations: [],
      language: ctx.language,
      modelAuthored: false,
    }
  }

  const parts: string[] = []
  if (heading) parts.push(heading)
  parts.push(lines.join('\n'))
  for (const field of missing) parts.push(unknownFieldAnswer(ctx, field).body)

  return {
    kind: 'fact',
    body: parts.join('\n\n'),
    citations,
    language: ctx.language,
    modelAuthored: false,
  }
}

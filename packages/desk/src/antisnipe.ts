/**
 * The anti-snipe tax explainer.
 *
 * Venue V2 charges roughly 99% at t=0 and decays it to zero over about three
 * seconds, and that tax flows to the fee recipient along the SAME rails as
 * ordinary creator fees. Two predictable consequences, both of which generate
 * tickets, and both of which this module exists to answer before they arrive:
 *
 *   1. A holder who bought in the first block sees almost nothing arrive and
 *      concludes they were scammed. They were not; they traded inside a
 *      published window against a published, decaying tax.
 *   2. A dev sees an enormous credit in the first minute and concludes the
 *      accounting is broken. It is not; the anti-snipe take lands in the normal
 *      creator-fee stream and is split under the same terms as every other
 *      credit, with the dev leg still pull-only by the dev's own address.
 *
 * WHAT THIS MODULE WILL NOT DO. It will not tell any individual what they paid.
 * The decay SHAPE is not readable from the two parameters the desk can observe,
 * so every curve figure here is labelled as an approximation and every
 * individual question is answered with "read your own transaction, here is the
 * link". Quoting a specific person a specific tax we have not verified would be
 * exactly the invented value this desk exists to not produce.
 */

import type { Address } from '@fee-split-vaults/core'
import type { DeskAnswer } from './answer.js'
import { citeFact, lookupFact, type Citation, type FactSheet } from './factsheet/builder.js'
import type { FactFieldId } from './factsheet/fields.js'
import { formatBpsAsPercent } from './factsheet/render.js'
import { unknownFieldAnswer, type FieldAnswerContext } from './field-answer.js'
import { foldPattern, normalize } from './text/normalize.js'

/**
 * The documented curve. Used only when the chain read is unavailable, and always
 * surfaced with 'protocol_doc' provenance so nobody mistakes it for a reading of
 * a particular token.
 */
export const DOCUMENTED_ANTISNIPE = {
  initialBps: 9_900,
  windowSeconds: 3,
} as const

export interface AntiSnipeParams {
  initialBps: number
  windowSeconds: number
}

/**
 * Linear approximation of the decay, for explaining SHAPE only.
 *
 * The real curve is enforced on chain and its exact form is not derivable from
 * the two parameters available here. Never quote the output of this function to
 * a holder as the tax they paid.
 */
export function antiSnipeTaxBpsAt(secondsSinceLaunch: number, params: AntiSnipeParams): number {
  if (!Number.isFinite(secondsSinceLaunch) || secondsSinceLaunch < 0) return params.initialBps
  if (params.windowSeconds <= 0) return 0
  if (secondsSinceLaunch >= params.windowSeconds) return 0
  const remaining = 1 - secondsSinceLaunch / params.windowSeconds
  return Math.max(0, Math.round(params.initialBps * remaining))
}

export function isWithinAntiSnipeWindow(
  launchUnix: number,
  atUnix: number,
  params: AntiSnipeParams,
): boolean {
  return atUnix >= launchUnix && atUnix - launchUnix < params.windowSeconds
}

/** Read the curve from the sheet, preferring an observed value over the doc. */
export function antiSnipeParamsFrom(
  sheet: FactSheet,
  nowUnix: number,
): { params: AntiSnipeParams; citations: Citation[]; observed: boolean } | undefined {
  const initial = lookupFact(sheet, 'antisnipe_initial_bps', nowUnix)
  const window = lookupFact(sheet, 'antisnipe_window_seconds', nowUnix)
  if (initial.status !== 'fresh' || window.status !== 'fresh') return undefined
  if (initial.fact.value.kind !== 'bps' || window.fact.value.kind !== 'duration_seconds') return undefined
  return {
    params: {
      initialBps: initial.fact.value.bps,
      windowSeconds: window.fact.value.seconds,
    },
    citations: [citeFact(sheet, initial.fact, nowUnix), citeFact(sheet, window.fact, nowUnix)],
    observed:
      initial.fact.provenance.source === 'chain_read' && window.fact.provenance.source === 'chain_read',
  }
}

export function antiSnipeExemptWallets(
  sheet: FactSheet,
  nowUnix: number,
): { wallets: Address[]; citation: Citation } | undefined {
  const found = lookupFact(sheet, 'antisnipe_exempt_wallets', nowUnix)
  if (found.status !== 'fresh' || found.fact.value.kind !== 'address_list') return undefined
  return {
    wallets: found.fact.value.addresses,
    citation: citeFact(sheet, found.fact, nowUnix),
  }
}

/**
 * The full explainer, answered from the sheet. Missing curve parameters produce
 * the ordinary "I don't have that" answer rather than the documented default:
 * the default is a protocol fact, and if it is not on the sheet it was not
 * observed and is not ours to assert about this token.
 */
export function explainAntiSnipe(ctx: FieldAnswerContext): DeskAnswer {
  const { sheet, nowUnix } = ctx
  const curve = antiSnipeParamsFrom(sheet, nowUnix)
  if (!curve) return unknownFieldAnswer(ctx, 'antisnipe_window_seconds')

  const { params, citations, observed } = curve
  const midpoint = Math.max(1, Math.floor(params.windowSeconds / 2))

  const lines: string[] = [
    'Anti-snipe window, in plain terms:',
    `- The first trades after launch pay a tax that starts near ${formatBpsAsPercent(params.initialBps)} and falls to zero across about ${params.windowSeconds}s.`,
    `- Roughly ${midpoint}s in it is already far below the opening figure (the exact curve is enforced on chain; treat the shape here as approximate).`,
    '- That tax goes to the creator fee recipient over the same rails as every other creator fee. It is not a separate contract, a hidden wallet, or a withdrawal.',
    '- It exists to make first-block sniping unprofitable. It is not retroactive and it does not apply to trades after the window.',
  ]

  const outCitations = [...citations]

  const exempt = antiSnipeExemptWallets(sheet, nowUnix)
  if (exempt) {
    lines.push(
      exempt.wallets.length === 0
        ? '- Exempt wallets: none are configured for this token.'
        : `- Exempt wallets (${exempt.wallets.length}): ${exempt.wallets.join(', ')}`,
    )
    outCitations.push(exempt.citation)
  } else {
    lines.push(
      "- Exempt wallets: I have not verified that list, so I will not summarise it. Read the exempt list on the Venue hook in the explorer: " +
        sheet.explorer.addressUrl(sheet.token),
    )
  }

  if (!observed) {
    lines.push(
      '- Note: these two figures are the documented protocol parameters, not a reading of this token. Check them against the hook yourself: ' +
        sheet.explorer.addressUrl(sheet.token),
    )
  }

  lines.push(
    `- To see what YOUR trade paid, open your own transaction on ${sheet.explorer.name} and read the transfers. I do not have per-wallet figures and will not estimate them.`,
  )

  return {
    kind: 'fact',
    body: lines.join('\n'),
    citations: outCitations,
    language: ctx.language,
    modelAuthored: false,
  }
}

/**
 * Proactive disclosure, pinned at launch. The mitigation for the "I got
 * scammed" ticket is publishing the window BEFORE anyone trades into it, not
 * explaining it afterwards.
 */
export function antiSnipeLaunchNotice(ctx: FieldAnswerContext): DeskAnswer {
  const curve = antiSnipeParamsFrom(ctx.sheet, ctx.nowUnix)
  if (!curve) return unknownFieldAnswer(ctx, 'antisnipe_window_seconds')
  const { params, citations } = curve
  const body = [
    'Before you trade: this token launches with an anti-snipe tax.',
    `- It starts near ${formatBpsAsPercent(params.initialBps)} at the very first moment and decays to zero over about ${params.windowSeconds}s.`,
    '- Buying inside that window means paying most of the trade as tax. Waiting past it means paying none of it.',
    '- The tax goes to the creator fee recipient on the normal fee rails. Nothing is hidden and nothing is discretionary.',
    `- Verify both figures yourself on ${ctx.sheet.explorer.name}: ${ctx.sheet.explorer.addressUrl(ctx.sheet.token)}`,
  ].join('\n')

  return {
    kind: 'fact',
    body,
    citations,
    language: ctx.language,
    modelAuthored: false,
  }
}

/**
 * The dev-facing half. A first-minute credit that dwarfs steady-state fees is
 * the anti-snipe take, not a bug and not a windfall the operator kept.
 */
export function explainWindfallCredit(ctx: FieldAnswerContext): DeskAnswer {
  const curve = antiSnipeParamsFrom(ctx.sheet, ctx.nowUnix)
  const citations: Citation[] = curve ? curve.citations : []
  const opening = curve
    ? `near ${formatBpsAsPercent(curve.params.initialBps)} for about ${curve.params.windowSeconds}s`
    : 'very high for the first seconds after launch'

  const body = [
    'That first credit is almost certainly the anti-snipe tax, not an error.',
    `- The tax is ${opening} and it is charged to whoever trades inside that window.`,
    '- It reaches the creator fee recipient through the ordinary fee path, so it lands in the same stream as steady-state fees and is split under the same terms.',
    '- It is one-off. Do not read it as a run rate; the following days will look nothing like it.',
    '- Your leg stays withdrawable only by your own payout address, in the same asset it arrived in. No conversion happens on the way.',
    `- Reconcile it against the pool's fee events yourself: ${ctx.sheet.explorer.addressUrl(ctx.sheet.token)}`,
  ].join('\n')

  return { kind: 'fact', body, citations, language: ctx.language, modelAuthored: false }
}

/**
 * Deterministic detection of the ticket this module answers, so T0 can handle it
 * without a model. Matching is on the normalised views, same as the classifier.
 */
const ANTISNIPE_COMPLAINT = foldPattern(
  /(igotscammed|iwasscammed|scammedme|thisisascam|igotrugged|stolemymoney|tookmymoney|onlygot|wheredidmymoneygo|wheresmytokens|wherearemytokens|lostmostofit|hugetax|massivetax|taxwas|whyisthetaxso)/,
)

const ANTISNIPE_CONTEXT = foldPattern(/(bought|swap|trade|buy|first|launch|snipe|tax|fee)/)

export function looksLikeAntiSnipeTicket(text: string): boolean {
  const { squeezed, lower } = normalize(text)
  const complaint = ANTISNIPE_COMPLAINT.test(squeezed) || /\b99\s?%/.test(lower)
  return complaint && ANTISNIPE_CONTEXT.test(squeezed)
}

/** Fields the anti-snipe answers depend on, for cache priority and tests. */
export const ANTISNIPE_FIELDS: readonly FactFieldId[] = [
  'antisnipe_initial_bps',
  'antisnipe_window_seconds',
  'antisnipe_exempt_wallets',
]

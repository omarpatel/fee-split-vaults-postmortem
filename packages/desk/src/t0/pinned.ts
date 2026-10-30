/**
 * The pinned FactSheet.
 *
 * The pin is the highest-leverage artefact the free tier has. A holder who has
 * the real contract address in front of them does not click the lookalike, and
 * a holder who read the anti-snipe window before trading does not open a ticket
 * claiming theft afterwards.
 *
 * The rendering deliberately omits reading ages, so the text only changes when
 * a VALUE changes. A pin that is rewritten every refresh trains everyone to
 * ignore the pin.
 */

import { createHash } from 'node:crypto'
import { renderOutbound, type DeskAnswer, type OutboundOptions } from '../answer.js'
import { antiSnipeParamsFrom } from '../antisnipe.js'
import { lookupFact } from '../factsheet/builder.js'
import type { FactFieldId } from '../factsheet/fields.js'
import { formatBpsAsPercent } from '../factsheet/render.js'
import { shortLabel, type FieldAnswerContext } from '../field-answer.js'
import type { TelegramClient } from '../telegram/client.js'

const PINNED_FIELDS: readonly FactFieldId[] = [
  'contract_address',
  'chain_id',
  'token_symbol',
  'total_supply',
  'circulating_supply',
  'quote_asset_symbol',
  'lp_locked',
  'holder_count',
  'top10_holder_share_pct',
  'creator_net_bps',
  'fee_recipient',
]

const SAFETY_RULES = [
  'Rules that never change:',
  '- No admin will ever DM you first. Anyone who does is not staff.',
  '- Nobody here will ever ask for a seed phrase, a private key, or a wallet connection to "verify" anything.',
  '- Links posted by anyone other than the pinned set get removed. That is not censorship, it is the drainer defence.',
  '- I answer facts and cite where each one came from. Anything I have not read, I say so.',
]

export function renderPinnedFactSheet(ctx: FieldAnswerContext): DeskAnswer {
  const lines: string[] = ['Verified facts for this token:']
  let verified = 0

  for (const field of PINNED_FIELDS) {
    const found = lookupFact(ctx.sheet, field, ctx.nowUnix)
    if (found.status !== 'fresh') continue
    lines.push(`${shortLabel(field)}: ${found.fact.display}`)
    verified++
  }

  if (verified === 0) {
    lines.push('(none are currently verified - the desk will not print unverified values)')
  }

  const curve = antiSnipeParamsFrom(ctx.sheet, ctx.nowUnix)
  if (curve) {
    lines.push(
      '',
      `Launch tax window: starts near ${formatBpsAsPercent(curve.params.initialBps)} and decays to zero over about ${curve.params.windowSeconds}s after launch. It goes to the creator fee recipient on the normal fee rails.`,
    )
  }

  lines.push('', `Check every line yourself: ${ctx.sheet.explorer.tokenUrl(ctx.sheet.token)}`)
  lines.push('', ...SAFETY_RULES)

  return {
    kind: 'fact',
    body: lines.join('\n'),
    citations: [],
    language: ctx.language,
    modelAuthored: false,
  }
}

export interface PinState {
  messageId: string
  bodyHash: string
  pinnedAtUnix: number
}

/**
 * Keeps one pinned message current. Re-pins only when the rendered values
 * actually differ, and unpins the message it replaces so a chat never
 * accumulates three contradictory pins.
 */
export class PinnedFactSheetManager {
  private state: PinState | undefined

  constructor(
    private readonly client: TelegramClient,
    private readonly chatId: string,
    private readonly outbound: OutboundOptions,
  ) {}

  current(): PinState | undefined {
    return this.state
  }

  async sync(ctx: FieldAnswerContext): Promise<{ changed: boolean; state?: PinState }> {
    const answer = renderPinnedFactSheet(ctx)
    const text = renderOutbound(answer, { ...this.outbound, includeCitations: false })
    const bodyHash = createHash('sha256').update(text).digest('hex').slice(0, 16)

    if (this.state && this.state.bodyHash === bodyHash) {
      return { changed: false, state: this.state }
    }

    const sent = await this.client.sendMessage(this.chatId, text, { disableLinkPreview: true, silent: true })
    await this.client.pinMessage(this.chatId, sent.messageId, true)

    const previous = this.state
    this.state = { messageId: sent.messageId, bodyHash, pinnedAtUnix: ctx.nowUnix }
    if (previous) {
      try {
        await this.client.unpinMessage(this.chatId, previous.messageId)
      } catch {
        // A pin that cannot be removed is a cosmetic problem, not a safety one.
      }
    }
    return { changed: true, state: this.state }
  }
}

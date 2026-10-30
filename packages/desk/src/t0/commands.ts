/**
 * T0: the deterministic bot. NO MODEL IS INVOLVED ON THIS PATH AT ALL.
 *
 * Every answer below is a table lookup against the cached FactSheet plus a
 * fixed string. That is what makes the tier cost about a cent per coin per day
 * and, more importantly, what makes it honest: at T0 there is nothing in the
 * loop that COULD invent a number.
 *
 * This is not a degraded agent. It is a venue plus a janitor, which is the
 * correct product at this budget - and it is the acquisition funnel, so the
 * facts it does serve have to be right.
 */

import { creatorNetBps } from '../../../../config/protocol.js'
import type { DeskAnswer } from '../answer.js'
import { explainAntiSnipe } from '../antisnipe.js'
import { lookupFact } from '../factsheet/builder.js'
import { answerFields, renderFields, unknownFieldAnswer, type FieldAnswerContext } from '../field-answer.js'

export const T0_COMMANDS = [
  'ca',
  'supply',
  'lp',
  'holders',
  'fees',
  'pool',
  'antisnipe',
  'facts',
  'help',
] as const

export type T0Command = (typeof T0_COMMANDS)[number]

export interface ParsedCommand {
  command: T0Command
  args: string
}

/**
 * Parse a slash command. Telegram appends @botname in group chats; a command
 * addressed to a DIFFERENT bot is not ours and is not answered.
 */
export function parseCommand(text: string, botUsername?: string): ParsedCommand | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return undefined
  const match = /^\/([a-z_]{1,20})(@([A-Za-z0-9_]{1,64}))?(\s+([\s\S]*))?$/i.exec(trimmed)
  if (!match) return undefined

  const [, rawCommand, , addressee, , rest] = match
  if (addressee && botUsername && addressee.toLowerCase() !== botUsername.toLowerCase()) {
    return undefined
  }
  const command = (rawCommand ?? '').toLowerCase()
  if (!(T0_COMMANDS as readonly string[]).includes(command)) return undefined
  return { command: command as T0Command, args: (rest ?? '').trim() }
}

const HELP_BODY = [
  'What I can verify for you, straight from chain reads:',
  '/ca - contract address and chain',
  '/supply - total, burned, locked and circulating supply',
  '/pool - pool id, quote asset and reserves',
  '/lp - whether LP is locked and until when',
  '/holders - holder count and concentration',
  '/fees - the creator fee rate for this token and what has been credited',
  '/antisnipe - the launch tax window and exempt wallets',
  '/facts - all of the above in one pinned message',
  '',
  'Every figure comes with the call it came from and how old the reading is.',
  'Anything I have not verified, I say so and hand you the link to check it yourself.',
  'I do not discuss value, timing, or what anyone ought to do with their money.',
].join('\n')

export function helpAnswer(ctx: FieldAnswerContext): DeskAnswer {
  return {
    kind: 'help',
    body: HELP_BODY,
    citations: [],
    language: ctx.language,
    modelAuthored: false,
  }
}

function caAnswer(ctx: FieldAnswerContext): DeskAnswer {
  const answer = answerFields(ctx, ['contract_address', 'chain_id', 'token_symbol'], 'Contract:')
  if (answer.kind !== 'fact') return answer
  answer.body +=
    `\n\nOn ${ctx.sheet.explorer.name}: ${ctx.sheet.explorer.tokenUrl(ctx.sheet.token)}` +
    '\nCompare it character by character against this pin. Lookalike addresses are posted in this chat constantly.'
  return answer
}

function feesAnswer(ctx: FieldAnswerContext): DeskAnswer {
  const { lines, citations, missing } = renderFields(ctx, [
    'creator_net_bps',
    'buyback_enabled',
    'creator_tax_bps',
    'fees_credited_24h_usd',
    'fees_credited_lifetime_usd',
  ])

  const parts: string[] = []
  if (lines.length > 0) parts.push('Fees for this token:\n' + lines.join('\n'))

  // The rate BRANCHES on the per-token buyback flag. Never a fixed figure.
  const buyback = lookupFact(ctx.sheet, 'buyback_enabled', ctx.nowUnix)
  const tax = lookupFact(ctx.sheet, 'creator_tax_bps', ctx.nowUnix)
  if (buyback.status === 'fresh' && buyback.fact.value.kind === 'bool') {
    const taxBps = tax.status === 'fresh' && tax.fact.value.kind === 'bps' ? tax.fact.value.bps : 0
    const alternative = creatorNetBps(!buyback.fact.value.value, taxBps)
    parts.push(
      `The creator rate is not a fixed number across Venue tokens: it depends on this token's buyback setting. ` +
        `With buyback ${buyback.fact.value.value ? 'off' : 'on'} instead, the same token would credit ${(alternative / 100).toFixed(2)}% of volume.`,
    )
  }

  for (const field of missing) parts.push(unknownFieldAnswer(ctx, field).body)

  if (lines.length === 0) {
    return {
      kind: 'unknown_field',
      body: parts.join('\n\n'),
      citations: [],
      language: ctx.language,
      modelAuthored: false,
    }
  }

  return {
    kind: 'fact',
    body: parts.join('\n\n'),
    citations,
    language: ctx.language,
    modelAuthored: false,
  }
}

export function factsAnswer(ctx: FieldAnswerContext): DeskAnswer {
  return answerFields(
    ctx,
    [
      'contract_address',
      'chain_id',
      'token_symbol',
      'total_supply',
      'circulating_supply',
      'pool_id',
      'quote_asset_symbol',
      'pool_liquidity_usd',
      'lp_locked',
      'holder_count',
      'top10_holder_share_pct',
      'creator_net_bps',
      'fee_recipient',
    ],
    'Verified facts:',
  )
}

/**
 * Dispatch. Total over the command set - a command with no handler would be a
 * compile error, not a silent fallthrough.
 */
export function handleT0Command(command: T0Command, ctx: FieldAnswerContext): DeskAnswer {
  switch (command) {
    case 'ca':
      return caAnswer(ctx)
    case 'supply':
      return answerFields(
        ctx,
        ['total_supply', 'burned_supply', 'locked_supply', 'circulating_supply'],
        'Supply:',
      )
    case 'lp':
      return answerFields(ctx, ['lp_locked', 'lp_unlock_unix', 'locked_supply'], 'Liquidity lock:')
    case 'holders':
      return answerFields(
        ctx,
        ['holder_count', 'top10_holder_share_pct', 'deployer_supply_share_pct'],
        'Holders:',
      )
    case 'fees':
      return feesAnswer(ctx)
    case 'pool':
      return answerFields(
        ctx,
        [
          'pool_id',
          'quote_asset_symbol',
          'pool_quote_reserve',
          'pool_token_reserve',
          'pool_liquidity_usd',
        ],
        'Pool:',
      )
    case 'antisnipe':
      return explainAntiSnipe(ctx)
    case 'facts':
      return factsAnswer(ctx)
    case 'help':
      return helpAnswer(ctx)
  }
}

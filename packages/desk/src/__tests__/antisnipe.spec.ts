/**
 * The anti-snipe explainer.
 *
 * This is the support ticket a Venue launch produces on day one: a 99% tax at
 * t=0 that decays over about three seconds and flows to the fee recipient along
 * the normal rails, which looks exactly like theft to the buyer and exactly
 * like a broken ledger to the dev.
 */

import { describe, expect, it } from 'vitest'
import {
  DOCUMENTED_ANTISNIPE,
  antiSnipeExemptWallets,
  antiSnipeLaunchNotice,
  antiSnipeParamsFrom,
  antiSnipeTaxBpsAt,
  explainAntiSnipe,
  explainWindfallCredit,
  isWithinAntiSnipeWindow,
  looksLikeAntiSnipeTicket,
} from '../antisnipe.js'
import { buildFactSheet } from '../factsheet/builder.js'
import { FakeDeskChainReader } from '../factsheet/chain-reader.js'
import { urlExplorer } from '../factsheet/render.js'
import type { FieldAnswerContext } from '../field-answer.js'
import { classifyRefusal } from '../refusal/classifier.js'
import type { FakeChainState } from '../factsheet/chain-reader.js'
import { chainState, EXPLORER_BASE, makeSheet, NOW, TOKEN, VAULT } from './fixtures.js'

const EXEMPT = ['0x5555555555555555555555555555555555555555', '0x6666666666666666666666666666666666666666']

async function ctxWith(antiSnipe: FakeChainState['antiSnipe'], documented = false) {
  const reader = new FakeDeskChainReader(chainState({ antiSnipe }))
  const sheet = await buildFactSheet({
    vault: VAULT,
    token: TOKEN,
    tier: 'T1',
    reader,
    explorer: urlExplorer(EXPLORER_BASE, 'the chain 4663 explorer'),
    nowUnix: NOW,
    documentedAntiSnipe: documented ? DOCUMENTED_ANTISNIPE : undefined,
  })
  const ctx: FieldAnswerContext = { sheet, nowUnix: NOW, language: 'en' }
  return ctx
}

describe('the decay curve', () => {
  const params = { initialBps: 9_900, windowSeconds: 3 }

  it('opens at the initial rate and reaches zero at the edge', () => {
    expect(antiSnipeTaxBpsAt(0, params)).toBe(9_900)
    expect(antiSnipeTaxBpsAt(1.5, params)).toBe(4_950)
    expect(antiSnipeTaxBpsAt(3, params)).toBe(0)
    expect(antiSnipeTaxBpsAt(300, params)).toBe(0)
  })

  it('fails closed on nonsense inputs', () => {
    expect(antiSnipeTaxBpsAt(Number.NaN, params)).toBe(9_900)
    expect(antiSnipeTaxBpsAt(-5, params)).toBe(9_900)
    expect(antiSnipeTaxBpsAt(1, { initialBps: 9_900, windowSeconds: 0 })).toBe(0)
  })

  it('knows when a trade fell inside the window', () => {
    expect(isWithinAntiSnipeWindow(NOW, NOW + 1, params)).toBe(true)
    expect(isWithinAntiSnipeWindow(NOW, NOW + 3, params)).toBe(false)
  })
})

describe('the explainer', () => {
  it('states the window, the destination and the self-check, with citations', async () => {
    const ctx = await ctxWith({ initialBps: 9_900, windowSeconds: 3, exemptWallets: EXEMPT })
    const answer = explainAntiSnipe(ctx)

    expect(answer.kind).toBe('fact')
    expect(answer.body).toContain('99.00%')
    expect(answer.body).toContain('3s')
    expect(answer.body).toContain('creator fee recipient')
    expect(answer.body).toContain('open your own transaction')
    expect(answer.citations.map((citation) => citation.field)).toContain('antisnipe_window_seconds')
  })

  it('surfaces the exempt wallet list when it has been read', async () => {
    const ctx = await ctxWith({ initialBps: 9_900, windowSeconds: 3, exemptWallets: EXEMPT })
    const answer = explainAntiSnipe(ctx)
    expect(answer.body).toContain(`Exempt wallets (2)`)
    expect(answer.body).toContain(EXEMPT[0]!)
    expect(antiSnipeExemptWallets(ctx.sheet, NOW)?.wallets).toEqual(EXEMPT)
  })

  it('says the exempt list is empty when it is genuinely empty', async () => {
    const ctx = await ctxWith({ initialBps: 9_900, windowSeconds: 3, exemptWallets: [] })
    expect(explainAntiSnipe(ctx).body).toContain('none are configured')
  })

  it('refuses to summarise an exempt list it has not read', async () => {
    const ctx = await ctxWith({ initialBps: 9_900, windowSeconds: 3 })
    const answer = explainAntiSnipe(ctx)
    expect(answer.body).toContain('I have not verified that list')
    expect(antiSnipeExemptWallets(ctx.sheet, NOW)).toBeUndefined()
  })

  it('labels documented parameters as documented, not as a reading', async () => {
    const ctx = await ctxWith({}, true)
    const curve = antiSnipeParamsFrom(ctx.sheet, NOW)
    expect(curve?.observed).toBe(false)
    const answer = explainAntiSnipe(ctx)
    expect(answer.body).toContain('documented protocol parameters, not a reading of this token')
  })

  it('gives the ordinary gap answer when the curve was never established', async () => {
    const ctx = await ctxWith({})
    const answer = explainAntiSnipe(ctx)
    expect(answer.kind).toBe('unknown_field')
    expect(answer.body).toContain(EXPLORER_BASE)
  })
})

describe('proactive disclosure and the dev-side explanation', () => {
  it('publishes the window before anyone trades into it', async () => {
    const ctx = await ctxWith({ initialBps: 9_900, windowSeconds: 3 })
    const notice = antiSnipeLaunchNotice(ctx)
    expect(notice.body).toContain('Before you trade')
    expect(notice.body).toContain('99.00%')
    expect(notice.body).toContain('decays to zero')
  })

  it('tells the dev the windfall is one-off and their leg is unconverted', async () => {
    const ctx = await ctxWith({ initialBps: 9_900, windowSeconds: 3 })
    const answer = explainWindfallCredit(ctx)
    expect(answer.body).toContain('not an error')
    expect(answer.body).toContain('one-off')
    expect(answer.body).toContain('in the same asset it arrived in')
  })

  it('keeps every anti-snipe string clear of the refusal classifier', async () => {
    const ctx = await ctxWith({ initialBps: 9_900, windowSeconds: 3, exemptWallets: EXEMPT })
    for (const body of [
      explainAntiSnipe(ctx).body,
      antiSnipeLaunchNotice(ctx).body,
      explainWindfallCredit(ctx).body,
    ]) {
      const decision = classifyRefusal(body, 'output')
      expect(decision.refused, decision.classes.join(',')).toBe(false)
    }
  })
})

describe('ticket detection', () => {
  it('recognises the "I got scammed" shape', () => {
    for (const text of [
      'i got scammed, i bought at launch and got almost nothing',
      'the tax was 99% on my first buy, where did my money go',
      'i bought in the first second and this is a scam, they took my money',
      'why is the tax so huge on the launch swap',
    ]) {
      expect(looksLikeAntiSnipeTicket(text), text).toBe(true)
    }
  })

  it('does not fire on ordinary complaints', () => {
    for (const text of [
      'the chart looks bad today',
      'my transaction failed, gas too low',
      'gm everyone',
      'is the lp locked',
    ]) {
      expect(looksLikeAntiSnipeTicket(text), text).toBe(false)
    }
  })

  it('is not fooled by spacing or stretched letters', () => {
    expect(looksLikeAntiSnipeTicket('i g o t  s c a m m e d on my launch buy')).toBe(true)
    expect(looksLikeAntiSnipeTicket('i gooot scammmmed buying at launch')).toBe(true)
  })
})

describe('the sheet keeps anti-snipe provenance honest', () => {
  it('marks a chain-read curve as observed', async () => {
    const sheet = await makeSheet()
    const curve = antiSnipeParamsFrom(sheet, NOW)
    expect(curve?.observed).toBe(true)
    expect(curve?.params).toEqual({ initialBps: 9_900, windowSeconds: 3 })
  })
})

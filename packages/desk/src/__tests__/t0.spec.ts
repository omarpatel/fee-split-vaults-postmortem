/**
 * T0: the deterministic tier.
 *
 * Two things are being pinned here. First, that the commands answer from the
 * cached sheet with a citation and never from anywhere else. Second, that every
 * string T0 can emit survives the desk's own output classifier - a free tier
 * that refuses its own /fees answer is worse than no free tier.
 */

import { describe, expect, it } from 'vitest'
import { renderOutbound } from '../answer.js'
import { lookupFact } from '../factsheet/builder.js'
import { FACT_SELF_CHECK } from '../factsheet/fields.js'
import type { FieldAnswerContext } from '../field-answer.js'
import { classifyRefusal } from '../refusal/classifier.js'
import { T0_COMMANDS, handleT0Command, parseCommand } from '../t0/commands.js'
import { PinnedFactSheetManager, renderPinnedFactSheet } from '../t0/pinned.js'
import { FakeTelegramClient } from '../telegram/client.js'
import { makeSheet, NOW, OUTBOUND, TOKEN } from './fixtures.js'

async function fullContext(): Promise<FieldAnswerContext> {
  const sheet = await makeSheet({ withHolders: true, withLedger: true })
  return { sheet, nowUnix: NOW, language: 'en' }
}

describe('command parsing', () => {
  it('parses a bare command', () => {
    expect(parseCommand('/ca')).toEqual({ command: 'ca', args: '' })
  })

  it('parses a command addressed to this bot', () => {
    expect(parseCommand('/supply@example_bot extra', 'example_bot')).toEqual({
      command: 'supply',
      args: 'extra',
    })
  })

  it('ignores a command addressed to another bot', () => {
    expect(parseCommand('/supply@some_other_bot', 'example_bot')).toBeUndefined()
  })

  it('ignores unknown commands and plain text', () => {
    expect(parseCommand('/moon')).toBeUndefined()
    expect(parseCommand('hello there')).toBeUndefined()
    expect(parseCommand('  /ca')).toEqual({ command: 'ca', args: '' })
  })
})

describe('T0 answers come from the sheet, with sources', () => {
  it('answers /ca with the bound address and an explorer link', async () => {
    const ctx = await fullContext()
    const answer = handleT0Command('ca', ctx)
    expect(answer.kind).toBe('fact')
    expect(answer.body).toContain(TOKEN)
    expect(answer.citations.map((citation) => citation.field)).toContain('contract_address')
  })

  it('answers /supply with cited figures', async () => {
    const ctx = await fullContext()
    const answer = handleT0Command('supply', ctx)
    const supply = lookupFact(ctx.sheet, 'total_supply', NOW)
    if (supply.status !== 'fresh') throw new Error('expected a fresh supply')
    expect(answer.body).toContain(supply.fact.display)
    expect(answer.citations.length).toBeGreaterThan(0)
  })

  it('states the creator rate for THIS token and names the branch', async () => {
    const ctx = await fullContext()
    const answer = handleT0Command('fees', ctx)
    expect(answer.body).toContain('0.70%')
    // Buyback is off on the fixture, so the alternative figure is the halved one.
    expect(answer.body).toContain('0.35%')
    expect(answer.body).toContain('depends on this token')
  })

  it('does not fabricate holder numbers when the index is missing', async () => {
    const sheet = await makeSheet()
    const answer = handleT0Command('holders', { sheet, nowUnix: NOW, language: 'en' })
    expect(answer.kind).toBe('unknown_field')
    expect(answer.body).toContain(FACT_SELF_CHECK.holder_count)
    expect(answer.citations).toHaveLength(0)
  })

  it('lists every command in /help', async () => {
    const ctx = await fullContext()
    const help = handleT0Command('help', ctx)
    for (const command of T0_COMMANDS) {
      if (command === 'help') continue
      expect(help.body).toContain(`/${command}`)
    }
  })
})

describe('every T0 emission survives the output classifier', () => {
  it('holds for all commands on a complete sheet', async () => {
    const ctx = await fullContext()
    for (const command of T0_COMMANDS) {
      const answer = handleT0Command(command, ctx)
      const decision = classifyRefusal(answer.body, 'output')
      expect(decision.refused, `${command}: ${decision.classes.join(',')}`).toBe(false)
    }
  })

  it('holds for all commands on an empty sheet, where every answer is a gap', async () => {
    const sheet = await makeSheet({
      state: { identity: {}, supply: {}, pool: {}, feeConfig: {}, lock: {}, antiSnipe: {}, launch: {} },
    })
    const ctx: FieldAnswerContext = { sheet, nowUnix: NOW, language: 'en' }
    for (const command of T0_COMMANDS) {
      const answer = handleT0Command(command, ctx)
      expect(classifyRefusal(answer.body, 'output').refused, command).toBe(false)
    }
  })

  it('holds for the pinned sheet', async () => {
    const ctx = await fullContext()
    expect(classifyRefusal(renderPinnedFactSheet(ctx).body, 'output').refused).toBe(false)
  })
})

describe('outbound rendering injects disclosure', () => {
  it('appends the canonical tag to every reply', async () => {
    const ctx = await fullContext()
    const text = renderOutbound(handleT0Command('ca', ctx), OUTBOUND)
    expect(text).toContain('AI-operated')
    expect(text).toContain('Example Ops Ltd')
  })

  it('strips a model-authored disclosure and re-adds exactly one', async () => {
    const text = renderOutbound(
      {
        kind: 'fact',
        body: 'Supply is fixed. #ad AI-operated. Not financial advice. DYOR',
        citations: [],
        language: 'en',
        modelAuthored: true,
      },
      OUTBOUND,
    )
    expect(text.match(/AI-operated/g)).toHaveLength(1)
    expect(text).not.toContain('#ad')
    expect(text.toLowerCase()).not.toContain('dyor')
  })

  it('truncates the body and never the disclosure', () => {
    const text = renderOutbound(
      {
        kind: 'fact',
        body: 'x'.repeat(5_000),
        citations: [],
        language: 'en',
        modelAuthored: false,
      },
      { ...OUTBOUND, maxChars: 200 },
    )
    expect(text.length).toBeLessThanOrEqual(200)
    expect(text.endsWith('AI-operated - Example Ops Ltd')).toBe(true)
  })

  it('fails closed when the operator name was never configured', async () => {
    const ctx = await fullContext()
    expect(() =>
      renderOutbound(handleT0Command('ca', ctx), { operatorName: 'SET_ME_BEFORE_LAUNCH' }),
    ).toThrow(/operatorName is unset/)
  })

  /**
   * REGRESSION. The guard here used to be
   *   options.operatorName === DISCLOSURE.operatorName
   * which tested "is this the compiled constant", not "is this a real name".
   * Every one of these PUBLISHED — `renderOutbound(..., {operatorName: 'TBD'})`
   * returned a message footed "AI-operated - TBD" — while the publisher, the
   * pilot and the API all refused the same strings.
   */
  it('fails closed on every OTHER placeholder too, not just the shipped sentinel', async () => {
    const ctx = await fullContext()
    for (const name of ['TBD', 'TODO', 'CHANGEME', 'set_me_now', 'n/a', 'YOUR_COMPANY', '', ' ']) {
      expect(
        () => renderOutbound(handleT0Command('ca', ctx), { operatorName: name }),
        `${JSON.stringify(name)} must not reach a published footer`,
      ).toThrow(/operatorName is unset/)
    }
  })

  /**
   * THE OTHER DIRECTION, which is what would have broken at launch. The old
   * equality check meant that once config/protocol.ts was edited to the real
   * name — a path .env.example and docs/OPERATIONS.md both document — the desk
   * would refuse the operator's OWN name and go permanently silent. The guard
   * must be a property of the string, not of what the constant happens to hold.
   */
  it('accepts a real operator name whatever the compiled constant is set to', async () => {
    const ctx = await fullContext()
    const text = renderOutbound(handleT0Command('ca', ctx), { operatorName: 'Acme Ops Ltd' })
    expect(text.endsWith('AI-operated - Acme Ops Ltd')).toBe(true)
  })
})

describe('the pinned FactSheet', () => {
  it('pins once and re-pins only when a value changes', async () => {
    const client = new FakeTelegramClient()
    const manager = new PinnedFactSheetManager(client, '-100', OUTBOUND)
    const ctx = await fullContext()

    const first = await manager.sync(ctx)
    expect(first.changed).toBe(true)
    expect(client.calls.filter((call) => call.kind === 'pin')).toHaveLength(1)

    // A later clock, same values: the pin must not churn.
    const second = await manager.sync({ ...ctx, nowUnix: NOW + 120 })
    expect(second.changed).toBe(false)
    expect(client.calls.filter((call) => call.kind === 'pin')).toHaveLength(1)

    const movedSheet = await makeSheet({
      withHolders: true,
      withLedger: true,
      state: { supply: { totalSupplyMinor: 5n, burnedMinor: 0n, lockedMinor: 0n } },
    })
    const third = await manager.sync({ ...ctx, sheet: movedSheet })
    expect(third.changed).toBe(true)
    expect(client.calls.filter((call) => call.kind === 'unpin')).toHaveLength(1)
  })

  it('says so rather than printing unverified values', async () => {
    const sheet = await makeSheet({
      state: { identity: {}, supply: {}, pool: {}, feeConfig: {}, lock: {}, antiSnipe: {}, launch: {} },
    })
    const body = renderPinnedFactSheet({ sheet, nowUnix: NOW, language: 'en' }).body
    // The bound fields survive; every unread field simply is not there. A pin
    // with a blank where the supply should be is the correct failure mode.
    expect(body).toContain('Contract address:')
    expect(body).not.toContain('Total supply:')
    expect(body).not.toContain('Holder count:')
    expect(body).not.toContain('Launch tax window:')
  })

  it('always carries the anti-DM rules', async () => {
    const ctx = await fullContext()
    const body = renderPinnedFactSheet(ctx).body
    expect(body).toContain('No admin will ever DM you first')
    expect(body).toContain('seed phrase')
  })
})

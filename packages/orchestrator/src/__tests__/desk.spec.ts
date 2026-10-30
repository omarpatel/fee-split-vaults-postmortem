/**
 * The desk phase: what the tick does with the desk's answers.
 *
 * The desk behind the port is a fake here on purpose. This file tests the
 * TICK's obligations - reply through the publisher with disclosure, respect
 * the per-window caps, raise the desk's escalations, run at T0 - and none of
 * the desk's own reasoning, which @fee-split-vaults/desk tests on its plane.
 */
import { describe, expect, it } from 'vitest'
import { DISCLOSURE } from '../../../../config/protocol.js'
import { DESK_WINDOW_LIMITS } from '../desk.js'
import type { DeskAnswerInput, DeskOutcome, DeskPort } from '../ports.js'
import { COIN, NOW, OPERATOR_NAME, makeHarness, makeScreening, type Harness } from './harness.js'

/** The window that closed at NOW: [T0, T0 + 1800). */
const WINDOW_START = Math.floor(NOW / 1_800) * 1_800 - 1_800

class ScriptedDesk implements DeskPort {
  readonly inputs: DeskAnswerInput[] = []

  constructor(private readonly script: (input: DeskAnswerInput, index: number) => DeskOutcome) {}

  async answer(input: DeskAnswerInput): Promise<DeskOutcome> {
    this.inputs.push(input)
    return this.script(input, this.inputs.length - 1)
  }
}

function reply(body: string, modelCalled = false): DeskOutcome {
  return { kind: 'reply', body, citedFields: ['supply.total'], modelAuthored: modelCalled, modelCalled, escalations: [] }
}

function seed(h: Harness, count: number, text = '/supply'): void {
  for (let i = 0; i < count; i += 1) {
    h.messages.add({
      sourceId: String(500 + i),
      authorId: `holder-${String(i)}`,
      text,
      postedAtUnix: WINDOW_START + i,
      origin: 'telegram',
      boundCoinRef: COIN,
    })
  }
}

describe('the desk phase', () => {
  it('publishes an answer as a disclosed Telegram reply to the message that asked', async () => {
    const desk = new ScriptedDesk(() => reply('Total supply: 1,000,000 ALPHA.'))
    const h = makeHarness({ desk, seedMessages: false })
    seed(h, 1)

    const result = await h.ticker.tick()

    expect(result.desk?.handled).toBe(1)
    expect(result.desk?.replies).toHaveLength(1)
    expect(result.desk?.replies[0]?.result.published).toBe(true)
    expect(result.refusals.filter((r) => r.phase === 'desk')).toEqual([])

    const wire = h.channels.telegram.sent.find((m) => m.replyToMessageId === 500)
    expect(wire).toBeDefined()
    expect(wire?.chatId).toBe('tg-alpha')
    expect(wire?.text).toContain('Total supply: 1,000,000 ALPHA.')
    // Disclosure is the publisher's, injected on the way out, never the desk's.
    expect(wire?.text).toContain(DISCLOSURE.aiOperationTag)
    expect(wire?.text).toContain(OPERATOR_NAME)

    // The desk saw the coin's binding and the window it was answering for.
    const input = desk.inputs[0]
    expect(input?.coinRef).toBe(COIN)
    expect(input?.chatId).toBe('tg-alpha')
    expect(input?.window.startUnix).toBe(WINDOW_START)
    expect(input?.modelPermitted).toBe(true)
    expect(input?.message.sourceId).toBe('500')
  })

  it('runs at T0, where cognition is refused, and tells the desk the tier', async () => {
    const desk = new ScriptedDesk(() => reply('help text'))
    const h = makeHarness({ desk, seedMessages: false, vault: { tier: 'T0' }, binding: null })
    seed(h, 1)

    const result = await h.ticker.tick()

    expect(result.refusals.find((r) => r.phase === 'cognition')?.code).toBe('tier_has_no_model')
    expect(result.desk?.handled).toBe(1)
    expect(desk.inputs[0]?.tier).toBe('T0')
    expect(h.channels.telegram.sent.some((m) => m.replyToMessageId === 500)).toBe(true)
  })

  it('caps model calls per window and keeps asking deterministically past the cap', async () => {
    const cap = DESK_WINDOW_LIMITS.maxModelCallsPerWindow
    const desk = new ScriptedDesk((input) =>
      input.modelPermitted
        ? reply('a model answer', true)
        : { kind: 'refused', code: 'budget_exhausted', modelCalled: false, escalations: [] },
    )
    const h = makeHarness({ desk, seedMessages: false })
    seed(h, cap + 4, 'what is the supply please')

    const result = await h.ticker.tick()

    expect(result.desk?.modelCalls).toBe(cap)
    expect(desk.inputs.slice(0, cap).every((input) => input.modelPermitted)).toBe(true)
    expect(desk.inputs.slice(cap).every((input) => !input.modelPermitted)).toBe(true)
    expect(result.desk?.refused).toBe(4)
    expect(h.channels.telegram.sent).toHaveLength(cap)
  })

  it('never hands the desk more messages than the per-window cap, and says so', async () => {
    const cap = DESK_WINDOW_LIMITS.maxMessagesPerWindow
    const desk = new ScriptedDesk(() => ({ kind: 'ignore', modelCalled: false, escalations: [] }))
    const h = makeHarness({ desk, seedMessages: false })
    seed(h, cap + 3)

    const result = await h.ticker.tick()

    expect(desk.inputs).toHaveLength(cap)
    expect(result.desk?.skippedByCap).toBe(3)
    expect(result.refusals.find((r) => r.phase === 'desk' && r.code === 'desk_window_cap')).toBeDefined()
  })

  it('sends a refusal template as the reply and raises the desk escalations to a human', async () => {
    const desk = new ScriptedDesk(() => ({
      kind: 'refused',
      code: 'refused',
      body: 'I do not discuss value. Ref R-ABC.',
      modelCalled: false,
      escalations: [{ reason: 'refusal_probe', summary: 'One account produced 8 refusals in an hour.', priority: 'high' }],
    }))
    const h = makeHarness({ desk, seedMessages: false })
    seed(h, 1, 'will it moon')

    const result = await h.ticker.tick()

    expect(result.desk?.refused).toBe(1)
    expect(h.channels.telegram.sent.some((m) => m.replyToMessageId === 500 && m.text.includes('R-ABC'))).toBe(true)
    const raised = h.escalations.raised.find((e) => e.kind === 'desk_escalation')
    expect(raised?.code).toBe('refusal_probe')
    expect(raised?.detail).toContain('[high]')
    expect(result.desk?.escalationsRaised).toBe(1)
  })

  it('reports a moderation action that could not be applied as a phase refusal', async () => {
    const desk = new ScriptedDesk(() => ({
      kind: 'moderated',
      actions: [],
      failed: [{ action: 'delete', code: 'moderation_rights_missing' }],
      modelCalled: false,
      escalations: [],
    }))
    const h = makeHarness({ desk, seedMessages: false })
    seed(h, 1, 'dm me for support')

    const result = await h.ticker.tick()

    expect(result.desk?.moderated).toBe(1)
    expect(result.refusals.find((r) => r.phase === 'desk')?.code).toBe('moderation_moderation_rights_missing')
    expect(h.channels.telegram.sent).toHaveLength(0)
  })

  it('records a publisher rejection instead of pretending the reply went out', async () => {
    // A handle in the body is a support-impersonation vector the publisher refuses.
    const desk = new ScriptedDesk(() => reply('dm @official_support for help'))
    const h = makeHarness({ desk, seedMessages: false })
    seed(h, 1)

    const result = await h.ticker.tick()

    expect(result.desk?.replies[0]?.result.published).toBe(false)
    expect(result.refusals.find((r) => r.phase === 'desk')?.code).toBe('reply_not_published')
    expect(h.channels.telegram.sent).toHaveLength(0)
  })

  it('refuses the phase when no desk is wired, and when screening is BLOCKED', async () => {
    const none = await makeHarness({ seedMessages: false }).ticker.tick()
    expect(none.refusals.find((r) => r.phase === 'desk')?.code).toBe('desk_unavailable')

    const desk = new ScriptedDesk(() => reply('never sent'))
    const blocked = makeHarness({ desk, screening: makeScreening({ verdict: 'BLOCKED' }) })
    const result = await blocked.ticker.tick()
    expect(result.refusals.find((r) => r.phase === 'desk')?.code).toBe('operations_not_permitted')
    expect(desk.inputs).toHaveLength(0)
  })

  it('does not hand the desk messages from other origins', async () => {
    const desk = new ScriptedDesk(() => reply('never'))
    const h = makeHarness({ desk, seedMessages: false })
    h.messages.add({
      sourceId: '9001',
      authorId: 'x-user',
      text: '@alpha when listing',
      postedAtUnix: WINDOW_START + 5,
      origin: 'x_mention',
      boundCoinRef: COIN,
    })

    const result = await h.ticker.tick()

    expect(desk.inputs).toHaveLength(0)
    expect(result.desk?.considered).toBe(0)
  })
})

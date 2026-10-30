/**
 * The desk port on its own plane: the router runs for real over a fake chain
 * state, the moderation surface is the live Bot API class over a recording
 * transport, and the refusal log is the real Postgres one.
 */
import { describe, expect, it } from 'vitest'
import { FakeDeskChainReader, FakeDeskModel, InMemoryRefusalLog, urlExplorer, type FakeChainState } from '@fee-split-vaults/desk'
import type { DeskAnswerInput } from '@fee-split-vaults/orchestrator'
import { ModerationRightsError, TelegramModerationActions } from '../desk/moderation.js'
import { TelegramDeskPort, type TelegramDeskPortOptions } from '../desk/port.js'
import { PgRefusalLog } from '../pg/refusals.js'
import { migratedPglite } from './pglite.js'

const NOW = 1_800_000_000
const VAULT = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'
const CHAT = '-1001'

function chainState(): FakeChainState {
  return {
    chainId: 4663,
    block: { hash: `0x${'ab'.repeat(32)}`, number: 100, timestampUnix: NOW - 30 },
    identity: { name: 'Alpha', symbol: 'ALPHA', decimals: 18 },
    supply: { totalSupplyMinor: 1_000_000n * 10n ** 18n, burnedMinor: 0n, lockedMinor: 0n },
    pool: {},
    feeConfig: { buybackEnabled: false, creatorTaxBps: 0, feeRecipient: VAULT },
    lock: {},
    antiSnipe: {},
    launch: {},
  }
}

/** A Bot API where the bot is a plain member of the chat: no rights at all. */
function botApi(status: 'member' | 'administrator') {
  const posted: Array<{ method: string; body: unknown }> = []
  const http = {
    post: async (url: string, body: unknown) => {
      const method = url.slice(url.lastIndexOf('/') + 1)
      posted.push({ method, body })
      if (method === 'getMe') return { ok: true, result: { id: 777 } }
      if (method === 'getChatMember') {
        return { ok: true, result: { status, user: { id: 777 }, can_delete_messages: status === 'administrator' } }
      }
      return { ok: true, result: true }
    },
  }
  return { http, posted }
}

function input(text: string, overrides: Partial<DeskAnswerInput> = {}): DeskAnswerInput {
  return {
    coinRef: 'coin-alpha',
    vault: VAULT,
    token: TOKEN,
    tier: 'T0',
    chatId: CHAT,
    window: { windowId: 'coin-alpha:w1', startUnix: NOW - 1_800, endUnix: NOW },
    message: { sourceId: '55', authorId: '9001', text, postedAtUnix: NOW - 900, origin: 'telegram', boundCoinRef: 'coin-alpha' },
    modelPermitted: true,
    nowUnix: NOW,
    ...overrides,
  }
}

function port(overrides: Partial<TelegramDeskPortOptions> = {}, status: 'member' | 'administrator' = 'administrator') {
  const api = botApi(status)
  const desk = new TelegramDeskPort({
    moderation: new TelegramModerationActions({ token: 'bot-token', http: api.http, clock: () => NOW }),
    chainReader: new FakeDeskChainReader(chainState()),
    explorer: urlExplorer('https://explorer.example'),
    refusalLog: new InMemoryRefusalLog(),
    operatorName: 'Example Ops Ltd',
    botUsername: 'alphadesk_bot',
    clock: () => NOW,
    ...overrides,
  })
  return { desk, api }
}

describe('TelegramDeskPort', () => {
  it('answers a T0 slash command from the FactSheet as an undisclosed body with cited fields', async () => {
    const { desk } = port()
    const outcome = await desk.answer(input('/supply'))
    expect(outcome.kind).toBe('reply')
    if (outcome.kind !== 'reply') return
    expect(outcome.body).toContain('1,000,000')
    expect(outcome.body).not.toContain('Example Ops Ltd')
    expect(outcome.citedFields.length).toBeGreaterThan(0)
    expect(outcome.modelCalled).toBe(false)
  })

  it('does not attempt a free-form question at T0: unaddressed is ignored, addressed gets the fixed help', async () => {
    const model = new FakeDeskModel(() => ({ answer: 'never', citedFields: [], cannotAnswer: false }))
    const { desk } = port({ model })
    expect((await desk.answer(input('what is the total supply?'))).kind).toBe('ignore')
    const addressed = await desk.answer(input('@alphadesk_bot what is the total supply?'))
    expect(addressed.kind).toBe('reply')
    if (addressed.kind === 'reply') expect(addressed.body).toContain('/supply')
    expect(model.requests).toHaveLength(0)
  })

  it('holds to the tick’s model cap: modelPermitted=false answers deterministically at T1', async () => {
    const model = new FakeDeskModel(() => ({ answer: 'never', citedFields: [], cannotAnswer: false }))
    const { desk } = port({ model })
    const outcome = await desk.answer(input('@alphadesk_bot how much is locked?', { tier: 'T1', modelPermitted: false }))
    expect(outcome.kind).toBe('refused')
    if (outcome.kind === 'refused') expect(outcome.code).toBe('budget_exhausted')
    expect(model.requests).toHaveLength(0)
  })

  it('refuses moderation, by code, when the bot is not an administrator', async () => {
    const { desk, api } = port({}, 'member')
    const outcome = await desk.answer(input('dm me for support, connect your wallet at claim-airdrop.example'))
    expect(outcome.kind).toBe('moderated')
    if (outcome.kind !== 'moderated') return
    expect(outcome.failed).toContainEqual({ action: 'delete', code: 'moderation_rights_missing' })
    expect(api.posted.map((p) => p.method)).not.toContain('deleteMessage')
  })

  it('refuses a message bound to another coin', async () => {
    const { desk } = port()
    await expect(
      desk.answer(input('/supply', { message: { ...input('/supply').message, boundCoinRef: 'coin-beta' } })),
    ).rejects.toMatchObject({ code: 'desk_binding_conflict' })
  })
})

describe('TelegramModerationActions', () => {
  it('checks the right before acting and caches the check per chat', async () => {
    const api = botApi('administrator')
    const actions = new TelegramModerationActions({ token: 't', http: api.http, clock: () => NOW })
    await actions.deleteMessage(CHAT, '1')
    await actions.deleteMessage(CHAT, '2')
    expect(api.posted.filter((p) => p.method === 'getChatMember')).toHaveLength(1)
    expect(api.posted.filter((p) => p.method === 'deleteMessage')).toHaveLength(2)
    // An administrator without can_restrict_members still cannot mute.
    await expect(actions.muteMember(CHAT, '9', NOW + 60)).rejects.toBeInstanceOf(ModerationRightsError)
  })
})

describe('PgRefusalLog', () => {
  it('counts what it recorded, persists on flush, and reloads after a restart', async () => {
    const pg = await migratedPglite()
    try {
      const log = new PgRefusalLog(pg.driver)
      log.record({
        ref: 'R-1', atUnix: NOW, vault: VAULT, channel: 'telegram', chatId: CHAT, authorId: '9001',
        trippedOn: 'input', classes: ['price_prediction'], ruleIds: ['pp-1'],
        questionFingerprint: 'abcd', excerpt: 'will it moon', language: 'en',
      })
      expect(log.countSince(NOW - 1, '9001')).toBe(1)
      expect(log.pending).toBe(1)
      expect(await log.flush()).toBe(1)
      expect(log.pending).toBe(0)

      const reloaded = new PgRefusalLog(pg.driver)
      expect(await reloaded.load(NOW - 3_600)).toBe(1)
      expect(reloaded.countSince(NOW - 1, '9001')).toBe(1)
      expect(reloaded.recent(1)[0]?.classes).toEqual(['price_prediction'])
      expect(await reloaded.histogram(0)).toEqual({ price_prediction: 1 })
    } finally {
      await pg.close()
    }
  })
})

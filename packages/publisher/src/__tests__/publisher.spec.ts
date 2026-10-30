import { imageAssetId, type ImageAsset } from '@fee-split-vaults/core'
import { describe, expect, it } from 'vitest'
import { DISCLOSURE } from '../../../../config/protocol.js'
import {
  createAutoApprovalGate,
  createDenyAllApprovalGate,
  createManualApprovalGate,
  type ApprovalGate,
} from '../approval.js'
import { createFakeChannelSet, createFakeImageAssetSource } from '../channels/fakes.js'
import { measureXChars } from '../channels/types.js'
import { createInMemoryEventLog } from '../log.js'
import { createPublisher, PublisherConfigError, type Publisher } from '../publisher.js'
import { createInMemoryAccountRegistry, createInMemoryPostRegistry } from '../registry.js'
import { createFixedClock, createManualScheduler } from '../scheduler.js'
import { countCodePoints, countOccurrences } from '../text.js'
import type { AccountBinding, PublishRequest } from '../types.js'

const OPERATOR = 'Venue Desk'
const VAULT = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'
const RIVAL_VAULT = '0x3333333333333333333333333333333333333333'
const RIVAL_TOKEN = '0x4444444444444444444444444444444444444444'
const ATTACKER = '0x651c06a1a38c5727f0d3ef7420d90e02e0fee33d'
const ROUTER = '0x5555555555555555555555555555555555555555'
const RECEIPTS = 'https://receipts.example.com'

const COIN = 'vnx'
const BINDINGS: AccountBinding[] = [
  { accountId: 'tg-chat-1', channel: 'telegram', coinRef: COIN, vault: VAULT, token: TOKEN, ticker: 'VNX', delegated: false },
  { accountId: 'x-op-1', channel: 'x_operator', coinRef: COIN, vault: VAULT, token: TOKEN, ticker: 'VNX', delegated: false },
  { accountId: 'x-dev-1', channel: 'x_client_delegated', coinRef: COIN, vault: VAULT, token: TOKEN, ticker: 'VNX', delegated: true },
  { accountId: 'clients/vnx', channel: 'site', coinRef: COIN, vault: VAULT, token: TOKEN, ticker: 'VNX', delegated: false },
]

const SHA = 'ab'.repeat(32)
const CARD: ImageAsset = {
  id: imageAssetId(COIN, 'card', SHA),
  coinRef: COIN,
  kind: 'card',
  mime: 'image/png',
  width: 1200,
  height: 675,
  sha256: SHA,
  bytes: new Uint8Array([1, 2, 3, 4]),
}
const RIVAL_CARD: ImageAsset = { ...CARD, id: imageAssetId('rival', 'card', SHA), coinRef: 'rival' }

function harness(options: { approvals?: ApprovalGate; images?: readonly ImageAsset[] } = {}) {
  const clock = createFixedClock(1_757_000_000)
  const nowUnix = () => clock.nowUnix()
  const images = options.images === undefined ? undefined : createFakeImageAssetSource(options.images)
  const channels = createFakeChannelSet({ operatorName: OPERATOR, nowUnix, ...(images === undefined ? {} : { images }) })
  const accounts = createInMemoryAccountRegistry(BINDINGS, [
    { vault: VAULT, token: TOKEN, ticker: 'VNX' },
    { vault: RIVAL_VAULT, token: RIVAL_TOKEN, ticker: 'RIVAL' },
  ])
  const posts = createInMemoryPostRegistry()
  const log = createInMemoryEventLog()
  const scheduler = createManualScheduler(clock)
  const publisher: Publisher = createPublisher({
    policy: {
      operatorName: OPERATOR,
      receiptsBaseUrl: RECEIPTS,
      allowedLinkHosts: ['vnx.example', 'dexscreener.com'],
      allowedRouterAddresses: [ROUTER],
      maxAccountLabelAgeSeconds: 86_400,
    },
    adapters: channels.adapters,
    accounts,
    posts,
    ...(images === undefined ? {} : { images }),
    log,
    approvals: options.approvals ?? createAutoApprovalGate('reviewer', nowUnix),
    scheduler,
    clock,
  })
  return { clock, channels, accounts, posts, log, scheduler, publisher }
}

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    vault: VAULT,
    channel: 'x_operator',
    body: 'The pinned message and the site copy were refreshed this morning.',
    isPromotional: false,
    links: [],
    ...overrides,
  }
}

describe('disclosure survives truncation', () => {
  it('cuts the body, never the disclosure, and stays inside the channel limit', async () => {
    const h = harness()
    const longBody = (
      'Desk note for holders: the group was staffed for the full window, the pinned ' +
      'message was refreshed, the FAQ entry about the fee recipient was rewritten, and ' +
      'the operations log on the site was updated with the same wording. '
    ).repeat(4)

    const result = await h.publisher.publish({
      request: request({ body: longBody, isPromotional: true }),
      accountId: 'x-op-1',
    })

    expect(result.published).toBe(true)
    const sent = h.channels.x.created[0]
    expect(sent).toBeDefined()
    const text = sent?.text ?? ''

    expect(measureXChars(text)).toBeLessThanOrEqual(280)
    expect(text).toContain(DISCLOSURE.paidPromotionTag)
    expect(text).toContain(DISCLOSURE.aiOperationTag)
    expect(text).toContain(OPERATOR)
    expect(text).toContain(`${RECEIPTS}/${VAULT}`)
    expect(text).toContain('…')
    expect(text.length).toBeLessThan(longBody.length)

    const record = await h.posts.get(`x-op-1:${sent?.postId ?? ''}`)
    expect(record?.bodyTruncated).toBe(true)
  })

  it('refuses rather than publishing undisclosed when the disclosure cannot fit', async () => {
    const h = harness()
    const tinyChannel = h.channels.adapters.x_operator
    const narrowed = { ...tinyChannel, limits: { ...tinyChannel.limits, maxChars: 20 } }
    const publisher = createPublisher({
      policy: {
        operatorName: OPERATOR,
        receiptsBaseUrl: RECEIPTS,
        allowedLinkHosts: [],
        allowedRouterAddresses: [],
        maxAccountLabelAgeSeconds: 86_400,
      },
      adapters: { ...h.channels.adapters, x_operator: narrowed },
      accounts: h.accounts,
      posts: h.posts,
      log: h.log,
      approvals: createAutoApprovalGate('reviewer', () => h.clock.nowUnix()),
      scheduler: h.scheduler,
      clock: h.clock,
    })

    const result = await publisher.publish({ request: request(), accountId: 'x-op-1' })

    expect(result.published).toBe(false)
    expect(result.rejectedReason).toContain('disclosure_exceeds_channel_limit')
    expect(h.channels.x.created).toHaveLength(0)
  })
})

describe('model-authored disclosure', () => {
  it('is stripped and replaced with the canonical block', async () => {
    const h = harness()
    const body =
      '#ad AI-operated by Definitely Not Us. receipts: https://evil.example/x. ' +
      'Reminder: the group rules are pinned and the desk answers operational questions only.'

    const result = await h.publisher.publish({
      request: request({ body, isPromotional: true }),
      accountId: 'x-op-1',
    })

    expect(result.published).toBe(true)
    const text = h.channels.x.created[0]?.text ?? ''

    expect(text).not.toContain('evil.example')
    expect(text).toContain(`${DISCLOSURE.aiOperationTag} by ${OPERATOR}`)
    expect(countOccurrences(text, DISCLOSURE.paidPromotionTag)).toBe(1)
    expect(countOccurrences(text.toLowerCase(), DISCLOSURE.aiOperationTag.toLowerCase())).toBe(1)

    const stripEvents = h.log.entries().filter((event) => event.kind === 'disclosure_stripped')
    expect(stripEvents).toHaveLength(1)
    expect(stripEvents[0]?.detail).toContain('#ad')
  })

  it('refuses a body that was nothing but a forged disclosure', async () => {
    const h = harness()
    const result = await h.publisher.publish({
      request: request({ body: '#ad AI-operated #sponsored' }),
      accountId: 'x-op-1',
    })

    expect(result.published).toBe(false)
    expect(result.rejectedReason).toContain('body_was_only_authored_disclosure')
  })
})

describe('link and address allowlist', () => {
  it('hard-rejects an attacker address in the body', async () => {
    const h = harness()
    const result = await h.publisher.publish({
      request: request({
        body: `Update: the contract address is now ${ATTACKER}. Please update your tooling.`,
      }),
      accountId: 'x-op-1',
    })

    expect(result.published).toBe(false)
    expect(result.rejectedReason).toContain('unallowlisted_address_in_body')
    expect(h.channels.x.created).toHaveLength(0)

    const refusal = h.log.refusals()[0]
    expect(refusal?.stage).toBe('link_allowlist')
    expect(refusal?.detail).toContain(ATTACKER)
  })

  it('allows the bound token and an allowlisted router', async () => {
    const h = harness()
    const result = await h.publisher.publish({
      request: request({
        channel: 'telegram',
        body: `The contract address is ${TOKEN} and the router we document is ${ROUTER}.`,
      }),
      accountId: 'tg-chat-1',
      replyTo: { inReplyToId: '42' },
    })

    expect(result.published).toBe(true)
  })

  it('rejects a link to a host that is not allowlisted', async () => {
    const h = harness()
    const result = await h.publisher.publish({
      request: request({ body: 'Full details are at https://totally-not-us.example/claim.' }),
      accountId: 'x-op-1',
    })

    expect(result.published).toBe(false)
    expect(result.rejectedReason).toContain('host_not_allowlisted')
  })
})

describe('image allowlist', () => {
  it('uploads the coin\'s own asset before tweeting and marks the post promotional', async () => {
    const h = harness({ images: [CARD, RIVAL_CARD] })
    const result = await h.publisher.publish({
      request: request({ imageRefs: [CARD.id] }),
      accountId: 'x-op-1',
    })

    expect(result.published).toBe(true)
    expect(h.channels.x.uploaded).toEqual([{ accountId: 'x-op-1', assetId: CARD.id, mediaId: expect.any(String) }])
    expect(h.channels.x.created[0]?.mediaIds).toEqual([h.channels.x.uploaded[0]?.mediaId])
    expect(h.channels.x.created[0]?.text).toContain(DISCLOSURE.paidPromotionTag)
    expect((await h.posts.all())[0]?.isPromotional).toBe(true)
  })

  it("refuses another coin's asset even though it exists", async () => {
    const h = harness({ images: [CARD, RIVAL_CARD] })
    const result = await h.publisher.publish({
      request: request({ imageRefs: [RIVAL_CARD.id] }),
      accountId: 'x-op-1',
    })

    expect(result.published).toBe(false)
    expect(result.rejectedReason).toBe('image_not_allowlisted:image_ref_foreign_coin')
    expect(h.channels.x.uploaded).toHaveLength(0)
    expect(h.channels.x.created).toHaveLength(0)
  })

  it('refuses a raw media id or any other id that is not an asset id', async () => {
    const h = harness({ images: [CARD] })
    const result = await h.publisher.publish({
      request: request({ imageRefs: ['1880028106020515840'] }),
      accountId: 'x-op-1',
    })
    expect(result.rejectedReason).toBe('image_not_allowlisted:image_ref_malformed')
  })

  it('refuses a well-formed id nothing was rendered under', async () => {
    const h = harness({ images: [] })
    const result = await h.publisher.publish({
      request: request({ imageRefs: [CARD.id] }),
      accountId: 'x-op-1',
    })
    expect(result.rejectedReason).toBe('image_not_allowlisted:image_asset_missing')
  })

  it('refuses every image when no asset source is configured', async () => {
    const h = harness()
    const result = await h.publisher.publish({
      request: request({ imageRefs: [CARD.id] }),
      accountId: 'x-op-1',
    })
    expect(result.rejectedReason).toBe('image_not_allowlisted:image_source_unavailable')
  })

  it('sends a telegram photo with the caption composed against the caption limit', async () => {
    const h = harness({ images: [CARD] })
    const longBody = 'The pinned message and the site copy were refreshed this morning. '.repeat(40)
    const result = await h.publisher.publish({
      request: request({ channel: 'telegram', body: longBody, imageRefs: [CARD.id] }),
      accountId: 'tg-chat-1',
    })

    expect(result.published).toBe(true)
    const sent = h.channels.telegram.sent[0]
    expect(sent?.photoBytes).toBe(CARD.bytes.byteLength)
    expect(countCodePoints(sent?.text ?? '')).toBeLessThanOrEqual(1_024)
    expect(sent?.text).toContain(DISCLOSURE.aiOperationTag)
    expect(sent?.text).toContain(`${RECEIPTS}/${VAULT}`)
  })
})

describe('one ticker per account', () => {
  it('refuses a second ticker on a bound account', async () => {
    const h = harness()
    const result = await h.publisher.publish({
      request: request({ body: 'Desk update for $VNX and $OTHER holders: the pinned post moved.' }),
      accountId: 'x-op-1',
    })

    expect(result.published).toBe(false)
    expect(result.rejectedReason).toContain('ticker_limit_exceeded')
    expect(DISCLOSURE.maxTickersPerAccount).toBe(1)
  })

  it('refuses cross-promotion of another client coin', async () => {
    const h = harness()
    const result = await h.publisher.publish({
      request: request({ body: 'The desk also staffs the RIVAL group this week.' }),
      accountId: 'x-op-1',
    })

    expect(result.published).toBe(false)
    expect(result.rejectedReason).toContain('cross_promotion')
  })
})

describe('outbound refusal classifier', () => {
  it('refuses advice and logs the classes', async () => {
    const h = harness()
    const result = await h.publisher.publish({
      request: request({ body: 'Buy now before the next leg up, this is a 100x setup.' }),
      accountId: 'x-op-1',
    })

    expect(result.published).toBe(false)
    expect(result.rejectedReason).toContain('refusal_classifier')

    const refusal = h.log.refusals()[0]
    expect(refusal?.refusalClasses).toContain('buy_sell_advice')
    expect(refusal?.refusalClasses).toContain('future_value_implication')
  })

  it('permits an operational answer that merely contains the word buy', async () => {
    const h = harness()
    const result = await h.publisher.publish({
      request: request({
        channel: 'telegram',
        body: `How to buy is covered in the pinned message. The contract address is ${TOKEN}.`,
      }),
      accountId: 'tg-chat-1',
      replyTo: { inReplyToId: '7' },
    })

    expect(result.published).toBe(true)
  })
})

describe('delegated account disclosure', () => {
  it('refuses to post when the dev has edited the disclosure out of the bio', async () => {
    const h = harness()
    h.channels.x.setProfile('x-dev-1', { description: 'gm' })

    const result = await h.publisher.publish({
      request: request({ channel: 'x_client_delegated' }),
      accountId: 'x-dev-1',
    })

    expect(result.published).toBe(false)
    expect(result.rejectedReason).toContain('account_disclosure_missing')
    expect(h.log.refusals()[0]?.detail).toContain('bio_missing_ai_tag')
  })

  it('refuses when the automated-account label is gone', async () => {
    const h = harness()
    h.channels.x.setProfile('x-dev-1', { automatedLabel: null })

    const result = await h.publisher.publish({
      request: request({ channel: 'x_client_delegated' }),
      accountId: 'x-dev-1',
    })

    expect(result.published).toBe(false)
    expect(h.log.refusals()[0]?.detail).toContain('automated_label_absent')
  })

  it('publishes when label and bio are both in place', async () => {
    const h = harness()
    const result = await h.publisher.publish({
      request: request({ channel: 'x_client_delegated' }),
      accountId: 'x-dev-1',
    })

    expect(result.published).toBe(true)
  })
})

describe('human approval gate', () => {
  it('parks a public post until a human decides, then publishes on re-submission', async () => {
    const gate = createManualApprovalGate()
    const h = harness({ approvals: gate })

    const first = await h.publisher.publish({
      request: request(),
      accountId: 'x-op-1',
      correlationId: 'corr-1',
    })
    expect(first.published).toBe(false)
    expect(first.rejectedReason).toContain('awaiting_human_approval')
    expect(h.channels.x.created).toHaveLength(0)
    expect(gate.pending()[0]?.request.text).toContain(DISCLOSURE.aiOperationTag)

    gate.approve('corr-1', 'compliance')
    const second = await h.publisher.publish({
      request: request(),
      accountId: 'x-op-1',
      correlationId: 'corr-1',
    })

    expect(second.published).toBe(true)
    const record = (await h.posts.all())[0]
    expect(record?.approvedBy).toBe('compliance')
  })

  it('leaves inbound telegram replies autonomous', async () => {
    const h = harness({ approvals: createDenyAllApprovalGate('should not be consulted') })

    const result = await h.publisher.publish({
      request: request({ channel: 'telegram', body: 'The pinned message answers that.' }),
      accountId: 'tg-chat-1',
      replyTo: { inReplyToId: '99' },
    })

    expect(result.published).toBe(true)
    expect(h.channels.telegram.sent[0]?.replyToMessageId).toBe(99)
  })

  it('gates an outbound telegram broadcast', async () => {
    const h = harness({ approvals: createDenyAllApprovalGate('not this week') })

    const result = await h.publisher.publish({
      request: request({ channel: 'telegram', body: 'The pinned message was refreshed.' }),
      accountId: 'tg-chat-1',
    })

    expect(result.published).toBe(false)
    expect(result.rejectedReason).toContain('rejected_by_reviewer')
  })
})

describe('read-back verification', () => {
  it('deletes the post when the disclosure is gone on re-fetch', async () => {
    const h = harness()
    const result = await h.publisher.publish({ request: request(), accountId: 'x-op-1' })
    expect(result.published).toBe(true)

    const postId = h.channels.x.created[0]?.postId ?? ''
    h.channels.x.tamper(postId, 'The pinned message and the site copy were refreshed this morning.')

    h.clock.advance(DISCLOSURE.readBackVerifySeconds)
    await h.scheduler.runDue()

    expect(h.channels.x.deleted).toContain(postId)
    const record = await h.posts.get(result.externalId ?? '')
    expect(record?.readBack?.ok).toBe(false)
    expect(record?.readBack?.deleted).toBe(true)
    expect(record?.readBack?.missing).toContain(DISCLOSURE.aiOperationTag)
    expect(h.log.entries().some((event) => event.kind === 'read_back_failed')).toBe(true)
  })

  it('deletes the post when the platform cannot be read back at all', async () => {
    const h = harness()
    const result = await h.publisher.publish({
      request: request({ channel: 'telegram', body: 'The pinned message was refreshed.' }),
      accountId: 'tg-chat-1',
      replyTo: { inReplyToId: '5' },
    })
    expect(result.published).toBe(true)

    const sent = h.channels.telegram.sent[0]
    h.channels.telegram.vanish(`${sent?.chatId ?? ''}:${sent?.messageId ?? 0}`)

    h.clock.advance(DISCLOSURE.readBackVerifySeconds)
    await h.scheduler.runDue()

    const record = await h.posts.get(result.externalId ?? '')
    expect(record?.readBack?.ok).toBe(false)
    expect(record?.readBack?.reason).toContain('read_back_unreadable')
    expect(h.channels.telegram.deleted).toContain(result.externalId)
  })

  it('leaves an intact post alone', async () => {
    const h = harness()
    const result = await h.publisher.publish({ request: request(), accountId: 'x-op-1' })

    h.clock.advance(DISCLOSURE.readBackVerifySeconds)
    await h.scheduler.runDue()

    expect(h.channels.x.deleted).toHaveLength(0)
    expect((await h.posts.get(result.externalId ?? ''))?.readBack?.ok).toBe(true)
  })

  it('sweeps posts whose timer was lost to a restart', async () => {
    const h = harness()
    const result = await h.publisher.publish({ request: request(), accountId: 'x-op-1' })
    h.scheduler.cancel(result.externalId ?? '')

    h.clock.advance(DISCLOSURE.readBackVerifySeconds + 1)
    const outcomes = await h.publisher.sweepUnverified()

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.ok).toBe(true)
  })
})

describe('configuration', () => {
  it('refuses to construct while the operator name is a placeholder', () => {
    const h = harness()
    expect(() =>
      createPublisher({
        policy: {
          operatorName: DISCLOSURE.operatorName,
          receiptsBaseUrl: RECEIPTS,
          allowedLinkHosts: [],
          allowedRouterAddresses: [],
          maxAccountLabelAgeSeconds: 86_400,
        },
        adapters: h.channels.adapters,
        accounts: h.accounts,
        posts: h.posts,
        log: h.log,
        approvals: createAutoApprovalGate(),
        scheduler: h.scheduler,
        clock: h.clock,
      }),
    ).toThrow(PublisherConfigError)
  })

  it('refuses an account that speaks for a different vault', async () => {
    const h = harness()
    const result = await h.publisher.publish({
      request: request({ vault: RIVAL_VAULT }),
      accountId: 'x-op-1',
    })

    expect(result.published).toBe(false)
    expect(result.rejectedReason).toContain('account_vault_mismatch')
  })
})

/**
 * demo publisher - everything that reaches a human audience.
 *
 * WHAT A VIEWER SHOULD TAKE AWAY. Disclosure is CODE-OWNED. It is never sourced
 * from a model, it is reserved out of the character budget before the body is
 * measured so truncation can only ever eat the copy, and it is re-checked
 * against the live post a minute after publication - and if it is not there any
 * more, the post comes down.
 *
 * Three regimes require the disclosure to be IN the communication: the FTC
 * Endorsement Guides, EU AI Act Art. 50 and CA SB 1001. A receipts ledger on a
 * separate page cures none of them, which is why the canonical block is appended
 * to the visible body of every emission and why a model-authored version of it
 * is deleted rather than trusted.
 */

import type { PublishRequest } from '@fee-split-vaults/core'
import {
  createAutoApprovalGate,
  createFakeChannelSet,
  createFixedClock,
  createInMemoryAccountRegistry,
  createInMemoryEventLog,
  createInMemoryPostRegistry,
  createManualScheduler,
  createPublisher,
  measureXChars,
  renderDisclosure,
  stripAuthoredDisclosure,
  type AccountBinding,
  type FakeChannelSet,
  type Publisher,
  type PublisherEvent,
  type PublisherEventLog,
  type PostRegistry,
} from '@fee-split-vaults/publisher'
import { DISCLOSURE } from '../../../config/protocol.ts'
import { table } from '../format.ts'
import { ATTACKER, COIN, NOW, OFFICIAL_SITE, OPERATOR_NAME, RECEIPTS_BASE, RIVAL, ROUTER } from './fixtures.ts'
import { ok, refused, summarise, type DemoResult, type Pair, type Scene } from './render.ts'

const BINDINGS: AccountBinding[] = [
  {
    accountId: 'x-op-moondog',
    coinRef: COIN.ref,
    channel: 'x_operator',
    vault: COIN.vault,
    token: COIN.token,
    ticker: COIN.ticker,
    delegated: false,
  },
  {
    accountId: 'tg-moondog',
    coinRef: COIN.ref,
    channel: 'telegram',
    vault: COIN.vault,
    token: COIN.token,
    ticker: COIN.ticker,
    delegated: false,
  },
]

interface Harness {
  publisher: Publisher
  channels: FakeChannelSet
  posts: PostRegistry
  log: PublisherEventLog
}

function harness(): Harness {
  const clock = createFixedClock(NOW)
  const nowUnix = (): number => clock.nowUnix()
  const channels = createFakeChannelSet({ operatorName: OPERATOR_NAME, nowUnix })
  const posts = createInMemoryPostRegistry()
  const log = createInMemoryEventLog()
  const publisher = createPublisher({
    policy: {
      operatorName: OPERATOR_NAME,
      receiptsBaseUrl: RECEIPTS_BASE,
      allowedLinkHosts: [OFFICIAL_SITE, 'dexscreener.com'],
      allowedRouterAddresses: [ROUTER],
      maxAccountLabelAgeSeconds: 86_400,
    },
    adapters: channels.adapters,
    accounts: createInMemoryAccountRegistry(BINDINGS, [
      { vault: COIN.vault, token: COIN.token, ticker: COIN.ticker },
      { vault: RIVAL.vault, token: RIVAL.token, ticker: RIVAL.ticker },
    ]),
    posts,
    log,
    approvals: createAutoApprovalGate('reviewer-1', nowUnix),
    scheduler: createManualScheduler(clock),
    clock,
  })
  return { publisher, channels, posts, log }
}

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    vault: COIN.vault,
    channel: 'x_operator',
    body:
      'Weekly report: the desk was staffed for the full window, the pinned message was ' +
      'refreshed, and the fee FAQ was rewritten.',
    isPromotional: false,
    links: [],
    ...overrides,
  }
}

function eventTable(log: PublisherEventLog): string {
  return table(log.entries() as PublisherEvent[], [
    { header: 'event', value: (e) => e.kind },
    { header: 'severity', value: (e) => e.severity ?? '-' },
    { header: 'detail', value: (e) => e.detail ?? e.reason ?? '' },
  ])
}

/** The exact text that went out on the wire for the most recent X post. */
function lastXPost(h: Harness): { id: string; text: string } {
  const created = h.channels.x.created[h.channels.x.created.length - 1]
  return { id: created?.postId ?? '(none)', text: created?.text ?? '(nothing was published)' }
}

export async function runPublisherDemo(): Promise<DemoResult> {
  const scenes: Scene[] = []
  const canonical = renderDisclosure({
    operatorName: OPERATOR_NAME,
    receiptUrl: `${RECEIPTS_BASE}/${COIN.vault}`,
    paidPromotion: false,
  })

  // -------------------------------------------------------------------------
  // 1. Disclosure injected by code.
  // -------------------------------------------------------------------------
  {
    const h = harness()
    const result = await h.publisher.publish({ request: request(), accountId: 'x-op-moondog' })
    const sent = lastXPost(h)
    const record = await h.posts.get(`x-op-moondog:${sent.id}`)
    scenes.push({
      id: 'publisher.disclosed',
      title: 'An ordinary operational post',
      proves:
        'The body carried no disclosure and the model was never asked for one. The canonical block is appended by code, names the operating entity, and links the receipts page for this exact vault.',
      verdict: ok(
        'PUBLISHED',
        `external id ${sent.id}, classified ${record?.isPromotional === true ? 'promotional' : 'operational'} by rule ${(record?.classificationRules ?? []).join(', ') || 'none'}`,
      ),
      given: [
        { label: 'channel', value: 'x_operator (280 characters, measured the way X measures)' },
        { label: 'account', value: 'x-op-moondog, bound to exactly one ticker' },
        { label: 'body in', value: request().body },
      ],
      path: [
        'normalize: invisible and bidi characters killed first, so every later check sees what a reader sees',
        'strip any model-authored disclosure (there was none)',
        'outbound refusal classifier: no match',
        'link and address wall: no address in the body but the bound token',
        'ticker policy: one ticker, this account\'s own',
        'classify: the rule engine defaults to PROMOTIONAL and only an operational rule hit downgrades it; a caller-declared "false" is never trusted to override a rule',
        'compose: disclosure measured FIRST and reserved out of the budget',
        're-scan the exact bytes about to be sent',
        'human approval, then publish, then schedule the read-back check',
      ],
      blocks: [
        { label: 'sent on the wire', text: sent.text },
        {
          label: 'the record kept',
          text: [
            `required tokens : ${(record?.requiredTokens ?? []).join(' | ')}`,
            `promotional     : ${String(record?.isPromotional)} (rules: ${(record?.classificationRules ?? []).join(', ') || 'none'})`,
            `body truncated  : ${String(record?.bodyTruncated)}`,
            `approved by     : ${record?.approvedBy ?? '(autonomous)'}`,
            `published hash  : ${record?.publishedTextHash.slice(0, 24) ?? '-'}…`,
          ].join('\n'),
        },
      ],
    })
  }

  // -------------------------------------------------------------------------
  // 2. A model that wrote its own disclosure.
  // -------------------------------------------------------------------------
  {
    const h = harness()
    const hostile =
      '#ad Svenueored post. This is an AI-generated update from Northgate Ops Ltd. ' +
      'Desk staffed all week and the FAQ was rewritten. ' +
      'receipts: https://moondog-receipts.top/proof — NFA, DYOR.'
    const stripped = stripAuthoredDisclosure(hostile, OPERATOR_NAME)
    const result = await h.publisher.publish({
      request: request({ body: hostile, isPromotional: true }),
      accountId: 'x-op-moondog',
    })
    const sent = lastXPost(h)
    scenes.push({
      id: 'publisher.authored_disclosure',
      title: 'A model writes its own disclosure, including a fake receipts link',
      proves:
        'A model-authored tag is unverifiable and, in the worst case, attacker-controlled. Every disclosure-shaped fragment is STRIPPED and the canonical block re-added - and the strip runs BEFORE the link allowlist, so a forged "receipts:" line pointing at an attacker domain is deleted as a forgery rather than judged as a link the copy needed.',
      verdict: ok(
        'PUBLISHED, REWRITTEN',
        `${String(stripped.removed.length)} authored fragments removed, one canonical block appended`,
      ),
      given: [
        { label: 'body in', value: hostile },
        { label: 'promotional', value: 'yes - set by the rule engine, so the #ad tag is ours to add' },
      ],
      path: [
        'stripAuthoredDisclosure removed every disclosure-shaped fragment, including the operator\'s own name',
        'the forged receipts link went with it, before the link allowlist ever saw it',
        'the rule engine classified the post as promotional',
        `the canonical block was appended: ${DISCLOSURE.paidPromotionTag} first, then ${DISCLOSURE.aiOperationTag}, then the real receipts URL`,
      ],
      blocks: [
        {
          label: 'fragments deleted',
          text: stripped.removed.map((r) => `- ${r}`).join('\n') || '(none)',
        },
        {
          label: 'body that survived - the strip list is deliberately over-broad',
          text: stripped.body,
        },
        { label: 'sent on the wire', text: sent.text },
        {
          label: 'result',
          text: `published=${String(result.published)} rejected=${result.rejectedReason ?? '-'}`,
        },
      ],
    })
  }

  // -------------------------------------------------------------------------
  // 3. An attacker address in the body.
  // -------------------------------------------------------------------------
  {
    const h = harness()
    const body = `Migration is live. Send to the new contract ${ATTACKER} before Friday.`
    const result = await h.publisher.publish({
      request: request({ body }),
      accountId: 'x-op-moondog',
    })
    const refusal = h.log.refusals()[0]
    scenes.push({
      id: 'publisher.address_wall',
      title: 'A post carrying an address that is not this coin\'s',
      proves:
        'The only addresses that may appear in a body are the bound token, the bound vault and the configured routers. Everything else is a HARD reject, not a warning and not a redaction - and the check runs again on the exact composed bytes, because truncation can slice an address into a different address.',
      verdict: refused('AT THE ADDRESS WALL', result.rejectedReason ?? 'unknown'),
      given: [
        { label: 'body in', value: body },
        { label: 'bound token', value: COIN.token },
        { label: 'allowed router', value: ROUTER },
      ],
      path: [
        'normalised first, so a confusable or zero-width split cannot hide the address',
        'checkLinksAndAddresses compared every address-shaped token against the allowlist',
        `${ATTACKER} matched nothing, so the publish was refused outright`,
        'the refusal is logged with a hash of the body, never with the body itself',
      ],
      blocks: [
        {
          label: 'nothing was sent',
          text: `x posts created: ${String(h.channels.x.created.length)}`,
        },
        {
          label: 'the refusal, as logged',
          text: refusal === undefined ? '(none)' : `${refusal.stage ?? '-'}:${refusal.reason ?? '-'} - ${refusal.detail ?? ''}`,
        },
      ],
    })
  }

  // -------------------------------------------------------------------------
  // 4. Cross-promotion between two clients on the same book.
  // -------------------------------------------------------------------------
  {
    const h = harness()
    const body = `Strong week for $${COIN.ticker}. Our friends at $${RIVAL.ticker} are shipping too.`
    const result = await h.publisher.publish({
      request: request({ body }),
      accountId: 'x-op-moondog',
    })
    scenes.push({
      id: 'publisher.cross_promotion',
      title: 'One client\'s account mentions another client on the book',
      proves:
        'An agency roster is many accounts each speaking for one coin. A coordinated inauthentic network is one account speaking for many. The binding is the enforcement point, and it is configuration - nothing a model writes can extend it.',
      verdict: refused('AT THE TICKER POLICY', result.rejectedReason ?? 'unknown'),
      given: [
        { label: 'body in', value: body },
        { label: 'account speaks for', value: `$${COIN.ticker} only (maxTickersPerAccount=${String(DISCLOSURE.maxTickersPerAccount)})` },
        { label: 'roster', value: `$${COIN.ticker}, $${RIVAL.ticker} - both clients, deliberately never mentioned together` },
      ],
      path: [
        'the ticker policy compared every ticker in the body against this account\'s binding',
        `$${RIVAL.ticker} is on the roster and is NOT this account's ticker`,
        'refused before classification, before composition, before any approval',
      ],
      blocks: [
        { label: 'nothing was sent', text: `x posts created: ${String(h.channels.x.created.length)}` },
      ],
    })
  }

  // -------------------------------------------------------------------------
  // 5. Truncation eats the body, never the disclosure.
  // -------------------------------------------------------------------------
  {
    const h = harness()
    const longBody = (
      'Desk note for holders: the group was staffed for the full window, the pinned message ' +
      'was refreshed, the FAQ entry about the fee recipient was rewritten, and the operations ' +
      'log on the site was updated with the same wording. '
    ).repeat(3)
    await h.publisher.publish({
      request: request({ body: longBody, isPromotional: true }),
      accountId: 'x-op-moondog',
    })
    const sent = lastXPost(h)
    const record = await h.posts.get(`x-op-moondog:${sent.id}`)
    const measured = measureXChars(sent.text)
    scenes.push({
      id: 'publisher.truncation',
      title: 'A body three times too long for the channel',
      proves:
        'The disclosure is measured and its cost removed from the budget BEFORE the body is measured, so the body is the only thing truncation can reach. If the disclosure alone did not fit the channel, the publisher would refuse rather than publish undisclosed.',
      verdict: ok(
        'PUBLISHED, BODY TRUNCATED',
        `${String(measured)} of 280 characters, bodyTruncated=${String(record?.bodyTruncated)}`,
      ),
      given: [
        { label: 'body in', value: `${String(longBody.length)} characters` },
        { label: 'channel limit', value: '280, measured the way X measures (a URL counts as 23)' },
      ],
      path: [
        'the canonical disclosure was rendered and measured first',
        'its cost plus the separator was subtracted from the channel budget',
        'the body was truncated to what remained',
        'the composer then ASSERTED every disclosure token is still present, and would have refused if not',
      ],
      blocks: [
        { label: 'sent on the wire', text: sent.text },
        {
          label: 'every required token still present',
          text: (record?.requiredTokens ?? [])
            .map((t: string) => `${sent.text.includes(t) ? 'present' : 'MISSING'}  ${t}`)
            .join('\n'),
        },
      ],
    })
  }

  // -------------------------------------------------------------------------
  // 6. Read-back: the disclosure went missing after publication.
  // -------------------------------------------------------------------------
  {
    const h = harness()
    await h.publisher.publish({ request: request(), accountId: 'x-op-moondog' })
    const sent = lastXPost(h)
    const externalId = `x-op-moondog:${sent.id}`

    // Someone with account access edits the post and removes the block.
    h.channels.x.tamper(sent.id, 'Desk staffed for the full window; the pinned message was refreshed.')

    const outcome = await h.publisher.verifyReadBack(externalId)
    scenes.push({
      id: 'publisher.read_back',
      title: 'The disclosure is edited out of a live post',
      proves:
        'Publishing disclosed is not the same as staying disclosed. A minute after publication the post is re-fetched and every required token checked against the LIVE text; a post that lost its disclosure is deleted. An unreadable post is deleted too - we could not tell, so it comes down.',
      verdict: refused(
        'POST DELETED',
        `${outcome.reason ?? 'unknown'}; missing ${outcome.missing.length} required token(s)`,
      ),
      given: [
        { label: 'published as', value: externalId },
        { label: 'read-back at', value: `T+${String(DISCLOSURE.readBackVerifySeconds)}s, on a scheduler, not on a hope` },
        { label: 'edit made', value: 'the disclosure block was removed from the live post' },
      ],
      path: [
        'the post was re-fetched from the platform',
        'verifyDisclosurePresent checked each required token against the live text',
        'tokens rather than the whole block, because platforms linkify and re-wrap - but a removed tag is still caught',
        'the post was deleted, the outcome recorded against the post record, and the event logged',
      ],
      blocks: [
        {
          label: 'missing tokens',
          text: outcome.missing.join('\n') || '(none)',
        },
        {
          label: 'outcome',
          text: [
            `ok       : ${String(outcome.ok)}`,
            `deleted  : ${String(outcome.deleted)}`,
            `reason   : ${outcome.reason ?? '-'}`,
            `deletions on the platform: ${String(h.channels.x.deleted.length)}`,
          ].join('\n'),
        },
        { label: 'publisher event log', text: eventTable(h.log), plain: true },
      ],
    })
  }

  const facts: Pair[] = [
    { label: 'canonical disclosure', value: canonical },
    { label: 'operator name source', value: 'configuration, checked against the placeholder predicate in core' },
    { label: 'model-supplied disclosure accepted', value: 'never - stripped, then re-added by code' },
    { label: 'addresses a body may contain', value: 'the bound token, the bound vault, configured routers. Nothing else.' },
    { label: 'tickers per account', value: String(DISCLOSURE.maxTickersPerAccount) },
    { label: 'read-back check', value: `T+${String(DISCLOSURE.readBackVerifySeconds)}s, plus a restart-safe sweep` },
  ]

  return summarise(
    'publisher',
    'disclosure is code-owned, survives truncation, and is re-checked against the live post',
    [
      'Six posts. Three go out - one plain, one after its model-authored disclosure was deleted and',
      'replaced, one truncated to fit the channel with the disclosure untouched. Two are refused',
      'outright: an address that is not this coin\'s, and a mention of another client on the book.',
      'The sixth is published, edited by someone with account access, and taken down for it.',
    ],
    scenes,
    facts,
  )
}

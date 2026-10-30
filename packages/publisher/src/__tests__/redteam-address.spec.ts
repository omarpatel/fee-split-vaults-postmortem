/**
 * RED TEAM: the publisher's address allowlist can be walked past.
 *
 * links.ts documents the exact attack it exists to close:
 *
 *   "a 'contract migration' injection ... our own labelled, trusted bot answers
 *    'where do I buy' with the attacker's address ... a HARD REJECT."
 *
 * ADDRESS_LIKE is `/0x[0-9a-fA-F]{4,}/g`. The hex body is case-insensitive by
 * character class; the `0x` prefix is a case-SENSITIVE literal because the regex
 * carries no `i` flag. `0X…` is therefore not an address as far as this file is
 * concerned, and neither is a prefix-free 40-character hex string.
 *
 * The post that comes out the other end carries the canonical disclosure, so it
 * is a signed, labelled, operator-attributed message pointing holders at an
 * attacker's contract.
 */

import { describe, expect, it } from 'vitest'
import { createAutoApprovalGate } from '../approval.js'
import { createFakeChannelSet } from '../channels/fakes.js'
import { buildLinkPolicy, checkLinksAndAddresses, extractAddressLikeTokens } from '../links.js'
import { createInMemoryEventLog } from '../log.js'
import { createPublisher, type Publisher } from '../publisher.js'
import { createInMemoryAccountRegistry, createInMemoryPostRegistry } from '../registry.js'
import { createFixedClock, createManualScheduler } from '../scheduler.js'
import type { AccountBinding, PublishRequest } from '../types.js'

const OPERATOR = 'Venue Desk'
const VAULT = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'
const ROUTER = '0x5555555555555555555555555555555555555555'
const RECEIPTS = 'https://receipts.example.com'

/** 40 hex characters. No run of three digits, so \d{3,} never fires on it. */
const ATTACKER_HEX = '1a2B3c4D5e6F7a8B9c0D1e2F3a4B5c6D7e8F9a0B'
const ATTACKER_UPPER = `0X${ATTACKER_HEX}`
const ATTACKER_LOWER = `0x${ATTACKER_HEX}`

const BINDINGS: AccountBinding[] = [
  { accountId: 'tg-chat-1', channel: 'telegram', coinRef: 'vnx', vault: VAULT, token: TOKEN, ticker: 'VNX', delegated: false },
  { accountId: 'site-1', channel: 'site', coinRef: 'vnx', vault: VAULT, token: TOKEN, ticker: 'VNX', delegated: false },
]

function harness() {
  const clock = createFixedClock(1_757_000_000)
  const nowUnix = () => clock.nowUnix()
  const channels = createFakeChannelSet({ operatorName: OPERATOR, nowUnix })
  const accounts = createInMemoryAccountRegistry(BINDINGS, [{ vault: VAULT, token: TOKEN, ticker: 'VNX' }])
  const posts = createInMemoryPostRegistry()
  const log = createInMemoryEventLog()
  const scheduler = createManualScheduler(clock)
  const publisher: Publisher = createPublisher({
    policy: {
      operatorName: OPERATOR,
      receiptsBaseUrl: RECEIPTS,
      allowedLinkHosts: ['vnx.example'],
      allowedRouterAddresses: [ROUTER],
      maxAccountLabelAgeSeconds: 86_400,
    },
    adapters: channels.adapters,
    accounts,
    posts,
    log,
    approvals: createAutoApprovalGate('reviewer', nowUnix),
    scheduler,
    clock,
  })
  return { clock, channels, accounts, posts, log, scheduler, publisher }
}

function request(body: string): PublishRequest {
  return { vault: VAULT, channel: 'site', body, isPromotional: false, links: [] }
}

describe('RED TEAM: uppercase 0X walks past the address allowlist', () => {
  it('extractAddressLikeTokens is blind to an uppercase prefix', () => {
    expect(extractAddressLikeTokens(ATTACKER_LOWER)).toHaveLength(1)

    // FAILS TODAY.
    expect(extractAddressLikeTokens(ATTACKER_UPPER)).toHaveLength(1)
  })

  it('checkLinksAndAddresses refuses 0x... but admits 0X...', () => {
    const policy = buildLinkPolicy({ allowedHosts: ['vnx.example'], allowedAddresses: [TOKEN, VAULT, ROUTER] })
    expect(checkLinksAndAddresses(`use ${ATTACKER_LOWER}`, [], policy)?.reason).toBe(
      'unallowlisted_address_in_body',
    )

    // FAILS TODAY.
    expect(checkLinksAndAddresses(`use ${ATTACKER_UPPER}`, [], policy)?.reason).toBe(
      'unallowlisted_address_in_body',
    )
  })

  it('checkLinksAndAddresses admits a prefix-free 40-character hex address', () => {
    const policy = buildLinkPolicy({ allowedHosts: ['vnx.example'], allowedAddresses: [TOKEN, VAULT, ROUTER] })

    // FAILS TODAY.
    expect(checkLinksAndAddresses(`contract: ${ATTACKER_HEX}`, [], policy)).not.toBeNull()
  })

  it('END TO END: publishes a disclosed post carrying the attacker address', async () => {
    const h = harness()
    const body = `Contract note for holders. The address of record for this token is ${ATTACKER_UPPER} and the desk has updated the pinned message to match.`

    const result = await h.publisher.publish({ request: request(body), accountId: 'site-1' })

    // FAILS TODAY: published === true, and the emitted text contains the
    // attacker's address alongside the canonical operator disclosure.
    expect(result.published).toBe(false)
    expect(result.rejectedReason).toContain('unallowlisted_address_in_body')
    expect(h.channels.site.pages.size).toBe(0)
  })

  it('END TO END: the emitted bytes contain the attacker address', async () => {
    const h = harness()
    const body = `Contract note for holders. The address of record for this token is ${ATTACKER_UPPER} and the desk has updated the pinned message to match.`

    await h.publisher.publish({ request: request(body), accountId: 'site-1' })
    const emitted = [...h.channels.site.pages.values()].map((p) => p.text).join('\n')

    // FAILS TODAY: this is what a holder reads, signed with the operator's name.
    expect(emitted).not.toContain(ATTACKER_HEX)
  })
})

describe('RED TEAM: the publisher has no handle check at all', () => {
  it('publishes a body funnelling holders to an attacker support account', async () => {
    const h = harness()
    const body =
      'If your swap failed, message vnx_support_desk on Telegram and the desk will unstick it for you.'

    const result = await h.publisher.publish({ request: request(body), accountId: 'site-1' })
    const emitted = [...h.channels.site.pages.values()].map((p) => p.text).join('\n')

    // FAILS TODAY: checkLinksAndAddresses looks for addresses, URLs and
    // dot-obfuscated domains. A bare account name is none of those, so the
    // classic drainer funnel goes out under the operator's own disclosure.
    expect(result.published).toBe(false)
    expect(emitted).not.toContain('vnx_support_desk')
  })
})

/**
 * text.js: "a zero-width space inside an address ('0x1234<ZWSP>5678') that
 * defeats a naive address matcher while still copy-pasting as a working
 * destination". U+200B is handled. The C1 block (U+0080-U+009F, which includes
 * NEL U+0085) and the Unicode separators U+2028 / U+2029 / U+202F are absent
 * from INVISIBLE_OR_BIDI, are untouched by NFKC, and are not reached by the
 * `[ \t]+` or `\n` collapses - so the very same trick works with any of them.
 *
 * The runtime's own sanitizer (corpus/sanitize.ts) DOES cover U+007F-U+009F.
 * The two normalizers disagree and the OUTBOUND one is the weaker.
 *
 * Written as escapes, not literals, for the reason text.js gives: an invisible
 * character in source is a character nobody can review.
 */
const ZWSP = String.fromCharCode(0x200b)
const UNSTRIPPED: ReadonlyArray<readonly [string, string]> = [
  ['NEL U+0085', String.fromCharCode(0x0085)],
  ['C1 U+0090', String.fromCharCode(0x0090)],
  ['LINE SEPARATOR U+2028', String.fromCharCode(0x2028)],
  ['PARAGRAPH SEPARATOR U+2029', String.fromCharCode(0x2029)],
  ['NARROW NO-BREAK SPACE U+202F', String.fromCharCode(0x202f)],
]

function interleave(value: string, sep: string, every: number): string {
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    out += value[i]
    if (i >= 2 && (i - 1) % every === 0) out += sep
  }
  return out
}

describe('RED TEAM: invisible characters the publisher does not strip', () => {
  it('U+200B is caught - it is the one the comment names', () => {
    const policy = buildLinkPolicy({ allowedHosts: ['vnx.example'], allowedAddresses: [TOKEN, VAULT, ROUTER] })
    expect(checkLinksAndAddresses(`send to ${interleave(ATTACKER_LOWER, ZWSP, 3)}`, [], policy)?.reason).toBe(
      'unallowlisted_address_in_body',
    )
  })

  for (const [name, sep] of UNSTRIPPED) {
    it(`${name} defeats the address wall`, async () => {
      const policy = buildLinkPolicy({ allowedHosts: ['vnx.example'], allowedAddresses: [TOKEN, VAULT, ROUTER] })
      const payload = interleave(ATTACKER_LOWER, sep, 3)

      // FAILS TODAY: a lowercase 0x address, split by a character the publisher
      // never removes, is not an address as far as ADDRESS_LIKE is concerned.
      expect(checkLinksAndAddresses(`send to ${payload}`, [], policy)).not.toBeNull()

      const h = harness()
      const result = await h.publisher.publish({
        request: request(`Contract of record: ${payload}. The pinned message is updated.`),
        accountId: 'site-1',
      })
      expect(result.published).toBe(false)
    })
  }
})

/**
 * The link control is described as an allowlist, and buildLinkPolicy/hostAllowed
 * really are one. But the DETECTOR that decides whether a span of text is a link
 * at all is BARE_DOMAIN - a finite deny-list of TLDs. A host on a TLD that is not
 * in that list is never recognised as a link, so it is never handed to
 * checkUrl(), so the allowlist never runs. The runtime's HANDLE_LIKE bare-domain
 * pattern has an even shorter list, so nothing on the cognition plane catches it
 * either.
 *
 * .top, .click, .icu, .cfd, .sbs and .cyou are among the most abused TLDs in
 * crypto phishing. None of them is in either list.
 */
const UNLISTED_TLDS = ['top', 'click', 'icu', 'cfd', 'sbs', 'cyou', 'win', 'vip', 'shop', 'store', 'ru']

describe('RED TEAM: the link allowlist is gated by a TLD deny-list', () => {
  it('catches a .com the policy does not allow', () => {
    const policy = buildLinkPolicy({ allowedHosts: ['vnx.example'], allowedAddresses: [TOKEN, VAULT, ROUTER] })
    expect(checkLinksAndAddresses('claim at vnx-claim.com now', [], policy)?.reason).toBe(
      'host_not_allowlisted',
    )
  })

  for (const tld of UNLISTED_TLDS) {
    it(`does not even see a .${tld} host`, async () => {
      const policy = buildLinkPolicy({ allowedHosts: ['vnx.example'], allowedAddresses: [TOKEN, VAULT, ROUTER] })
      const host = `vnx-claim.${tld}`

      // FAILS TODAY.
      expect(checkLinksAndAddresses(`claim at ${host} now`, [], policy)).not.toBeNull()

      const h = harness()
      const result = await h.publisher.publish({
        request: request(`Holder allocation snapshot is live. Claim your allocation at ${host} before Friday.`),
        accountId: 'site-1',
      })
      const emitted = [...h.channels.site.pages.values()].map((p) => p.text).join('\n')
      expect(result.published).toBe(false)
      expect(emitted).not.toContain(host)
    })
  }
})

/**
 * A naming-service name is not a website - it is a PAYMENT DESTINATION that a
 * wallet resolves to an address. ENS (.eth), Unstoppable (.crypto), SNS (.sol)
 * and SPACE ID (.bnb) are all absent from BARE_DOMAIN and from the runtime's
 * HANDLE_LIKE list, so "send it to venuevault.eth" is not a link, not an address,
 * and not a handle to any check in the system.
 */
describe('RED TEAM: naming-service destinations cross every check', () => {
  for (const name of ['venuevault.eth', 'vnx-treasury.eth', 'venue.crypto', 'vault.sol', 'claim.bnb']) {
    it(`publishes "${name}" as a destination`, async () => {
      const h = harness()
      const result = await h.publisher.publish({
        request: request(`Fee routing changed. Send any manual top-up to ${name} and the desk will confirm receipt.`),
        accountId: 'site-1',
      })
      const emitted = [...h.channels.site.pages.values()].map((p) => p.text).join('\n')

      // FAILS TODAY.
      expect(result.published).toBe(false)
      expect(emitted).not.toContain(name)
    })
  }
})

/**
 * A naming-service name is refused by its OWN rule, not by the link allowlist.
 *
 * The distinction is load-bearing and is why the two checks are separate. A host
 * is a candidate the allowlist judges, so a host CAN be permitted - that is what
 * an allowlist is for. `venuevault.eth` is a payment destination a wallet
 * resolves, so it is refused before the allowlist runs and cannot be permitted
 * by adding it to allowedLinkHosts. If these ever collapse into one rule, this
 * test is what notices.
 */
describe('naming-service names are refused by their own rule', () => {
  it('refuses even when the operator has allowlisted the host', () => {
    const policy = buildLinkPolicy({
      allowedHosts: ['venuevault.eth', 'vnx.example'],
      allowedAddresses: [TOKEN, VAULT, ROUTER],
    })
    expect(checkLinksAndAddresses('send a top-up to venuevault.eth', [], policy)?.reason).toBe(
      'naming_service_destination_in_body',
    )
  })

  it('still lets an allowlisted ordinary host through', () => {
    const policy = buildLinkPolicy({
      allowedHosts: ['vnx.example'],
      allowedAddresses: [TOKEN, VAULT, ROUTER],
    })
    expect(checkLinksAndAddresses('docs live at vnx.example/faq', [], policy)).toBeNull()
  })
})

/**
 * The allowlist COMPARISON folds the same spellings the matcher does.
 *
 * Widening the matcher without widening the comparison would have moved the
 * bypass one line down: `0X<vault>` would be extracted as a token and then fail
 * to equal the allowlisted `0x<vault>`, so the vault's own address would be
 * refused in its own disclosure - and the pressure to fix that by narrowing the
 * matcher again is exactly how the original bug would come back.
 */
describe('one address, three spellings, one allowlist key', () => {
  const policy = buildLinkPolicy({
    allowedHosts: ['vnx.example'],
    allowedAddresses: [TOKEN, VAULT, ROUTER],
  })

  for (const [label, spelling] of [
    ['lowercase prefix', VAULT],
    ['uppercase prefix', VAULT.replace(/^0x/, '0X')],
    ['no prefix', VAULT.slice(2)],
    ['mixed-case hex', `0x${VAULT.slice(2).toUpperCase()}`],
  ] as const) {
    it(`admits the bound vault written with a ${label}`, () => {
      expect(checkLinksAndAddresses(`the vault is ${spelling}`, [], policy)).toBeNull()
    })
  }

  for (const [label, spelling] of [
    ['lowercase prefix', ATTACKER_LOWER],
    ['uppercase prefix', ATTACKER_UPPER],
    ['no prefix', ATTACKER_HEX],
  ] as const) {
    it(`refuses an unallowlisted address written with a ${label}`, () => {
      expect(checkLinksAndAddresses(`the vault is ${spelling}`, [], policy)?.reason).toBe(
        'unallowlisted_address_in_body',
      )
    })
  }
})

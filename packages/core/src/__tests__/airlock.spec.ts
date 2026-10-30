/**
 * THE ADVERSARIAL SUITE airlock.ts has referenced since it was written.
 *
 * It did not exist. packages/core had no __tests__ directory and zero tests, so
 * the single most security-critical file in the repository was the only untested
 * one, and the file's own header pointed at a suite that was never created. That
 * is how the `0X` prefix survived: not because nobody thought of case, but
 * because nothing ever asked.
 *
 * TWO RULES FOR THIS FILE.
 *
 *   1. THE ORACLE IS A CORPUS, NOT A REGEX. Assertions are written against
 *      concrete strings a human can read and judge, never against a re-declared
 *      copy of the pattern under test. The adversarial helper in
 *      packages/runtime carried a byte-identical copy of the address bug, so it
 *      certified the attack payload as clean; an oracle that shares the
 *      implementation's blind spots proves only that the code agrees with
 *      itself.
 *   2. EVERY ENTRY IS A DESTINATION A HUMAN WOULD ACT ON. Not "looks suspicious"
 *      - somewhere a holder could send money or attention. If a payload is added
 *      here it is because someone could be drained by it.
 */

import { describe, expect, it } from 'vitest'
import {
  AirlockViolation,
  assertNoDestination,
  scrubGist,
  validateDigest,
  type Digest,
} from '../airlock.js'

/** A real-shaped EVM address. No run of 3+ digits, so `\d{3,}` never fires. */
const HEX40 = '1a2B3c4D5e6F7a8B9c0D1e2F3a4B5c6D7e8F9a0B'

const ZWSP = String.fromCharCode(0x200b)
const NEL = String.fromCharCode(0x0085)
const C1 = String.fromCharCode(0x0090)
const LINE_SEP = String.fromCharCode(0x2028)
const PARA_SEP = String.fromCharCode(0x2029)
const NNBSP = String.fromCharCode(0x202f)

function interleave(value: string, sep: string, every: number): string {
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    out += value[i]
    if (i >= 2 && (i - 1) % every === 0) out += sep
  }
  return out
}

/**
 * THE CORPUS. Every string here names a destination. Each is annotated with the
 * wall it walked past before the destinations module existed.
 */
const KNOWN_BAD: ReadonlyArray<readonly [string, string]> = [
  // --- addresses -----------------------------------------------------------
  ['lowercase prefix (the only form ever caught)', `buy at 0x${HEX40}`],
  ['UPPERCASE prefix - the critical finding', `buy at 0X${HEX40}`],
  ['mixed prefix', `buy at 0X${HEX40.toLowerCase()}`],
  ['no prefix at all - an address is 40 hex characters', `new contract ${HEX40}`],
  ['64-hex, a tx hash or a key', `pool id ${'ab12'.repeat(16)}`],
  ['split by a zero-width space', `send to ${interleave(`0x${HEX40}`, ZWSP, 3)}`],
  ['split by NEL U+0085', `send to ${interleave(`0x${HEX40}`, NEL, 3)}`],
  ['split by a C1 control', `send to ${interleave(`0x${HEX40}`, C1, 3)}`],
  ['split by LINE SEPARATOR', `send to ${interleave(`0x${HEX40}`, LINE_SEP, 3)}`],
  ['split by PARAGRAPH SEPARATOR', `send to ${interleave(`0x${HEX40}`, PARA_SEP, 3)}`],
  ['split by NARROW NO-BREAK SPACE', `send to ${interleave(`0x${HEX40}`, NNBSP, 3)}`],
  ['fullwidth homoglyphs', 'pay ０ｘＤＥＡＤＢＥＥＦＤＥＡＤＢＥＥＦＤＥＡＤ'],
  ['base58 / Solana', 'transfer to 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'],

  // --- hosts, on TLDs no deny-list enumerated ------------------------------
  ['a .com the policy does not allow', 'claim at vnx-claim.com now'],
  ['.top', 'claim your allocation at vnx-claim.top before friday'],
  ['.click', 'holder snapshot at vnx-claim.click'],
  ['.icu', 'holder snapshot at vnx-claim.icu'],
  ['.cfd', 'holder snapshot at vnx-claim.cfd'],
  ['.sbs', 'holder snapshot at vnx-claim.sbs'],
  ['.cyou', 'holder snapshot at vnx-claim.cyou'],
  ['.win', 'holder snapshot at vnx-claim.win'],
  ['.vip', 'holder snapshot at vnx-claim.vip'],
  ['.shop', 'holder snapshot at vnx-claim.shop'],
  ['.ru', 'holder snapshot at vnx-claim.ru'],
  ['.rest', 'holder snapshot at vnx-claim.rest'],
  ['.quest', 'holder snapshot at vnx-claim.quest'],
  ['.bond', 'holder snapshot at vnx-claim.bond'],
  ['an explicit url', 'go to https://vnx-claim.top/x now'],
  ['dot obfuscation', 'go to vnx-claim [.] top now'],
  ['bracketed word dot', 'go to vnx-claim [dot] top now'],
  ['parenthesised word dot', 'go to vnx-claim(dot)top now'],

  // --- naming services: destinations, not websites -------------------------
  ['ENS', 'send any manual top-up to venuevault.eth'],
  ['ENS with a hyphen', 'the treasury is vnx-treasury.eth'],
  ['Unstoppable', 'send it to venue.crypto'],
  ['SNS', 'the treasury is vault.sol'],
  ['SPACE ID', 'claim from claim.bnb'],

  // --- contacts ------------------------------------------------------------
  ['@handle', 'dm @vnx_support_desk for help'],
  ['@handle preceded by a word character', 'write me@vnx_support_desk'],
  ['@handle in brackets', 'dm (@drainer_bot) for the airdrop'],
  ['a bare handle, sigil dropped', 'message vnx_support_desk on telegram'],
  ['a telegram invite', 'join t.me/definitely_the_dev'],
]

describe('the airlock corpus: no destination reaches the planner', () => {
  for (const [label, payload] of KNOWN_BAD) {
    it(`assertNoDestination refuses ${label}`, () => {
      expect(() => assertNoDestination(payload, 'gists')).toThrow(AirlockViolation)
    })
  }

  for (const [label, payload] of KNOWN_BAD) {
    it(`scrubGist redacts ${label}`, () => {
      const scrubbed = scrubGist(payload)
      // The destination itself is gone...
      expect(scrubbed).not.toContain(HEX40)
      expect(scrubbed.toLowerCase()).not.toContain('vnx-claim')
      expect(scrubbed).not.toContain('venuevault')
      expect(scrubbed).not.toContain('vnx_support_desk')
      expect(scrubbed).not.toContain('drainer_bot')
      expect(scrubbed).not.toContain('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')
      // ...and the result is something the boundary itself accepts.
      expect(() => assertNoDestination(scrubbed, 'gists')).not.toThrow()
    })
  }

  for (const [label, payload] of KNOWN_BAD) {
    it(`validateDigest never renders ${label} to the planner`, () => {
      const digest = validateDigest({
        windowId: 'w1',
        coinRef: 'coin_alpha',
        windowStartUnix: 1_788_652_800,
        windowEndUnix: 1_788_654_600,
        admittedMessageCount: 3,
        droppedMessageCount: 0,
        distinctAuthorCount: 3,
        topicCounts: { contract_address_request: 3 },
        signals: [],
        gists: [payload],
        readerRefusals: 0,
      })
      const rendered = digest.gists.join(' ')
      expect(rendered).not.toContain(HEX40)
      expect(rendered.toLowerCase()).not.toContain('vnx-claim')
      expect(rendered).not.toContain('venuevault')
      expect(rendered).not.toContain('vnx_support_desk')
    })
  }
})

/**
 * CALIBRATION. A wall that refuses everything is not a wall, it is an outage.
 * These are the strings a desk legitimately writes, and every one of them must
 * cross. If a future widening breaks one of these, the widening is wrong.
 */
const KNOWN_GOOD: readonly string[] = [
  'several holders ask where to buy',
  'holders want to know when the next update lands',
  'sentiment turned negative after the pinned message changed',
  'a few people report a scam account copying the project name',
  'moderation cover is thin in the european evening',
  'the desk has a backlog of unanswered operational questions',
]

describe('the airlock is not an outage', () => {
  for (const good of KNOWN_GOOD) {
    it(`admits "${good}"`, () => {
      const scrubbed = scrubGist(good)
      expect(scrubbed).toBe(good)
      expect(() => assertNoDestination(scrubbed, 'gists')).not.toThrow()
    })
  }
})

describe('scrubGist normalises before it redacts, not after', () => {
  it('does not reassemble a split payload after the patterns have run', () => {
    // The inverted order produced "visit evil.com now" - the domain restored,
    // unredacted, by a strip that ran after every pattern had already missed it.
    expect(scrubGist(`visit evil${ZWSP}.com now`)).toContain('[link]')
    expect(scrubGist(`send to 0xdead${ZWSP}beefdeadbeefdeadbeefdeadbeefdeadbeefdead`)).not.toContain(
      '0xdead',
    )
  })

  it('never emits a fragment of the payload it redacted', () => {
    for (const [, payload] of KNOWN_BAD) {
      const scrubbed = scrubGist(payload)
      expect(scrubbed).not.toMatch(/0[xX][0-9a-fA-F]{4,}/)
    }
  })
})

/**
 * THE COUNTERS ARE A CENSUS. assemble.ts says a flood's size is carried by "a
 * number [that] cannot carry a payload". That is true of a reconciled integer
 * and false of an unbounded float.
 */
describe('topicCounts and signals cannot carry a payload', () => {
  const base = {
    windowId: 'w1',
    coinRef: 'coin_alpha',
    windowStartUnix: 1_788_652_800,
    windowEndUnix: 1_788_654_600,
    admittedMessageCount: 3,
    droppedMessageCount: 0,
    distinctAuthorCount: 2,
    topicCounts: {},
    signals: [],
    gists: [],
    readerRefusals: 0,
  }
  const build = (overrides: Record<string, unknown>): Digest =>
    validateDigest({ ...base, ...overrides })

  const total = (d: Digest): number =>
    Object.values(d.topicCounts).reduce<number>((a, b) => a + (b ?? 0), 0)

  it('reconciles every count against the trusted admitted count', () => {
    const d = build({
      topicCounts: { how_to_buy: 1_908_088_953, price_question: 1_263_694_405 },
    })
    expect(total(d)).toBeLessThanOrEqual(d.admittedMessageCount)
  })

  it('leaves an honest census untouched', () => {
    const d = build({
      admittedMessageCount: 12,
      topicCounts: { how_to_buy: 6, sentiment_positive: 3 },
    })
    expect(d.topicCounts.how_to_buy).toBe(6)
    expect(d.topicCounts.sentiment_positive).toBe(3)
  })

  it('refuses a fractional count, which carries fifteen digits where one belongs', () => {
    const d = build({ topicCounts: { how_to_buy: 0.123456789012345 } })
    expect(Number.isInteger(d.topicCounts.how_to_buy)).toBe(true)
  })

  it('rejects a fractional message count outright', () => {
    expect(() => build({ admittedMessageCount: 3.14159265358979 })).toThrow(AirlockViolation)
  })

  it('caps and de-duplicates signals', () => {
    const d = build({ signals: new Array(50_000).fill('quiet') })
    expect(d.signals).toEqual(['quiet'])
  })

  it('normalises key ORDER, which was itself a channel worth ~44 bits', () => {
    const a = build({ topicCounts: { scam_report: 1, how_to_buy: 1, price_question: 1 } })
    const b = build({ topicCounts: { price_question: 1, scam_report: 1, how_to_buy: 1 } })
    expect(Object.keys(a.topicCounts)).toEqual(Object.keys(b.topicCounts))
    const c = build({ signals: ['quiet', 'scam_wave'] })
    const e = build({ signals: ['scam_wave', 'quiet'] })
    expect(c.signals).toEqual(e.signals)
  })
})

describe('the schema stays closed', () => {
  it('refuses an unrecognised field', () => {
    expect(() =>
      validateDigest({
        windowId: 'w1',
        coinRef: 'coin_alpha',
        windowStartUnix: 1,
        windowEndUnix: 2,
        admittedMessageCount: 0,
        droppedMessageCount: 0,
        distinctAuthorCount: 0,
        topicCounts: {},
        signals: [],
        gists: [],
        readerRefusals: 0,
        payee: '0x1111111111111111111111111111111111111111',
      }),
    ).toThrow(AirlockViolation)
  })

  it('refuses an unknown topic code and an unknown signal code', () => {
    const base = {
      windowId: 'w1',
      coinRef: 'coin_alpha',
      windowStartUnix: 1,
      windowEndUnix: 2,
      admittedMessageCount: 0,
      droppedMessageCount: 0,
      distinctAuthorCount: 0,
      topicCounts: {},
      signals: [],
      gists: [],
      readerRefusals: 0,
    }
    expect(() => validateDigest({ ...base, topicCounts: { please_pay: 1 } })).toThrow(
      AirlockViolation,
    )
    expect(() => validateDigest({ ...base, signals: ['send_funds'] })).toThrow(AirlockViolation)
  })
})

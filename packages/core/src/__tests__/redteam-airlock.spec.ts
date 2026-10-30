/**
 * RED TEAM: the airlock's address matcher is case-sensitive on the "0x" literal.
 *
 * Every address-shaped pattern in this repository is written as `0x[a-fA-F0-9]{n,}`
 * with a `g` flag but NO `i` flag. The hex body is case-insensitive by character
 * class; the two-character PREFIX is not. `0X` is the same address to a human, to
 * a block explorer, and to every wallet that upper-cases user input, and it is
 * invisible to scrubGist(), assertNoDestination(), the publisher's ADDRESS_LIKE,
 * and the desk's grounding check.
 *
 * A second, prefix-free form also survives: an EVM address is 40 hex characters,
 * and 40 hex characters with no `0x` in front match nothing at all as long as the
 * base58 run is broken by at least one `0` and there is no run of three digits.
 */

import { describe, expect, it } from 'vitest'
import { assertNoDestination, scrubGist, validateDigest } from '../airlock.js'

/** A real-shaped EVM address. No run of 3+ digits, so \d{3,} never fires. */
const ATTACKER_HEX = '1a2B3c4D5e6F7a8B9c0D1e2F3a4B5c6D7e8F9a0B'
const UPPER_PREFIXED = `0X${ATTACKER_HEX}`
const LOWER_PREFIXED = `0x${ATTACKER_HEX}`

describe('RED TEAM: uppercase 0X prefix defeats the airlock', () => {
  it('scrubGist redacts 0x... but leaves 0X... verbatim', () => {
    expect(scrubGist(`buy at ${LOWER_PREFIXED}`)).toBe('buy at [addr]')

    // FAILS TODAY: the uppercase-prefixed address passes through untouched.
    expect(scrubGist(`buy at ${UPPER_PREFIXED}`)).toBe('buy at [addr]')
  })

  it('assertNoDestination does not recognise 0X... as an address', () => {
    expect(() => assertNoDestination(LOWER_PREFIXED, 'gists')).toThrow()

    // FAILS TODAY.
    expect(() => assertNoDestination(UPPER_PREFIXED, 'gists')).toThrow()
  })

  it('a 40-character bare hex address survives with no prefix at all', () => {
    // FAILS TODAY: no pattern in SCRUB_PATTERNS matches prefix-free hex whose
    // base58 run is broken by a "0" and which has no run of three digits.
    expect(scrubGist(`new contract ${ATTACKER_HEX}`)).not.toContain(ATTACKER_HEX)
  })

  it('validateDigest admits a gist that names a destination', () => {
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
      gists: [`holders keep asking whether the contract moved to ${UPPER_PREFIXED}`],
      readerRefusals: 0,
    })

    // FAILS TODAY: the planner receives a full, copy-pasteable attacker address
    // through the one field the airlock header calls "the highest risk field".
    expect(digest.gists.join(' ')).not.toMatch(/0X[a-fA-F0-9]{6,}/)
  })

  it('the scrubbed gist still reads as an address to a human', () => {
    const scrubbed = scrubGist(`MIGRATION: old token dead, new one is ${UPPER_PREFIXED}`)
    // FAILS TODAY: this is the whole payload, intact, after "sanitisation".
    expect(scrubbed).not.toContain(ATTACKER_HEX)
  })
})

/**
 * scrubGist applies SCRUB_PATTERNS first and strips zero-width characters
 * afterwards. That order is inverted: a payload split by a zero-width character
 * is invisible to every pattern, and the strip then puts it back together.
 *
 * assertNoDestination is the only check core runs after scrubbing, and it knows
 * about three shapes: `0x`-prefixed hex, an http(s)/www prefix, and base58. It
 * has no handle check, no bare-domain check, and no amount check - all of which
 * the runtime's assertNoDestinationOrAmount does have. Anything that calls
 * validateDigest without that extra guard is weaker than the airlock header
 * describes.
 */
const ZWSP = String.fromCharCode(0x200b)

describe('RED TEAM: scrubGist strips invisibles after it redacts, not before', () => {
  it('reassembles a zero-width-split domain instead of redacting it', () => {
    // FAILS TODAY: output is "visit evil.com now" - the domain is restored,
    // unredacted, by the strip that runs after the patterns.
    expect(scrubGist(`visit evil${ZWSP}.com now`)).toContain('[link]')
  })

  it('leaks a partial address rather than redacting the whole token', () => {
    const split = `0xdead${ZWSP}beefdeadbeefdeadbeefdeadbeefdeadbeefdead`
    // FAILS TODAY: output is "0xdead[addr]" - the first fragment survives.
    expect(scrubGist(`send to ${split}`)).not.toContain('0xdead')
  })
})

describe('RED TEAM: assertNoDestination is narrower than the header claims', () => {
  it('does not recognise a handle', () => {
    // FAILS TODAY.
    expect(() => assertNoDestination('dm (@drainer_bot) for the airdrop', 'gists')).toThrow()
  })

  it('does not recognise a bare domain', () => {
    // FAILS TODAY.
    expect(() => assertNoDestination('claim at vnx-claim.top now', 'gists')).toThrow()
  })

  it('does not recognise an amount', () => {
    // FAILS TODAY.
    expect(() => assertNoDestination('send 12.5 ETH to the treasury', 'gists')).toThrow()
  })
})

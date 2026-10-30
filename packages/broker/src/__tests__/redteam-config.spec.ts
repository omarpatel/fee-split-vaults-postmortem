/**
 * RED TEAM: the "compiled ceiling" is a mutable object.
 *
 * policy.ts: "A TOKEN CANNOT LOOSEN A LIMIT. Compiled SPEND_LIMITS is the
 * ceiling; a token that tries to raise any cap is refused outright."
 * gates.ts:  a load-time tripwire that refuses to load if COMMITMENT_RULE has
 *            been relaxed "in config/protocol.ts".
 *
 * Both read a plain object literal. `as const` is a TypeScript assertion that is
 * erased at emit; nothing in config/protocol.ts is Object.freeze()d, and the
 * tripwire runs once at import. So the ceiling every money decision is measured
 * against is a mutable global, and the tripwire cannot see a change made after
 * the module graph is warm. DISCLOSURE.operatorName - the name printed on every
 * published disclosure - is mutable on the same terms.
 *
 * This is hardening rather than an exploit: it needs code running in-process,
 * which the cognition plane does not have. It matters because the ceiling is
 * cited as structural, and it is not.
 */

import { describe, expect, it } from 'vitest'
import { COMMITMENT_RULE, DISCLOSURE, SPEND_LIMITS, TERMS, TIERS } from '../../../../config/protocol.js'
import { PolicyKeyring, PolicyTokenSigner, verifyPolicyToken, compiledPolicyLimits } from '../policy.js'

const KEY_ID = 'policy-2026-09'
const SERVICE_KEY = 'a-service-key-that-is-at-least-32-bytes-long'
const VAULT = '0x1111111111111111111111111111111111111111'
const NOW = 1_788_600_000

describe('RED TEAM: config/protocol.ts is mutable at runtime', () => {
  it('freezes nothing', () => {
    // FAILS TODAY on every one of these.
    expect(Object.isFrozen(SPEND_LIMITS)).toBe(true)
    expect(Object.isFrozen(TERMS)).toBe(true)
    expect(Object.isFrozen(COMMITMENT_RULE)).toBe(true)
    expect(Object.isFrozen(DISCLOSURE)).toBe(true)
  })

  /**
   * NOTE ON THIS TEST, which was rewritten rather than fixed.
   *
   * As written it asserted the vulnerability's MECHANISM - that assigning to
   * SPEND_LIMITS.rollingCapOfMedian succeeds and moves the ceiling - and it
   * cannot coexist with the test above it. Once the export is frozen, the
   * assignment throws a TypeError in strict mode (every module here is ESM, so
   * every module here is strict), and it throws from inside the `try`, from
   * inside the `finally`, and from anywhere else it is written.
   *
   * What follows asserts the property the finding argues for, and it is stronger
   * than the original: the mutation is REFUSED, the ceiling does not move, and
   * the loosened token stays refused across the attempt. It fails against an
   * unfrozen config, where the assignment succeeds silently and the token
   * verifies.
   */
  it('refuses the mutation that would have raised the ceiling', () => {
    const keyring = new PolicyKeyring({ [KEY_ID]: SERVICE_KEY })
    const signer = new PolicyTokenSigner(keyring, KEY_ID)
    const loosened = {
      ...compiledPolicyLimits(),
      rollingCapOfMedian: SPEND_LIMITS.rollingCapOfMedian * 10,
    }
    const token = signer.sign({
      v: 1,
      vault: VAULT,
      tier: 'T1',
      spendEnabled: true,
      enabledAssets: [],
      limits: loosened,
      issuedAtUnix: NOW,
      expiresAtUnix: NOW + 60,
      nonce: 'n1',
    })

    // Baseline: refused, as documented.
    expect(() => verifyPolicyToken(token, keyring, VAULT, NOW)).toThrow(/limit_loosened|exceeds the compiled ceiling/)

    const original = SPEND_LIMITS.rollingCapOfMedian

    // One assignment anywhere in the process used to raise the ceiling for
    // everyone. It is now a TypeError, from every call site, in every module.
    expect(() => {
      ;(SPEND_LIMITS as { rollingCapOfMedian: number }).rollingCapOfMedian = original * 100
    }).toThrow(TypeError)

    expect(SPEND_LIMITS.rollingCapOfMedian).toBe(original)
    expect(() => verifyPolicyToken(token, keyring, VAULT, NOW)).toThrow(/limit_loosened|exceeds the compiled ceiling/)
  })

  it('freezes the nested objects too, not only the top level', () => {
    expect(Object.isFrozen(TIERS)).toBe(true)
    expect(Object.isFrozen(TIERS.T1)).toBe(true)
    expect(() => {
      ;(TIERS.T1 as { name: string }).name = 'Attacker'
    }).toThrow(TypeError)
    expect(() => {
      ;(DISCLOSURE as { operatorName: string }).operatorName = 'Attacker'
    }).toThrow(TypeError)
  })
})

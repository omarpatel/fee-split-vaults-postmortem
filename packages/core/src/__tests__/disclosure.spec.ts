/**
 * The operator-name guard.
 *
 * These tests pin BOTH directions, because the guard this file replaced was
 * wrong in both: it published 'TBD' and it would have refused the operator's
 * real name once config/protocol.ts was filled in.
 */

import { describe, expect, it } from 'vitest'
import { DISCLOSURE } from '../../../../config/protocol.js'
import {
  MIN_OPERATOR_NAME_LENGTH,
  PLACEHOLDER_OPERATOR_NAME_PATTERNS,
  isPlaceholderOperatorName,
  requireOperatorName,
} from '../disclosure.js'

describe('isPlaceholderOperatorName', () => {
  it('rejects the sentinel config/protocol.ts actually ships', () => {
    expect(DISCLOSURE.operatorName).toBe('SET_ME_BEFORE_LAUNCH')
    expect(isPlaceholderOperatorName(DISCLOSURE.operatorName)).toBe(true)
  })

  it('rejects the placeholders the desk used to PUBLISH', () => {
    // Every one of these returned a footer like "AI-operated - TBD" before the
    // guard was single-sourced.
    for (const name of ['TBD', 'tba', 'TODO', 'CHANGEME', 'change-me', 'set_me_now', 'SET ME']) {
      expect(isPlaceholderOperatorName(name), `${name} must be refused`).toBe(true)
    }
  })

  it('rejects absent, empty and whitespace-only names', () => {
    for (const name of [undefined, null, '', ' ', '\t\n', 'A']) {
      expect(isPlaceholderOperatorName(name), `${JSON.stringify(name)} must be refused`).toBe(true)
    }
  })

  it('rejects the other not-a-name shapes', () => {
    for (const name of ['n/a', 'NONE', 'unset', 'unknown', 'null', 'undefined', 'xxx', 'XXXXX', 'YOUR_COMPANY', 'your company', 'Placeholder Ltd']) {
      expect(isPlaceholderOperatorName(name), `${name} must be refused`).toBe(true)
    }
  })

  it('ACCEPTS real names, including ones a substring rule would have eaten', () => {
    for (const name of [
      'Acme Ops Ltd',
      'Example Ops Ltd', // the desk suite's own fixture
      'Todos Ltd', // the pilot's old /TODO/i rejected this
      'Setmeal Holdings BV', // /^set_me\b/ must not fire without the boundary
      'Nanjing Trading Co', // /^(na)$/ is anchored, so this is fine
      'TBD Capital Partners', // /^tbd$/ is anchored; only the bare word is refused
      'Xi', // exactly MIN_OPERATOR_NAME_LENGTH
    ]) {
      expect(isPlaceholderOperatorName(name), `${name} must be accepted`).toBe(false)
    }
  })

  it('trims before judging, so a padded sentinel is still a sentinel', () => {
    expect(isPlaceholderOperatorName('  SET_ME_BEFORE_LAUNCH\n')).toBe(true)
    expect(isPlaceholderOperatorName('  Acme Ops Ltd  ')).toBe(false)
  })

  it('exports a non-empty pattern list and a sane minimum length', () => {
    expect(PLACEHOLDER_OPERATOR_NAME_PATTERNS.length).toBeGreaterThan(0)
    expect(MIN_OPERATOR_NAME_LENGTH).toBe(2)
  })
})

describe('requireOperatorName', () => {
  class Boom extends Error {}
  const make = (m: string) => new Boom(m)

  it('returns the trimmed name when it is real', () => {
    expect(requireOperatorName('  Acme Ops Ltd  ', make)).toBe('Acme Ops Ltd')
  })

  it('throws the caller’s error type, quoting the offending value', () => {
    expect(() => requireOperatorName('TBD', make)).toThrow(Boom)
    expect(() => requireOperatorName('TBD', make)).toThrow(/"TBD"/)
    expect(() => requireOperatorName(undefined, make)).toThrow(/null/)
  })

  it('names both places the operator can fix it', () => {
    expect(() => requireOperatorName('SET_ME_BEFORE_LAUNCH', make)).toThrow(/VENUE_OPERATOR_NAME/)
    expect(() => requireOperatorName('SET_ME_BEFORE_LAUNCH', make)).toThrow(/config\/protocol\.ts/)
  })

  /**
   * THE REGRESSION THAT MATTERS.
   *
   * The desk's old rule was `operatorName === DISCLOSURE.operatorName`. That is
   * a test of "did you pass the compiled constant", not of "is this a real
   * name" — so the day the operator does the documented thing and edits
   * config/protocol.ts, the constant becomes their real name and the desk
   * starts refusing every message. This asserts the predicate is a property of
   * the STRING, independent of what the constant currently holds.
   */
  it('does not depend on what DISCLOSURE.operatorName currently is', () => {
    const asIfLaunched = 'Acme Ops Ltd'
    expect(isPlaceholderOperatorName(asIfLaunched)).toBe(false)
    expect(requireOperatorName(asIfLaunched, make)).toBe(asIfLaunched)
    // Even if the constant were set to exactly this, the name stays valid.
    expect(isPlaceholderOperatorName(DISCLOSURE.operatorName)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'

import {
  buildDisclosureBlock,
  COMPENSATION_SENTENCE,
  WHAT_WE_DID_NOT_DO,
  type DisclosureFacts,
} from '../disclosure.js'
import { formatBps } from '../money.js'
import { DISCLOSURE, TERMS } from '../../protocol.js'

const FACTS: DisclosureFacts = {
  operatorLegalName: 'Example Operations Ltd',
  // The published rate, read from config: this fixture models a vault signed
  // today, and the assertion below checks the block NAMES the fee rather than
  // that it says any particular percentage.
  operatorBps: TERMS.operatorBps,
  budgetBps: 2_000,
  operatorAddresses: [
    { label: 'Operator treasury', address: '0x'.padEnd(42, '1'), role: 'Receives the operator fee.' },
  ],
  vaultAddress: '0x'.padEnd(42, '2'),
  paidPromotionInUse: true,
}

describe('the disclosure block', () => {
  it('carries the 17(b) compensation clause verbatim', () => {
    const block = buildDisclosureBlock(FACTS)
    const joined = block.paragraphs.join('\n')
    expect(joined).toContain(COMPENSATION_SENTENCE)
  })

  it('states both halves of the clause, not just the flattering one', () => {
    expect(COMPENSATION_SENTENCE).toContain('we hold no member tokens')
    expect(COMPENSATION_SENTENCE).toContain(
      'we are paid a percentage of member trading fees and therefore profit when member trading volume rises',
    )
  })

  it('keeps the compensation clause in a paragraph of its own so truncation cannot split it', () => {
    const block = buildDisclosureBlock(FACTS)
    const carriers = block.paragraphs.filter((paragraph) => paragraph.includes(COMPENSATION_SENTENCE))
    expect(carriers).toHaveLength(1)
    expect(carriers[0]?.endsWith(COMPENSATION_SENTENCE)).toBe(true)
  })

  it('names the operator, the fee, and every address', () => {
    const block = buildDisclosureBlock(FACTS)
    const joined = block.paragraphs.join('\n')
    expect(joined).toContain('Example Operations Ltd')
    expect(joined).toContain(formatBps(FACTS.operatorBps))
    expect(block.addresses.map((entry) => entry.address)).toContain(FACTS.vaultAddress)
    expect(block.addresses.map((entry) => entry.address)).toContain(FACTS.operatorAddresses[0]?.address)
  })

  it('identifies the machine operator, as Art. 50 and SB 1001 require', () => {
    expect(buildDisclosureBlock(FACTS).tags).toContain(DISCLOSURE.aiOperationTag)
  })

  it('adds the paid-promotion tag only when paid promotion is in use', () => {
    expect(buildDisclosureBlock(FACTS).tags).toContain(DISCLOSURE.paidPromotionTag)
    expect(buildDisclosureBlock({ ...FACTS, paidPromotionInUse: false }).tags).not.toContain(
      DISCLOSURE.paidPromotionTag,
    )
  })

  it('still discloses compensation when no promotion was bought', () => {
    const quiet = buildDisclosureBlock({ ...FACTS, paidPromotionInUse: false })
    expect(quiet.paragraphs.join('\n')).toContain(COMPENSATION_SENTENCE)
  })

  it('reflects the dial without implying the operator can change it', () => {
    const joined = buildDisclosureBlock({ ...FACTS, budgetBps: 3_500 }).paragraphs.join('\n')
    expect(joined).toContain('35%')
    expect(joined).toContain('set by the dev, not by the operator')
  })
})

describe('what we did not do', () => {
  it('is fixed copy that does not vary by coin or by week', () => {
    expect(WHAT_WE_DID_NOT_DO.length).toBeGreaterThanOrEqual(6)
    for (const line of WHAT_WE_DID_NOT_DO) {
      expect(line.startsWith('We did not')).toBe(true)
    }
  })

  it('names the specific abstentions the architecture actually enforces', () => {
    const joined = WHAT_WE_DID_NOT_DO.join(' ')
    expect(joined).toContain('token')
    expect(joined).toContain('custody')
    expect(joined).toContain('undisclosed account')
    expect(joined).toContain('predict a price')
  })
})

/**
 * RED TEAM: the T1 desk's grounding check.
 *
 * grounding.ts promises: "Does every address in it match an address the desk
 * actually read?" It answers that question with `/0x[a-fA-F0-9]{6,}/g` - no `i`
 * flag - so the answer is only "yes" for a lowercase prefix.
 *
 * Worse, the number check cannot rescue it: after the address matcher declines
 * to consume the token, numbersIn() splits it into single digits, and every
 * single digit 0-9 is in STRUCTURAL_NUMBERS. So an ungrounded address written as
 * `0X…` is invisible to both of the two checks that could have caught it, and
 * HaikuDesk returns kind:'fact' with the model's text verbatim.
 */

import { describe, expect, it } from 'vitest'
import { groundAnswer } from '../t1/grounding.js'
import { HaikuDesk } from '../t1/desk.js'
import type { DeskModel, DeskModelReply, DeskModelRequest } from '../t1/model.js'
import { makeSheet, NOW } from './fixtures.js'

const ATTACKER_HEX = '1a2B3c4D5e6F7a8B9c0D1e2F3a4B5c6D7e8F9a0B'
const ATTACKER_UPPER = `0X${ATTACKER_HEX}`
const ATTACKER_LOWER = `0x${ATTACKER_HEX}`

function scriptedModel(reply: DeskModelReply): DeskModel {
  return {
    async answer(_request: DeskModelRequest): Promise<DeskModelReply> {
      return reply
    },
  }
}

describe('RED TEAM: uppercase 0X defeats the desk grounding check', () => {
  it('flags a lowercase ungrounded address but not an uppercase one', async () => {
    const sheet = await makeSheet()

    const lower = groundAnswer(`The contract is ${ATTACKER_LOWER}.`, {
      sheet,
      nowUnix: NOW,
      citedFields: ['contract_address'],
    })
    expect(lower.violations.map((v) => v.kind)).toContain('ungrounded_address')

    const upper = groundAnswer(`The contract is ${ATTACKER_UPPER}.`, {
      sheet,
      nowUnix: NOW,
      citedFields: ['contract_address'],
    })

    // FAILS TODAY: no violation at all. The address matcher does not see it and
    // the number check sees only single digits, which are all "structural".
    expect(upper.violations.map((v) => v.kind)).toContain('ungrounded_address')
    expect(upper.ok).toBe(false)
  })

  it('END TO END: HaikuDesk returns an attacker address as a verified fact', async () => {
    const sheet = await makeSheet()
    const answer = `The address of record for this token is ${ATTACKER_UPPER}. Older pins are out of date.`

    const desk = new HaikuDesk({
      model: scriptedModel({ answer, citedFields: ['contract_address'], cannotAnswer: false }),
    })

    const attempt = await desk.answer(
      'what is the contract address?',
      { sheet, nowUnix: NOW, language: 'en' },
      'ref-1',
    )

    // FAILS TODAY: kind === 'fact', body === the attacker's address, and the
    // outbound renderer then signs it with the operator's disclosure footer.
    expect(attempt.failure).toBe('ungrounded')
    expect(attempt.answer.body).not.toContain(ATTACKER_HEX)
  })
})

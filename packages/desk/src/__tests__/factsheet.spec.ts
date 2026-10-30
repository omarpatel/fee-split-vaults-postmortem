/**
 * The other half of the safety claim: an absent FactSheet field never produces
 * an invented answer.
 *
 * The tests below attack it from three directions - the builder (does a failed
 * read become an absent fact or a zero?), the field answerer (does an absent
 * field produce a gap or a guess?), and the grounding check with a hostile
 * model installed (does a confident hallucination reach the chat?).
 */

import { describe, expect, it } from 'vitest'
import { creatorNetBps, VENUE } from '../../../../config/protocol.js'
import {
  FactSheetError,
  buildFactSheet,
  lookupFact,
  staleFields,
  usableFacts,
} from '../factsheet/builder.js'
import { FakeDeskChainReader } from '../factsheet/chain-reader.js'
import { FACT_FIELDS, FACT_SELF_CHECK, FACT_TTL_SECONDS } from '../factsheet/fields.js'
import { formatTokenAmount, urlExplorer } from '../factsheet/render.js'
import { answerField, answerFields, type FieldAnswerContext } from '../field-answer.js'
import { groundAnswer } from '../t1/grounding.js'
import { HaikuDesk } from '../t1/desk.js'
import { FakeDeskModel, parseDeskModelReply } from '../t1/model.js'
import { chainState, EXPLORER_BASE, makeSheet, NOW, TOKEN, VAULT } from './fixtures.js'

const ALWAYS_BOUND = new Set(['contract_address', 'chain_id', 'venue_version'])

async function blindSheet() {
  const reader = new FakeDeskChainReader(
    chainState({ identity: {}, supply: {}, pool: {}, feeConfig: {}, lock: {}, antiSnipe: {}, launch: {} }),
  )
  return buildFactSheet({
    vault: VAULT,
    token: TOKEN,
    tier: 'T1',
    reader,
    explorer: urlExplorer(EXPLORER_BASE),
    nowUnix: NOW,
  })
}

describe('FactSheet builder: a failed read is an absent fact', () => {
  it('marks every unreadable field absent instead of defaulting it', async () => {
    const sheet = await blindSheet()
    for (const field of FACT_FIELDS) {
      if (ALWAYS_BOUND.has(field)) continue
      expect(lookupFact(sheet, field, NOW).status, field).toBe('absent')
    }
    expect(sheet.absent.length).toBeGreaterThan(20)
  })

  it('refuses to build a sheet from the wrong chain', async () => {
    const reader = new FakeDeskChainReader(chainState({ chainId: VENUE.chainId + 1 }))
    await expect(
      buildFactSheet({
        vault: VAULT,
        token: TOKEN,
        tier: 'T1',
        reader,
        explorer: urlExplorer(EXPLORER_BASE),
        nowUnix: NOW,
      }),
    ).rejects.toBeInstanceOf(FactSheetError)
  })

  it('does not derive circulating supply from a partial read', async () => {
    const reader = new FakeDeskChainReader(
      chainState({ supply: { totalSupplyMinor: 1_000n, burnedMinor: undefined, lockedMinor: 0n } }),
    )
    const sheet = await buildFactSheet({
      vault: VAULT,
      token: TOKEN,
      tier: 'T1',
      reader,
      explorer: urlExplorer(EXPLORER_BASE),
      nowUnix: NOW,
    })
    expect(lookupFact(sheet, 'circulating_supply', NOW).status).toBe('absent')
  })

  it('pins every chain read to a block hash, never a number', async () => {
    const sheet = await makeSheet()
    const supply = lookupFact(sheet, 'total_supply', NOW)
    expect(supply.status).toBe('fresh')
    if (supply.status !== 'fresh') return
    expect(supply.fact.provenance.blockHash).toBe(sheet.builtAtBlock.hash)
  })

  it('keeps money in bigint minor units', async () => {
    const sheet = await makeSheet()
    const supply = lookupFact(sheet, 'total_supply', NOW)
    if (supply.status !== 'fresh' || supply.fact.value.kind !== 'token_amount') {
      throw new Error('expected a fresh token amount')
    }
    expect(typeof supply.fact.value.minor).toBe('bigint')
    expect(formatTokenAmount(1_000_000_000_000000000000000000n, 18)).toBe('1,000,000,000')
    expect(formatTokenAmount(1_234_567891234567891234n, 18)).toBe('1,234.5678')
  })
})

describe('FactSheet builder: the creator rate branches', () => {
  it('derives 0.70% with buyback off', async () => {
    const sheet = await makeSheet({ state: { feeConfig: { buybackEnabled: false, creatorTaxBps: 0 } } })
    const found = lookupFact(sheet, 'creator_net_bps', NOW)
    if (found.status !== 'fresh') throw new Error('expected a fresh rate')
    expect(found.fact.display).toBe('0.70%')
    expect(found.fact.provenance.source).toBe('derived')
  })

  it('halves it with buyback on, and never hardcodes either figure', async () => {
    const sheet = await makeSheet({ state: { feeConfig: { buybackEnabled: true, creatorTaxBps: 0 } } })
    const found = lookupFact(sheet, 'creator_net_bps', NOW)
    if (found.status !== 'fresh') throw new Error('expected a fresh rate')
    expect(found.fact.display).toBe('0.35%')
    expect(found.fact.value).toEqual({ kind: 'bps', bps: creatorNetBps(true, 0) })
  })

  it('adds the per-token creator tax on top', async () => {
    const sheet = await makeSheet({ state: { feeConfig: { buybackEnabled: false, creatorTaxBps: 500 } } })
    const found = lookupFact(sheet, 'creator_net_bps', NOW)
    if (found.status !== 'fresh') throw new Error('expected a fresh rate')
    expect(found.fact.display).toBe('0.75%')
  })

  it('has no rate at all when the buyback flag could not be read', async () => {
    const sheet = await makeSheet({ state: { feeConfig: { creatorTaxBps: 0 } } })
    expect(lookupFact(sheet, 'creator_net_bps', NOW).status).toBe('absent')
  })
})

describe('freshness: stale is unusable, not merely old', () => {
  it('drops a field out of the usable set once its TTL passes', async () => {
    const sheet = await makeSheet()
    const later = NOW + FACT_TTL_SECONDS.pool_quote_reserve + 1
    expect(lookupFact(sheet, 'pool_quote_reserve', later).status).toBe('stale')
    expect(staleFields(sheet, later)).toContain('pool_quote_reserve')
    expect(usableFacts(sheet, later).map((fact) => fact.field)).not.toContain('pool_quote_reserve')
  })

  it('answers a stale field with the gap template and the age, not the value', async () => {
    const sheet = await makeSheet()
    const later = NOW + FACT_TTL_SECONDS.pool_quote_reserve + 600
    const ctx: FieldAnswerContext = { sheet, nowUnix: later, language: 'en' }
    const answer = answerField(ctx, 'pool_quote_reserve')
    expect(answer.kind).toBe('unknown_field')
    expect(answer.body).toContain(FACT_SELF_CHECK.pool_quote_reserve)
    expect(answer.body).toContain('freshness limit')
    expect(answer.citations).toHaveLength(0)
  })

  it('treats a reading from the future as stale rather than trusting it', async () => {
    const sheet = await makeSheet()
    expect(lookupFact(sheet, 'total_supply', NOW - 10).status).toBe('stale')
  })
})

describe('field answers: an absent field is always a gap plus a way to check', () => {
  it('never invents a value for any field in the vocabulary', async () => {
    const sheet = await blindSheet()
    const ctx: FieldAnswerContext = { sheet, nowUnix: NOW, language: 'en' }
    for (const field of FACT_FIELDS) {
      if (ALWAYS_BOUND.has(field)) continue
      const answer = answerField(ctx, field)
      expect(answer.kind, field).toBe('unknown_field')
      expect(answer.body, field).toContain(FACT_SELF_CHECK[field])
      expect(answer.body, field).toContain(EXPLORER_BASE)
      expect(answer.citations, field).toHaveLength(0)
    }
  })

  it('keeps present and missing fields strictly separated in a combined answer', async () => {
    const sheet = await makeSheet()
    const ctx: FieldAnswerContext = { sheet, nowUnix: NOW, language: 'en' }
    const answer = answerFields(ctx, ['total_supply', 'holder_count'], 'Supply:')
    expect(answer.kind).toBe('fact')
    expect(answer.body).toContain('Total supply:')
    expect(answer.body).toContain(FACT_SELF_CHECK.holder_count)
    expect(answer.citations.map((citation) => citation.field)).toEqual(['total_supply'])
  })

  it('answers in the requested language frame', async () => {
    const sheet = await blindSheet()
    const answer = answerField({ sheet, nowUnix: NOW, language: 'es' }, 'holder_count')
    expect(answer.body.startsWith('No tengo')).toBe(true)
  })
})

describe('grounding: a hallucination cannot reach the chat', () => {
  it('accepts an answer whose figures all come from a cited fact', async () => {
    const sheet = await makeSheet()
    const supply = lookupFact(sheet, 'total_supply', NOW)
    if (supply.status !== 'fresh') throw new Error('expected a fresh supply')
    const result = groundAnswer(`Total supply is ${supply.fact.display}.`, {
      sheet,
      nowUnix: NOW,
      citedFields: ['total_supply'],
    })
    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.citations).toHaveLength(1)
  })

  it('rejects a figure that appears in no cited fact', async () => {
    const sheet = await makeSheet()
    const result = groundAnswer('There are 4,200 holders.', {
      sheet,
      nowUnix: NOW,
      citedFields: ['total_supply'],
    })
    expect(result.ok).toBe(false)
    expect(result.violations.map((violation) => violation.kind)).toContain('ungrounded_number')
  })

  it('rejects a citation of a field the desk never read', async () => {
    const sheet = await makeSheet()
    const result = groundAnswer('There are 4200 holders.', {
      sheet,
      nowUnix: NOW,
      citedFields: ['holder_count'],
    })
    expect(result.ok).toBe(false)
    expect(result.violations.map((violation) => violation.kind)).toContain('absent_citation')
  })

  it('rejects a citation whose reading has aged out', async () => {
    const sheet = await makeSheet()
    const later = NOW + FACT_TTL_SECONDS.pool_quote_reserve + 5
    const result = groundAnswer('The pool holds 250,000 USDG.', {
      sheet,
      nowUnix: later,
      citedFields: ['pool_quote_reserve'],
    })
    expect(result.ok).toBe(false)
    expect(result.violations.map((violation) => violation.kind)).toContain('stale_citation')
  })

  it('rejects an address the desk never read', async () => {
    const sheet = await makeSheet()
    const result = groundAnswer('Send it to 0x651c06a1a38c5727f0d3ef7420d90e02e0fee33d.', {
      sheet,
      nowUnix: NOW,
      citedFields: [],
    })
    expect(result.violations.map((violation) => violation.kind)).toContain('ungrounded_address')
  })

  it('rejects a link to anywhere but the explorer', async () => {
    const sheet = await makeSheet()
    const result = groundAnswer('Claim it at https://not-the-explorer.example/claim', {
      sheet,
      nowUnix: NOW,
      citedFields: [],
    })
    expect(result.violations.map((violation) => violation.kind)).toContain('ungrounded_link')
  })

  it('rejects an unknown field id outright', async () => {
    const sheet = await makeSheet()
    const result = groundAnswer('All good.', {
      sheet,
      nowUnix: NOW,
      citedFields: ['definitely_not_a_field'],
    })
    expect(result.violations.map((violation) => violation.kind)).toContain('unknown_field')
  })
})

describe('T1 desk: hostile models produce honest gaps', () => {
  const ctxFor = async () => {
    const sheet = await makeSheet()
    const ctx: FieldAnswerContext = { sheet, nowUnix: NOW, language: 'en' }
    return ctx
  }

  it('discards a confidently invented holder count', async () => {
    const ctx = await ctxFor()
    const model = new FakeDeskModel(() => ({
      answer: 'This token has 12,431 holders and the top ten hold 4%.',
      citedFields: ['holder_count', 'top10_holder_share_pct'],
    }))
    const desk = new HaikuDesk({ model })
    const attempt = await desk.answer('how many holders are there?', ctx, 'R-TEST')

    expect(attempt.failure).toBe('ungrounded')
    expect(attempt.answer.kind).toBe('unknown_field')
    expect(attempt.answer.body).not.toContain('12,431')
    expect(attempt.answer.citations).toHaveLength(0)
  })

  it('discards an answer that cites nothing but quotes a figure', async () => {
    const ctx = await ctxFor()
    const model = new FakeDeskModel(() => ({
      answer: 'Liquidity is around 900,000 USDG.',
      citedFields: [],
    }))
    const attempt = await new HaikuDesk({ model }).answer('how deep is the pool?', ctx, 'R-TEST')
    expect(attempt.failure).toBe('ungrounded')
    expect(attempt.grounding?.violations.map((violation) => violation.kind)).toContain('uncited_figure')
  })

  it('passes an answer that quotes a cited fact exactly', async () => {
    const ctx = await ctxFor()
    const supply = lookupFact(ctx.sheet, 'total_supply', NOW)
    if (supply.status !== 'fresh') throw new Error('expected a fresh supply')
    const model = new FakeDeskModel(() => ({
      answer: `Total supply is ${supply.fact.display}.`,
      citedFields: ['total_supply'],
    }))
    const attempt = await new HaikuDesk({ model }).answer('what is the supply?', ctx, 'R-TEST')
    expect(attempt.failure).toBeUndefined()
    expect(attempt.answer.kind).toBe('fact')
    expect(attempt.answer.modelAuthored).toBe(true)
    expect(attempt.answer.citations.map((citation) => citation.field)).toEqual(['total_supply'])
  })

  it('never shows the model an absent or stale field', async () => {
    const sheet = await makeSheet()
    const later = NOW + FACT_TTL_SECONDS.pool_quote_reserve + 1
    const ctx: FieldAnswerContext = { sheet, nowUnix: later, language: 'en' }
    const model = new FakeDeskModel(() => ({ answer: '', citedFields: [], cannotAnswer: true }))
    await new HaikuDesk({ model }).answer('anything', ctx, 'R-TEST')

    const shown = model.requests[0]?.facts.map((fact) => fact.field) ?? []
    expect(shown).not.toContain('holder_count')
    expect(shown).not.toContain('pool_quote_reserve')
    expect(shown).toContain('total_supply')
  })

  it('falls back to the gap template when the model times out', async () => {
    const ctx = await ctxFor()
    const model = new FakeDeskModel(
      () => new Promise((resolve) => setTimeout(() => resolve({ answer: 'late', citedFields: [] }), 50)),
    )
    const attempt = await new HaikuDesk({ model, timeoutMs: 5 }).answer('supply?', ctx, 'R-TEST')
    expect(attempt.failure).toBe('model_timeout')
    expect(attempt.answer.kind).toBe('unknown_field')
  })

  it('falls back when the model throws', async () => {
    const ctx = await ctxFor()
    const model = new FakeDeskModel(() => {
      throw new Error('provider exploded')
    })
    const attempt = await new HaikuDesk({ model }).answer('supply?', ctx, 'R-TEST')
    expect(attempt.failure).toBe('model_error')
  })

  it('refuses on the output even when the question was innocuous', async () => {
    const ctx = await ctxFor()
    const model = new FakeDeskModel(() => ({
      answer: 'Supply is fixed, and honestly you should buy before it 10x from here.',
      citedFields: ['total_supply'],
    }))
    const attempt = await new HaikuDesk({ model }).answer('what is the supply?', ctx, 'R-TEST')
    expect(attempt.answer.kind).toBe('refusal')
    expect(attempt.screen.trippedOn).toBe('output')
  })
})

describe('model reply parsing fails closed', () => {
  it('treats junk as cannot-answer', () => {
    expect(parseDeskModelReply('not json at all').cannotAnswer).toBe(true)
    expect(parseDeskModelReply('').cannotAnswer).toBe(true)
    expect(parseDeskModelReply('{"answer":').cannotAnswer).toBe(true)
    expect(parseDeskModelReply('{"answer": ""}').cannotAnswer).toBe(true)
  })

  it('extracts a well-formed reply even when it is wrapped in prose', () => {
    const reply = parseDeskModelReply(
      'Sure! {"answer": "Total supply is 10.", "cited_fields": ["total_supply"], "cannot_answer": false}',
    )
    expect(reply.answer).toBe('Total supply is 10.')
    expect(reply.citedFields).toEqual(['total_supply'])
    expect(reply.cannotAnswer).toBe(false)
  })
})

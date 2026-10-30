/**
 * The factsheet provenance schema.
 *
 * The last block cross-checks the shipped schema against the desk's own field
 * vocabulary by READING ITS SOURCE AS TEXT rather than importing it. That is
 * deliberate: the desk is owned by another track and under active edit, and a
 * type-level import would make this suite fail on their build errors. Reading
 * the file catches the drift that matters - a field added on one side and not
 * the other - without coupling the two builds.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CatalogError } from '../errors.js'
import { loadFactsheetSchema, parseFactsheetSchema, SOURCE_CLASS } from '../factsheet.js'

const schema = loadFactsheetSchema()

function base(fields: unknown[]): unknown {
  return { schemaVersion: 1, publishedAtUnix: 1_788_652_800, fields }
}

const CHAIN_FIELD = {
  id: 'a_chain_field',
  label: 'a chain field',
  source: 'chain_read',
  class: 'chain_read',
  method: 'someCall()',
  ttlSeconds: 300,
  serveWhenStale: false,
  staleBehavior: 'refuse_with_self_check',
  selfCheck: 'read it yourself in the explorer',
}

describe('the shipped schema', () => {
  it('declares a field vocabulary the desk can answer from', () => {
    expect(schema.fieldIds.length).toBeGreaterThan(20)
    expect(schema.has('contract_address')).toBe(true)
    expect(schema.has('creator_net_bps')).toBe(true)
  })

  it('gives every field a TTL and a self-check', () => {
    for (const field of schema.fields) {
      expect(field.ttlSeconds).toBeGreaterThan(0)
      expect(field.selfCheck.length).toBeGreaterThan(10)
      expect(field.method.length).toBeGreaterThan(0)
    }
  })

  it('serves NOTHING when stale, which is the default the brief asks for', () => {
    for (const field of schema.fields) {
      expect(field.serveWhenStale).toBe(false)
      expect(field.staleBehavior).toBe('refuse_with_self_check')
    }
  })

  it('keeps the security-relevant fields on a short leash', () => {
    // A stale fee recipient is a security answer, not a trivia answer.
    expect(schema.field('fee_recipient').ttlSeconds).toBeLessThanOrEqual(300)
    expect(schema.field('pool_liquidity_usd').ttlSeconds).toBeLessThanOrEqual(300)
  })

  it('labels our own books as operator-asserted, never as a chain fact', () => {
    expect(schema.field('fees_credited_24h_usd').class).toBe('operator_asserted')
    expect(schema.field('fees_credited_lifetime_usd').class).toBe('operator_asserted')
    expect(schema.field('contract_address').class).toBe('operator_asserted')
    // A USD figure derived from two chain reads is still ours, because the
    // price that converted them came from us.
    expect(schema.field('pool_liquidity_usd').class).toBe('operator_asserted')
    expect(schema.field('pool_liquidity_usd').source).toBe('derived')
  })

  it('keeps every derivation retraceable and no longer-lived than its inputs', () => {
    for (const field of schema.fields) {
      if (field.source !== 'derived') continue
      expect(field.derivedFrom?.length).toBeGreaterThan(0)
      for (const inputId of field.derivedFrom ?? []) {
        expect(schema.has(inputId)).toBe(true)
        expect(field.ttlSeconds).toBeLessThanOrEqual(schema.field(inputId).ttlSeconds)
      }
    }
  })

  it('agrees with its own source-to-class table', () => {
    for (const field of schema.fields) {
      if (field.source === 'derived') continue
      expect(field.class).toBe(SOURCE_CLASS[field.source])
    }
  })
})

describe('servability', () => {
  it('serves a fresh observation and refuses an aged one', () => {
    const now = 2_000_000_000
    expect(schema.isServable('fee_recipient', now - 299, now)).toBe(true)
    expect(schema.isServable('fee_recipient', now - 301, now)).toBe(false)
  })

  it('refuses an observation from the future, which is a clock bug not a fact', () => {
    const now = 2_000_000_000
    expect(schema.isServable('fee_recipient', now + 60, now)).toBe(false)
  })

  it('fails closed on a field the schema does not declare', () => {
    expect(() => schema.field('wen_moon')).toThrow(CatalogError)
    expect(() => schema.isServable('wen_moon', 1, 2)).toThrow(/unknown_field/)
  })
})

describe('validation refuses', () => {
  it('a field with no TTL', () => {
    expect(() => parseFactsheetSchema(base([{ ...CHAIN_FIELD, ttlSeconds: 0 }]), 'test')).toThrow(
      /bad_ttl/,
    )
  })

  it('a field that does not state serveWhenStale at all', () => {
    const { serveWhenStale, ...withoutFlag } = CHAIN_FIELD
    expect(serveWhenStale).toBe(false)
    expect(() => parseFactsheetSchema(base([withoutFlag]), 'test')).toThrow(
      /missing_serve_when_stale/,
    )
  })

  it('stale serving with no written justification', () => {
    expect(() =>
      parseFactsheetSchema(
        base([
          {
            ...CHAIN_FIELD,
            serveWhenStale: true,
            staleBehavior: 'serve_with_age_disclosure',
          },
        ]),
        'test',
      ),
    ).toThrow(/unjustified_stale_serving/)
  })

  it('stale serving that does not disclose the age', () => {
    expect(() =>
      parseFactsheetSchema(
        base([
          {
            ...CHAIN_FIELD,
            serveWhenStale: true,
            staleJustification: 'this value is immutable by construction and cheap to re-verify',
          },
        ]),
        'test',
      ),
    ).toThrow(/stale_without_age_disclosure/)
  })

  it('a ledger figure filed as a chain read', () => {
    expect(() =>
      parseFactsheetSchema(base([{ ...CHAIN_FIELD, source: 'ledger' }]), 'test'),
    ).toThrow(/class_source_mismatch/)
  })

  it('a derived field claiming to be stronger than its weakest input', () => {
    expect(() =>
      parseFactsheetSchema(
        base([
          { ...CHAIN_FIELD, id: 'ours', source: 'ledger', class: 'operator_asserted' },
          {
            ...CHAIN_FIELD,
            id: 'laundered',
            source: 'derived',
            class: 'chain_read',
            derivedFrom: ['ours'],
          },
        ]),
        'test',
      ),
    ).toThrow(/derived_class_overclaim/)
  })

  it('a derived field that outlives its shortest-lived input', () => {
    expect(() =>
      parseFactsheetSchema(
        base([
          { ...CHAIN_FIELD, id: 'short_lived', ttlSeconds: 60 },
          {
            ...CHAIN_FIELD,
            id: 'too_durable',
            source: 'derived',
            ttlSeconds: 3600,
            derivedFrom: ['short_lived'],
          },
        ]),
        'test',
      ),
    ).toThrow(/derived_ttl_exceeds_input/)
  })

  it('a derivation naming an input the schema does not declare', () => {
    expect(() =>
      parseFactsheetSchema(
        base([{ ...CHAIN_FIELD, source: 'derived', derivedFrom: ['ghost'] }]),
        'test',
      ),
    ).toThrow(/unknown_derived_input/)
  })

  it('a derived field with no inputs at all', () => {
    expect(() =>
      parseFactsheetSchema(base([{ ...CHAIN_FIELD, source: 'derived' }]), 'test'),
    ).toThrow(/derived_without_inputs/)
  })

  it('an unknown key, so a misspelled ttl cannot silently vanish', () => {
    expect(() =>
      parseFactsheetSchema(base([{ ...CHAIN_FIELD, ttlSecond: 300 }]), 'test'),
    ).toThrow(/unknown_field/)
  })
})

describe('agreement with the desk vocabulary', () => {
  const deskFields = fileURLToPath(
    new URL('../../../desk/src/factsheet/fields.ts', import.meta.url),
  )

  it('declares exactly the fields the desk knows how to answer', () => {
    if (!existsSync(deskFields)) {
      // The desk package is owned by another track. If it is not present, this
      // check has nothing to compare against and the rest of the suite stands.
      expect(schema.fieldIds.length).toBeGreaterThan(0)
      return
    }
    const source = readFileSync(deskFields, 'utf8')
    const block = /export const FACT_FIELDS = \[([\s\S]*?)\] as const/.exec(source)
    expect(block).not.toBeNull()
    const declared = [...(block?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1])
    expect(declared.length).toBeGreaterThan(0)
    expect([...schema.fieldIds].sort()).toEqual([...declared].sort())
  })
})

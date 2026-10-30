/**
 * THE FACTSHEET PROVENANCE SCHEMA.
 *
 * The desk answers holder questions only from a FactSheet, and this file is the
 * declaration of what a fact is allowed to be: where it came from, how long the
 * observation stays usable, and whether it may be served after that. The desk
 * owns the answering; this package owns the schema and its validation, which is
 * the right split because a component that both asserts a fact's freshness and
 * decides whether it is fresh enough has no check on itself.
 *
 * THREE THINGS THIS SCHEMA MAKES IMPOSSIBLE:
 *
 *   A FACT WITH NO TTL. Every field carries a freshness budget. There is no
 *   "static" escape hatch, because "immutable by construction" is a claim about
 *   the contract, and the read that established it can still be from a block
 *   that got reorged out.
 *
 *   SERVING STALE BY ACCIDENT. `serveWhenStale` is required and false almost
 *   everywhere; setting it true requires a written justification in the data
 *   itself. The default is no, and it is a no that someone has to argue past.
 *
 *   A MISLABELLED SOURCE. Each field declares both a specific source and a
 *   coarse class, and the loader recomputes the class from the source rather
 *   than trusting it. A ledger figure cannot be filed as a chain read, and a
 *   derived field inherits the WEAKEST class among its inputs - so a number
 *   computed partly from our own books is never presented as a chain fact.
 */
import { existsSync, readFileSync } from 'node:fs'
import { CatalogError } from './errors.js'
import { dataPaths } from './paths.js'

function fail(code: string, message: string): never {
  throw new CatalogError('factsheet_schema', code, message)
}

/**
 * The specific provenance vocabulary, matching the `FactSource` union the desk
 * consumes in packages/desk/src/factsheet/fields.ts.
 */
export const FACT_SOURCES = [
  'chain_read',
  'hook_event',
  'indexer',
  'ledger',
  'protocol_doc',
  'operator_bound',
  'derived',
] as const

export type FactSource = (typeof FACT_SOURCES)[number]

/** The coarse bucket a holder actually cares about: who is asserting this. */
export const FACT_CLASSES = ['chain_read', 'contract', 'operator_asserted'] as const
export type FactClass = (typeof FACT_CLASSES)[number]

/** How much a class is worth. Higher is weaker; derived takes its worst input. */
const CLASS_RANK: Readonly<Record<FactClass, number>> = {
  chain_read: 0,
  contract: 1,
  operator_asserted: 2,
}

/**
 * Source to class. `indexer` is a chain read because it is an aggregation of
 * chain reads; `ledger` is operator-asserted because it is our own books, and
 * calling our books a chain fact is exactly the kind of quiet overclaim a
 * disclosed operator cannot afford.
 */
export const SOURCE_CLASS: Readonly<Record<Exclude<FactSource, 'derived'>, FactClass>> = {
  chain_read: 'chain_read',
  indexer: 'chain_read',
  hook_event: 'contract',
  protocol_doc: 'contract',
  ledger: 'operator_asserted',
  operator_bound: 'operator_asserted',
}

export type StaleBehavior = 'refuse_with_self_check' | 'serve_with_age_disclosure'

export interface FactFieldSchema {
  id: string
  label: string
  source: FactSource
  class: FactClass
  /** The call, event, or aggregation that produces it. */
  method: string
  ttlSeconds: number
  /** Default no. True requires `staleJustification`. */
  serveWhenStale: boolean
  staleBehavior: StaleBehavior
  /** How a holder checks this WITHOUT trusting the desk. Emitted verbatim. */
  selfCheck: string
  derivedFrom?: string[]
  staleJustification?: string
  note?: string
}

export interface FactsheetSchemaFile {
  schemaVersion: 1
  publishedAtUnix: number
  fields: FactFieldSchema[]
  note?: string
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('not_an_object', `${where} is not an object`)
  }
  return value as Record<string, unknown>
}

function str(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) {
    fail('missing_string', `${where}.${key} must be a non-empty string`)
  }
  return value
}

export function parseFactsheetSchema(raw: unknown, where: string): FactsheetSchemaFile {
  const file = asObject(raw, where)
  if (file.schemaVersion !== 1) {
    fail('unsupported_schema_version', `${where} declares an unsupported schemaVersion`)
  }
  const publishedAtUnix = file.publishedAtUnix
  if (typeof publishedAtUnix !== 'number' || !Number.isSafeInteger(publishedAtUnix) || publishedAtUnix <= 0) {
    fail('bad_published_at', `${where}.publishedAtUnix must be a positive integer`)
  }
  if (!Array.isArray(file.fields)) fail('missing_fields', `${where}.fields must be an array`)

  const fields: FactFieldSchema[] = []
  const byId = new Map<string, FactFieldSchema>()

  for (const [index, item] of file.fields.entries()) {
    const fieldWhere = `${where}.fields[${index}]`
    const source = asObject(item, fieldWhere)

    for (const key of Object.keys(source)) {
      if (
        ![
          'id',
          'label',
          'source',
          'class',
          'method',
          'ttlSeconds',
          'serveWhenStale',
          'staleBehavior',
          'selfCheck',
          'derivedFrom',
          'staleJustification',
          'note',
        ].includes(key)
      ) {
        fail('unknown_field', `${fieldWhere} carries unknown key "${key}"; the schema is closed`)
      }
    }

    const id = str(source, 'id', fieldWhere)
    if (!/^[a-z0-9_]+$/.test(id)) {
      fail('bad_field_id', `${fieldWhere}.id must be lowercase snake_case`)
    }
    if (byId.has(id)) fail('duplicate_field', `${fieldWhere} duplicates field "${id}"`)

    const factSource = str(source, 'source', fieldWhere)
    if (!(FACT_SOURCES as readonly string[]).includes(factSource)) {
      fail('bad_source', `${fieldWhere}.source must be one of ${FACT_SOURCES.join(', ')}`)
    }
    const declaredClass = str(source, 'class', fieldWhere)
    if (!(FACT_CLASSES as readonly string[]).includes(declaredClass)) {
      fail('bad_class', `${fieldWhere}.class must be one of ${FACT_CLASSES.join(', ')}`)
    }

    const ttlSeconds = source.ttlSeconds
    if (typeof ttlSeconds !== 'number' || !Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      fail(
        'bad_ttl',
        `${fieldWhere}.ttlSeconds must be a positive integer; a fact with no freshness budget is a fact ` +
          `nobody ever re-reads`,
      )
    }

    const serveWhenStale = source.serveWhenStale
    if (typeof serveWhenStale !== 'boolean') {
      fail(
        'missing_serve_when_stale',
        `${fieldWhere}.serveWhenStale must be stated explicitly; the default is no and it is a no ` +
          `someone has to argue past`,
      )
    }

    const staleBehavior = str(source, 'staleBehavior', fieldWhere)
    if (staleBehavior !== 'refuse_with_self_check' && staleBehavior !== 'serve_with_age_disclosure') {
      fail('bad_stale_behavior', `${fieldWhere}.staleBehavior is not a known behaviour`)
    }
    if (!serveWhenStale && staleBehavior !== 'refuse_with_self_check') {
      fail(
        'inconsistent_stale_behavior',
        `${fieldWhere} may not be served when stale, so its stale behaviour must be refuse_with_self_check`,
      )
    }
    if (serveWhenStale) {
      const justification = source.staleJustification
      if (typeof justification !== 'string' || justification.length < 20) {
        fail(
          'unjustified_stale_serving',
          `${fieldWhere} is served when stale but carries no written justification`,
        )
      }
      if (staleBehavior !== 'serve_with_age_disclosure') {
        fail(
          'stale_without_age_disclosure',
          `${fieldWhere} is served when stale and must disclose the observation's age when it is`,
        )
      }
    }

    const field: FactFieldSchema = {
      id,
      label: str(source, 'label', fieldWhere),
      source: factSource as FactSource,
      class: declaredClass as FactClass,
      method: str(source, 'method', fieldWhere),
      ttlSeconds,
      serveWhenStale,
      staleBehavior,
      selfCheck: str(source, 'selfCheck', fieldWhere),
    }

    if (source.derivedFrom !== undefined) {
      if (!Array.isArray(source.derivedFrom) || source.derivedFrom.length === 0) {
        fail('bad_derived_from', `${fieldWhere}.derivedFrom must be a non-empty array`)
      }
      field.derivedFrom = source.derivedFrom.map((entry, i) => {
        if (typeof entry !== 'string' || entry.length === 0) {
          fail('bad_derived_from', `${fieldWhere}.derivedFrom[${i}] is not a field id`)
        }
        return entry
      })
    }
    if (typeof source.staleJustification === 'string') {
      field.staleJustification = source.staleJustification
    }
    if (typeof source.note === 'string') field.note = source.note

    if (field.source === 'derived') {
      if (field.derivedFrom === undefined) {
        fail(
          'derived_without_inputs',
          `${fieldWhere} is derived but names no inputs; a derivation nobody can retrace is an assertion`,
        )
      }
    } else if (field.derivedFrom !== undefined) {
      fail('non_derived_with_inputs', `${fieldWhere} is not derived but names derivedFrom`)
    }

    fields.push(field)
    byId.set(id, field)
  }

  if (fields.length === 0) fail('no_fields', `${where} declares no fields`)

  // Second pass: derivations resolve, and a derived field inherits the weakest
  // class among its inputs.
  for (const field of fields) {
    if (field.source !== 'derived') {
      const expected = SOURCE_CLASS[field.source as Exclude<FactSource, 'derived'>]
      if (field.class !== expected) {
        fail(
          'class_source_mismatch',
          `field "${field.id}" declares class "${field.class}" but its source "${field.source}" is always "${expected}"`,
        )
      }
      continue
    }

    let worst: FactClass = 'chain_read'
    for (const inputId of field.derivedFrom ?? []) {
      const input = byId.get(inputId)
      if (input === undefined) {
        fail(
          'unknown_derived_input',
          `field "${field.id}" derives from "${inputId}", which this schema does not declare`,
        )
      }
      if (input.id === field.id) {
        fail('self_derivation', `field "${field.id}" derives from itself`)
      }
      if (CLASS_RANK[input.class] > CLASS_RANK[worst]) worst = input.class
    }
    // One-directional: a derivation may declare itself WEAKER than its inputs -
    // a USD figure derived from two chain reads is still operator-asserted,
    // because the price that converted them came from us. It may never declare
    // itself stronger, which is the overclaim this check exists to catch.
    if (CLASS_RANK[field.class] < CLASS_RANK[worst]) {
      fail(
        'derived_class_overclaim',
        `field "${field.id}" declares class "${field.class}" but its weakest input is "${worst}"; a number ` +
          `computed partly from our own books is not a chain fact`,
      )
    }
    // A derivation cannot outlive its shortest-lived input.
    for (const inputId of field.derivedFrom ?? []) {
      const input = byId.get(inputId)
      if (input !== undefined && field.ttlSeconds > input.ttlSeconds) {
        fail(
          'derived_ttl_exceeds_input',
          `field "${field.id}" has a ${field.ttlSeconds}s TTL but derives from "${inputId}", which expires ` +
            `after ${input.ttlSeconds}s`,
        )
      }
    }
  }

  const out: FactsheetSchemaFile = { schemaVersion: 1, publishedAtUnix, fields }
  if (typeof file.note === 'string') out.note = file.note
  return out
}

export class FactsheetSchema {
  readonly #byId = new Map<string, FactFieldSchema>()
  readonly publishedAtUnix: number

  constructor(file: FactsheetSchemaFile) {
    for (const field of file.fields) this.#byId.set(field.id, field)
    this.publishedAtUnix = file.publishedAtUnix
  }

  /** Fail closed: a field the schema does not declare cannot be answered. */
  field(id: string): FactFieldSchema {
    const field = this.#byId.get(id)
    if (field === undefined) {
      fail('unknown_field', `"${id}" is not a declared fact field and cannot be answered`)
    }
    return field
  }

  has(id: string): boolean {
    return this.#byId.has(id)
  }

  get fieldIds(): string[] {
    return [...this.#byId.keys()]
  }

  get fields(): FactFieldSchema[] {
    return [...this.#byId.values()]
  }

  /**
   * May this observation be served now? The whole point of the schema in one
   * function: an aged-out fact is refused unless it was explicitly, and in
   * writing, marked servable.
   */
  isServable(id: string, observedAtUnix: number, nowUnix: number): boolean {
    const field = this.field(id)
    const age = nowUnix - observedAtUnix
    if (age < 0) return false // observed in the future: a clock problem, not a fact
    if (age <= field.ttlSeconds) return true
    return field.serveWhenStale
  }
}

export function loadFactsheetSchema(dataDir?: string): FactsheetSchema {
  const path = dataPaths(dataDir).factsheetSchema
  if (!existsSync(path)) fail('missing_file', `${path} does not exist`)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail('malformed_json', `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return new FactsheetSchema(parseFactsheetSchema(raw, path))
}

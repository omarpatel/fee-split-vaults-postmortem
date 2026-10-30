/**
 * THE OFAC SDN LIST: loader interface, cache format, and fetch-and-cache.
 *
 * Sanctions screening is the one stage-1 check with a hard legal consequence
 * for a false negative, so this file fails closed three times over:
 *
 *   1. THE SHIPPED CACHE IS NOT AUTHORITATIVE. A fresh checkout carries an
 *      empty cache with `authoritative: false`. packages/screening already
 *      refuses to issue a CLEAR against a non-authoritative source, so a
 *      deployment that never ran the fetch script cannot clear anybody. The
 *      real SDN file is ~17k entries and about 2 MB; it does not belong in git,
 *      it changes on OFAC's schedule and not on ours, and a stale copy checked
 *      in would be worse than no copy because it would look like one.
 *
 *   2. THE CACHE DATES ITSELF. `publishedAtUnix` is taken from OFAC's own
 *      publish date where the file carries one and from the HTTP
 *      `Last-Modified` header otherwise, never from our clock, because "when we
 *      downloaded it" is not "when OFAC published it" and the staleness gate
 *      cares about the second one.
 *
 *   3. THE CACHE IS SEALED. A hand-edited cache does not load. Removing a name
 *      from a sanctions list with a text editor should not be a thing that
 *      quietly works.
 *
 * The SDN download is published by OFAC as a set of flat CSV files: SDN.CSV
 * carries the primary names, ALT.CSV carries aliases keyed by the same entity
 * number. Both use "-0-" as their null token.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CatalogError } from './errors.js'
import { canonicalJson, sha256Hex } from './hash.js'
import { dataPaths } from './paths.js'
import type { HttpClient } from './http.js'

function fail(code: string, message: string): never {
  throw new CatalogError('screening_data', code, message)
}

export type SdnEntryType = 'individual' | 'entity' | 'vessel' | 'digital_currency'

/** Shaped to match the `SdnEntry` packages/screening consumes. */
export interface SdnEntry {
  uid: string
  name: string
  aliases?: string[]
  program?: string
  type: SdnEntryType
}

/**
 * The interface packages/screening reads through. Kept structurally identical
 * to its own `SdnSource` so a catalog-loaded cache drops straight in.
 */
export interface SdnSource {
  entries(): readonly SdnEntry[]
  /** When OFAC published the loaded file. Drives the staleness gate. */
  publishedAtUnix(): number
  /** False for anything that is not the official download. */
  authoritative(): boolean
}

export interface SdnCacheFile {
  schemaVersion: 1
  /** False on the shipped placeholder. Only the fetch script may set it true. */
  authoritative: boolean
  /** OFAC's publish date, not ours. */
  publishedAtUnix: number
  publishedOnDate: string
  /** When we pulled it. Recorded for the audit trail, never for staleness. */
  fetchedAtUnix: number
  sourceUris: string[]
  /** sha256 over the canonical JSON of the entries array. */
  entriesHash: string
  entryCount: number
  entries: SdnEntry[]
  note?: string
}

const SDN_TYPES: readonly SdnEntryType[] = ['individual', 'entity', 'vessel', 'digital_currency']

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const NULL_TOKEN = '-0-'

/**
 * RFC4180-ish CSV: quoted fields, doubled quotes inside them, CRLF or LF.
 * Written out rather than pulled in because a sanctions list parser is not a
 * place to inherit a dependency's edge cases.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let started = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === undefined) break

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      started = true
      continue
    }
    if (char === ',') {
      row.push(field)
      field = ''
      started = true
      continue
    }
    if (char === '\r') continue
    if (char === '\n') {
      if (started || field.length > 0 || row.length > 0) {
        row.push(field)
        rows.push(row)
      }
      row = []
      field = ''
      started = false
      continue
    }
    field += char
    started = true
  }

  if (inQuotes) fail('malformed_csv', 'CSV ended inside a quoted field')
  if (started || field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function cell(row: readonly string[], index: number): string | undefined {
  const raw = row[index]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed === NULL_TOKEN) return undefined
  return trimmed
}

/**
 * SDN.CSV columns, in OFAC's published order:
 *   0 ent_num, 1 SDN_Name, 2 SDN_Type, 3 Program, 4 Title, 5 Call_Sign,
 *   6 Vess_type, 7 Tonnage, 8 GRT, 9 Vess_flag, 10 Vess_owner, 11 Remarks
 *
 * SDN_Type is "individual" or "vessel" or null; a null type is an entity. A
 * remark naming a digital currency address reclassifies the row, because those
 * are the entries this business is most likely to encounter.
 */
export function parseSdnCsv(text: string): SdnEntry[] {
  const entries: SdnEntry[] = []
  for (const row of parseCsv(text)) {
    const uid = cell(row, 0)
    if (uid === undefined || !/^\d+$/.test(uid)) continue // header, footer, or publish-date row
    const name = cell(row, 1)
    if (name === undefined) continue

    const rawType = cell(row, 2)?.toLowerCase()
    const remarks = cell(row, 11) ?? ''
    let type: SdnEntryType = 'entity'
    if (rawType === 'individual') type = 'individual'
    else if (rawType === 'vessel') type = 'vessel'
    if (/digital currency address/i.test(remarks)) type = 'digital_currency'

    const entry: SdnEntry = { uid, name, type }
    const program = cell(row, 3)
    if (program !== undefined) entry.program = program
    entries.push(entry)
  }
  return entries
}

/**
 * ALT.CSV columns: 0 ent_num, 1 alt_num, 2 alt_type, 3 alt_name, 4 alt_remarks.
 * Aliases are attached to the primary entry by entity number.
 */
export function attachAliases(entries: readonly SdnEntry[], altCsv: string): SdnEntry[] {
  const aliases = new Map<string, string[]>()
  for (const row of parseCsv(altCsv)) {
    const uid = cell(row, 0)
    const name = cell(row, 3)
    if (uid === undefined || !/^\d+$/.test(uid) || name === undefined) continue
    const list = aliases.get(uid) ?? []
    if (!list.includes(name)) list.push(name)
    aliases.set(uid, list)
  }
  return entries.map((entry) => {
    const list = aliases.get(entry.uid)
    if (list === undefined || list.length === 0) return entry
    return { ...entry, aliases: list }
  })
}

/**
 * OFAC stamps a publish date into the SDN file as a trailing row of the form
 * `"Publish Date","MM/DD/YYYY"`. Returns null when absent, so the caller falls
 * back to Last-Modified rather than to our own clock.
 */
export function publishDateFromCsv(text: string): number | null {
  for (const row of parseCsv(text)) {
    for (const [index, value] of row.entries()) {
      if (!/publish\s*date/i.test(value)) continue
      const candidate = row[index + 1] ?? value
      const match = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(candidate)
      if (match === null) continue
      const [, month, day, year] = match
      if (month === undefined || day === undefined || year === undefined) continue
      return Math.floor(
        Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0) / 1000,
      )
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Cache file
// ---------------------------------------------------------------------------

export function sdnEntriesHash(entries: readonly SdnEntry[]): string {
  return sha256Hex(canonicalJson(entries))
}

export function parseSdnCache(raw: unknown, where: string): SdnCacheFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('not_an_object', `${where} is not an object`)
  }
  const file = raw as Record<string, unknown>
  if (file.schemaVersion !== 1) {
    fail('unsupported_schema_version', `${where} declares an unsupported schemaVersion`)
  }
  if (typeof file.authoritative !== 'boolean') {
    fail('missing_authoritative', `${where}.authoritative must be a boolean`)
  }
  const publishedAtUnix = file.publishedAtUnix
  if (typeof publishedAtUnix !== 'number' || !Number.isSafeInteger(publishedAtUnix) || publishedAtUnix < 0) {
    fail('bad_published_at', `${where}.publishedAtUnix must be a non-negative integer`)
  }
  const fetchedAtUnix = file.fetchedAtUnix
  if (typeof fetchedAtUnix !== 'number' || !Number.isSafeInteger(fetchedAtUnix) || fetchedAtUnix < 0) {
    fail('bad_fetched_at', `${where}.fetchedAtUnix must be a non-negative integer`)
  }
  if (!Array.isArray(file.entries)) fail('missing_entries', `${where}.entries must be an array`)
  if (!Array.isArray(file.sourceUris)) fail('missing_sources', `${where}.sourceUris must be an array`)

  const entries: SdnEntry[] = []
  const seen = new Set<string>()
  for (const [index, item] of file.entries.entries()) {
    const entryWhere = `${where}.entries[${index}]`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      fail('bad_entry', `${entryWhere} is not an object`)
    }
    const source = item as Record<string, unknown>
    const uid = source.uid
    const name = source.name
    const type = source.type
    if (typeof uid !== 'string' || uid.length === 0) fail('bad_uid', `${entryWhere}.uid is missing`)
    if (typeof name !== 'string' || name.length === 0) fail('bad_name', `${entryWhere}.name is missing`)
    if (typeof type !== 'string' || !SDN_TYPES.includes(type as SdnEntryType)) {
      fail('bad_type', `${entryWhere}.type must be one of ${SDN_TYPES.join(', ')}`)
    }
    if (seen.has(uid)) fail('duplicate_uid', `${entryWhere} duplicates uid "${uid}"`)
    seen.add(uid)

    const entry: SdnEntry = { uid, name, type: type as SdnEntryType }
    if (Array.isArray(source.aliases)) {
      const aliases = source.aliases.map((alias, i) => {
        if (typeof alias !== 'string' || alias.length === 0) {
          fail('bad_alias', `${entryWhere}.aliases[${i}] is not a non-empty string`)
        }
        return alias
      })
      if (aliases.length > 0) entry.aliases = aliases
    }
    if (typeof source.program === 'string' && source.program.length > 0) {
      entry.program = source.program
    }
    entries.push(entry)
  }

  const entriesHash = file.entriesHash
  if (typeof entriesHash !== 'string' || !/^[0-9a-f]{64}$/.test(entriesHash)) {
    fail('bad_entries_hash', `${where}.entriesHash is not a sha256 digest`)
  }
  const recomputed = sdnEntriesHash(entries)
  if (recomputed !== entriesHash) {
    fail(
      'entries_hash_mismatch',
      `${where} is sealed ${entriesHash.slice(0, 12)} but its entries hash to ${recomputed.slice(0, 12)}. ` +
        `A sanctions list was edited by hand; re-run "npm run fetch:ofac -w @fee-split-vaults/catalog".`,
    )
  }
  if (file.entryCount !== entries.length) {
    fail('entry_count_mismatch', `${where}.entryCount does not match the number of entries`)
  }
  if (file.authoritative === true && entries.length === 0) {
    fail(
      'authoritative_but_empty',
      `${where} claims to be the official SDN list but carries no entries`,
    )
  }

  const out: SdnCacheFile = {
    schemaVersion: 1,
    authoritative: file.authoritative,
    publishedAtUnix,
    publishedOnDate:
      typeof file.publishedOnDate === 'string'
        ? file.publishedOnDate
        : new Date(publishedAtUnix * 1000).toISOString().slice(0, 10),
    fetchedAtUnix,
    sourceUris: file.sourceUris.map(String),
    entriesHash,
    entryCount: entries.length,
    entries,
  }
  if (typeof file.note === 'string') out.note = file.note
  return out
}

/** Wraps a loaded cache as the source packages/screening reads through. */
export class CachedSdnSource implements SdnSource {
  constructor(private readonly file: SdnCacheFile) {}

  entries(): readonly SdnEntry[] {
    return this.file.entries
  }

  publishedAtUnix(): number {
    return this.file.publishedAtUnix
  }

  authoritative(): boolean {
    return this.file.authoritative
  }
}

export function sdnCachePath(dataDir?: string): string {
  return join(dataPaths(dataDir).screeningDir, 'ofac', 'sdn-cache.json')
}

export function loadSdnCache(dataDir?: string): SdnCacheFile {
  const path = sdnCachePath(dataDir)
  if (!existsSync(path)) fail('missing_file', `${path} does not exist`)
  try {
    return parseSdnCache(JSON.parse(readFileSync(path, 'utf8')), path)
  } catch (error) {
    if (error instanceof CatalogError) throw error
    fail('malformed_json', `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function writeSdnCache(file: SdnCacheFile, dataDir?: string): string {
  const path = sdnCachePath(dataDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  return path
}

// ---------------------------------------------------------------------------
// Fetch and cache
// ---------------------------------------------------------------------------

/** OFAC's published flat-file endpoints. */
export const OFAC_SDN_CSV_URL = 'https://sanctionslistservice.ofac.treas.gov/api/download/sdn.csv'
export const OFAC_ALT_CSV_URL = 'https://sanctionslistservice.ofac.treas.gov/api/download/alt.csv'

export interface FetchSdnOptions {
  client: HttpClient
  sdnUrl?: string
  altUrl?: string
  /** Our clock. Recorded as fetchedAtUnix, never used for staleness. */
  nowUnix: number
  timeoutMs?: number
}

function lastModifiedUnix(headers: Record<string, string> | undefined): number | null {
  const raw = headers?.['last-modified']
  if (raw === undefined) return null
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) return null
  return Math.floor(parsed / 1000)
}

/**
 * Download, parse, seal. Returns the cache file; writing it is a separate step
 * so the script can report before it overwrites anything.
 *
 * Every failure is a throw. A partial sanctions list is worse than none,
 * because none is visibly unusable and a partial one looks fine.
 */
export async function fetchSdnCache(options: FetchSdnOptions): Promise<SdnCacheFile> {
  const sdnUrl = options.sdnUrl ?? OFAC_SDN_CSV_URL
  const altUrl = options.altUrl ?? OFAC_ALT_CSV_URL
  const timeoutMs = options.timeoutMs ?? 60_000

  const sdnResponse = await options.client({ url: sdnUrl, timeoutMs })
  if (!sdnResponse.ok) {
    fail('sdn_fetch_failed', `GET ${sdnUrl} returned ${sdnResponse.status}`)
  }
  const altResponse = await options.client({ url: altUrl, timeoutMs })
  if (!altResponse.ok) {
    fail('alt_fetch_failed', `GET ${altUrl} returned ${altResponse.status}`)
  }

  const primary = parseSdnCsv(sdnResponse.text)
  if (primary.length === 0) {
    fail(
      'empty_sdn_download',
      `${sdnUrl} parsed to zero entries; the download is truncated, reshaped, or not the SDN file`,
    )
  }
  const entries = attachAliases(primary, altResponse.text)

  const published =
    publishDateFromCsv(sdnResponse.text) ?? lastModifiedUnix(sdnResponse.headers)
  if (published === null) {
    fail(
      'no_publish_date',
      `neither ${sdnUrl} nor its Last-Modified header carries a publish date, so the staleness gate ` +
        `would have nothing to measure. Refusing to cache a list that cannot date itself.`,
    )
  }
  if (published > options.nowUnix + 86_400) {
    fail('publish_date_in_future', 'the SDN publish date is in the future; refusing the download')
  }

  return {
    schemaVersion: 1,
    authoritative: true,
    publishedAtUnix: published,
    publishedOnDate: new Date(published * 1000).toISOString().slice(0, 10),
    fetchedAtUnix: options.nowUnix,
    sourceUris: [sdnUrl, altUrl],
    entriesHash: sdnEntriesHash(entries),
    entryCount: entries.length,
    entries,
  }
}

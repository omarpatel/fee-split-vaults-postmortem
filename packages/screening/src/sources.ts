/**
 * The two stage-1 inputs an operator supplies from outside the repository.
 *
 * THE SLUR LIST IS NOT CHECKED IN. It arrives as a JSON file named by
 * SCREENING_LEXICON_FILE, in the parseLexiconJson shape; a file that cannot be
 * read, parses to nothing, or names an unknown category is a construction
 * refusal, never an empty list that quietly leaves `slur` unconfigured.
 *
 * THE SANCTIONS LIST IS OFAC'S OWN FILE. OfacSdnSource loads the official SDN
 * download - the legacy comma-delimited `sdn.csv` (no header, `-0-` for null)
 * or the `sdn.xml` publication - from a URL or a local path. It is
 * authoritative ONLY when a publish date could be established: the XML carries
 * one in <publshInformation>, the CSV carries none and is dated by the HTTP
 * Last-Modified header. A list with no date cannot be judged against the
 * staleness policy, so it screens but never clears. Nothing here refreshes
 * itself: the list is loaded once, and SdnScreener's maxListAgeSeconds turns
 * an old load into `sanctions_list_stale`, which is the operator's cue to
 * restart with a fresh download.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { Lexicon, parseLexiconJson, type LexiconEntry, type LexiconSource } from './lexicon.js'
import { LoadedSdnSource, SdnScreener, type SdnEntry, type SdnEntryType, type SdnSource } from './ofac.js'

// ---------------------------------------------------------------------------
// Lexicon file
// ---------------------------------------------------------------------------

export type LexiconFileErrorCode = 'unreadable' | 'empty' | 'invalid'

export class LexiconFileError extends Error {
  constructor(
    message: string,
    readonly code: LexiconFileErrorCode,
    readonly path: string,
  ) {
    super(`lexicon file ${path}: ${message}`)
    this.name = 'LexiconFileError'
  }
}

export class FileLexiconSource implements LexiconSource {
  readonly #entries: readonly LexiconEntry[]
  readonly #revision: string

  constructor(readonly path: string) {
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      throw new LexiconFileError(error instanceof Error ? error.message : String(error), 'unreadable', path)
    }
    if (raw.trim().length === 0) throw new LexiconFileError('file is empty', 'empty', path)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new LexiconFileError(`not JSON: ${error instanceof Error ? error.message : String(error)}`, 'invalid', path)
    }
    let entries: LexiconEntry[]
    try {
      entries = parseLexiconJson(parsed)
    } catch (error) {
      throw new LexiconFileError(error instanceof Error ? error.message : String(error), 'invalid', path)
    }
    if (entries.length === 0) throw new LexiconFileError('parses to zero entries', 'empty', path)
    this.#entries = entries
    this.#revision = `file:${basename(path)}@sha256:${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`
  }

  entries(): readonly LexiconEntry[] {
    return this.#entries
  }

  revision(): string {
    return this.#revision
  }
}

// ---------------------------------------------------------------------------
// OFAC SDN list
// ---------------------------------------------------------------------------

export const DEFAULT_OFAC_SDN_URL = 'https://www.treasury.gov/ofac/downloads/sdn.csv'

export type SdnLoadErrorCode = 'misconfigured' | 'unreachable' | 'empty' | 'unparseable'

export class SdnLoadError extends Error {
  constructor(
    message: string,
    readonly code: SdnLoadErrorCode,
    readonly source: string,
  ) {
    super(`sdn list ${source}: ${message}`)
    this.name = 'SdnLoadError'
  }
}

/** The legacy flat file's null marker, sometimes followed by a trailing space. */
const SDN_NULL = '-0-'
const SDN_CSV_COLUMNS = 12

/** RFC-4180-ish row split: quoted fields, doubled quotes, no embedded newlines in this file. */
function splitCsvRow(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      fields.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  fields.push(field)
  return fields
}

function csvValue(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim()
  return value.length === 0 || value === SDN_NULL ? undefined : value
}

function sdnTypeOf(raw: string | undefined, remarks: string | undefined): SdnEntryType {
  if (remarks !== undefined && /digital currency address/i.test(remarks)) return 'digital_currency'
  switch ((raw ?? '').toLowerCase()) {
    case 'individual':
      return 'individual'
    case 'vessel':
      return 'vessel'
    default:
      // Entities are typed `-0-` in the flat file; aircraft have no type of their own here.
      return 'entity'
  }
}

/**
 * sdn.csv: ent_num, SDN_Name, SDN_Type, Program, Title, Call_Sign, Vess_type,
 * Tonnage, GRT, Vess_flag, Vess_owner, Remarks. No header row. Aliases live
 * in the separate alt.csv and are not carried by this file. The download ends
 * in a DOS end-of-file byte (0x1A) on a line of its own, which is tolerated.
 */
export function parseSdnCsv(text: string): SdnEntry[] {
  const entries: SdnEntry[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.replace(/\u001a/g, '').trim().length === 0) continue
    const fields = splitCsvRow(line)
    if (fields.length !== SDN_CSV_COLUMNS) {
      throw new Error(`row ${index + 1} has ${fields.length} fields, expected ${SDN_CSV_COLUMNS}`)
    }
    const uid = csvValue(fields[0])
    const name = csvValue(fields[1])
    if (uid === undefined || !/^\d+$/.test(uid)) throw new Error(`row ${index + 1} has no numeric ent_num`)
    if (name === undefined) throw new Error(`row ${index + 1} (ent_num ${uid}) has no SDN_Name`)
    const entry: SdnEntry = { uid, name, type: sdnTypeOf(csvValue(fields[2]), csvValue(fields[11])) }
    const program = csvValue(fields[3])
    if (program !== undefined) entry.program = program
    entries.push(entry)
  }
  return entries
}

function decodeXmlText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .trim()
}

function xmlChild(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block)
  return match?.[1] === undefined ? undefined : decodeXmlText(match[1])
}

function xmlChildren(block: string, tag: string): string[] {
  const out: string[] = []
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  for (let match = pattern.exec(block); match !== null; match = pattern.exec(block)) {
    if (match[1] !== undefined) out.push(match[1])
  }
  return out
}

/** OFAC's Publish_Date is MM/DD/YYYY. Midnight UTC of that day. */
function parsePublishDate(raw: string): number {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim())
  if (match === null) throw new Error(`Publish_Date "${raw}" is not MM/DD/YYYY`)
  const stamp = Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2]))
  if (!Number.isFinite(stamp)) throw new Error(`Publish_Date "${raw}" is not a date`)
  return Math.floor(stamp / 1000)
}

/**
 * sdn.xml: <sdnList><publshInformation><Publish_Date/></publshInformation>
 * <sdnEntry><uid/><firstName/><lastName/><sdnType/><programList><program/>
 * </programList><akaList><aka><lastName/>...</aka></akaList>...</sdnEntry>.
 * Names are the entry's lastName (entities) or "firstName lastName"
 * (individuals); every aka becomes an alias.
 */
export function parseSdnXml(text: string): { entries: SdnEntry[]; publishedAtUnix?: number } {
  if (!/<sdnList[\s>]/.test(text)) throw new Error('no <sdnList> root')
  const entries: SdnEntry[] = []
  for (const block of xmlChildren(text, 'sdnEntry')) {
    const uid = xmlChild(block, 'uid')
    if (uid === undefined || !/^\d+$/.test(uid)) throw new Error('sdnEntry without a numeric uid')
    // The entry's own name fields precede akaList; slice so an aka's lastName cannot be read as the entry's.
    const own = block.split('<akaList')[0] ?? block
    const first = xmlChild(own, 'firstName')
    const last = xmlChild(own, 'lastName')
    const name = [first, last].filter((part): part is string => part !== undefined && part.length > 0).join(' ')
    if (name.length === 0) throw new Error(`sdnEntry ${uid} has no name`)
    const rawType = (xmlChild(own, 'sdnType') ?? '').toLowerCase()
    const remarks = xmlChild(own, 'remarks')
    const idTypes = xmlChildren(block, 'idType').map(decodeXmlText).join(' ')
    const entry: SdnEntry = {
      uid,
      name,
      type: sdnTypeOf(rawType, `${remarks ?? ''} ${idTypes}`),
    }
    const programs = xmlChildren(block, 'program').map(decodeXmlText).filter((p) => p.length > 0)
    if (programs.length > 0) entry.program = programs.join(';')
    const aliases = xmlChildren(block, 'aka')
      .map((aka) => {
        const akaFirst = xmlChild(aka, 'firstName')
        const akaLast = xmlChild(aka, 'lastName')
        return [akaFirst, akaLast].filter((part): part is string => part !== undefined && part.length > 0).join(' ')
      })
      .filter((alias) => alias.length > 0)
    if (aliases.length > 0) entry.aliases = aliases
    entries.push(entry)
  }
  const published = xmlChild(text, 'Publish_Date')
  return published === undefined ? { entries } : { entries, publishedAtUnix: parsePublishDate(published) }
}

export interface OfacSdnLoadOptions {
  /** The official download; DEFAULT_OFAC_SDN_URL when neither url nor file is given. */
  url?: string
  /** A local copy of the same file. Wins over url when both are given. */
  file?: string
  fetch?: typeof fetch
  /** Bytes the download may not exceed. The real file is ~10 MB; this is a bound, not a target. */
  maxBytes?: number
}

const DEFAULT_SDN_MAX_BYTES = 64 * 1024 * 1024

export class OfacSdnSource implements SdnSource {
  readonly #inner: SdnSource
  readonly #publishedAtUnix: number | undefined
  /** Where the list came from and how it was dated, for the boot banner. */
  readonly detail: string

  private constructor(entries: readonly SdnEntry[], publishedAtUnix: number | undefined, detail: string) {
    this.#publishedAtUnix = publishedAtUnix
    this.#inner = new LoadedSdnSource(entries, publishedAtUnix ?? 0)
    this.detail = detail
  }

  static async load(options: OfacSdnLoadOptions = {}): Promise<OfacSdnSource> {
    const maxBytes = options.maxBytes ?? DEFAULT_SDN_MAX_BYTES
    let text: string
    let source: string
    let lastModifiedUnix: number | undefined

    if (options.file !== undefined) {
      source = options.file
      try {
        text = readFileSync(options.file, 'utf8')
      } catch (error) {
        throw new SdnLoadError(error instanceof Error ? error.message : String(error), 'unreachable', source)
      }
    } else {
      source = options.url ?? DEFAULT_OFAC_SDN_URL
      let parsedUrl: URL
      try {
        parsedUrl = new URL(source)
      } catch {
        throw new SdnLoadError('not a URL', 'misconfigured', source)
      }
      if (parsedUrl.protocol !== 'https:') throw new SdnLoadError('must be https', 'misconfigured', source)
      const fetchImpl = options.fetch ?? fetch
      let response: Response
      try {
        response = await fetchImpl(source, { headers: { accept: 'text/csv, application/xml, text/xml, */*' } })
      } catch (error) {
        throw new SdnLoadError(error instanceof Error ? error.message : String(error), 'unreachable', source)
      }
      if (!response.ok) throw new SdnLoadError(`HTTP ${response.status}`, 'unreachable', source)
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (declared > maxBytes) throw new SdnLoadError(`content-length ${declared} exceeds ${maxBytes}`, 'unparseable', source)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > maxBytes) throw new SdnLoadError(`${bytes.byteLength} bytes exceeds ${maxBytes}`, 'unparseable', source)
      text = new TextDecoder('utf-8').decode(bytes)
      const lastModified = response.headers.get('last-modified')
      if (lastModified !== null) {
        const stamp = Date.parse(lastModified)
        if (Number.isFinite(stamp)) lastModifiedUnix = Math.floor(stamp / 1000)
      }
    }

    if (text.trim().length === 0) throw new SdnLoadError('file is empty', 'empty', source)

    let entries: SdnEntry[]
    let publishedAtUnix: number | undefined
    let dated: string
    try {
      if (/^\s*<\?xml|<sdnList[\s>]/.test(text)) {
        const parsed = parseSdnXml(text)
        entries = parsed.entries
        publishedAtUnix = parsed.publishedAtUnix ?? lastModifiedUnix
        dated =
          parsed.publishedAtUnix !== undefined
            ? 'dated by Publish_Date'
            : lastModifiedUnix !== undefined
              ? 'dated by Last-Modified'
              : 'UNDATED'
      } else {
        entries = parseSdnCsv(text)
        publishedAtUnix = lastModifiedUnix
        dated = lastModifiedUnix !== undefined ? 'dated by Last-Modified' : 'UNDATED (sdn.csv carries no publish date)'
      }
    } catch (error) {
      throw new SdnLoadError(error instanceof Error ? error.message : String(error), 'unparseable', source)
    }
    if (entries.length === 0) throw new SdnLoadError('parses to zero entries', 'empty', source)

    const when = publishedAtUnix === undefined ? '' : ` ${new Date(publishedAtUnix * 1000).toISOString().slice(0, 10)}`
    return new OfacSdnSource(entries, publishedAtUnix, `${entries.length} SDN entries from ${source}, ${dated}${when}`)
  }

  entries(): readonly SdnEntry[] {
    return this.#inner.entries()
  }

  /** Zero when the list could not be dated; `authoritative()` is false in that case. */
  publishedAtUnix(): number {
    return this.#publishedAtUnix ?? 0
  }

  authoritative(): boolean {
    return this.#publishedAtUnix !== undefined
  }
}

// ---------------------------------------------------------------------------
// Composition helper shared by the API and the ops rescreen job
// ---------------------------------------------------------------------------

export interface ScreeningSourceOptions {
  lexiconFile?: string
  sdnFile?: string
  sdnUrl?: string
  fetch?: typeof fetch
  /** The builtin publishable half of the lexicon is always included; this adds to it. */
  builtinLexicon: LexiconSource
  /** The non-authoritative sample list, used only when no SDN file or URL is configured. */
  sampleSdn: SdnSource
}

export interface ScreeningSources {
  lexicon: Lexicon
  sdn: SdnScreener
  /** True when the operator's slur list was loaded. */
  lexiconReal: boolean
  lexiconDetail: string
  /** True when the loaded SDN list is authoritative (official file, dated). */
  sdnReal: boolean
  sdnDetail: string
}

/**
 * Builds the two stage-1 inputs from what the environment named. A named
 * file or URL that cannot be loaded THROWS (LexiconFileError / SdnLoadError):
 * a configured source is never quietly replaced by the sample.
 */
export async function loadScreeningSources(options: ScreeningSourceOptions): Promise<ScreeningSources> {
  const lexiconSources: LexiconSource[] = [options.builtinLexicon]
  let lexiconReal = false
  let lexiconDetail = 'builtin list only; no SCREENING_LEXICON_FILE, so no slur list and no CLEAR verdict can issue'
  if (options.lexiconFile !== undefined) {
    const file = new FileLexiconSource(options.lexiconFile)
    lexiconSources.push(file)
    lexiconReal = file.entries().some((entry) => entry.category === 'slur')
    lexiconDetail = lexiconReal
      ? `${file.entries().length} operator terms from ${file.revision()} plus the builtin list`
      : `${file.entries().length} operator terms from ${file.revision()} but NO slur entries; no CLEAR verdict can issue`
  }

  let sdn: SdnSource = options.sampleSdn
  let sdnReal = false
  let sdnDetail = 'SampleSdnSource is not authoritative; no CLEAR verdict can issue'
  if (options.sdnFile !== undefined || options.sdnUrl !== undefined) {
    const loaded = await OfacSdnSource.load({
      ...(options.sdnFile === undefined ? {} : { file: options.sdnFile }),
      ...(options.sdnUrl === undefined ? {} : { url: options.sdnUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
    sdn = loaded
    sdnReal = loaded.authoritative()
    sdnDetail = sdnReal ? loaded.detail : `${loaded.detail}; not authoritative, no CLEAR verdict can issue`
  }

  return {
    lexicon: new Lexicon(lexiconSources),
    sdn: new SdnScreener(sdn),
    lexiconReal,
    lexiconDetail,
    sdnReal,
    sdnDetail,
  }
}

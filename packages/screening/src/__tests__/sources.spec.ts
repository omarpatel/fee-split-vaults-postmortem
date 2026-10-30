import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Lexicon, DEFAULT_LEXICON_SOURCE } from '../lexicon.js'
import { SdnScreener, SampleSdnSource } from '../ofac.js'
import {
  FileLexiconSource,
  LexiconFileError,
  OfacSdnSource,
  SdnLoadError,
  loadScreeningSources,
  parseSdnCsv,
  parseSdnXml,
} from '../sources.js'
import { NOW } from './fixtures.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'screening-sources-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function file(name: string, content: string): string {
  const path = join(dir, name)
  writeFileSync(path, content, 'utf8')
  return path
}

/** Three rows in the legacy layout: an entity (`-0-` type), an individual, a digital-currency entity with a quoted comma. */
const SDN_CSV = [
  '36,"AEROCARIBBEAN AIRLINES","-0- ","CUBA","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- "',
  '10001,"DOE, John","individual","SDGT","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","DOB 01 Jan 1970"',
  '20002,"TORNADO CASH","-0- ","CYBER2","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","Digital Currency Address - ETH 0x8589427373D6D84E98730D7795D8f6f8731FDA16; alt. Digital Currency Address - ETH 0x722122dF12D4e14e13Ac3b6895a86e84145b6967"',
  '',
].join('\r\n')

const SDN_XML = `<?xml version="1.0" encoding="utf-8"?>
<sdnList xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
  <publshInformation><Publish_Date>09/12/2026</Publish_Date><Record_Count>2</Record_Count></publshInformation>
  <sdnEntry>
    <uid>36</uid><lastName>AEROCARIBBEAN AIRLINES</lastName><sdnType>Entity</sdnType>
    <programList><program>CUBA</program></programList>
    <akaList><aka><uid>12</uid><type>a.k.a.</type><category>strong</category><lastName>AERO-CARIBBEAN</lastName></aka></akaList>
  </sdnEntry>
  <sdnEntry>
    <uid>10001</uid><firstName>John</firstName><lastName>DOE &amp; SONS</lastName><sdnType>Individual</sdnType>
    <programList><program>SDGT</program><program>CYBER2</program></programList>
  </sdnEntry>
</sdnList>`

describe('parseSdnCsv', () => {
  it('reads the 12-column legacy layout with -0- nulls and quoted commas', () => {
    const entries = parseSdnCsv(SDN_CSV)
    expect(entries).toEqual([
      { uid: '36', name: 'AEROCARIBBEAN AIRLINES', type: 'entity', program: 'CUBA' },
      { uid: '10001', name: 'DOE, John', type: 'individual', program: 'SDGT' },
      { uid: '20002', name: 'TORNADO CASH', type: 'digital_currency', program: 'CYBER2' },
    ])
  })

  it('refuses a row with the wrong column count rather than shifting fields', () => {
    expect(() => parseSdnCsv('36,"AEROCARIBBEAN AIRLINES","-0- ","CUBA"')).toThrow(/4 fields, expected 12/)
  })
})

describe('parseSdnXml', () => {
  it('reads names, akas, programs and the publish date', () => {
    const parsed = parseSdnXml(SDN_XML)
    expect(parsed.publishedAtUnix).toBe(Math.floor(Date.UTC(2026, 8, 12) / 1000))
    expect(parsed.entries).toEqual([
      { uid: '36', name: 'AEROCARIBBEAN AIRLINES', type: 'entity', program: 'CUBA', aliases: ['AERO-CARIBBEAN'] },
      { uid: '10001', name: 'John DOE & SONS', type: 'individual', program: 'SDGT;CYBER2' },
    ])
  })

  it('does not take an aka name for the entry name', () => {
    expect(() =>
      parseSdnXml(
        `<sdnList><sdnEntry><uid>1</uid><akaList><aka><lastName>ALIAS ONLY</lastName></aka></akaList></sdnEntry></sdnList>`,
      ),
    ).toThrow(/has no name/)
  })
})

describe('OfacSdnSource', () => {
  it('is authoritative only when the list carries a publish date', async () => {
    const xml = await OfacSdnSource.load({ file: file('sdn.xml', SDN_XML) })
    expect(xml.authoritative()).toBe(true)
    expect(new SdnScreener(xml).listStatus(xml.publishedAtUnix() + 3_600)).toBe('ok')
    expect(new SdnScreener(xml).match('aerocaribbean airlines flight')[0]?.uid).toBe('36')

    const csv = await OfacSdnSource.load({ file: file('sdn.csv', SDN_CSV) })
    expect(csv.authoritative()).toBe(false)
    expect(csv.entries()).toHaveLength(3)
    expect(new SdnScreener(csv).listStatus(NOW)).toBe('not_authoritative')
    expect(csv.detail).toContain('UNDATED')
  })

  it('dates a CSV download by the Last-Modified header', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(SDN_CSV, {
        status: 200,
        headers: { 'last-modified': 'Fri, 12 Sep 2026 14:00:00 GMT', 'content-type': 'text/csv' },
      })
    const source = await OfacSdnSource.load({ url: 'https://example.test/sdn.csv', fetch: fetchImpl })
    expect(source.authoritative()).toBe(true)
    expect(source.publishedAtUnix()).toBe(Math.floor(Date.parse('Fri, 12 Sep 2026 14:00:00 GMT') / 1000))
    expect(source.detail).toContain('dated by Last-Modified')
  })

  it('refuses an unreachable, empty or non-https source by code', async () => {
    await expect(OfacSdnSource.load({ file: join(dir, 'missing.csv') })).rejects.toMatchObject({
      name: 'SdnLoadError',
      code: 'unreachable',
    })
    await expect(OfacSdnSource.load({ file: file('empty.csv', '\n') })).rejects.toMatchObject({ code: 'empty' })
    await expect(OfacSdnSource.load({ url: 'http://example.test/sdn.csv' })).rejects.toMatchObject({ code: 'misconfigured' })
    const fetchImpl: typeof fetch = async () => new Response('nope', { status: 503 })
    await expect(OfacSdnSource.load({ url: 'https://example.test/sdn.csv', fetch: fetchImpl })).rejects.toBeInstanceOf(SdnLoadError)
  })
})

describe('FileLexiconSource', () => {
  it('loads an operator list and reports a content-addressed revision', () => {
    const source = new FileLexiconSource(
      file('lexicon.json', JSON.stringify([{ term: 'zorblax', category: 'slur' }, { term: 'official', category: 'official_claim', requireBoundary: true }])),
    )
    expect(source.entries()).toHaveLength(2)
    expect(source.revision()).toMatch(/^file:lexicon\.json@sha256:[0-9a-f]{12}$/)
    expect(new Lexicon([DEFAULT_LEXICON_SOURCE, source]).has('slur')).toBe(true)
  })

  it('refuses a missing, empty or malformed file by code', () => {
    expect(() => new FileLexiconSource(join(dir, 'missing.json'))).toThrow(LexiconFileError)
    expect(() => new FileLexiconSource(join(dir, 'missing.json'))).toThrow(/unreadable|ENOENT/)
    expect(() => new FileLexiconSource(file('empty.json', ''))).toThrowError(expect.objectContaining({ code: 'empty' }))
    expect(() => new FileLexiconSource(file('none.json', '[]'))).toThrowError(expect.objectContaining({ code: 'empty' }))
    expect(() => new FileLexiconSource(file('bad.json', '{"term":"x"}'))).toThrowError(expect.objectContaining({ code: 'invalid' }))
    expect(() =>
      new FileLexiconSource(file('cat.json', JSON.stringify([{ term: 'x', category: 'made_up' }]))),
    ).toThrowError(expect.objectContaining({ code: 'invalid' }))
  })
})

describe('loadScreeningSources', () => {
  const base = { builtinLexicon: DEFAULT_LEXICON_SOURCE, sampleSdn: new SampleSdnSource(NOW) }

  it('reports both inputs as fake when nothing is configured', async () => {
    const sources = await loadScreeningSources(base)
    expect(sources.lexiconReal).toBe(false)
    expect(sources.sdnReal).toBe(false)
    expect(sources.sdn.listStatus(NOW)).toBe('not_authoritative')
  })

  it('reports real inputs once a slur list and a dated SDN file are loaded', async () => {
    const sources = await loadScreeningSources({
      ...base,
      lexiconFile: file('lexicon.json', JSON.stringify([{ term: 'zorblax', category: 'slur' }])),
      sdnFile: file('sdn.xml', SDN_XML),
    })
    expect(sources.lexiconReal).toBe(true)
    expect(sources.sdnReal).toBe(true)
    expect(sources.lexicon.has('slur')).toBe(true)
  })

  it('a lexicon file with no slur entries is loaded but not counted as real', async () => {
    const sources = await loadScreeningSources({
      ...base,
      lexiconFile: file('lexicon.json', JSON.stringify([{ term: 'x', category: 'trademark' }])),
    })
    expect(sources.lexiconReal).toBe(false)
    expect(sources.lexiconDetail).toContain('NO slur entries')
  })

  it('propagates a configured source that cannot be loaded instead of falling back', async () => {
    await expect(loadScreeningSources({ ...base, sdnFile: join(dir, 'missing.csv') })).rejects.toBeInstanceOf(SdnLoadError)
    await expect(loadScreeningSources({ ...base, lexiconFile: join(dir, 'missing.json') })).rejects.toBeInstanceOf(
      LexiconFileError,
    )
  })
})

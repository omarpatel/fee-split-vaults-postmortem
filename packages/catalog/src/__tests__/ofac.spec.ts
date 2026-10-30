/**
 * The OFAC SDN loader, its CSV parser, and the fail-closed cache.
 *
 * Every test here runs offline against the fake HTTP client. The one network
 * call in the package lives in a script and is never exercised by the suite.
 */
import { describe, expect, it } from 'vitest'
import { FakeHttpClient } from '../http.js'
import {
  attachAliases,
  CachedSdnSource,
  fetchSdnCache,
  loadSdnCache,
  OFAC_ALT_CSV_URL,
  OFAC_SDN_CSV_URL,
  parseCsv,
  parseSdnCache,
  parseSdnCsv,
  publishDateFromCsv,
  sdnEntriesHash,
} from '../ofac.js'

const SDN_CSV = [
  '36,"AEROCARIBBEAN AIRLINES","-0-","CUBA","-0-","-0-","-0-","-0-","-0-","-0-","-0-","-0- "',
  '12345,"LAZARUS GROUP","-0-","DPRK","-0-","-0-","-0-","-0-","-0-","-0-","-0-","Cyber-related designation."',
  '2676,"AL ZAWAHIRI, Ayman","individual","SDGT","Doctor","-0-","-0-","-0-","-0-","-0-","-0-","-0- "',
  '30000,"SOME MIXER","-0-","CYBER2","-0-","-0-","-0-","-0-","-0-","-0-","-0-","Digital Currency Address - XBT 1abcdef; alt. Digital Currency Address - ETH 0x1234."',
  '9999,"KEUM UN SAN 3","vessel","DPRK4","-0-","-0-","Cargo","2,913","-0-","Korea, North","-0-","-0- "',
  '"Publish Date","09/04/2026"',
].join('\n')

const ALT_CSV = [
  '12345,1,"aka","HIDDEN COBRA","-0- "',
  '12345,2,"aka","APT38","-0- "',
  '30000,1,"aka","SOME, MIXER LLC","-0- "',
].join('\n')

describe('the CSV parser', () => {
  it('handles quoted fields, embedded commas and doubled quotes', () => {
    const rows = parseCsv('a,"b,c","d""e"\r\n1,2,3\n')
    expect(rows).toEqual([
      ['a', 'b,c', 'd"e'],
      ['1', '2', '3'],
    ])
  })

  it('refuses a file that ends inside a quoted field', () => {
    expect(() => parseCsv('a,"unterminated')).toThrow(/malformed_csv/)
  })
})

describe('parsing the SDN download', () => {
  it('reads names, programs and types, and skips the publish-date row', () => {
    const entries = parseSdnCsv(SDN_CSV)
    expect(entries).toHaveLength(5)
    expect(entries.map((entry) => entry.uid)).toEqual(['36', '12345', '2676', '30000', '9999'])
    expect(entries[2]).toMatchObject({ name: 'AL ZAWAHIRI, Ayman', type: 'individual', program: 'SDGT' })
    expect(entries[4]?.type).toBe('vessel')
  })

  it('treats a null SDN_Type as an entity', () => {
    expect(parseSdnCsv(SDN_CSV)[1]).toMatchObject({ name: 'LAZARUS GROUP', type: 'entity' })
  })

  it('reclassifies an entry whose remarks name a digital currency address', () => {
    // These are the SDN entries this business is most likely to meet.
    expect(parseSdnCsv(SDN_CSV)[3]?.type).toBe('digital_currency')
  })

  it('attaches aliases from ALT.CSV by entity number', () => {
    const entries = attachAliases(parseSdnCsv(SDN_CSV), ALT_CSV)
    expect(entries[1]?.aliases).toEqual(['HIDDEN COBRA', 'APT38'])
    expect(entries[0]?.aliases).toBeUndefined()
  })

  it('reads OFAC\'s own publish date rather than using our clock', () => {
    expect(publishDateFromCsv(SDN_CSV)).toBe(Date.UTC(2026, 8, 4) / 1000)
    expect(publishDateFromCsv('1,"NAME","-0-"')).toBeNull()
  })
})

describe('fetch and cache', () => {
  const nowUnix = 1_788_652_800

  function client(sdn = SDN_CSV, alt = ALT_CSV): FakeHttpClient {
    return new FakeHttpClient().on(OFAC_SDN_CSV_URL, sdn).on(OFAC_ALT_CSV_URL, alt)
  }

  it('produces a sealed, authoritative cache dated by OFAC', async () => {
    const cache = await fetchSdnCache({ client: client().client, nowUnix })
    expect(cache.authoritative).toBe(true)
    expect(cache.entryCount).toBe(5)
    expect(cache.publishedOnDate).toBe('2026-09-04')
    expect(cache.fetchedAtUnix).toBe(nowUnix)
    expect(cache.entriesHash).toBe(sdnEntriesHash(cache.entries))
    // Round-trips through the validator.
    expect(() => parseSdnCache(JSON.parse(JSON.stringify(cache)), 'roundtrip')).not.toThrow()
  })

  it('falls back to Last-Modified when the file carries no publish date', async () => {
    const withoutDate = SDN_CSV.split('\n').slice(0, -1).join('\n')
    const fake = new FakeHttpClient()
      .on(OFAC_SDN_CSV_URL, withoutDate, 200, { 'last-modified': 'Fri, 04 Sep 2026 12:00:00 GMT' })
      .on(OFAC_ALT_CSV_URL, ALT_CSV)
    const cache = await fetchSdnCache({ client: fake.client, nowUnix })
    expect(cache.publishedOnDate).toBe('2026-09-04')
  })

  it('refuses a download that cannot date itself', async () => {
    const withoutDate = SDN_CSV.split('\n').slice(0, -1).join('\n')
    await expect(
      fetchSdnCache({ client: client(withoutDate).client, nowUnix }),
    ).rejects.toThrow(/no_publish_date/)
  })

  it('refuses an empty or reshaped download rather than caching a partial list', async () => {
    await expect(fetchSdnCache({ client: client('').client, nowUnix })).rejects.toThrow(
      /empty_sdn_download/,
    )
  })

  it('refuses a failed fetch instead of silently keeping the old list', async () => {
    const fake = new FakeHttpClient().onStatus(OFAC_SDN_CSV_URL, 503)
    await expect(fetchSdnCache({ client: fake.client, nowUnix })).rejects.toThrow(
      /sdn_fetch_failed/,
    )
  })

  it('refuses a publish date in the future', async () => {
    const future = SDN_CSV.replace('09/04/2026', '01/01/2030')
    await expect(fetchSdnCache({ client: client(future).client, nowUnix })).rejects.toThrow(
      /publish_date_in_future/,
    )
  })
})

describe('the cache is sealed', () => {
  it('refuses a name deleted from the list with a text editor', async () => {
    const cache = await fetchSdnCache({
      client: new FakeHttpClient().on(OFAC_SDN_CSV_URL, SDN_CSV).on(OFAC_ALT_CSV_URL, ALT_CSV)
        .client,
      nowUnix: 1_788_652_800,
    })
    const tampered = { ...cache, entries: cache.entries.slice(1), entryCount: cache.entryCount - 1 }
    expect(() => parseSdnCache(tampered, 'tampered')).toThrow(/entries_hash_mismatch/)
  })

  it('refuses a cache that claims authority while holding nothing', () => {
    expect(() =>
      parseSdnCache(
        {
          schemaVersion: 1,
          authoritative: true,
          publishedAtUnix: 1,
          fetchedAtUnix: 1,
          sourceUris: [],
          entriesHash: sdnEntriesHash([]),
          entryCount: 0,
          entries: [],
        },
        'test',
      ),
    ).toThrow(/authoritative_but_empty/)
  })
})

describe('the shipped placeholder', () => {
  const cache = loadSdnCache()

  it('is explicitly NOT authoritative, so no CLEAR can be issued against it', () => {
    expect(cache.authoritative).toBe(false)
    expect(cache.entryCount).toBe(0)
    expect(new CachedSdnSource(cache).authoritative()).toBe(false)
  })

  it('names the real download so the fetch script has somewhere to go', () => {
    expect(cache.sourceUris).toContain(OFAC_SDN_CSV_URL)
    expect(cache.sourceUris).toContain(OFAC_ALT_CSV_URL)
  })

  it('dates itself at the epoch, so any staleness gate fails it', () => {
    expect(cache.publishedAtUnix).toBe(0)
    expect(new CachedSdnSource(cache).publishedAtUnix()).toBe(0)
  })
})

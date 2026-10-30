/**
 * The offline re-pricing path: streaming a large escrow document, and the
 * arithmetic that turns its per-asset minor units into a gated USD series.
 *
 * WHY THESE TESTS EXIST. The 7-day merged artifact is 229 MB, too large to
 * `JSON.parse` safely on the machine that produced it, so the re-pricing reads
 * it with a hand-written streaming scanner. A scanner that drops recipients
 * does not crash - it reports a SMALLER MARKET, silently, exactly the way the
 * checkpoint bug once reported a table of zeros from a perfectly good
 * checkpoint. So the scanner is pinned against a full parse, at chunk sizes
 * small enough that every object straddles a boundary, and on content designed
 * to break a naive scanner: braces inside strings, escaped quotes, and the
 * multi-byte symbols this chain actually carries.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// The re-pricing CLIs live beside the artifacts they read, in tools/artifacts.
// The two pieces with real failure modes - the streaming reader and the money
// arithmetic - live here in tools/lib instead, so tsc checks them and this file
// can import them. tools/artifacts is gitignored; a committed test may not
// depend on a tree that is deliberately not committed.
import { readHeader, streamRecipients } from '../lib/doc-stream.ts'
import { longestRun, median, scaleTable, valueDay } from '../lib/doc-reprice.ts'

const NATIVE = '0x0000000000000000000000000000000000000000'
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const CBBTC = '0x27b6823adc585f739d5fedd7d6587462ca132eaa'

const scratch = mkdtempSync(join(tmpdir(), 'venue-reprice-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A document shaped exactly like escrow-index's output, with nasty content. */
function writeDocument(name: string, recipients: unknown[]): string {
  const document = {
    meta: { tool: 'escrow-index', warnings: ['unrelated {brace} text'] },
    result: {
      schema: 'escrow-daily-credits-2',
      escrow: '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e',
      chainId: 4663,
      totalCredits: recipients.reduce(
        (sum: number, r) =>
          sum + (r as { days: Array<{ creditCount: number }> }).days.reduce((a, d) => a + d.creditCount, 0),
        0,
      ),
      assetDecimals: { [NATIVE]: 18, [USDG]: 6, [CBBTC]: 8 },
      // Symbols that would break a scanner that does not understand JSON strings
      // or multi-byte characters. Every one of these shapes is real: the live
      // asset set contains ten emoji symbols.
      assetSymbols: { [NATIVE]: 'ETH', [USDG]: 'USDG', [CBBTC]: '🅿️{"}\\weird' },
      assetTotals: [{ asset: NATIVE, kind: 'native', symbol: 'ETH', decimals: 18, credits: 1 }],
      pricing: { recipientsTotal: recipients.length },
      recipients,
    },
  }
  const path = join(scratch, name)
  writeFileSync(path, JSON.stringify(document, null, 2))
  return path
}

function recipient(address: string, days: Array<Record<string, string>>): unknown {
  return {
    recipient: address,
    firstCreditUnix: 1788134400,
    lastCreditUnix: 1788652800,
    activeDays: days.length,
    totalByAssetMinor: {},
    totalUsd: null,
    days: days.map((byAssetMinor, i) => ({
      dayUnix: 1788134400 + i * 86400,
      dateUtc: new Date((1788134400 + i * 86400) * 1000).toISOString().slice(0, 10),
      byAssetMinor,
      usd: null,
      creditCount: Object.keys(byAssetMinor).length,
    })),
  }
}

describe('streaming a merged escrow document', () => {
  const recipients = Array.from({ length: 40 }, (_, i) =>
    recipient(`0x${String(i).padStart(40, '0')}`, [
      { [NATIVE]: String(BigInt(i + 1) * 10n ** 17n) },
      { [USDG]: String((i + 1) * 1_000_000), [CBBTC]: String(i * 1000) },
    ]),
  )
  const path = writeDocument('doc.json', recipients)

  it('reads the header without loading the recipients array', () => {
    const { result, recipientsOffset } = readHeader(path)
    expect(result.schema).toBe('escrow-daily-credits-2')
    expect(result.assetDecimals?.[USDG]).toBe(6)
    expect(result.pricing?.recipientsTotal).toBe(40)
    expect(recipientsOffset).toBeGreaterThan(0)
  })

  it('refuses a file with no recipients key rather than reporting none', () => {
    const bogus = join(scratch, 'bogus.json')
    writeFileSync(bogus, JSON.stringify({ hello: 'world' }))
    expect(() => readHeader(bogus)).toThrow(/no "recipients" key/)
  })

  // The straddle path is the one that loses data when it is wrong, and it only
  // runs when an object spans a chunk boundary. A 64-byte chunk guarantees that
  // for every single object.
  it.each([64, 97, 256, 1024, 8192, 1 << 20])('yields every recipient exactly at chunk %i', (chunk) => {
    const { recipientsOffset } = readHeader(path)
    const streamed = [...streamRecipients(path, recipientsOffset, chunk)]
    expect(streamed).toHaveLength(recipients.length)
    expect(streamed).toEqual(recipients)
  })

  it('is not confused by braces, escaped quotes or emoji in the document', () => {
    // The symbols block sits in the header and the warnings block sits before
    // it; both contain braces inside strings. If the scanner counted those, the
    // recipient count would come out wrong rather than throwing.
    const { recipientsOffset } = readHeader(path)
    expect([...streamRecipients(path, recipientsOffset, 64)]).toHaveLength(40)
  })

  it('yields nothing extra when the array is empty', () => {
    const empty = writeDocument('empty.json', [])
    const { recipientsOffset } = readHeader(empty)
    expect([...streamRecipients(empty, recipientsOffset, 64)]).toHaveLength(0)
  })
})

describe('valueDay', () => {
  const scaleOf = scaleTable({ [NATIVE]: 18, [USDG]: 6, [CBBTC]: 8 })
  const book = new Map([
    [NATIVE, 3200],
    [USDG, 1],
    [CBBTC, 80425.926624],
  ])

  it('applies each asset its OWN decimals', () => {
    // One USDG is 1_000_000 minor units, not 1e18. Reading it at 18 decimals
    // renders $1.00 as 1e-12 - the exact factor-of-10^12 error that made
    // $9,033,382.77 look like 9.033e-6.
    const { usd } = valueDay({ [USDG]: '1000000' }, book, scaleOf)
    expect(usd).toBeCloseTo(1, 12)
    const wrong = valueDay({ [USDG]: '1000000' }, book, scaleTable({ [USDG]: 18 }))
    expect(wrong.usd).toBeCloseTo(1e-12, 18)
  })

  it('sums across assets at their several scales', () => {
    const { usd, unpricedAssets } = valueDay(
      { [NATIVE]: '500000000000000000', [USDG]: '2500000', [CBBTC]: '100000000' },
      book,
      scaleOf,
    )
    // 0.5 ETH * 3200 + 2.5 USDG * 1 + 1 cbBTC * 80425.926624
    expect(usd).toBeCloseTo(1600 + 2.5 + 80425.926624, 6)
    expect(unpricedAssets).toBe(0)
  })

  it('counts an unpriced asset instead of adding zero for it', () => {
    const { usd, unpricedAssets } = valueDay(
      { [NATIVE]: '1000000000000000000', '0xdeadbeef00000000000000000000000000000000': '999' },
      book,
      scaleOf,
    )
    expect(usd).toBe(3200)
    // The caller MUST be able to tell "worth $3200" from "worth at least $3200".
    expect(unpricedAssets).toBe(1)
  })

  it('refuses to price an asset whose decimals are unknown rather than assuming 18', () => {
    const bookWithStray = new Map(book)
    bookWithStray.set('0xstray', 5)
    const { usd, unpricedAssets, missingScale } = valueDay({ '0xstray': '1000' }, bookWithStray, scaleOf)
    expect(usd).toBe(0)
    expect(unpricedAssets).toBe(1)
    expect(missingScale).toEqual(['0xstray'])
  })

  it('does not lose low digits of a large balance to a float', () => {
    // 2^53 is 9007199254740992. A balance above that in minor units must not be
    // widened before scaling.
    const minor = 123456789012345678901n
    const { usd } = valueDay({ [NATIVE]: String(minor) }, new Map([[NATIVE, 1]]), scaleOf)
    expect(usd).toBeCloseTo(123.456789012345678901, 9)
  })

  it('is zero for an empty day, which is a real zero and not an unknown', () => {
    expect(valueDay({}, book, scaleOf)).toEqual({ usd: 0, unpricedAssets: 0, missingScale: [] })
  })
})

describe('median and longestRun, the gate primitives', () => {
  it('takes the middle of an odd series and the mean of the middle pair of an even one', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBe(0)
  })

  it('breaks a run on a day below the gate rather than skipping it', () => {
    // A dormant day is a day BELOW the gate. If it were skipped, every gap
    // would vanish and every recipient would look continuously active.
    expect(longestRun([2000, 2000, 0, 2000, 2000, 2000], 1000)).toBe(3)
    expect(longestRun([2000, 2000, 2000], 1000)).toBe(3)
    expect(longestRun([500, 500], 1000)).toBe(0)
  })

  it('treats a value exactly at the gate as above it', () => {
    expect(longestRun([1000, 1000], 1000)).toBe(2)
    expect(median([1000, 1000, 1000])).toBe(1000)
  })
})

describe('the trailing-7-day-median gate, as the protocol defines it', () => {
  // The definition that grants a tier, reproduced end to end over a document.
  const gate = 1000
  const above = (daily: number[]): boolean => median(daily.slice(-7)) >= gate

  it('a recipient with one huge day does not clear a median gate', () => {
    expect(above([100000, 0, 0, 0, 0, 0, 0])).toBe(false)
  })

  it('a recipient steadily above the gate clears it', () => {
    expect(above([1200, 1100, 1500, 1300, 1050, 1400, 1600])).toBe(true)
  })

  it('four of seven days above the gate is enough; three is not', () => {
    expect(above([2000, 2000, 2000, 2000, 0, 0, 0])).toBe(true)
    expect(above([2000, 2000, 2000, 0, 0, 0, 0])).toBe(false)
  })

  it('pricing more assets can only raise the value, so it can only raise the count', () => {
    // The bounding argument the whole re-pricing rests on: a pointwise-larger
    // series has a pointwise-larger trailing median.
    const priced = [900, 900, 900, 900, 900, 900, 900]
    const withMore = priced.map((v, i) => v + [0, 50, 200, 300, 0, 120, 400][i]!)
    expect(above(priced)).toBe(false)
    expect(above(withMore)).toBe(true)
    expect(median(withMore.slice(-7))).toBeGreaterThanOrEqual(median(priced.slice(-7)))
  })
})

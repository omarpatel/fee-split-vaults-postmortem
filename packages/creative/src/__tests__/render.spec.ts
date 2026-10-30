import { describe, expect, it } from 'vitest'
import { IMAGE_DIMENSIONS, IMAGE_KINDS, NARRATIVE_LIMITS, type NarrativeProfile } from '@fee-split-vaults/core'
import { CreativeError } from '../errors.js'
import { renderCoinAssets } from '../render.js'
import { InMemoryImageAssetStore } from '../store.js'
import { TEMPLATES, TEXT_CAPS, wrapText } from '../templates.js'

const NARRATIVE: NarrativeProfile = {
  version: 1,
  tagline: 'A coin for people who like their memes with a side of math',
  themes: ['roadmap_question'],
  tone: 'playful',
  palette: { primary: '#0b3d91', secondary: '#ffcc00' },
  approvedAtUnix: 1_700_000_000,
  approvedBy: 'operator-1',
  sourceHashes: [],
}

const INPUT = { coinRef: 'venue-4663-pepe', symbol: 'PEPE', name: 'Pepe on Venue', narrative: NARRATIVE }

/** Glyph counts of every <text> body in an SVG, XML entities decoded to one glyph each. */
function textLengths(svg: string): number[] {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(
    (m) => Array.from(m[1]!.replace(/&[a-z]+;/g, 'x')).length,
  )
}

describe('renderCoinAssets', () => {
  it('is deterministic: same input, same sha256 and id', async () => {
    const [a, b] = await Promise.all([renderCoinAssets(INPUT), renderCoinAssets(INPUT)])
    expect(a.map((x) => x.sha256)).toEqual(b.map((x) => x.sha256))
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id))
    expect(a.map((x) => x.kind)).toEqual([...IMAGE_KINDS])
  })

  it('renders every kind at its contracted dimensions, non-blank', async () => {
    const assets = await renderCoinAssets(INPUT)
    for (const asset of assets) {
      expect({ width: asset.width, height: asset.height }).toEqual(IMAGE_DIMENSIONS[asset.kind])
      expect(asset.id).toBe(`${INPUT.coinRef}:${asset.kind}:${asset.sha256.slice(0, 16)}`)
      // PNG signature, and enough bytes that it cannot be a flat single colour.
      expect(Array.from(asset.bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
      expect(asset.bytes.length).toBeGreaterThan(2_000)
    }
  })

  it('renders with a null narrative', async () => {
    const assets = await renderCoinAssets({ ...INPUT, narrative: null, kinds: ['avatar'] })
    expect(assets).toHaveLength(1)
    expect(assets[0]!.kind).toBe('avatar')
  })

  it('refuses a destination-like name or symbol instead of rendering it', async () => {
    for (const [field, patch] of [
      ['name', { name: 'Buy at pepe-claim.top' }],
      ['name', { name: 'PEPE 0xdeadbeefcafe' }],
      ['symbol', { symbol: '@pepe_dev' }],
    ] as const) {
      const attempt = renderCoinAssets({ ...INPUT, ...patch })
      await expect(attempt).rejects.toBeInstanceOf(CreativeError)
      await expect(attempt).rejects.toMatchObject({ code: 'destination_in_input', field })
    }
  })

  it('refuses an unknown kind rather than skipping it', async () => {
    await expect(
      renderCoinAssets({ ...INPUT, kinds: ['banner', 'poster' as never] }),
    ).rejects.toMatchObject({ code: 'unknown_kind' })
  })

  it('refuses when no font can be resolved', async () => {
    await expect(renderCoinAssets(INPUT, { systemFonts: false })).rejects.toMatchObject({
      code: 'font_unresolved',
    })
  })
})

describe('templates keep text inside the canvas', () => {
  const longest = {
    symbol: 'W'.repeat(40),
    name: 'W'.repeat(120),
    tagline: 'W'.repeat(NARRATIVE_LIMITS.maxTaglineChars),
    tone: 'technical' as const,
    palette: null,
  }

  for (const kind of IMAGE_KINDS) {
    it(`${kind}: every text run is at or under its glyph cap`, () => {
      const caps = TEXT_CAPS[kind]
      const perLine = Math.max(caps.symbol + 1, caps.name, caps.tagline?.perLine ?? 0) // +1 for the '$' ticker sigil
      const lengths = textLengths(TEMPLATES[kind](longest))
      expect(lengths.length).toBeGreaterThan(0)
      for (const len of lengths) expect(len).toBeLessThanOrEqual(perLine)
      expect(TEMPLATES[kind](longest)).toContain('\u2026')
    })
  }

  it('a maximum-length tagline with spaces wraps without truncation', () => {
    const cap = TEXT_CAPS.card.tagline!
    const tagline = Array.from({ length: 16 }, () => 'word').join(' ') // 79 chars
    const lines = wrapText(tagline, cap.perLine, cap.lines)
    expect(lines.join(' ')).toBe(tagline)
    expect(lines.length).toBeLessThanOrEqual(cap.lines)
  })

  it('escapes markup in text', () => {
    const svg = TEMPLATES.card({ ...longest, symbol: 'A&B', name: '<script>', tagline: null })
    expect(svg).toContain('$A&amp;B')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).not.toContain('<script>')
  })
})

describe('InMemoryImageAssetStore', () => {
  it('lists only the coin asked for and refuses a mislabelled asset', async () => {
    const store = new InMemoryImageAssetStore()
    const [asset] = await renderCoinAssets({ ...INPUT, kinds: ['avatar'] })
    await store.put(asset!)
    expect(await store.list(INPUT.coinRef)).toEqual([{ id: asset!.id, kind: 'avatar' }])
    expect(await store.list('other')).toEqual([])
    expect(await store.get(asset!.id)).toBe(asset)
    await expect(store.put({ ...asset!, coinRef: 'other' })).rejects.toMatchObject({ code: 'asset_id_mismatch' })
  })
})

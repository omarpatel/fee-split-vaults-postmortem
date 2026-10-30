/**
 * SVG templates. Pure functions of trusted, already-sanitised text: no fetch,
 * no external image, no font by URL, no randomness. Geometry only, so the
 * output is a function of (input, tone, palette) and nothing else.
 *
 * Two properties every template keeps:
 *   - text never escapes the canvas. Each slot has a glyph cap derived from its
 *     budget and font size, over-long text is cut with an ellipsis, and the whole
 *     text group is clipped to the canvas so even a pathological all-wide-glyph
 *     string cannot render outside it.
 *   - text is XML-escaped at the single point it enters markup. Callers pass
 *     plain strings; nothing here interprets them.
 */

import { IMAGE_DIMENSIONS, NARRATIVE_TONES, type ImageKind, type NarrativeTone } from '@fee-split-vaults/core'
import { CreativeError } from './errors.js'

export interface Palette {
  readonly primary: string
  readonly secondary: string
}

export interface TemplateInput {
  readonly symbol: string
  readonly name: string
  readonly tagline: string | null
  readonly tone: NarrativeTone
  /** null → DEFAULT_PALETTE. */
  readonly palette: Palette | null
}

/** Used when a coin has no approved narrative yet. */
export const DEFAULT_PALETTE: Palette = { primary: '#1f2a44', secondary: '#f2b134' }

/** Layout used when a coin has no approved narrative: the plainest of the four. */
export const DEFAULT_TONE: NarrativeTone = 'serious'

const HEX_COLOUR = /^#[0-9a-f]{6}$/
const ELLIPSIS = '\u2026'

// ---------------------------------------------------------------------------
// Text fitting
// ---------------------------------------------------------------------------

export function glyphCount(text: string): number {
  return Array.from(text).length
}

/** Cut to `maxChars` code points, the last one an ellipsis. */
export function fitText(text: string, maxChars: number): string {
  const cps = Array.from(text)
  if (cps.length <= maxChars) return text
  return `${cps.slice(0, Math.max(0, maxChars - 1)).join('').trimEnd()}${ELLIPSIS}`
}

/** Greedy word wrap into at most `maxLines` lines of at most `maxChars` glyphs. */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const word of text.split(' ')) {
    const candidate = current.length === 0 ? word : `${current} ${word}`
    if (glyphCount(candidate) <= maxChars) {
      current = candidate
      continue
    }
    if (current.length > 0) lines.push(current)
    current = word
  }
  if (current.length > 0) lines.push(current)
  if (lines.length > maxLines) {
    const tail = lines.slice(maxLines - 1).join(' ')
    lines.length = maxLines - 1
    lines.push(tail)
  }
  return lines.map((line) => fitText(line, maxChars))
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * A text slot. `em` is the assumed average glyph advance as a fraction of the
 * font size - 0.8 for a ticker (upper case, bold), 0.62 for mixed-case prose.
 * The symbol slot shrinks between `max` and `min` to fit; the others are fixed.
 */
interface Slot {
  readonly max: number
  readonly min: number
  readonly em: number
  readonly maxLines: number
}

interface Layout {
  /** Horizontal pixels available to text. */
  readonly budget: number
  readonly symbol: Slot
  readonly name: Slot
  readonly tagline: Slot | null
}

const LAYOUTS: Readonly<Record<ImageKind, Layout>> = {
  banner: {
    budget: 900,
    symbol: { max: 150, min: 60, em: 0.8, maxLines: 1 },
    name: { max: 46, min: 46, em: 0.62, maxLines: 1 },
    tagline: { max: 32, min: 32, em: 0.62, maxLines: 2 },
  },
  avatar: {
    budget: 340,
    symbol: { max: 110, min: 34, em: 0.8, maxLines: 1 },
    name: { max: 22, min: 22, em: 0.62, maxLines: 1 },
    tagline: null,
  },
  card: {
    budget: 744,
    symbol: { max: 130, min: 56, em: 0.8, maxLines: 1 },
    name: { max: 40, min: 40, em: 0.62, maxLines: 1 },
    tagline: { max: 30, min: 30, em: 0.62, maxLines: 2 },
  },
}

function capOf(budget: number, slot: Slot): number {
  return Math.floor(budget / (slot.min * slot.em))
}

export interface TextCaps {
  readonly symbol: number
  readonly name: number
  readonly tagline: { readonly perLine: number; readonly lines: number } | null
}

function capsOf(layout: Layout): TextCaps {
  return {
    symbol: capOf(layout.budget, layout.symbol),
    name: capOf(layout.budget, layout.name),
    tagline:
      layout.tagline === null
        ? null
        : { perLine: capOf(layout.budget, layout.tagline), lines: layout.tagline.maxLines },
  }
}

/** Glyphs per line each slot holds at its smallest font size. The invariant the tests pin. */
export const TEXT_CAPS: Readonly<Record<ImageKind, TextCaps>> = {
  banner: capsOf(LAYOUTS.banner),
  avatar: capsOf(LAYOUTS.avatar),
  card: capsOf(LAYOUTS.card),
}

function fitSymbol(symbol: string, layout: Layout): { text: string; size: number } {
  const text = fitText(symbol, capOf(layout.budget, layout.symbol))
  const wanted = Math.floor(layout.budget / (Math.max(1, glyphCount(text)) * layout.symbol.em))
  const size = Math.min(layout.symbol.max, Math.max(layout.symbol.min, wanted))
  return { text, size }
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

function channel(hex: string, offset: number): number {
  const v = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of '#rrggbb'. */
function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
}

function textColour(background: string): string {
  return luminance(background) < 0.4 ? '#ffffff' : '#141414'
}

function resolvePalette(palette: Palette | null): Palette {
  const p = palette ?? DEFAULT_PALETTE
  for (const [key, value] of Object.entries(p)) {
    if (!HEX_COLOUR.test(value)) {
      throw new CreativeError('invalid_palette', `palette.${key} must be #rrggbb lowercase`, `palette.${key}`)
    }
  }
  return p
}

// ---------------------------------------------------------------------------
// Backdrops - one per tone, geometry only
// ---------------------------------------------------------------------------

const n = (v: number): string => (Math.round(v * 100) / 100).toString()

function playful(w: number, h: number, p: Palette): string {
  const cx = w * 0.6
  const cy = h * 0.15
  return [
    `<circle cx="${n(w * 0.85)}" cy="${n(h * 0.2)}" r="${n(h * 0.35)}" fill="${p.secondary}" fill-opacity="0.7"/>`,
    `<circle cx="${n(w * 0.7)}" cy="${n(h * 0.92)}" r="${n(h * 0.22)}" fill="${p.secondary}" fill-opacity="0.45"/>`,
    `<circle cx="${n(w * 0.1)}" cy="${n(h * 1.05)}" r="${n(h * 0.3)}" fill="#ffffff" fill-opacity="0.12"/>`,
    `<rect x="${n(cx)}" y="${n(cy)}" width="${n(w * 0.1)}" height="${n(h * 0.5)}" rx="${n(h * 0.05)}" fill="${p.secondary}" fill-opacity="0.35" transform="rotate(25 ${n(cx + w * 0.05)} ${n(cy + h * 0.25)})"/>`,
  ].join('')
}

function serious(w: number, h: number, p: Palette): string {
  return [
    `<rect x="0" y="${n(h * 0.86)}" width="${n(w)}" height="${n(h * 0.14)}" fill="${p.secondary}"/>`,
    `<rect x="${n(w * 0.78)}" y="0" width="${n(w * 0.012)}" height="${n(h * 0.86)}" fill="${p.secondary}" fill-opacity="0.5"/>`,
    `<rect x="${n(w * 0.8)}" y="${n(h * 0.12)}" width="${n(w * 0.14)}" height="${n(h * 0.62)}" fill="#ffffff" fill-opacity="0.08"/>`,
  ].join('')
}

function technical(w: number, h: number, p: Palette): string {
  const cols = 24
  const rows = 8
  let d = ''
  for (let i = 1; i < cols; i++) d += `M${n((w / cols) * i)} 0V${n(h)}`
  for (let j = 1; j < rows; j++) d += `M0 ${n((h / rows) * j)}H${n(w)}`
  const bracket = (x: number, y: number, sx: number, sy: number): string =>
    `<path d="M${n(x)} ${n(y + sy * h * 0.12)}V${n(y)}H${n(x + sx * w * 0.06)}" fill="none" stroke="${p.secondary}" stroke-width="${n(h * 0.012)}"/>`
  return [
    `<path d="${d}" fill="none" stroke="${p.secondary}" stroke-opacity="0.18" stroke-width="1"/>`,
    bracket(w * 0.04, h * 0.08, 1, 1),
    bracket(w * 0.96, h * 0.92, -1, -1),
    `<rect x="${n(w * 0.7)}" y="${n(h * 0.25)}" width="${n(w * 0.22)}" height="${n(h * 0.5)}" fill="none" stroke="${p.secondary}" stroke-opacity="0.6" stroke-width="${n(h * 0.008)}"/>`,
  ].join('')
}

function community(w: number, h: number, p: Palette): string {
  const cx = w * 0.82
  const cy = h * 0.5
  const ring = h * 0.32
  const dots: string[] = []
  for (let i = 0; i < 12; i++) {
    const a = (Math.PI * 2 * i) / 12
    dots.push(
      `<circle cx="${n(cx + Math.cos(a) * ring)}" cy="${n(cy + Math.sin(a) * ring)}" r="${n(h * 0.055)}" fill="${p.secondary}" fill-opacity="${i % 3 === 0 ? '0.9' : '0.5'}"/>`,
    )
  }
  return [
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(ring)}" fill="none" stroke="${p.secondary}" stroke-opacity="0.35" stroke-width="${n(h * 0.01)}"/>`,
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(h * 0.1)}" fill="${p.secondary}"/>`,
    ...dots,
  ].join('')
}

const BACKDROPS: Readonly<Record<NarrativeTone, (w: number, h: number, p: Palette) => string>> = {
  playful,
  serious,
  technical,
  community,
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function open(kind: ImageKind, tone: NarrativeTone, p: Palette): string {
  const { width, height } = IMAGE_DIMENSIONS[kind]
  if (!NARRATIVE_TONES.includes(tone)) {
    throw new CreativeError('unknown_tone', `tone ${JSON.stringify(tone)} is not one of ${NARRATIVE_TONES.join(', ')}`, 'tone')
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><clipPath id="canvas"><rect width="${width}" height="${height}"/></clipPath></defs>` +
    `<rect width="${width}" height="${height}" fill="${p.primary}"/>` +
    BACKDROPS[tone](width, height, p)
  )
}

function text(x: number, y: number, size: number, weight: number, fill: string, content: string, anchor = 'start'): string {
  return `<text x="${n(x)}" y="${n(y)}" font-family="sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escapeXml(content)}</text>`
}

function taglineLines(input: TemplateInput, layout: Layout): string[] {
  if (input.tagline === null || layout.tagline === null) return []
  return wrapText(input.tagline, capOf(layout.budget, layout.tagline), layout.tagline.maxLines)
}

export function bannerSvg(input: TemplateInput): string {
  const p = resolvePalette(input.palette)
  const layout = LAYOUTS.banner
  const fg = textColour(p.primary)
  const symbol = fitSymbol(input.symbol, layout)
  const name = fitText(input.name, capOf(layout.budget, layout.name))
  const lines = taglineLines(input, layout)
  return (
    open('banner', input.tone, p) +
    `<g clip-path="url(#canvas)">` +
    text(100, 235, symbol.size, 700, fg, `$${symbol.text}`) +
    text(100, 312, layout.name.max, 500, fg, name) +
    lines.map((line, i) => text(100, 372 + i * 40, layout.tagline!.max, 400, fg, line)).join('') +
    `</g></svg>`
  )
}

export function avatarSvg(input: TemplateInput): string {
  const p = resolvePalette(input.palette)
  const layout = LAYOUTS.avatar
  const fg = textColour(p.primary)
  const symbol = fitSymbol(input.symbol, layout)
  const name = fitText(input.name, capOf(layout.budget, layout.name))
  return (
    open('avatar', input.tone, p) +
    `<g clip-path="url(#canvas)">` +
    text(200, 190 + symbol.size * 0.35, symbol.size, 700, fg, symbol.text, 'middle') +
    text(200, 320, layout.name.max, 500, fg, name, 'middle') +
    `</g></svg>`
  )
}

export function cardSvg(input: TemplateInput): string {
  const p = resolvePalette(input.palette)
  const layout = LAYOUTS.card
  const fg = textColour(p.primary)
  const symbol = fitSymbol(input.symbol, layout)
  const name = fitText(input.name, capOf(layout.budget, layout.name))
  const lines = taglineLines(input, layout)
  return (
    open('card', input.tone, p) +
    `<g clip-path="url(#canvas)">` +
    text(90, 300, symbol.size, 700, fg, `$${symbol.text}`) +
    text(90, 372, layout.name.max, 500, fg, name) +
    lines.map((line, i) => text(90, 440 + i * 38, layout.tagline!.max, 400, fg, line)).join('') +
    `</g></svg>`
  )
}

export const TEMPLATES: Readonly<Record<ImageKind, (input: TemplateInput) => string>> = {
  banner: bannerSvg,
  avatar: avatarSvg,
  card: cardSvg,
}

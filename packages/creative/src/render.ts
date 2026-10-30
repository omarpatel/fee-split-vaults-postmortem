/**
 * renderCoinAssets - trusted inputs in, PNG ImageAssets out.
 *
 * Inputs are the chain-read symbol/name and the operator-approved
 * NarrativeProfile (or null). The symbol and name come from a contract anyone
 * can deploy, so they are treated as hostile text: folded, whitespace-collapsed
 * and passed through assertNoDestination before a template sees them. A symbol
 * that is a URL is refused, not rendered.
 *
 * Determinism: the SVG is a pure function of the input, and resvg is
 * deterministic for a fixed font set. Pass `fontFiles` to pin the fonts and the
 * sha256 is stable across hosts; with system fonts only it is stable per host.
 */

import { createHash } from 'node:crypto'
import { Resvg } from '@resvg/resvg-js'
import {
  AirlockViolation,
  IMAGE_DIMENSIONS,
  IMAGE_KINDS,
  assertNoDestination,
  foldForDetection,
  imageAssetId,
  type ImageAsset,
  type ImageKind,
  type NarrativeProfile,
} from '@fee-split-vaults/core'
import { CreativeError } from './errors.js'
import { DEFAULT_TONE, TEMPLATES, type TemplateInput } from './templates.js'

export interface RenderCoinAssetsInput {
  readonly coinRef: string
  readonly symbol: string
  readonly name: string
  readonly narrative: NarrativeProfile | null
  /** Defaults to every kind. */
  readonly kinds?: readonly ImageKind[]
}

export interface RenderCoinAssetsOptions {
  /** Local font files to load. Pin these for cross-host determinism. */
  readonly fontFiles?: readonly string[]
  /** Default true. Off means only `fontFiles` can satisfy text. */
  readonly systemFonts?: boolean
}

/** Renders text alone; if no font resolved, resvg drops the node and the bbox is empty. */
const FONT_PROBE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50">' +
  '<text x="5" y="35" font-family="sans-serif" font-size="30" font-weight="700">Ag</text></svg>'

function sanitizeText(raw: string, field: string): string {
  const text = foldForDetection(raw).replace(/\s+/g, ' ').trim()
  if (text.length === 0) throw new CreativeError('empty_text', `${field} is empty after folding`, field)
  try {
    assertNoDestination(text, field)
  } catch (error) {
    if (error instanceof AirlockViolation) {
      throw new CreativeError('destination_in_input', `${field}: ${error.message}`, field)
    }
    throw error
  }
  return text
}

function resolveKinds(kinds: readonly ImageKind[] | undefined): readonly ImageKind[] {
  if (kinds === undefined) return IMAGE_KINDS
  const seen = new Set<ImageKind>()
  for (const kind of kinds) {
    if (!IMAGE_KINDS.includes(kind)) {
      throw new CreativeError('unknown_kind', `${JSON.stringify(kind)} is not one of ${IMAGE_KINDS.join(', ')}`, 'kinds')
    }
    if (seen.has(kind)) throw new CreativeError('unknown_kind', `${kind} requested twice`, 'kinds')
    seen.add(kind)
  }
  return kinds
}

export async function renderCoinAssets(
  input: RenderCoinAssetsInput,
  opts: RenderCoinAssetsOptions = {},
): Promise<readonly ImageAsset[]> {
  const kinds = resolveKinds(input.kinds)
  const template: TemplateInput = {
    symbol: sanitizeText(input.symbol, 'symbol'),
    name: sanitizeText(input.name, 'name'),
    tagline: input.narrative === null ? null : sanitizeText(input.narrative.tagline, 'narrative.tagline'),
    tone: input.narrative?.tone ?? DEFAULT_TONE,
    palette: input.narrative?.palette ?? null,
  }
  const font = {
    loadSystemFonts: opts.systemFonts ?? true,
    fontFiles: [...(opts.fontFiles ?? [])],
  }

  const probe = new Resvg(FONT_PROBE, { font, logLevel: 'off' }).innerBBox()
  if (probe === undefined || !(probe.width > 0)) {
    throw new CreativeError(
      'font_unresolved',
      `no sans-serif font could be resolved (systemFonts=${font.loadSystemFonts}, fontFiles=${font.fontFiles.length})`,
    )
  }

  const assets: ImageAsset[] = []
  for (const kind of kinds) {
    const { width, height } = IMAGE_DIMENSIONS[kind]
    const rendered = new Resvg(TEMPLATES[kind](template), {
      fitTo: { mode: 'width', value: width },
      font,
      logLevel: 'off',
    }).render()
    if (rendered.width !== width || rendered.height !== height) {
      throw new CreativeError(
        'dimension_mismatch',
        `${kind} rendered ${rendered.width}x${rendered.height}, expected ${width}x${height}`,
        kind,
      )
    }
    const png = rendered.asPng()
    const bytes = new Uint8Array(png.buffer, png.byteOffset, png.byteLength)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    let id: string
    try {
      id = imageAssetId(input.coinRef, kind, sha256)
    } catch (error) {
      if (error instanceof TypeError) throw new CreativeError('invalid_coin_ref', error.message, 'coinRef')
      throw error
    }
    assets.push({ id, coinRef: input.coinRef, kind, mime: 'image/png', width, height, sha256, bytes })
  }
  return assets
}

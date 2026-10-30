/**
 * NarrativeProfile - what a coin is "about", as trusted, operator-approved data.
 *
 * Where it comes from: at onboarding the dev names one or more source documents
 * (a launch post, a site). Those are UNTRUSTED. They are fetched by code, folded
 * and scrubbed, summarised by the READER plane (no tools), reduced to this closed
 * shape, and then an operator approves the result. Only the approved profile is
 * stored, and only the stored profile reaches the planner.
 *
 * Where it goes: rendered by trusted code into a per-coin planner block and into
 * generated creative (banner, avatar, post card). It never reaches the reader.
 *
 * What it cannot hold, by construction: an address, an amount, a URL, a handle,
 * a free-form instruction. `tagline` is the only prose field and it must survive
 * `assertNoDestination`. Widening this schema is a security review.
 */

import { AirlockViolation, TOPIC_CODES, assertNoDestination, type TopicCode } from './airlock.js'
import { foldForDetection } from './destinations.js'

export const NARRATIVE_TONES = ['playful', 'serious', 'technical', 'community'] as const
export type NarrativeTone = (typeof NARRATIVE_TONES)[number]

export const NARRATIVE_LIMITS = {
  maxTaglineChars: 80,
  maxThemes: 5,
  maxSourceHashes: 8,
} as const

export interface NarrativeProfile {
  readonly version: 1
  /** One short line of prose. Scrubbed; passes assertNoDestination. */
  readonly tagline: string
  /** Closed vocabulary, drawn from TOPIC_CODES. */
  readonly themes: readonly TopicCode[]
  readonly tone: NarrativeTone
  /** '#rrggbb' lowercase. Used by creative only. */
  readonly palette: { readonly primary: string; readonly secondary: string }
  /** Operator approval. Unapproved profiles do not exist as far as the planner knows. */
  readonly approvedAtUnix: number
  readonly approvedBy: string
  /** sha256 hex of each fetched source document, for audit. Never the document. */
  readonly sourceHashes: readonly string[]
}

const HEX_COLOUR = /^#[0-9a-f]{6}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const OPERATOR_ID = /^[A-Za-z0-9_.-]{1,64}$/

const ALLOWED_KEYS: Record<string, true> = {
  version: true,
  tagline: true,
  themes: true,
  tone: true,
  palette: true,
  approvedAtUnix: true,
  approvedBy: true,
  sourceHashes: true,
}

function fail(message: string, field: string): never {
  throw new AirlockViolation(message, field)
}

/**
 * Validates an untyped value into a NarrativeProfile. Throws AirlockViolation on
 * any deviation: unknown key, wrong type, out-of-vocabulary theme, destination-
 * like content in the tagline. There is no lenient mode.
 */
export function validateNarrativeProfile(raw: unknown): NarrativeProfile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('profile is not an object', 'narrative')
  }
  const obj = raw as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (ALLOWED_KEYS[key] !== true) fail(`unrecognised field ${key}`, `narrative.${key}`)
  }
  if (obj.version !== 1) fail('unsupported version', 'narrative.version')

  if (typeof obj.tagline !== 'string') fail('tagline must be a string', 'narrative.tagline')
  const tagline = foldForDetection(obj.tagline).replace(/\s+/g, ' ').trim()
  if (tagline.length === 0) fail('tagline is empty', 'narrative.tagline')
  if (tagline.length > NARRATIVE_LIMITS.maxTaglineChars) {
    fail(`tagline exceeds ${NARRATIVE_LIMITS.maxTaglineChars} chars`, 'narrative.tagline')
  }
  assertNoDestination(tagline, 'narrative.tagline')

  if (!Array.isArray(obj.themes)) fail('themes must be an array', 'narrative.themes')
  if (obj.themes.length > NARRATIVE_LIMITS.maxThemes) {
    fail(`more than ${NARRATIVE_LIMITS.maxThemes} themes`, 'narrative.themes')
  }
  const themes: TopicCode[] = []
  for (const theme of obj.themes) {
    if (typeof theme !== 'string' || !(TOPIC_CODES as readonly string[]).includes(theme)) {
      fail('theme outside closed vocabulary', 'narrative.themes')
    }
    if (!themes.includes(theme as TopicCode)) themes.push(theme as TopicCode)
  }

  if (typeof obj.tone !== 'string' || !(NARRATIVE_TONES as readonly string[]).includes(obj.tone)) {
    fail('tone outside closed vocabulary', 'narrative.tone')
  }

  const palette = obj.palette
  if (typeof palette !== 'object' || palette === null || Array.isArray(palette)) {
    fail('palette must be an object', 'narrative.palette')
  }
  const p = palette as Record<string, unknown>
  for (const key of Object.keys(p)) {
    if (key !== 'primary' && key !== 'secondary') fail(`unrecognised field ${key}`, 'narrative.palette')
  }
  if (typeof p.primary !== 'string' || !HEX_COLOUR.test(p.primary)) {
    fail('primary colour must be #rrggbb lowercase', 'narrative.palette.primary')
  }
  if (typeof p.secondary !== 'string' || !HEX_COLOUR.test(p.secondary)) {
    fail('secondary colour must be #rrggbb lowercase', 'narrative.palette.secondary')
  }

  if (
    typeof obj.approvedAtUnix !== 'number' ||
    !Number.isSafeInteger(obj.approvedAtUnix) ||
    obj.approvedAtUnix <= 0
  ) {
    fail('approvedAtUnix must be a positive integer', 'narrative.approvedAtUnix')
  }
  if (typeof obj.approvedBy !== 'string' || !OPERATOR_ID.test(obj.approvedBy)) {
    fail('approvedBy must be an operator id', 'narrative.approvedBy')
  }

  if (!Array.isArray(obj.sourceHashes)) fail('sourceHashes must be an array', 'narrative.sourceHashes')
  if (obj.sourceHashes.length > NARRATIVE_LIMITS.maxSourceHashes) {
    fail(`more than ${NARRATIVE_LIMITS.maxSourceHashes} source hashes`, 'narrative.sourceHashes')
  }
  const sourceHashes: string[] = []
  for (const hash of obj.sourceHashes) {
    if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
      fail('source hash must be sha256 hex', 'narrative.sourceHashes')
    }
    if (!sourceHashes.includes(hash)) sourceHashes.push(hash)
  }

  return {
    version: 1,
    tagline,
    themes,
    tone: obj.tone as NarrativeTone,
    palette: { primary: p.primary, secondary: p.secondary },
    approvedAtUnix: obj.approvedAtUnix,
    approvedBy: obj.approvedBy,
    sourceHashes,
  }
}

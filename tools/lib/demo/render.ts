/**
 * The demo's rendering vocabulary.
 *
 * Every subsystem in this directory produces the SAME structure - a list of
 * scenes - and this file is the only thing that turns one into text. The
 * consequence is that `--json` and the human report cannot disagree: the JSON
 * is the scene list, and the report is a pure function of it.
 *
 * A scene is one thing the product was asked to do and what it did about it.
 * Half of them are refusals, because the refusals are the product: an agency
 * that answers every question and buys every SKU is not this agency, and the
 * only way to show that is to watch it decline in the same format in which it
 * accepts.
 *
 * Styling is format.ts's - ASCII, no colour, headings underlined, key/value
 * blocks padded the way emitDryRun pads its resolved config. These reports get
 * pasted into documents and read on a projector.
 */

import { heading, subheading, table, wrapText } from '../format.ts'

/**
 * What happened.
 *
 * `gap` is NOT a softer refusal and must not render as one. A refusal is the
 * system declining to answer a question it understood; a gap is the system
 * saying it never observed the thing being asked about, and handing back a way
 * to check it independently. Collapsing the two would hide the single most
 * load-bearing behaviour in the desk.
 */
export type VerdictKind = 'ok' | 'refused' | 'gap'

export interface Verdict {
  kind: VerdictKind
  /** Short, upper-case, subsystem's own word: ANSWERED, APPROVED, PUBLISHED. */
  label: string
  /** Why, in one line. For a refusal this names the gate or rule that fired. */
  why: string
}

export function ok(label: string, why: string): Verdict {
  return { kind: 'ok', label, why }
}

export function refused(label: string, why: string): Verdict {
  return { kind: 'refused', label, why }
}

export function gap(label: string, why: string): Verdict {
  return { kind: 'gap', label, why }
}

export interface Pair {
  label: string
  value: string
}

export interface Block {
  label: string
  /** Verbatim. Rendered in a gutter so it is unmistakably an artifact. */
  text: string
  /**
   * Set for text that is already laid out - a table from format.ts - so it is
   * printed as-is rather than put behind the artifact gutter and re-wrapped.
   */
  plain?: boolean
}

export interface Scene {
  /** Stable across runs. Used by --only and by anything reading the JSON. */
  id: string
  title: string
  /** The one sentence this scene exists to demonstrate. */
  proves: string
  verdict: Verdict
  /** What the subsystem was handed. */
  given: Pair[]
  /** Ordered narration of what the code actually did, step by step. */
  path: string[]
  /** Verbatim artifacts: the wire message, the digest, the decision. */
  blocks?: Block[]
}

export interface DemoResult {
  subsystem: string
  /** One line naming the claim the whole subcommand is evidence for. */
  headline: string
  /** Read before the scenes. Sets up what the reader is about to watch. */
  premise: string[]
  scenes: Scene[]
  counts: { total: number; ok: number; refused: number; gap: number }
  /**
   * Non-empty when the subcommand produced a report but NOT the demonstration
   * it exists to produce - the vault walkthrough with no compiled artifact to
   * pin itself to, say. Drives report.ts's incomplete banner and exit code 3.
   */
  incompleteReasons: string[]
  /**
   * Subsystem-specific measured facts worth carrying in the JSON - a token
   * count, a predicted address, an elapsed time. Rendered as a closing table.
   */
  facts: Pair[]
}

export function summarise(
  subsystem: string,
  headline: string,
  premise: string[],
  scenes: Scene[],
  facts: Pair[] = [],
  incompleteReasons: string[] = [],
): DemoResult {
  return {
    subsystem,
    headline,
    premise,
    scenes,
    counts: {
      total: scenes.length,
      ok: scenes.filter((s) => s.verdict.kind === 'ok').length,
      refused: scenes.filter((s) => s.verdict.kind === 'refused').length,
      gap: scenes.filter((s) => s.verdict.kind === 'gap').length,
    },
    facts,
    incompleteReasons,
  }
}

const GUTTER = '    | '
const KEY_WIDTH = 9

/** A key/value line, padded the way emitDryRun pads its resolved config. */
function field(label: string, value: string, indent = '  '): string[] {
  const width = 92 - indent.length - KEY_WIDTH - 1
  const wrapped = value.includes('\n')
    ? value.split('\n')
    : wrapText(value, width)
  return wrapped.map((line, i) =>
    i === 0
      ? `${indent}${label.padEnd(KEY_WIDTH)} ${line}`
      : `${indent}${' '.repeat(KEY_WIDTH)} ${line}`,
  )
}

/**
 * Verbatim text, in a gutter.
 *
 * A real outbound message is one long line and a projector is 100 columns, so
 * long lines are soft-wrapped onto a continuation indent. The gutter stays, so
 * a wrap is never mistaken for a newline the product actually emitted.
 */
function gutter(text: string, width = 88): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (line.length <= width) {
      out.push(`${GUTTER}${line}`)
      continue
    }
    const wrapped = wrapText(line, width)
    for (const [i, piece] of wrapped.entries()) {
      out.push(i === 0 ? `${GUTTER}${piece}` : `${GUTTER}  ${piece}`)
    }
  }
  return out
}

export function renderScene(scene: Scene, index: number): string {
  const lines: string[] = []
  lines.push(subheading(`${index}. ${scene.title}`))
  lines.push(...field('verdict', `${verdictTag(scene.verdict)} - ${scene.verdict.why}`))
  lines.push(...field('proves', scene.proves))

  if (scene.given.length > 0) {
    const width = Math.max(...scene.given.map((g) => g.label.length))
    const rendered = scene.given
      .map((g) => `${g.label.padEnd(width)}  ${g.value}`)
      .join('\n')
    lines.push(...field('given', rendered))
  }

  if (scene.path.length > 0) {
    lines.push(
      ...field(
        'path',
        scene.path.map((step, i) => `${String(i + 1).padStart(2)}. ${step}`).join('\n'),
      ),
    )
  }

  for (const block of scene.blocks ?? []) {
    lines.push(`  ${block.label}`)
    if (block.plain === true) lines.push(block.text)
    else lines.push(...gutter(block.text))
  }

  return lines.join('\n')
}

/**
 * The verdict tag. Refusals are padded to the same width as successes so the
 * eye can run down the left edge of a report and find them.
 */
function verdictTag(verdict: Verdict): string {
  const mark = verdict.kind === 'ok' ? '[ok]' : verdict.kind === 'refused' ? '[REFUSED]' : '[gap]'
  return `${mark} ${verdict.label}`
}

export function renderDemo(result: DemoResult): string {
  const lines: string[] = []
  lines.push(heading(`demo ${result.subsystem} - ${result.headline}`))
  lines.push('')
  for (const line of result.premise) {
    for (const wrapped of wrapText(line, 92)) lines.push(`  ${wrapped}`)
  }

  for (const [index, scene] of result.scenes.entries()) {
    lines.push(renderScene(scene, index + 1))
  }

  lines.push(heading('What just happened'))
  lines.push(
    table(result.scenes, [
      { header: '#', value: (s) => String(result.scenes.indexOf(s) + 1), align: 'right' },
      { header: 'scene', value: (s) => s.title },
      { header: 'verdict', value: (s) => verdictTag(s.verdict) },
    ]),
  )
  lines.push('')
  lines.push(
    `  ${result.counts.total} scenes: ${result.counts.ok} carried out, ` +
      `${result.counts.refused} REFUSED, ${result.counts.gap} answered "I have not verified that".`,
  )

  if (result.facts.length > 0) {
    lines.push(subheading('Measured in this run'))
    lines.push(
      table(result.facts, [
        { header: 'fact', value: (f) => f.label },
        { header: 'value', value: (f) => f.value },
      ]),
    )
  }
  return lines.join('\n')
}

/** Trim a long verbatim artifact for display, saying how much was cut. */
export function clip(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`].join('\n')
}

/** `0x1111…1111`. Addresses are shown short everywhere except where they matter. */
export function short(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address
}

/** A count, grouped in threes. 500000 reads as a typo; 500,000 reads as a flood. */
export function countText(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Truncate for a table cell. Never used on anything a verdict depends on. */
export function ellipsis(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

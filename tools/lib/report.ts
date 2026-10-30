/**
 * Shared output path for every tool: one JSON document is the source of truth,
 * the human report is a rendering of it. They can never disagree, because the
 * human renderer takes the same object that gets written to --out.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { banner } from './format.ts'
import { stringifyJson } from './json.ts'

/**
 * Exit code for a run that COMPLETED but could not measure what it exists to
 * measure - most often because its amounts had no price.
 *
 * Distinct from 2 (bad config / bad flags) and 1 (crash) so a pipeline can
 * tell "you asked the wrong question" from "I could not answer the question I
 * was asked". What it must never be is 0: a tool that exits 0 after printing a
 * table it had to refuse to fill has told the caller everything is fine.
 */
export const EXIT_INCOMPLETE_MEASUREMENT = 3

/**
 * Every tool's output carries this. `warnings` is not decoration: it is the
 * mechanism by which a measured number keeps its caveats attached when someone
 * copies it into a spreadsheet.
 */
export interface ReportMeta {
  tool: string
  schemaVersion: string
  generatedAtUnix: number
  /** Config echo, redacted. */
  config: Record<string, unknown>
  /** Requests actually issued, and cache hit rate. */
  io: { httpRequests: number; cacheHits: number; cacheMisses: number }
  /** Things that limit how far the numbers may be read. Always printed. */
  warnings: string[]
  /** Method limitations inherent to the data source, not to this run. */
  methodLimits: string[]
  /**
   * False when the run produced an artifact but NOT an answer. Drives both the
   * closing banner and the process exit code. Omitted means true, so a tool
   * that has not thought about it still behaves as it did before - but every
   * tool that can fail this way sets it explicitly.
   */
  measurementComplete?: boolean
  /** Why it is incomplete. Never empty when measurementComplete is false. */
  incompleteReasons?: string[]
}

export interface Report<T> {
  meta: ReportMeta
  result: T
}

export async function emit<T>(
  report: Report<T>,
  options: { json: boolean; outPath?: string | undefined; human: (report: Report<T>) => string },
): Promise<void> {
  // The artifact is written FIRST and unconditionally. An incomplete run still
  // produces evidence worth keeping - the raw amounts are exactly what a later
  // repricing run needs - so refusing to write it would destroy data to make a
  // point. What the run must not do is claim success, which is the exit code's
  // job, and must not print derived conclusions, which is the renderer's.
  const serialized = stringifyJson(report, 'string', 2)
  if (options.outPath !== undefined && options.outPath.length > 0) {
    await mkdir(dirname(options.outPath), { recursive: true })
    await writeFile(options.outPath, `${serialized}\n`, 'utf8')
  }
  const incomplete = report.meta.measurementComplete === false
  if (options.json) {
    process.stdout.write(`${serialized}\n`)
    if (incomplete) process.exitCode = EXIT_INCOMPLETE_MEASUREMENT
    return
  }
  process.stdout.write(`${options.human(report)}\n`)
  if (report.meta.warnings.length > 0) {
    process.stdout.write(`\n${banner(['READ THESE BEFORE QUOTING ANY NUMBER ABOVE'])}\n`)
    for (const warning of report.meta.warnings) {
      process.stdout.write(wrapBullet(warning))
    }
  }
  if (report.meta.methodLimits.length > 0) {
    process.stdout.write(`\nMETHOD LIMITS\n`)
    for (const limit of report.meta.methodLimits) {
      process.stdout.write(wrapBullet(limit))
    }
  }
  if (options.outPath !== undefined && options.outPath.length > 0) {
    process.stdout.write(`\nJSON written to ${options.outPath}\n`)
  }
  if (incomplete) {
    // Last thing on the screen as well as the first, because a long report
    // scrolls the top banner away and this is the sentence that matters.
    process.stdout.write(
      `\n${banner([
        'MEASUREMENT INCOMPLETE.',
        `${report.meta.tool} produced an artifact but NOT an answer. The conclusions this tool exists`,
        'to draw were REFUSED, not computed, and no figure above may be quoted as a result.',
        `Exit code ${EXIT_INCOMPLETE_MEASUREMENT}.`,
      ])}\n`,
    )
    for (const reason of report.meta.incompleteReasons ?? []) {
      process.stdout.write(wrapBullet(reason))
    }
    process.exitCode = EXIT_INCOMPLETE_MEASUREMENT
  }
}

function wrapBullet(text: string, width = 96): string {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      lines.push(current)
      current = word
    } else {
      current = current.length === 0 ? word : `${current} ${word}`
    }
  }
  if (current.length > 0) lines.push(current)
  return lines.map((l, i) => (i === 0 ? `  * ${l}\n` : `    ${l}\n`)).join('')
}

/** The --dry-run rendering: plan only, no network I/O has happened. */
export interface DryRunPlan {
  tool: string
  config: Record<string, unknown>
  steps: Array<{ description: string; endpoint?: string; estimatedRequests?: number }>
  estimatedRequestsTotal: number
  notes: string[]
}

export function emitDryRun(plan: DryRunPlan, json: boolean): void {
  if (json) {
    process.stdout.write(`${stringifyJson(plan, 'string', 2)}\n`)
    return
  }
  const lines: string[] = []
  lines.push(`DRY RUN - ${plan.tool}. No network request was made.`)
  lines.push('')
  lines.push('RESOLVED CONFIG')
  for (const [key, value] of Object.entries(plan.config)) {
    lines.push(`  ${key.padEnd(24)} ${stringifyJson(value, 'string', 0)}`)
  }
  lines.push('')
  lines.push('PLAN')
  for (const [i, step] of plan.steps.entries()) {
    const budget =
      step.estimatedRequests !== undefined ? ` [~${step.estimatedRequests} requests]` : ''
    lines.push(`  ${String(i + 1).padStart(2)}. ${step.description}${budget}`)
    if (step.endpoint) lines.push(`      -> ${step.endpoint}`)
  }
  lines.push('')
  lines.push(`  Estimated total requests: ~${plan.estimatedRequestsTotal}`)
  if (plan.notes.length > 0) {
    lines.push('')
    lines.push('NOTES')
    for (const note of plan.notes) lines.push(`  * ${note}`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

export function progress(verbose: boolean, message: string): void {
  if (verbose) process.stderr.write(`${message}\n`)
}

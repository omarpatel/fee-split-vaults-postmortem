/**
 * Tiny declarative CLI layer shared by every tool.
 *
 * Every tool gets --help, --json, --dry-run, --no-cache and --out for free, and
 * unknown flags are a hard error rather than a silent no-op: a typo'd
 * --min-usd on a market-sizing run would otherwise produce a confident number
 * from the wrong threshold.
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * True when this module is the process entrypoint.
 *
 * Every tool guards its runCli call with this so that a test can import the
 * module for its pure helpers without the CLI executing as a side effect.
 */
export function isEntrypoint(importMetaUrl: string): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    const self = realpathSync(fileURLToPath(importMetaUrl))
    return self === realpathSync(entry)
  } catch {
    return false
  }
}

export interface OptionSpec {
  name: string
  /** Single-character alias, without the dash. */
  short?: string
  type: 'string' | 'number' | 'boolean' | 'string[]'
  describe: string
  default?: string | number | boolean | string[]
  /** Shown in --help as the value placeholder. */
  placeholder?: string
  required?: boolean
}

export interface CommandSpec {
  name: string
  summary: string
  /** Longer prose printed under the usage line. */
  detail?: string
  options: OptionSpec[]
  /** Example invocations, printed verbatim. */
  examples?: string[]
  /**
   * Overrides the derived `node tools/<name>.ts [options]` usage line.
   *
   * Exists for subcommands: a spec named "demo desk" would otherwise render as
   * `node tools/demo desk.ts`, which is not a command anyone can type.
   */
  usage?: string
}

export type ParsedValues = Record<string, string | number | boolean | string[] | undefined>

export class CliError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 2) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

/**
 * Errors that describe an operating condition rather than a defect. These get a
 * one-line message; everything else keeps its stack, because an unexpected
 * error in a measurement tool is a reason to look at the code.
 */
const OPERATIONAL_ERRORS = new Set([
  'ConfigError',
  'HttpError',
  'RpcError',
  'CallRevertedError',
  'UnservableRangeError',
  'MissingPriceError',
  'UnpricedSeriesError',
  'ZeroProtocolLegError',
  // A signature that does not match its --mode is the operator's typo, and the
  // message already names both shapes. A stack trace on top just buries it.
  'CreditEventShapeError',
  'EscrowSeriesSchemaError',
  // A state written for a different gate, escrow, chain or floor - and a seed
  // document carrying no end block - are both refusals watch.ts raises on
  // purpose, and each message already names the fix. Printing a stack on top of
  // "use a document written by escrow-index.ts" buries the only useful line.
  'WatchStateError',
])

const COMMON_OPTIONS: OptionSpec[] = [
  { name: 'help', short: 'h', type: 'boolean', describe: 'Print this help and exit.' },
  {
    name: 'json',
    type: 'boolean',
    describe: 'Emit machine-readable JSON on stdout instead of the human report.',
  },
  {
    name: 'dry-run',
    type: 'boolean',
    describe:
      'Resolve config and print the exact plan (endpoints, ranges, request budget) without performing any network I/O.',
  },
  { name: 'no-cache', type: 'boolean', describe: 'Bypass the on-disk results cache.' },
  {
    name: 'out',
    type: 'string',
    placeholder: '<file>',
    describe: 'Write the JSON result to this file in addition to stdout.',
  },
  { name: 'verbose', short: 'v', type: 'boolean', describe: 'Log progress to stderr.' },
]

export function renderHelp(spec: CommandSpec): string {
  const all = [...spec.options, ...COMMON_OPTIONS]
  const lines: string[] = []
  lines.push(`${spec.name} - ${spec.summary}`)
  lines.push('')
  lines.push(`USAGE`)
  lines.push(`  ${spec.usage ?? `node tools/${spec.name}.ts [options]`}`)
  lines.push('')
  if (spec.detail) {
    lines.push('WHAT THIS SETTLES')
    for (const paragraph of spec.detail.trim().split('\n')) lines.push(`  ${paragraph.trim()}`)
    lines.push('')
  }
  lines.push('OPTIONS')
  const rendered = all.map((o) => {
    const flag = `--${o.name}${o.type === 'boolean' ? '' : ` ${o.placeholder ?? `<${o.type}>`}`}`
    return { flag: o.short ? `-${o.short}, ${flag}` : `    ${flag}`, option: o }
  })
  const width = Math.max(...rendered.map((r) => r.flag.length))
  for (const { flag, option } of rendered) {
    const suffix =
      option.default !== undefined
        ? ` (default: ${Array.isArray(option.default) ? option.default.join(',') : String(option.default)})`
        : option.required
          ? ' (required)'
          : ''
    lines.push(`  ${flag.padEnd(width)}  ${option.describe}${suffix}`)
  }
  if (spec.examples && spec.examples.length > 0) {
    lines.push('')
    lines.push('EXAMPLES')
    for (const example of spec.examples) lines.push(`  ${example}`)
  }
  return lines.join('\n')
}

export function parseArgs(spec: CommandSpec, argv: readonly string[]): ParsedValues {
  const all = [...spec.options, ...COMMON_OPTIONS]
  const byName = new Map(all.map((o) => [o.name, o]))
  const byShort = new Map(all.filter((o) => o.short).map((o) => [o.short!, o]))

  const values: ParsedValues = {}
  for (const option of all) {
    if (option.default !== undefined) values[option.name] = option.default
  }

  const positional: string[] = []
  const seenListFlags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (!token.startsWith('-')) {
      positional.push(token)
      continue
    }

    let name: string
    let inlineValue: string | undefined
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      name = eq === -1 ? token.slice(2) : token.slice(2, eq)
      inlineValue = eq === -1 ? undefined : token.slice(eq + 1)
    } else {
      const short = token.slice(1)
      const option = byShort.get(short)
      if (!option) throw new CliError(`unknown flag -${short}. Try --help.`)
      name = option.name
    }

    const option = byName.get(name)
    if (!option) throw new CliError(`unknown flag --${name}. Try --help.`)

    if (option.type === 'boolean') {
      if (inlineValue !== undefined) {
        values[name] = inlineValue !== 'false' && inlineValue !== '0'
      } else {
        values[name] = true
      }
      continue
    }

    const raw = inlineValue ?? argv[++i]
    if (raw === undefined) throw new CliError(`--${name} needs a value.`)
    if (option.type === 'number') {
      const n = Number(raw)
      if (!Number.isFinite(n)) throw new CliError(`--${name} must be a number, got "${raw}".`)
      values[name] = n
    } else if (option.type === 'string[]') {
      // Repeating the flag appends; the option default is replaced, not appended to.
      const seen = seenListFlags.has(name)
      const previous = seen && Array.isArray(values[name]) ? (values[name] as string[]) : []
      seenListFlags.add(name)
      values[name] = [
        ...previous,
        ...raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ]
    } else {
      values[name] = raw
    }
  }

  if (positional.length > 0) {
    throw new CliError(`unexpected positional argument "${positional[0]}". All input is via flags.`)
  }

  for (const option of all) {
    if (option.required && values[option.name] === undefined && values.help !== true) {
      throw new CliError(`--${option.name} is required. Try --help.`)
    }
  }
  return values
}

export function getString(values: ParsedValues, name: string): string | undefined {
  const v = values[name]
  return typeof v === 'string' ? v : undefined
}

export function requireString(values: ParsedValues, name: string): string {
  const v = getString(values, name)
  if (v === undefined || v.length === 0) throw new CliError(`--${name} is required.`)
  return v
}

export function getNumber(values: ParsedValues, name: string, fallback: number): number {
  const v = values[name]
  return typeof v === 'number' ? v : fallback
}

export function getBool(values: ParsedValues, name: string): boolean {
  return values[name] === true
}

export function getList(values: ParsedValues, name: string): string[] {
  const v = values[name]
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  return []
}

/**
 * Standard entrypoint wrapper. Prints help, routes CliError to a clean message
 * and a non-zero exit, and never swallows an unexpected error - a tool that
 * exits 0 after failing to measure something is worse than one that crashes.
 */
export async function runCli(
  spec: CommandSpec,
  argv: readonly string[],
  main: (values: ParsedValues) => Promise<void>,
): Promise<void> {
  let values: ParsedValues
  try {
    values = parseArgs(spec, argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }
  if (values.help === true) {
    process.stdout.write(`${renderHelp(spec)}\n`)
    return
  }
  try {
    await main(values)
  } catch (error) {
    // A misconfiguration is a user error, not a crash: print the fix, not a stack.
    if (error instanceof CliError) {
      process.stderr.write(`${spec.name}: ${error.message}\n`)
      process.exitCode = error.exitCode
      return
    }
    if (error instanceof Error && OPERATIONAL_ERRORS.has(error.name)) {
      process.stderr.write(`${spec.name}: ${error.message}\n`)
      process.exitCode = 2
      return
    }
    // Node system errors (ENOENT, ECONNREFUSED, ...) are operating conditions,
    // not bugs. A stack trace for a missing input file just buries the message.
    if (error instanceof Error && typeof (error as { code?: unknown }).code === 'string') {
      process.stderr.write(`${spec.name}: ${error.message}\n`)
      process.exitCode = 1
      return
    }
    process.stderr.write(
      `${spec.name}: ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}\n`,
    )
    process.exitCode = 1
  }
}

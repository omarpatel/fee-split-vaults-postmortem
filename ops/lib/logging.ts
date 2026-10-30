/**
 * Structured logging.
 *
 * Every ops log line is a flat object with a stable `event` key. Two rules that
 * are not stylistic:
 *
 *   1. bigint minor units are serialized as base-10 STRINGS. JSON.stringify
 *      throws on a bigint, and a Number() cast silently loses the low digits of
 *      a large balance. redactAndFlatten() does the conversion.
 *   2. No untrusted text is ever logged verbatim at the point where it could be
 *      re-read as instructions. Fields whose name matches the untrusted-content
 *      pattern are hashed, not printed.
 */

import { createHash } from 'node:crypto'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export type LogFields = Record<string, unknown>

export interface LogRecord {
  atUnix: number
  level: LogLevel
  event: string
  fields: Record<string, string | number | boolean | null>
}

export interface Logger {
  child(fields: LogFields): Logger
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

/** Field names whose values are attacker-influenced and must never be printed raw. */
const UNTRUSTED_FIELD = /(^|_)(body|message|text|gist|metadata|name|symbol|description|memo|raw)($|_)/i

/**
 * Field names whose values are secrets and must never be printed at all.
 *
 * Matched on whole underscore-separated words rather than as substrings. A
 * substring match on "key" redacts `run_key`, `lock_key` and `day_key` - the
 * three fields an incident responder most needs - and a substring match on
 * "token" redacts the ERC-20 token address, which is not a credential.
 */
const SECRET_FIELD =
  /(^|_)(secret|secrets|password|passphrase|mnemonic|privkey|apikey|authorization|cookie|signature|sig)($|_)|(^|_)(private|signing|secret|api|encryption)_key($|_)|(^|_)(access|auth|bearer|refresh|session|policy|id)_token($|_)|^key$/i

export function hashForLog(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)}`
}

export function redactAndFlatten(fields: LogFields): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_FIELD.test(key)) {
      out[key] = '[redacted]'
      continue
    }
    const flat = flattenValue(value)
    if (typeof flat === 'string' && UNTRUSTED_FIELD.test(key)) {
      out[key] = hashForLog(flat)
      out[`${key}_len`] = flat.length
      continue
    }
    out[key] = flat
  }
  return out
}

function flattenValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'bigint':
      return value.toString(10)
    case 'string':
    case 'number':
    case 'boolean':
      return value
    default:
      break
  }
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (Array.isArray(value)) return value.map((v) => String(flattenValue(v))).join(',')
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)) ?? null
  } catch {
    return '[unserializable]'
  }
}

export type LogSink = (record: LogRecord) => void

export interface StructuredLoggerOptions {
  sink: LogSink
  nowUnix: () => number
  minLevel?: LogLevel
  base?: LogFields
}

export class StructuredLogger implements Logger {
  readonly #sink: LogSink
  readonly #now: () => number
  readonly #minLevel: LogLevel
  readonly #base: LogFields

  constructor(options: StructuredLoggerOptions) {
    this.#sink = options.sink
    this.#now = options.nowUnix
    this.#minLevel = options.minLevel ?? 'info'
    this.#base = options.base ?? {}
  }

  child(fields: LogFields): Logger {
    return new StructuredLogger({
      sink: this.#sink,
      nowUnix: this.#now,
      minLevel: this.#minLevel,
      base: { ...this.#base, ...fields },
    })
  }

  debug(event: string, fields: LogFields = {}): void {
    this.#emit('debug', event, fields)
  }

  info(event: string, fields: LogFields = {}): void {
    this.#emit('info', event, fields)
  }

  warn(event: string, fields: LogFields = {}): void {
    this.#emit('warn', event, fields)
  }

  error(event: string, fields: LogFields = {}): void {
    this.#emit('error', event, fields)
  }

  #emit(level: LogLevel, event: string, fields: LogFields): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.#minLevel]) return
    this.#sink({
      atUnix: this.#now(),
      level,
      event,
      fields: redactAndFlatten({ ...this.#base, ...fields }),
    })
  }
}

/** One JSON object per line on stdout. What a log shipper expects. */
export function jsonLineSink(write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): LogSink {
  return (record) => {
    write(JSON.stringify({ ts: record.atUnix, level: record.level, event: record.event, ...record.fields }))
  }
}

/** Test double. Keeps every record so a test can assert on emitted events. */
export class MemoryLogSink {
  readonly records: LogRecord[] = []

  readonly sink: LogSink = (record) => {
    this.records.push(record)
  }

  events(): string[] {
    return this.records.map((r) => r.event)
  }

  find(event: string): LogRecord | undefined {
    return this.records.find((r) => r.event === event)
  }

  all(event: string): LogRecord[] {
    return this.records.filter((r) => r.event === event)
  }
}

/** A logger that discards everything. For call sites that legitimately do not log. */
export const NULL_LOGGER: Logger = {
  child: () => NULL_LOGGER,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

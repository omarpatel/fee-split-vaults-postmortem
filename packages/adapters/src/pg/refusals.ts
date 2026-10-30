/**
 * The desk's refusal log, persisted.
 *
 * `RefusalLog` is synchronous by design - the router records a refusal and
 * immediately counts the author's recent ones to decide whether a human is
 * told - so this class keeps the recent window IN MEMORY and writes through to
 * Postgres in batches. `record()` and `countSince()` never wait on the
 * database; `flush()` does, and the desk port awaits it after every message
 * so a write failure surfaces on the tick as a refusal rather than being lost
 * in a fire-and-forget promise.
 *
 * `load()` warms the memory window from the table on start, so an author who
 * produced seven refusals before a restart is still one refusal from a probe
 * escalation after it.
 */

import type { RefusalLog, RefusalLogEntry } from '@fee-split-vaults/desk'
import { REFUSAL_CLASSES } from '../../../../config/protocol.js'
import { SourceUnavailableError } from '../errors.js'
import { countFromSql, type SqlDriver } from './sql.js'

interface RefusalRow {
  ref: string
  at_unix: unknown
  vault: string
  channel: string
  chat_id: string | null
  author_id: string | null
  tripped_on: string
  classes_json: string
  rule_ids_json: string
  question_fingerprint: string
  excerpt: string
  language: string
}

const TRIPPED_ON = ['input', 'output', 'none'] as const
const CHANNELS: readonly RefusalLogEntry['channel'][] = ['telegram', 'x_operator', 'x_client_delegated', 'site']
const LANGUAGES: readonly RefusalLogEntry['language'][] = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'tr', 'zh', 'ja', 'ko']

/** A stored value must be one the desk's own enum names; anything else is refused, not defaulted. */
function oneOf<T extends string>(values: readonly T[], raw: string, field: string): T {
  const found = values.find((value) => value === raw)
  if (found === undefined) throw new TypeError(`${field} holds unknown value ${raw}`)
  return found
}

function parseStringArray(json: string, field: string): string[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === 'string')) {
    throw new TypeError(`${field} is not a JSON array of strings`)
  }
  return parsed
}

function rowToEntry(row: RefusalRow): RefusalLogEntry {
  return {
    ref: row.ref,
    atUnix: countFromSql(row.at_unix, 'desk_refusal.at_unix'),
    vault: row.vault,
    channel: oneOf(CHANNELS, row.channel, 'desk_refusal.channel'),
    ...(row.chat_id === null ? {} : { chatId: row.chat_id }),
    ...(row.author_id === null ? {} : { authorId: row.author_id }),
    trippedOn: oneOf(TRIPPED_ON, row.tripped_on, 'desk_refusal.tripped_on'),
    classes: parseStringArray(row.classes_json, 'desk_refusal.classes_json').map((cls) =>
      oneOf(REFUSAL_CLASSES, cls, 'desk_refusal.classes_json'),
    ),
    ruleIds: parseStringArray(row.rule_ids_json, 'desk_refusal.rule_ids_json'),
    questionFingerprint: row.question_fingerprint,
    excerpt: row.excerpt,
    language: oneOf(LANGUAGES, row.language, 'desk_refusal.language'),
  }
}

export interface PgRefusalLogOptions {
  /** Entries kept in memory for `recent()` and `countSince()`. */
  capacity?: number
}

export class PgRefusalLog implements RefusalLog {
  readonly #driver: SqlDriver
  readonly #capacity: number
  #entries: RefusalLogEntry[] = []
  #pending: RefusalLogEntry[] = []

  constructor(driver: SqlDriver, options: PgRefusalLogOptions = {}) {
    this.#driver = driver
    this.#capacity = options.capacity ?? 5_000
  }

  /** Warm the memory window from the table. Returns how many rows were loaded. */
  async load(sinceUnix: number): Promise<number> {
    let rows: RefusalRow[]
    try {
      rows = await this.#driver.query<RefusalRow>(
        `SELECT ref, at_unix, vault, channel, chat_id, author_id, tripped_on, classes_json,
                rule_ids_json, question_fingerprint, excerpt, language
           FROM desk_refusal
          WHERE at_unix >= $1
          ORDER BY at_unix, ref
          LIMIT $2`,
        [sinceUnix, this.#capacity],
      )
    } catch (error) {
      throw new SourceUnavailableError('desk_refusal', String(error), error)
    }
    this.#entries = rows.map(rowToEntry)
    return this.#entries.length
  }

  record(entry: RefusalLogEntry): void {
    this.#entries.push(entry)
    if (this.#entries.length > this.#capacity) this.#entries.splice(0, this.#entries.length - this.#capacity)
    this.#pending.push(entry)
  }

  recent(limit = 100): RefusalLogEntry[] {
    return this.#entries.slice(-limit).reverse()
  }

  countSince(unix: number, authorId?: string): number {
    let count = 0
    for (const entry of this.#entries) {
      if (entry.atUnix < unix) continue
      if (authorId !== undefined && entry.authorId !== authorId) continue
      count++
    }
    return count
  }

  /** Rows recorded and not yet written. */
  get pending(): number {
    return this.#pending.length
  }

  /**
   * Write everything recorded since the last flush, in one transaction. A
   * failure leaves the batch pending - nothing is dropped - and throws, so the
   * caller can record the refusal.
   */
  async flush(): Promise<number> {
    if (this.#pending.length === 0) return 0
    const batch = this.#pending
    try {
      await this.#driver.transaction(async (tx) => {
        for (const entry of batch) {
          await tx.execute(
            `INSERT INTO desk_refusal
                 (ref, at_unix, vault, channel, chat_id, author_id, tripped_on, classes_json,
                  rule_ids_json, question_fingerprint, excerpt, language)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (ref) DO NOTHING`,
            [
              entry.ref,
              entry.atUnix,
              entry.vault,
              entry.channel,
              entry.chatId ?? null,
              entry.authorId ?? null,
              entry.trippedOn,
              JSON.stringify(entry.classes),
              JSON.stringify(entry.ruleIds),
              entry.questionFingerprint,
              entry.excerpt,
              entry.language,
            ],
          )
        }
      })
    } catch (error) {
      throw new SourceUnavailableError('desk_refusal', String(error), error)
    }
    this.#pending = this.#pending.slice(batch.length)
    return batch.length
  }

  /** Refusal counts by class since `sinceUnix`, from the table. For reports. */
  async histogram(sinceUnix: number): Promise<Record<string, number>> {
    let rows: Array<{ classes_json: string }>
    try {
      rows = await this.#driver.query<{ classes_json: string }>(
        'SELECT classes_json FROM desk_refusal WHERE at_unix >= $1',
        [sinceUnix],
      )
    } catch (error) {
      throw new SourceUnavailableError('desk_refusal', String(error), error)
    }
    const out: Record<string, number> = {}
    for (const row of rows) {
      for (const cls of parseStringArray(row.classes_json, 'desk_refusal.classes_json')) {
        out[cls] = (out[cls] ?? 0) + 1
      }
    }
    return out
  }
}

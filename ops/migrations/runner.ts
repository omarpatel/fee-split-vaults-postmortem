/**
 * Forward-only migration runner.
 *
 * FOUR REFUSALS, ALL FAIL-CLOSED. A migration runner that "tries its best" is
 * how a production schema quietly diverges from the repository.
 *
 *   CHECKSUM CHANGED. An already-applied file whose content differs from what
 *   was applied. Somebody edited history; the databases in the fleet are no
 *   longer describable by this repository. Refuse.
 *   APPLIED FILE MISSING. A version recorded in the database with no file.
 *   Refuse: we cannot say what that database contains.
 *   OUT-OF-ORDER INSERT. A pending migration numbered below the highest applied
 *   one. It would apply in a different order on a fresh database than it did on
 *   production, which is the definition of an unreproducible schema. Refuse.
 *   DUPLICATE VERSION. Two files claiming the same number. Refuse.
 *
 * Each migration runs in ONE transaction together with the insert into
 * ops_migration, so a half-applied migration cannot be recorded as done. That
 * relies on transactional DDL, which Postgres has; a database without it needs a
 * different strategy and this runner would be the wrong tool.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../lib/logging.js'
import { NULL_LOGGER } from '../lib/logging.js'
import type { SqlDriver } from './driver.js'

export const MIGRATION_TABLE = 'ops_migration'

export const CREATE_MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
    version         INTEGER PRIMARY KEY,
    name            TEXT    NOT NULL,
    checksum        TEXT    NOT NULL,
    applied_at_unix BIGINT  NOT NULL
)`

export interface MigrationFile {
  version: number
  name: string
  fileName: string
  sql: string
  checksum: string
}

export interface AppliedMigration {
  version: number
  name: string
  checksum: string
  applied_at_unix: number
}

export class MigrationError extends Error {
  constructor(
    readonly code:
      | 'checksum_mismatch'
      | 'applied_file_missing'
      | 'out_of_order'
      | 'duplicate_version'
      | 'bad_file_name'
      | 'lock_unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'MigrationError'
  }
}

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/

export function checksumOf(sql: string): string {
  // Line endings are normalized so a Windows checkout does not look like a
  // rewritten migration to a Linux deployment.
  return `sha256:${createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex')}`
}

export function loadMigrations(directory: string): MigrationFile[] {
  const entries = readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()
  const files: MigrationFile[] = []
  const seen = new Map<number, string>()

  for (const fileName of entries) {
    const match = FILE_NAME.exec(fileName)
    if (!match || match[1] === undefined || match[2] === undefined) {
      throw new MigrationError('bad_file_name', `migration "${fileName}" must be NNNN_snake_name.sql`)
    }
    const version = Number(match[1])
    const previous = seen.get(version)
    if (previous !== undefined) {
      throw new MigrationError('duplicate_version', `version ${version} claimed by both ${previous} and ${fileName}`)
    }
    seen.set(version, fileName)
    const sql = readFileSync(join(directory, fileName), 'utf8')
    files.push({ version, name: match[2], fileName, sql, checksum: checksumOf(sql) })
  }

  return files.sort((a, b) => a.version - b.version)
}

/**
 * Serializes concurrent `migrate` invocations. Two deployments rolling at once
 * would otherwise both see the same pending list and both apply it.
 */
export interface MigrationLock {
  acquire(): Promise<boolean>
  release(): Promise<void>
}

/** Postgres advisory lock. Session-scoped, released explicitly or on disconnect. */
export class PgAdvisoryLock implements MigrationLock {
  /** Arbitrary but fixed. Any other process using this id must be this runner. */
  static readonly KEY = 5_140_663

  constructor(private readonly driver: SqlDriver) {}

  async acquire(): Promise<boolean> {
    const rows = await this.driver.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      PgAdvisoryLock.KEY,
    ])
    return rows[0]?.locked === true
  }

  async release(): Promise<void> {
    await this.driver.query('SELECT pg_advisory_unlock($1)', [PgAdvisoryLock.KEY])
  }
}

export class NoOpLock implements MigrationLock {
  async acquire(): Promise<boolean> {
    return true
  }
  async release(): Promise<void> {}
}

export interface MigrateOptions {
  driver: SqlDriver
  directory: string
  nowUnix: () => number
  log?: Logger
  lock?: MigrationLock
  /** Plan only. Reports what would run and changes nothing. */
  dryRun?: boolean
}

export interface MigrateResult {
  applied: MigrationFile[]
  alreadyApplied: number
  pending: MigrationFile[]
  dryRun: boolean
}

export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? NULL_LOGGER
  const lock = options.lock ?? new NoOpLock()

  if (!(await lock.acquire())) {
    throw new MigrationError('lock_unavailable', 'another migration run holds the lock; refusing to proceed')
  }

  try {
    await options.driver.execute(CREATE_MIGRATION_TABLE)
    const files = loadMigrations(options.directory)
    const applied = await options.driver.query<AppliedMigration>(
      `SELECT version, name, checksum, applied_at_unix FROM ${MIGRATION_TABLE} ORDER BY version`,
    )

    const pending = plan(files, applied)
    log.info('migrate.plan', {
      files: files.length,
      applied: applied.length,
      pending: pending.length,
      dry_run: options.dryRun === true,
    })

    if (options.dryRun === true) {
      return { applied: [], alreadyApplied: applied.length, pending, dryRun: true }
    }

    const done: MigrationFile[] = []
    for (const file of pending) {
      await options.driver.transaction(async (tx) => {
        await tx.execute(file.sql)
        await tx.execute(
          `INSERT INTO ${MIGRATION_TABLE} (version, name, checksum, applied_at_unix) VALUES ($1, $2, $3, $4)`,
          [file.version, file.name, file.checksum, options.nowUnix()],
        )
      })
      done.push(file)
      log.info('migrate.applied', { version: file.version, name: file.name, checksum: file.checksum })
    }

    return { applied: done, alreadyApplied: applied.length, pending, dryRun: false }
  } finally {
    await lock.release()
  }
}

/**
 * Decide what runs, and refuse if the recorded history and the files disagree.
 * Pure, so every refusal is directly testable.
 */
export function plan(files: readonly MigrationFile[], applied: readonly AppliedMigration[]): MigrationFile[] {
  const byVersion = new Map(files.map((f) => [f.version, f]))

  for (const record of applied) {
    const file = byVersion.get(record.version)
    if (!file) {
      throw new MigrationError(
        'applied_file_missing',
        `migration ${record.version} (${record.name}) is recorded as applied but its file is gone; ` +
          'this database can no longer be described by this repository',
      )
    }
    if (file.checksum !== record.checksum) {
      throw new MigrationError(
        'checksum_mismatch',
        `migration ${record.version} (${file.fileName}) changed after it was applied: ` +
          `recorded ${record.checksum}, on disk ${file.checksum}. Add a NEW migration instead of editing this one.`,
      )
    }
  }

  const appliedVersions = new Set(applied.map((a) => a.version))
  const highestApplied = applied.reduce((max, a) => Math.max(max, a.version), 0)
  const pending = files.filter((f) => !appliedVersions.has(f.version))

  for (const file of pending) {
    if (file.version < highestApplied) {
      throw new MigrationError(
        'out_of_order',
        `migration ${file.fileName} is numbered below the highest applied version (${highestApplied}); ` +
          'renumber it above the head so a fresh database applies the same order production did',
      )
    }
  }

  return pending
}

export function formatPlan(result: MigrateResult): string {
  const out: string[] = []
  out.push(
    result.dryRun
      ? `migrate (dry run): ${result.alreadyApplied} already applied, ${result.pending.length} pending`
      : `migrate: ${result.alreadyApplied} already applied, ${result.applied.length} applied now`,
  )
  for (const file of result.dryRun ? result.pending : result.applied) {
    out.push(`  ${String(file.version).padStart(4, '0')}  ${file.name}  ${file.checksum.slice(0, 23)}`)
  }
  if ((result.dryRun ? result.pending : result.applied).length === 0) out.push('  (nothing to do)')
  return out.join('\n')
}

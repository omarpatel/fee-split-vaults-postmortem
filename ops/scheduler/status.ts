/**
 * The operator CLI the runbooks call.
 *
 * It reads and writes the operations tables directly, because during an incident
 * the application may be exactly what is broken. Every mutating command is
 * narrow, names an actor, and leaves an audit row.
 *
 *   npm run status -- --help          (from the repo root; needs no database)
 *
 * The command list below is generated from STATUS_COMMANDS, so `--help` and the
 * dispatch switch cannot disagree. Kept here as well because this header is
 * where a reader of the source looks first.
 *
 *   node ops/scheduler/status.js jobs
 *   node ops/scheduler/status.js dead-letters [--job <id>] [--all]
 *   node ops/scheduler/status.js resolve-dead-letter --id <id> --by <who> --resolution replayed
 *   node ops/scheduler/status.js retry --run-key <key> --by <who> [--i-understand]
 *   node ops/scheduler/status.js locks
 *   node ops/scheduler/status.js unlock --key <lock-key> --by <who> --i-understand
 *   node ops/scheduler/status.js assets
 *   node ops/scheduler/status.js asset --address <0x...>
 *   node ops/scheduler/status.js disable-asset --address <0x...> --reason <text> --by <who>
 *   node ops/scheduler/status.js enable-asset  --address <0x...> --by <who>
 *   node ops/scheduler/status.js freezes
 *   node ops/scheduler/status.js unfreeze --id <id> --by <who>
 *   node ops/scheduler/status.js unmatched-sweeps
 *
 * TWO COMMANDS CAN COST MONEY and both demand --i-understand:
 *   `unlock`  releases a lease someone may still be holding, so two workers can
 *             run the same scope. The idempotency record still protects a
 *             completed period; an in-flight one is not protected.
 *   `retry`   reopens a run record. For a job that moves money, reopening a
 *             record whose work already happened is how a claim happens twice.
 *             It is refused for money-moving jobs unless you insist.
 */

import { connectPg, connectionStringFrom } from '../lib/pg.js'
import { PgDriver, type SqlDriver } from '../migrations/driver.js'
import { SystemClock } from '../lib/time.js'
import { MONEY_MOVING_JOB_IDS } from './registry.js'

/**
 * The command table, as data.
 *
 * It was prose in the header comment above, which meant `--help` did not exist
 * at all: the only way to learn the commands was to open the source. Running
 * `npm run status` printed one line about a missing DATABASE_URL and nothing
 * else, which reads as a broken tool rather than as an unconfigured one. Help
 * is now generated from this list, so the list and the switch cannot drift.
 */
export interface StatusCommand {
  name: string
  args: string
  summary: string
  /** True for commands that can cost money if used carelessly. */
  dangerous?: boolean
}

export const STATUS_COMMANDS: readonly StatusCommand[] = [
  { name: 'jobs', args: '', summary: 'Runs that are not completed, plus anything completed in the last 24h.' },
  { name: 'dead-letters', args: '[--job <id>] [--all]', summary: 'Unresolved dead letters, newest first.' },
  {
    name: 'resolve-dead-letter',
    args: '--id <id> --by <who> --resolution replayed|discarded|fixed_out_of_band',
    summary: 'Close one dead letter and record who closed it and how.',
  },
  {
    name: 'retry',
    args: '--run-key <key> --by <who> [--i-understand]',
    summary: 'Reopen a non-completed run record. Refused for money-moving jobs without --i-understand.',
    dangerous: true,
  },
  { name: 'locks', args: '', summary: 'Every held lease and whether it has expired.' },
  {
    name: 'unlock',
    args: '--key <lock-key> --by <who> --i-understand',
    summary: 'Release a lease. Lets a second worker run the same scope.',
    dangerous: true,
  },
  { name: 'assets', args: '', summary: 'Quote assets and whether each is enabled.' },
  { name: 'asset', args: '--address <0x...>', summary: 'One asset, plus escrow balances still credited in it.' },
  {
    name: 'disable-asset',
    args: '--address <0x...> --reason <text> --by <who>',
    summary: 'Stop using a quote asset. Leaves an audit row.',
  },
  { name: 'enable-asset', args: '--address <0x...> --by <who>', summary: 'Re-enable a quote asset.' },
  { name: 'freezes', args: '', summary: 'Open ledger freezes.' },
  { name: 'unfreeze', args: '--id <id> --by <who>', summary: 'Clear one freeze.' },
  { name: 'unmatched-sweeps', args: '', summary: 'Escrow sweeps with no three-way match yet.' },
]

/**
 * Why a connection string is needed, and the two ways to get one.
 *
 * Named separately because "DATABASE_URL is required" on its own tells an
 * operator nothing about where a database is supposed to come from, and this
 * CLI is what the runbooks reach for during an incident.
 */
export const STATUS_NO_DATABASE_HELP = [
  'status: --database-url or DATABASE_URL is required.',
  '',
  'This CLI reads and writes the operations tables directly, because during an incident the',
  'application may be exactly what is broken. It has no in-memory mode: there would be nothing',
  'in it to look at.',
  '',
  'For a local database (docker-compose.yml at the repo root defines it):',
  '  docker compose up -d db',
  '  export DATABASE_URL=postgres://venue:local-development-placeholder@127.0.0.1:5432/fee_split_vaults',
  '  npm run migrate -w @fee-split-vaults/ops -- --database-url "$DATABASE_URL"',
  '  npm install pg    # loaded at the point of use, not a build-time dependency of ops',
  '',
  'To see the commands without a database:  npm run status -- --help',
  '',
  'The scheduler itself needs no database to be exercised:  npm run scheduler:local -w @fee-split-vaults/ops',
].join('\n')

export function renderStatusHelp(): string {
  const width = Math.max(...STATUS_COMMANDS.map((c) => c.name.length))
  const lines: string[] = [
    'status - read and repair the operations tables.',
    '',
    'USAGE',
    '  npm run status -- <command> [flags]          (from the repo root)',
    '  node ops/scheduler/status.js <command> [flags]',
    '',
    'Every command needs a database: --database-url <url>, or DATABASE_URL in the environment.',
    '',
    'COMMANDS',
  ]
  for (const command of STATUS_COMMANDS) {
    lines.push(`  ${command.name.padEnd(width)}  ${command.summary}`)
    if (command.args.length > 0) lines.push(`  ${' '.repeat(width)}  ${command.args}`)
  }
  lines.push('')
  lines.push('TWO COMMANDS CAN COST MONEY, and both demand --i-understand:')
  lines.push('  unlock  releases a lease someone may still hold, so two workers can run the same scope.')
  lines.push('          A completed period is still protected by its idempotency record; an in-flight')
  lines.push('          one is not.')
  lines.push('  retry   reopens a run record. For a job that moves money, reopening a record whose work')
  lines.push('          already happened is how a claim happens twice.')
  lines.push('')
  lines.push('With no command, `jobs` runs.')
  return lines.join('\n')
}

export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h') || argv[0] === 'help'
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

function required(argv: readonly string[], name: string): string {
  const value = flag(argv, name)
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}

function table(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return '(no rows)'
  const first = rows[0]
  if (first === undefined) return '(no rows)'
  const columns = Object.keys(first)
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column] ?? '').length)),
  )
  const line = (cells: readonly string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? cell.length)).join('  ')
  return [line(columns), line(widths.map((w) => '-'.repeat(w))), ...rows.map((row) => line(columns.map((c) => String(row[c] ?? ''))))].join('\n')
}

export async function runStatus(argv: readonly string[], driver: SqlDriver, nowUnix: number): Promise<number> {
  const command = argv[0] ?? 'jobs'
  const out = (text: string): void => {
    process.stdout.write(`${text}\n`)
  }

  // Also handled in main() before the connection is opened; repeated here so a
  // caller that already has a driver still gets help rather than a SQL error.
  if (wantsHelp(argv)) {
    out(renderStatusHelp())
    return 0
  }

  switch (command) {
    case 'jobs': {
      const rows = await driver.query(
        `SELECT job_id, scope, state, attempt, period, completed_at_unix, updated_at_unix, code
           FROM ops_job_run
          WHERE state <> 'completed'
             OR completed_at_unix > $1
          ORDER BY job_id, scope
          LIMIT 200`,
        [nowUnix - 86_400],
      )
      out(table(rows as Record<string, unknown>[]))
      return 0
    }

    case 'dead-letters': {
      const job = flag(argv, 'job')
      const all = argv.includes('--all')
      const rows = await driver.query(
        `SELECT id, job_id, scope, period, attempts, error_code, last_failed_at_unix, resolution
           FROM ops_dead_letter
          WHERE ($1::text IS NULL OR job_id = $1)
            AND ($2 OR resolved_at_unix IS NULL)
          ORDER BY last_failed_at_unix DESC
          LIMIT 200`,
        [job ?? null, all],
      )
      out(table(rows as Record<string, unknown>[]))
      return 0
    }

    case 'resolve-dead-letter': {
      const id = required(argv, 'id')
      const by = required(argv, 'by')
      const resolution = required(argv, 'resolution')
      if (!['replayed', 'discarded', 'fixed_out_of_band'].includes(resolution)) {
        throw new Error('--resolution must be replayed, discarded or fixed_out_of_band')
      }
      const result = await driver.execute(
        `UPDATE ops_dead_letter
            SET resolved_at_unix = $1, resolved_by = $2, resolution = $3
          WHERE id = $4 AND resolved_at_unix IS NULL`,
        [nowUnix, by, resolution, id],
      )
      out(result.rowsAffected === 1 ? `resolved ${id}` : `no open dead letter ${id}`)
      return result.rowsAffected === 1 ? 0 : 1
    }

    case 'retry': {
      const runKey = required(argv, 'run-key')
      const by = required(argv, 'by')
      const rows = await driver.query<{ job_id: string; state: string }>(
        'SELECT job_id, state FROM ops_job_run WHERE run_key = $1',
        [runKey],
      )
      const record = rows[0]
      if (!record) {
        out(`no run record for ${runKey}`)
        return 1
      }
      if (record.state === 'completed') {
        // Reopening a completed run is how work happens twice. Never.
        out(`refusing: ${runKey} is completed. Completed runs are never reopened; schedule new work instead.`)
        return 1
      }
      if (MONEY_MOVING_JOB_IDS.includes(record.job_id) && !argv.includes('--i-understand')) {
        out(
          `refusing: ${record.job_id} moves money. Its work may already have happened on chain. ` +
            'Check the executor outbox and the three-way match first, then pass --i-understand.',
        )
        return 1
      }
      const result = await driver.execute(
        `UPDATE ops_job_run
            SET state = 'retry', attempt = 0, code = $1, updated_at_unix = $2, lease_expires_at_unix = NULL
          WHERE run_key = $3 AND state <> 'completed'`,
        [`reopened_by:${by}`, nowUnix, runKey],
      )
      out(result.rowsAffected === 1 ? `reopened ${runKey}` : `no change for ${runKey}`)
      return result.rowsAffected === 1 ? 0 : 1
    }

    case 'locks': {
      const rows = await driver.query(
        `SELECT lock_key, owner, acquired_at_unix, expires_at_unix, (expires_at_unix <= $1) AS expired
           FROM ops_job_lock ORDER BY expires_at_unix`,
        [nowUnix],
      )
      out(table(rows as Record<string, unknown>[]))
      return 0
    }

    case 'unlock': {
      const key = required(argv, 'key')
      const by = required(argv, 'by')
      if (!argv.includes('--i-understand')) {
        out('refusing: releasing a live lease lets a second worker run the same scope. Pass --i-understand.')
        return 1
      }
      const result = await driver.execute('DELETE FROM ops_job_lock WHERE lock_key = $1', [key])
      out(`${result.rowsAffected === 1 ? 'released' : 'no such lock'} ${key} (by ${by})`)
      return result.rowsAffected === 1 ? 0 : 1
    }

    case 'assets': {
      const rows = await driver.query(
        `SELECT address, symbol, decimals, enabled, is_pausable_proxy, max_transfer_minor, disabled_reason
           FROM quote_asset ORDER BY symbol`,
      )
      out(table(rows as Record<string, unknown>[]))
      return 0
    }

    case 'asset': {
      const address = required(argv, 'address')
      const asset = await driver.query('SELECT * FROM quote_asset WHERE address = $1', [address])
      out(table(asset as Record<string, unknown>[]))
      out('')
      out('Escrow balances still credited in this asset:')
      const balances = await driver.query(
        `SELECT vault, balance_minor
           FROM ledger_balance
          WHERE asset = $1 AND account = 'asset:escrow' AND balance_minor <> '0'
          ORDER BY length(balance_minor) DESC, balance_minor DESC
          LIMIT 50`,
        [address],
      )
      out(table(balances as Record<string, unknown>[]))
      return 0
    }

    case 'disable-asset': {
      const address = required(argv, 'address')
      const reason = required(argv, 'reason')
      const by = required(argv, 'by')
      const result = await driver.execute(
        `UPDATE quote_asset
            SET enabled = FALSE, disabled_reason = $1, disabled_at_unix = $2, updated_at_unix = $2
          WHERE address = $3`,
        [`${reason} (by ${by})`, nowUnix, address],
      )
      out(result.rowsAffected === 1 ? `disabled ${address}` : `no such asset ${address}`)
      return result.rowsAffected === 1 ? 0 : 1
    }

    case 'enable-asset': {
      const address = required(argv, 'address')
      const by = required(argv, 'by')
      const result = await driver.execute(
        `UPDATE quote_asset
            SET enabled = TRUE, disabled_reason = $1, updated_at_unix = $2
          WHERE address = $3`,
        [`re-enabled by ${by}`, nowUnix, address],
      )
      out(result.rowsAffected === 1 ? `enabled ${address}` : `no such asset ${address}`)
      return result.rowsAffected === 1 ? 0 : 1
    }

    case 'freezes': {
      const rows = await driver.query(
        `SELECT id, scope_kind, scope_vault, scope_asset, reason, frozen_at_unix, variance_id
           FROM ledger_freeze WHERE cleared_at_unix IS NULL ORDER BY frozen_at_unix`,
      )
      out(table(rows as Record<string, unknown>[]))
      return 0
    }

    case 'unfreeze': {
      const id = required(argv, 'id')
      const by = required(argv, 'by')
      const result = await driver.execute(
        'UPDATE ledger_freeze SET cleared_at_unix = $1, cleared_by = $2 WHERE id = $3 AND cleared_at_unix IS NULL',
        [nowUnix, by, id],
      )
      out(result.rowsAffected === 1 ? `cleared freeze ${id}` : `no open freeze ${id}`)
      return result.rowsAffected === 1 ? 0 : 1
    }

    case 'unmatched-sweeps': {
      const rows = await driver.query(
        `SELECT sweep_id, vault, asset, claimed_minor, completed_at_unix
           FROM escrow_sweep WHERE matched_at_unix IS NULL ORDER BY completed_at_unix LIMIT 100`,
      )
      out(table(rows as Record<string, unknown>[]))
      return 0
    }

    default:
      process.stderr.write(
        `unknown command "${command}". Known commands: ${STATUS_COMMANDS.map((c) => c.name).join(', ')}.\n` +
          'Run with --help for the full list.\n',
      )
      return 2
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  // Help must work with no database. It did not before, which is why running
  // this CLI unconfigured looked like it did nothing at all.
  if (wantsHelp(argv)) {
    process.stdout.write(`${renderStatusHelp()}\n`)
    return 0
  }
  const connectionString = connectionStringFrom(argv)
  if (!connectionString) {
    process.stderr.write(`${STATUS_NO_DATABASE_HELP}\n`)
    return 2
  }
  const { client, close } = await connectPg(connectionString)
  try {
    return await runStatus(argv, new PgDriver(client), new SystemClock().nowUnix())
  } finally {
    await close()
  }
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('status.js')

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`status: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 2
    })
}

/**
 * In-memory SqlDriver for tests.
 *
 * It DISPATCHES ON STATEMENT IDENTITY, not by parsing SQL: every statement the
 * store issues is an exported constant in sql.ts, so the fake can key a handler
 * off the exact string. That keeps this file a test double rather than a
 * half-built database engine, and it means an unrecognised statement is a loud
 * failure - a new query added to the store without a handler here cannot pass
 * silently.
 *
 * Transactions snapshot every table and restore on rejection, so the atomicity
 * the store depends on is really exercised rather than assumed.
 */

import { SQL, type SqlDriver, type SqlValue } from './sql.js'

type Row = Record<string, SqlValue>

interface Tables {
  ledger_entry: Map<string, Row>
  ledger_observation: Map<string, Row>
  ledger_recognition: Map<string, Row>
  ledger_balance: Map<string, Row>
  ledger_flow: Map<string, Row>
  ledger_variance: Map<string, Row>
  ledger_freeze: Map<string, Row>
  ledger_sequence: Map<string, Row>
}

function emptyTables(): Tables {
  return {
    ledger_entry: new Map(),
    ledger_observation: new Map(),
    ledger_recognition: new Map(),
    ledger_balance: new Map(),
    ledger_flow: new Map(),
    ledger_variance: new Map(),
    ledger_freeze: new Map(),
    ledger_sequence: new Map(),
  }
}

function snapshot(tables: Tables): Tables {
  const copy = emptyTables()
  for (const name of Object.keys(tables) as Array<keyof Tables>) {
    for (const [key, row] of tables[name]) copy[name].set(key, { ...row })
  }
  return copy
}

function key(...parts: Array<SqlValue | undefined>): string {
  return parts.map((p) => String(p)).join('\u001f')
}

export class UnhandledStatementError extends Error {
  constructor(readonly sql: string) {
    super(`fake driver has no handler for statement: ${sql}`)
    this.name = 'UnhandledStatementError'
  }
}

export class InMemorySqlDriver implements SqlDriver {
  private tables: Tables = emptyTables()
  /** Every statement executed, in order. Assertions read this. */
  readonly log: Array<{ sql: string; params: readonly SqlValue[] }> = []

  async query<R extends Record<string, SqlValue>>(
    sql: string,
    params: readonly SqlValue[],
  ): Promise<R[]> {
    this.log.push({ sql, params })
    const t = this.tables

    switch (sql) {
      case SQL.selectEntryById:
        return rowsOf<R>(t.ledger_entry.get(key(params[0] ?? null)))

      case SQL.selectEntriesPage: {
        const after = Number(params[0])
        const limit = Number(params[1])
        return [...t.ledger_entry.values()]
          .filter((r) => Number(r.seq) > after)
          .sort((a, b) => Number(a.seq) - Number(b.seq))
          .slice(0, limit) as R[]
      }

      case SQL.selectMaxSeq: {
        let max: number | null = null
        for (const row of t.ledger_entry.values()) {
          const seq = Number(row.seq)
          if (max === null || seq > max) max = seq
        }
        return [{ max_seq: max }] as unknown as R[]
      }

      case SQL.selectSequence:
        return rowsOf<R>(t.ledger_sequence.get(key(params[0] ?? null)))

      case SQL.selectObservation:
        return rowsOf<R>(t.ledger_observation.get(key(params[0] ?? null)))

      case SQL.selectRecognition:
        return rowsOf<R>(
          t.ledger_recognition.get(key(params[0] ?? null, params[1] ?? null, params[2] ?? null)),
        )

      case SQL.selectRecognitions:
        return [...t.ledger_recognition.values()] as R[]

      case SQL.selectBalance:
        return rowsOf<R>(
          t.ledger_balance.get(key(params[0] ?? null, params[1] ?? null, params[2] ?? null)),
        )

      case SQL.selectBalances:
        return [...t.ledger_balance.values()] as R[]

      case SQL.selectFlow:
        return rowsOf<R>(
          t.ledger_flow.get(key(params[0] ?? null, params[1] ?? null, params[2] ?? null)),
        )

      case SQL.selectFlows:
        return [...t.ledger_flow.values()] as R[]

      case SQL.selectVariances:
        return [...t.ledger_variance.values()] as R[]

      case SQL.selectFreezes:
        return [...t.ledger_freeze.values()] as R[]

      case SQL.selectFreezeById:
        return rowsOf<R>(t.ledger_freeze.get(key(params[0] ?? null)))

      default:
        throw new UnhandledStatementError(sql)
    }
  }

  async execute(sql: string, params: readonly SqlValue[]): Promise<{ rowsAffected: number }> {
    this.log.push({ sql, params })
    const t = this.tables
    const p = (i: number): SqlValue => params[i] ?? null

    switch (sql) {
      case SQL.insertEntry: {
        const row: Row = {
          id: p(0),
          seq: p(1),
          vault: p(2),
          asset: p(3),
          debit_account: p(4),
          credit_account: p(5),
          amount_minor: p(6),
          occurred_at_unix: p(7),
          block_hash: p(8),
          tx_hash: p(9),
          log_index: p(10),
          source: p(11),
          memo: p(12),
        }
        assertAmountConstraint(row.amount_minor)
        if (t.ledger_entry.has(key(row.id))) {
          throw new Error('ledger_entry primary key violation')
        }
        t.ledger_entry.set(key(row.id), row)
        return { rowsAffected: 1 }
      }

      case SQL.insertSequence:
        t.ledger_sequence.set(key(p(0)), { name: p(0), next_value: p(1) })
        return { rowsAffected: 1 }

      case SQL.updateSequence: {
        const row = t.ledger_sequence.get(key(p(1)))
        if (row === undefined) return { rowsAffected: 0 }
        row.next_value = p(0)
        return { rowsAffected: 1 }
      }

      case SQL.insertObservation: {
        const row: Row = {
          id: p(0),
          vault: p(1),
          asset: p(2),
          accrual_key: p(3),
          source: p(4),
          amount_minor: p(5),
          occurred_at_unix: p(6),
          block_hash: p(7),
          tx_hash: p(8),
          log_index: p(9),
          outcome: p(10),
          entry_ids: p(11),
        }
        if (t.ledger_observation.has(key(row.id))) {
          throw new Error('ledger_observation primary key violation')
        }
        t.ledger_observation.set(key(row.id), row)
        return { rowsAffected: 1 }
      }

      case SQL.insertRecognition: {
        const row: Row = {
          vault: p(0),
          asset: p(1),
          accrual_key: p(2),
          per_source_json: p(3),
          recognized_source: p(4),
          recognized_minor: p(5),
          first_recognized_at_unix: p(6),
          last_observed_at_unix: p(7),
          supersessions: p(8),
        }
        const k = key(row.vault, row.asset, row.accrual_key)
        if (t.ledger_recognition.has(k)) {
          throw new Error('ledger_recognition primary key violation')
        }
        t.ledger_recognition.set(k, row)
        return { rowsAffected: 1 }
      }

      case SQL.updateRecognition: {
        const row = t.ledger_recognition.get(key(p(5), p(6), p(7)))
        if (row === undefined) return { rowsAffected: 0 }
        row.per_source_json = p(0)
        row.recognized_source = p(1)
        row.recognized_minor = p(2)
        row.last_observed_at_unix = p(3)
        row.supersessions = p(4)
        return { rowsAffected: 1 }
      }

      case SQL.insertBalance: {
        const row: Row = {
          vault: p(0),
          asset: p(1),
          account: p(2),
          debits_minor: p(3),
          credits_minor: p(4),
          balance_minor: p(5),
          entry_count: p(6),
        }
        t.ledger_balance.set(key(row.vault, row.asset, row.account), row)
        return { rowsAffected: 1 }
      }

      case SQL.updateBalance: {
        const row = t.ledger_balance.get(key(p(4), p(5), p(6)))
        if (row === undefined) return { rowsAffected: 0 }
        row.debits_minor = p(0)
        row.credits_minor = p(1)
        row.balance_minor = p(2)
        row.entry_count = p(3)
        return { rowsAffected: 1 }
      }

      case SQL.insertFlow: {
        const row: Row = {
          vault: p(0),
          asset: p(1),
          posting_kind: p(2),
          amount_minor: p(3),
          entry_count: p(4),
        }
        t.ledger_flow.set(key(row.vault, row.asset, row.posting_kind), row)
        return { rowsAffected: 1 }
      }

      case SQL.updateFlow: {
        const row = t.ledger_flow.get(key(p(2), p(3), p(4)))
        if (row === undefined) return { rowsAffected: 0 }
        row.amount_minor = p(0)
        row.entry_count = p(1)
        return { rowsAffected: 1 }
      }

      case SQL.insertVariance: {
        const row: Row = {
          id: p(0),
          vault: p(1),
          asset: p(2),
          ledger_balance_minor: p(3),
          chain_balance_minor: p(4),
          delta_minor: p(5),
          severity: p(6),
          detected_at_unix: p(7),
          block_hash: p(8),
          note: p(9),
        }
        t.ledger_variance.set(key(row.id), row)
        return { rowsAffected: 1 }
      }

      case SQL.deleteVariance:
        return { rowsAffected: t.ledger_variance.delete(key(p(0))) ? 1 : 0 }

      case SQL.insertFreeze: {
        const row: Row = {
          id: p(0),
          scope_kind: p(1),
          scope_vault: p(2),
          scope_asset: p(3),
          reason: p(4),
          variance_id: p(5),
          frozen_at_unix: p(6),
          cleared_at_unix: p(7),
          cleared_by: p(8),
        }
        t.ledger_freeze.set(key(row.id), row)
        return { rowsAffected: 1 }
      }

      case SQL.updateFreezeCleared: {
        const row = t.ledger_freeze.get(key(p(2)))
        if (row === undefined) return { rowsAffected: 0 }
        row.cleared_at_unix = p(0)
        row.cleared_by = p(1)
        return { rowsAffected: 1 }
      }

      default:
        throw new UnhandledStatementError(sql)
    }
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    // Savepoint semantics: a nested transaction rolls back to its own entry
    // point, which is what the store's putVariance-inside-a-caller case needs.
    const saved = snapshot(this.tables)
    try {
      return await fn(this)
    } catch (error) {
      this.tables = saved
      throw error
    }
  }

  /** Wipes every table. Tests reuse one driver across cases with this. */
  reset(): void {
    this.tables = emptyTables()
    this.log.length = 0
  }

  rowCount(table: keyof Tables): number {
    return this.tables[table].size
  }
}

function rowsOf<R>(row: Row | undefined): R[] {
  return row === undefined ? [] : ([{ ...row }] as unknown as R[])
}

/** Mirrors ledger_entry_amount_positive from schema.sql. */
function assertAmountConstraint(value: SqlValue | undefined): void {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-') || value === '0') {
    throw new Error('CHECK constraint ledger_entry_amount_positive failed')
  }
}

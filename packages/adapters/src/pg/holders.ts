/**
 * The holder indexer's balance ledger over Postgres, on 0016's
 * `token_holder_balance` and `token_holder_cursor`.
 *
 * `apply` is ONE transaction: the range's deltas and the cursor that says the
 * range landed either both persist or neither does, which is what makes a
 * crash mid-tick a replay rather than a skip or a double count. A delta that
 * would take a holder below zero is refused by the table's own CHECK as a
 * last line; the indexer refuses it first, with a reason.
 */

import type { Address } from '@fee-split-vaults/core'
import {
  HolderLedgerError,
  normalizeAddress,
  type HolderBalance,
  type HolderBalanceStore,
  type HolderCursor,
  type Hex,
} from '@fee-split-vaults/indexer'
import { guarded, strFromSql } from './rows.js'
import { bigIntFromSql, countFromSql, type SqlDriver } from './sql.js'

interface CursorRow {
  token: unknown
  block_number: unknown
  block_hash: unknown
  block_timestamp_unix: unknown
  updated_at_unix: unknown
}

export class PgHolderBalanceStore implements HolderBalanceStore {
  constructor(private readonly driver: SqlDriver) {}

  async cursor(token: Address): Promise<HolderCursor | undefined> {
    const rows = await guarded('token_holder_cursor', () =>
      this.driver.query<CursorRow>(
        `SELECT token, block_number, block_hash, block_timestamp_unix, updated_at_unix
           FROM token_holder_cursor WHERE token = $1`,
        [normalizeAddress(token)],
      ),
    )
    const row = rows[0]
    if (row === undefined) return undefined
    const f = 'token_holder_cursor'
    return {
      token: strFromSql(row.token, `${f}.token`),
      blockNumber: bigIntFromSql(row.block_number, `${f}.block_number`),
      blockHash: strFromSql(row.block_hash, `${f}.block_hash`) as Hex,
      blockTimestampUnix: countFromSql(row.block_timestamp_unix, `${f}.block_timestamp_unix`),
      updatedAtUnix: countFromSql(row.updated_at_unix, `${f}.updated_at_unix`),
    }
  }

  async apply(token: Address, deltas: ReadonlyMap<string, bigint>, cursor: HolderCursor): Promise<void> {
    const key = normalizeAddress(token)
    await guarded('token_holder_balance', () =>
      this.driver.transaction(async (tx) => {
        for (const [holder, delta] of deltas) {
          if (delta === 0n) continue
          const who = normalizeAddress(holder)
          if (delta > 0n) {
            // A credit upserts the sum.
            await tx.execute(
              `INSERT INTO token_holder_balance (token, holder, balance, updated_block)
               VALUES ($1, $2, $3::numeric, $4::bigint)
               ON CONFLICT (token, holder) DO UPDATE
                  SET balance = token_holder_balance.balance + EXCLUDED.balance,
                      updated_block = EXCLUDED.updated_block`,
              [key, who, delta.toString(), cursor.blockNumber.toString()],
            )
            continue
          }
          // A debit is an UPDATE, never an insert: a debit against a holder
          // with no row is a conservation failure, and the table's CHECK
          // would refuse the proposed negative row before it could be summed.
          const { rowsAffected } = await tx.execute(
            `UPDATE token_holder_balance
                SET balance = balance + $3::numeric, updated_block = $4::bigint
              WHERE token = $1 AND holder = $2`,
            [key, who, delta.toString(), cursor.blockNumber.toString()],
          )
          if (rowsAffected !== 1) {
            throw new HolderLedgerError(key, `debit of ${String(-delta)} against ${who}, which holds nothing`)
          }
        }
        // A holder that reached zero is not a holder: the table ranks holders.
        await tx.execute('DELETE FROM token_holder_balance WHERE token = $1 AND balance = 0', [key])
        await tx.execute(
          `INSERT INTO token_holder_cursor (token, block_number, block_hash, block_timestamp_unix, updated_at_unix)
           VALUES ($1, $2::bigint, $3, $4, $5)
           ON CONFLICT (token) DO UPDATE
              SET block_number = EXCLUDED.block_number,
                  block_hash = EXCLUDED.block_hash,
                  block_timestamp_unix = EXCLUDED.block_timestamp_unix,
                  updated_at_unix = EXCLUDED.updated_at_unix
            WHERE token_holder_cursor.block_number <= EXCLUDED.block_number`,
          [key, cursor.blockNumber.toString(), cursor.blockHash, cursor.blockTimestampUnix, cursor.updatedAtUnix],
        )
      }),
    )
  }

  async top(token: Address, limit: number): Promise<HolderBalance[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`top() limit ${String(limit)} is not a positive integer`)
    const rows = await guarded('token_holder_balance', () =>
      this.driver.query<{ holder: unknown; balance: unknown }>(
        `SELECT holder, balance FROM token_holder_balance
          WHERE token = $1 ORDER BY balance DESC, holder ASC LIMIT $2`,
        [normalizeAddress(token), limit],
      ),
    )
    return rows.map((row) => ({
      holder: strFromSql(row.holder, 'token_holder_balance.holder'),
      balanceMinor: bigIntFromSql(row.balance, 'token_holder_balance.balance'),
    }))
  }

  async balance(token: Address, holder: Address): Promise<bigint> {
    const rows = await guarded('token_holder_balance', () =>
      this.driver.query<{ balance: unknown }>(
        'SELECT balance FROM token_holder_balance WHERE token = $1 AND holder = $2',
        [normalizeAddress(token), normalizeAddress(holder)],
      ),
    )
    const row = rows[0]
    return row === undefined ? 0n : bigIntFromSql(row.balance, 'token_holder_balance.balance')
  }
}

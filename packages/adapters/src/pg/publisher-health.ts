/**
 * The publisher's channel health store over Postgres (0021).
 *
 * APPEND ONLY. `put` inserts one row per probe and `get` returns the newest,
 * so the onset of a suspension can be dated from history and a retried job
 * cannot overwrite the row that first saw it. account_id is lowercased on
 * both sides, the same key the binding registry uses.
 */

import type { Channel } from '@fee-split-vaults/core'
import {
  boundHealthDetail,
  type ChannelHealthRecord,
  type ChannelHealthStatus,
  type ChannelHealthStore,
} from '@fee-split-vaults/publisher'
import { enumFromSql, guarded, strFromSql } from './rows.js'
import { countFromSql, type SqlDriver } from './sql.js'

const CHANNELS: readonly Channel[] = ['telegram', 'x_operator', 'x_client_delegated', 'site']
const STATUSES: readonly ChannelHealthStatus[] = ['ok', 'suspended', 'locked', 'unauthorized', 'unreachable']
const TABLE = 'publisher_account_health'

export class PgChannelHealthStore implements ChannelHealthStore {
  constructor(private readonly driver: SqlDriver) {}

  async get(channel: Channel, accountId: string): Promise<ChannelHealthRecord | null> {
    const rows = await guarded(TABLE, () =>
      this.driver.query(
        `SELECT channel, account_id, status, observed_at_unix, detail FROM ${TABLE}
          WHERE channel = $1 AND account_id = $2
          ORDER BY observed_at_unix DESC, id DESC LIMIT 1`,
        [channel, accountId.toLowerCase()],
      ),
    )
    const row = rows[0]
    if (row === undefined) return null
    return {
      channel: enumFromSql(row.channel, CHANNELS, `${TABLE}.channel`),
      accountId: strFromSql(row.account_id, `${TABLE}.account_id`),
      status: enumFromSql(row.status, STATUSES, `${TABLE}.status`),
      observedAtUnix: countFromSql(row.observed_at_unix, `${TABLE}.observed_at_unix`),
      detail: strFromSql(row.detail, `${TABLE}.detail`),
    }
  }

  async put(record: ChannelHealthRecord): Promise<void> {
    await guarded(TABLE, () =>
      this.driver.execute(
        `INSERT INTO ${TABLE} (channel, account_id, status, observed_at_unix, detail) VALUES ($1, $2, $3, $4, $5)`,
        [record.channel, record.accountId.toLowerCase(), record.status, record.observedAtUnix, boundHealthDetail(record.detail)],
      ),
    )
  }
}

/**
 * Halt notices, persisted.
 *
 * The indexer SIGNALS a halt and the broker ENFORCES it; nothing in between
 * owns it, which is why the in-memory sink loses every open halt on a restart.
 * That is the wrong direction to lose state in: a process that comes back up
 * with an empty halt list reports "no halts" to the tick loop, and no halts
 * means spend authority is active again for a coin whose fee recipient may have
 * been taken an hour ago.
 *
 * So this is both halves of the seam. It implements the indexer's `HaltSink`
 * so a watcher can write to it, and it answers `halts(token)` for the
 * orchestrator's `ChainReadModel`. A read that fails throws: an empty array
 * here is the single most dangerous value in this package.
 *
 * DEDUPE IS BY (token, reason) WHILE OPEN. `watch_stale` re-fires on every
 * sweep interval for as long as the chain is unreachable, and one row per
 * sweep would bury the interesting halts under thousands of copies of the same
 * one. The first detection time is kept - "since when" is the operationally
 * important number - and the detail is refreshed.
 */

import type { Address } from '@fee-split-vaults/core'
import type { HaltNotice, HaltReason, HaltSink } from '@fee-split-vaults/indexer'
import { SourceUnavailableError } from '../errors.js'
import { countFromSql, type SqlDriver } from '../pg/sql.js'

export interface HaltReadModel {
  /** OPEN halts only. A cleared halt is history, not a live restriction. */
  open(token: Address): Promise<HaltNotice[]>
}

export interface HaltStore extends HaltSink, HaltReadModel {
  clear(token: Address, reason: HaltReason, atUnix: number, by: string): Promise<number>
}

export class InMemoryHaltStore implements HaltStore {
  readonly #open = new Map<string, HaltNotice>()
  /** Set to make every call throw, so the fail-closed paths can be exercised. */
  unavailable = false

  #key(token: Address, reason: HaltReason): string {
    return `${token.toLowerCase()}|${reason}`
  }

  async halt(notice: HaltNotice): Promise<void> {
    if (this.unavailable) throw new SourceUnavailableError('halt store', 'injected fault')
    const key = this.#key(notice.token, notice.reason)
    const existing = this.#open.get(key)
    this.#open.set(
      key,
      existing === undefined
        ? notice
        : { ...notice, detectedAtUnix: Math.min(existing.detectedAtUnix, notice.detectedAtUnix) },
    )
  }

  async open(token: Address): Promise<HaltNotice[]> {
    if (this.unavailable) throw new SourceUnavailableError('halt store', 'injected fault')
    return [...this.#open.values()]
      .filter((notice) => notice.token.toLowerCase() === token.toLowerCase())
      .sort((a, b) => a.detectedAtUnix - b.detectedAtUnix)
  }

  async clear(token: Address, reason: HaltReason, _atUnix: number, _by: string): Promise<number> {
    if (this.unavailable) throw new SourceUnavailableError('halt store', 'injected fault')
    return this.#open.delete(this.#key(token, reason)) ? 1 : 0
  }
}

interface HaltRow {
  vault: string
  token: string
  reason: string
  detail: string
  detected_at_unix: unknown
  block_hash: string | null
  block_number: unknown
  tx_hash: string | null
}

export class PgHaltStore implements HaltStore {
  constructor(private readonly driver: SqlDriver) {}

  async halt(notice: HaltNotice): Promise<void> {
    try {
      await this.driver.execute(
        `INSERT INTO chain_halt_notice
             (vault, token, reason, detail, detected_at_unix, block_hash, block_number, tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8)
         ON CONFLICT (token, reason) WHERE cleared_at_unix IS NULL
         DO UPDATE SET detail = EXCLUDED.detail,
                       detected_at_unix = least(chain_halt_notice.detected_at_unix, EXCLUDED.detected_at_unix)`,
        [
          notice.vault.toLowerCase(),
          notice.token.toLowerCase(),
          notice.reason,
          notice.detail.slice(0, 1_000),
          notice.detectedAtUnix,
          notice.evidence?.blockHash ?? null,
          notice.evidence?.blockNumber === undefined ? null : notice.evidence.blockNumber.toString(),
          notice.evidence?.txHash ?? null,
        ],
      )
    } catch (error) {
      throw new SourceUnavailableError('chain_halt_notice', String(error), error)
    }
  }

  async open(token: Address): Promise<HaltNotice[]> {
    let rows: HaltRow[]
    try {
      rows = await this.driver.query<HaltRow>(
        `SELECT vault, token, reason, detail, detected_at_unix, block_hash, block_number, tx_hash
           FROM chain_halt_notice
          WHERE token = $1 AND cleared_at_unix IS NULL
          ORDER BY detected_at_unix`,
        [token.toLowerCase()],
      )
    } catch (error) {
      throw new SourceUnavailableError('chain_halt_notice', String(error), error)
    }
    return rows.map((row) => {
      const evidence: NonNullable<HaltNotice['evidence']> = {}
      if (row.block_hash !== null) Object.assign(evidence, { blockHash: row.block_hash })
      if (row.block_number !== null && row.block_number !== undefined) {
        Object.assign(evidence, { blockNumber: BigInt(String(row.block_number)) })
      }
      if (row.tx_hash !== null) Object.assign(evidence, { txHash: row.tx_hash })

      const notice: HaltNotice = {
        vault: row.vault,
        token: row.token,
        reason: row.reason as HaltReason,
        detail: row.detail,
        detectedAtUnix: countFromSql(row.detected_at_unix, 'chain_halt_notice.detected_at_unix'),
      }
      return Object.keys(evidence).length === 0 ? notice : { ...notice, evidence }
    })
  }

  async clear(token: Address, reason: HaltReason, atUnix: number, by: string): Promise<number> {
    try {
      const result = await this.driver.execute(
        `UPDATE chain_halt_notice
            SET cleared_at_unix = $3, cleared_by = $4
          WHERE token = $1 AND reason = $2 AND cleared_at_unix IS NULL`,
        [token.toLowerCase(), reason, atUnix, by],
      )
      return result.rowsAffected
    } catch (error) {
      throw new SourceUnavailableError('chain_halt_notice', String(error), error)
    }
  }
}

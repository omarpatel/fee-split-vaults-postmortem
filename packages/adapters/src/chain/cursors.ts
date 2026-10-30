/**
 * Block cursors, and the coverage watermark that goes with each one.
 *
 * THE CURSOR IS NOT ONLY A BLOCK NUMBER. It also carries the TIMESTAMP of the
 * block it stopped at, and that second field is what makes fail-closed possible
 * at all. The orchestrator asks its questions in unix time - "postings between
 * these two instants" - while a scan advances in block numbers. Without a
 * timestamp beside the number there is no way to answer "does what I have
 * scanned actually reach the end of the window you asked about", and every
 * window would be answered from whatever happened to be ingested.
 *
 * WHY NOT ops_cursor. `ops_cursor` already exists and is the right table for
 * the jobs that read a stream forward in TIME: its column is `position_unix`
 * and its semantics are "this job has processed up to this instant". A block
 * number is not an instant. Storing 56,321,180 in a column called
 * `position_unix` would put a block height into a field every other reader
 * treats as a clock, and the first person to compute an age from it would get
 * an answer 1.7 billion seconds wrong. `chain_scan_cursor` in 0008_fleet.sql
 * carries both fields with their real names instead.
 */

import { CursorUnavailableError } from '../errors.js'
import { bigIntFromSql, countFromSql, type SqlDriver } from '../pg/sql.js'

/**
 * Which forward scan a cursor belongs to.
 *
 * `vault_movements` is per vault: its scope is the vault address, because each
 * vault's Claimed/Credited stream is queried against that vault's own address.
 * `fees` is fleet-wide: the indexer scans every watched coin's curve and pool
 * events in shared bounded queries, so one watermark describes them all.
 */
export type ScanStream = 'vault_movements' | 'fees'

export interface ScanCursor {
  readonly stream: ScanStream
  /** Vault address for a per-vault stream; the literal 'fleet' for a shared one. */
  readonly scope: string
  /** Highest block fully scanned. Everything at or below it has been observed. */
  readonly blockNumber: bigint
  /**
   * Timestamp of that block: the COVERAGE WATERMARK.
   *
   * Optional, and absent means "this cursor has advanced but covers nothing you
   * may rely on yet" - the state a cold backfill sits in while it grinds
   * forward. It is deliberately not 0: a zero here would be read as a 1970
   * timestamp and would fail every lag comparison in a way that looks like a
   * clock bug rather than like an honest unknown.
   */
  readonly blockTimestampUnix?: number
  readonly updatedAtUnix: number
}

export interface ChainCursorStore {
  get(stream: ScanStream, scope: string): Promise<ScanCursor | undefined>
  /**
   * Advance a cursor. MONOTONIC: a write that would move a cursor backwards is
   * refused rather than applied, because the only thing that legitimately
   * rewinds a scan is a reorg, and a reorg is handled by the indexer's tracker
   * rolling postings back - not by a scanner quietly re-reading old blocks and
   * reporting the range as freshly covered.
   */
  put(cursor: ScanCursor): Promise<void>
  /**
   * Explicit rewind, for a reorg. Loud on purpose.
   *
   * IT CLEARS THE COVERAGE WATERMARK RATHER THAN LOWERING IT. The honest new
   * watermark would be the timestamp of `toBlock`, and this signature does not
   * carry it - a rewind is driven by a reorg notice, not by a block fetch. The
   * only two things that could be written instead are both wrong: keeping the
   * old watermark claims coverage over the range about to be re-scanned, and
   * `atUnix` is the moment the rewind happened, which on a live chain is LATER
   * than the coverage being dropped and so lowers nothing at all.
   *
   * So it writes the one value that is true: unknown. Reads refuse with
   * `CoverageGapError` until a sync re-scans up to the finalized head and
   * re-establishes a watermark it can actually vouch for. That is an outage in
   * the reads for as long as the backfill takes, and a reorg under a
   * money-movement scan IS an outage of certainty - the movement rows for the
   * rewound range are still in the store and may describe transfers the chain
   * no longer contains.
   */
  rewind(stream: ScanStream, scope: string, toBlock: bigint, atUnix: number): Promise<void>
}

export class CursorRegressionError extends CursorUnavailableError {
  constructor(stream: ScanStream, scope: string, from: bigint, to: bigint) {
    super(
      `${stream}/${scope}`,
      `refusing to move a cursor backwards from ${from} to ${to}; use rewind() if this is a reorg`,
    )
  }
}

export class InMemoryChainCursorStore implements ChainCursorStore {
  readonly #byKey = new Map<string, ScanCursor>()
  /** Set to make every call throw, so the fail-closed paths can be exercised. */
  unavailable = false

  #key(stream: ScanStream, scope: string): string {
    return `${stream}|${scope.toLowerCase()}`
  }

  async get(stream: ScanStream, scope: string): Promise<ScanCursor | undefined> {
    if (this.unavailable) throw new CursorUnavailableError(`${stream}/${scope}`, 'injected fault')
    return this.#byKey.get(this.#key(stream, scope))
  }

  async put(cursor: ScanCursor): Promise<void> {
    if (this.unavailable) {
      throw new CursorUnavailableError(`${cursor.stream}/${cursor.scope}`, 'injected fault')
    }
    const key = this.#key(cursor.stream, cursor.scope)
    const existing = this.#byKey.get(key)
    if (existing !== undefined && cursor.blockNumber < existing.blockNumber) {
      throw new CursorRegressionError(cursor.stream, cursor.scope, existing.blockNumber, cursor.blockNumber)
    }
    this.#byKey.set(key, cursor)
  }

  async rewind(stream: ScanStream, scope: string, toBlock: bigint, atUnix: number): Promise<void> {
    if (this.unavailable) throw new CursorUnavailableError(`${stream}/${scope}`, 'injected fault')
    const key = this.#key(stream, scope)
    const existing = this.#byKey.get(key)
    if (existing === undefined) return
    // The watermark is DROPPED, not lowered: see ChainCursorStore.rewind. The
    // spread deliberately omits blockTimestampUnix, so the rewound cursor
    // reports the honest unknown and every read refuses until a re-scan lands.
    const { blockTimestampUnix: _dropped, ...rest } = existing
    this.#byKey.set(key, { ...rest, blockNumber: toBlock, updatedAtUnix: atUnix })
  }
}

interface CursorRow {
  stream: string
  scope: string
  block_number: unknown
  block_timestamp_unix: unknown
  updated_at_unix: unknown
}

export class PgChainCursorStore implements ChainCursorStore {
  constructor(private readonly driver: SqlDriver) {}

  async get(stream: ScanStream, scope: string): Promise<ScanCursor | undefined> {
    let rows: CursorRow[]
    try {
      rows = await this.driver.query<CursorRow>(
        `SELECT stream, scope, block_number, block_timestamp_unix, updated_at_unix
           FROM chain_scan_cursor WHERE stream = $1 AND scope = $2`,
        [stream, scope.toLowerCase()],
      )
    } catch (error) {
      throw new CursorUnavailableError(`${stream}/${scope}`, String(error), error)
    }
    const row = rows[0]
    if (row === undefined) return undefined
    return {
      stream,
      scope: row.scope,
      blockNumber: bigIntFromSql(row.block_number, 'chain_scan_cursor.block_number'),
      ...(row.block_timestamp_unix === null || row.block_timestamp_unix === undefined
        ? {}
        : {
            blockTimestampUnix: countFromSql(
              row.block_timestamp_unix,
              'chain_scan_cursor.block_timestamp_unix',
            ),
          }),
      updatedAtUnix: countFromSql(row.updated_at_unix, 'chain_scan_cursor.updated_at_unix'),
    }
  }

  /**
   * ONE STATEMENT, and the monotonicity is in its WHERE clause rather than in a
   * read-then-write. Two workers scanning the same vault both issue this and
   * the lower one simply changes nothing; a SELECT-then-UPDATE would let the
   * slower worker's stale number win the race and re-open a covered range.
   *
   * IT DIFFERS FROM THE IN-MEMORY STORE ON PURPOSE. That one THROWS on a
   * backwards write, because in a single process a cursor going backwards is a
   * bug and should be loud. Here it is the expected outcome of two workers
   * racing, so the losing write is a no-op rather than an error. Both refuse to
   * move the cursor back; they disagree only about how surprising that is.
   */
  async put(cursor: ScanCursor): Promise<void> {
    try {
      await this.driver.execute(
        `INSERT INTO chain_scan_cursor
             (stream, scope, block_number, block_timestamp_unix, updated_at_unix)
         VALUES ($1, $2, $3::bigint, $4, $5)
         ON CONFLICT (stream, scope) DO UPDATE
            SET block_number = EXCLUDED.block_number,
                -- COALESCE, not assignment: a backfill chunk that did not reach
                -- the head writes a NULL watermark, and that must not erase a
                -- real one. Coverage shrinks only through rewind().
                block_timestamp_unix =
                    COALESCE(EXCLUDED.block_timestamp_unix, chain_scan_cursor.block_timestamp_unix),
                updated_at_unix = EXCLUDED.updated_at_unix
          WHERE chain_scan_cursor.block_number <= EXCLUDED.block_number`,
        [
          cursor.stream,
          cursor.scope.toLowerCase(),
          cursor.blockNumber.toString(),
          cursor.blockTimestampUnix ?? null,
          cursor.updatedAtUnix,
        ],
      )
    } catch (error) {
      throw new CursorUnavailableError(`${cursor.stream}/${cursor.scope}`, String(error), error)
    }
  }

  async rewind(stream: ScanStream, scope: string, toBlock: bigint, atUnix: number): Promise<void> {
    try {
      await this.driver.execute(
        // NULL, not least(block_timestamp_unix, $4). $4 is the moment of the
        // rewind, which is later than the watermark being dropped, so least()
        // kept the old value and the rewind changed no coverage at all. NULL is
        // the column's documented "covers nothing you may rely on yet".
        `UPDATE chain_scan_cursor
            SET block_number = $3::bigint,
                block_timestamp_unix = NULL,
                updated_at_unix = $4
          WHERE stream = $1 AND scope = $2`,
        [stream, scope.toLowerCase(), toBlock.toString(), atUnix],
      )
    } catch (error) {
      throw new CursorUnavailableError(`${stream}/${scope}`, String(error), error)
    }
  }
}

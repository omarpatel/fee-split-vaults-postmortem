/**
 * The fee indexer's store over Postgres.
 *
 * The two contract behaviours `IndexerStore` names are enforced in SQL rather
 * than in a read-then-write:
 *
 *   - putPostings is idempotent on posting id: `ON CONFLICT (id) DO NOTHING`,
 *     and the count returned is the driver's affected-row count, so a re-scan
 *     of an overlapping range reports exactly the rows that were new.
 *   - markFinalizedThrough finalises only postings whose (block_number,
 *     block_hash) is present in indexer_block. It is one UPDATE ... FROM; a
 *     posting whose block we cannot vouch for is simply not matched by the
 *     join, stays unfinalised, and grants no authority.
 *
 * Every read goes through `guarded`: a driver failure is a
 * `SourceUnavailableError`, never an empty list. For this store that matters
 * twice over - an empty postings() reads as "this coin has earned nothing",
 * which is a coin with no budget and no complaint.
 */

import type { Address, PoolId } from '@fee-split-vaults/core'
import type {
  BlockRef,
  CoinBinding,
  CursorKey,
  FeePosting,
  IndexerStore,
  PendingOverride,
  PostingQuery,
  RecipientObservation,
} from '@fee-split-vaults/indexer'
import {
  boolFromSql,
  enumFromSql,
  guarded,
  optBigIntFromSql,
  optCountFromSql,
  optStrFromSql,
  strFromSql,
  withOptional,
} from './rows.js'
import { bigIntFromSql, countFromSql, type SqlDriver, type SqlValue } from './sql.js'

type Hex = `0x${string}`

const BINDING_COLUMNS =
  'token, vault, curve, pool_id, candidate_pool_id, quote_asset, launched_at_unix, launch_block_number, ' +
  'buyback_enabled, creator_tax_bps, coverage_start_unix, graduated_at_unix'

const POSTING_COLUMNS =
  'id, vault, token, asset, credited_minor::text AS credited_minor, gross_fee_minor::text AS gross_fee_minor, ' +
  'derivation, volume_minor::text AS volume_minor, source, phase, classification, side, counterparty, ' +
  'block_number, block_hash, tx_hash, log_index, occurred_at_unix, finalized, ' +
  'buyback_amount_minor::text AS buyback_amount_minor, tokens_locked::text AS tokens_locked'

const DERIVATIONS = ['explicit', 'creator_share_of_fee'] as const
const SOURCES = ['curve_event', 'pool_fees_swept'] as const
const PHASES = ['pre_graduation', 'post_graduation'] as const
const CLASSIFICATIONS = ['trade', 'anti_snipe_window'] as const
const SIDES = ['buy', 'sell', 'sweep'] as const

type BindingRow = Record<string, unknown>
type PostingRow = Record<string, unknown>

function rowToBinding(row: BindingRow): CoinBinding {
  const f = 'indexer_binding'
  const base: CoinBinding = {
    token: strFromSql(row.token, `${f}.token`),
    vault: strFromSql(row.vault, `${f}.vault`),
    curve: strFromSql(row.curve, `${f}.curve`),
    quoteAsset: strFromSql(row.quote_asset, `${f}.quote_asset`),
    launchedAtUnix: countFromSql(row.launched_at_unix, `${f}.launched_at_unix`),
    launchBlockNumber: bigIntFromSql(row.launch_block_number, `${f}.launch_block_number`),
    buybackEnabled: boolFromSql(row.buyback_enabled, `${f}.buyback_enabled`),
    creatorTaxBps: countFromSql(row.creator_tax_bps, `${f}.creator_tax_bps`),
    coverageStartUnix: countFromSql(row.coverage_start_unix, `${f}.coverage_start_unix`),
  }
  let out: CoinBinding = withOptional(base, 'poolId', optStrFromSql(row.pool_id, `${f}.pool_id`))
  out = withOptional(out, 'candidatePoolId', optStrFromSql(row.candidate_pool_id, `${f}.candidate_pool_id`))
  return withOptional(out, 'graduatedAtUnix', optCountFromSql(row.graduated_at_unix, `${f}.graduated_at_unix`))
}

function rowToPosting(row: PostingRow): FeePosting {
  const f = 'indexer_fee_posting'
  const base: FeePosting = {
    id: strFromSql(row.id, `${f}.id`),
    vault: strFromSql(row.vault, `${f}.vault`),
    token: strFromSql(row.token, `${f}.token`),
    asset: strFromSql(row.asset, `${f}.asset`),
    creditedMinor: bigIntFromSql(row.credited_minor, `${f}.credited_minor`),
    grossFeeMinor: bigIntFromSql(row.gross_fee_minor, `${f}.gross_fee_minor`),
    derivation: enumFromSql(row.derivation, DERIVATIONS, `${f}.derivation`),
    volumeMinor: bigIntFromSql(row.volume_minor, `${f}.volume_minor`),
    source: enumFromSql(row.source, SOURCES, `${f}.source`),
    phase: enumFromSql(row.phase, PHASES, `${f}.phase`),
    classification: enumFromSql(row.classification, CLASSIFICATIONS, `${f}.classification`),
    side: enumFromSql(row.side, SIDES, `${f}.side`),
    blockNumber: bigIntFromSql(row.block_number, `${f}.block_number`),
    blockHash: strFromSql(row.block_hash, `${f}.block_hash`) as Hex,
    txHash: strFromSql(row.tx_hash, `${f}.tx_hash`),
    logIndex: countFromSql(row.log_index, `${f}.log_index`),
    occurredAtUnix: countFromSql(row.occurred_at_unix, `${f}.occurred_at_unix`),
    finalized: boolFromSql(row.finalized, `${f}.finalized`),
  }
  let out: FeePosting = withOptional(base, 'counterparty', optStrFromSql(row.counterparty, `${f}.counterparty`))
  out = withOptional(out, 'buybackAmountMinor', optBigIntFromSql(row.buyback_amount_minor, `${f}.buyback_amount_minor`))
  return withOptional(out, 'tokensLocked', optBigIntFromSql(row.tokens_locked, `${f}.tokens_locked`))
}

function rowToBlock(row: Record<string, unknown>): BlockRef {
  return {
    number: bigIntFromSql(row.block_number, 'indexer_block.block_number'),
    hash: strFromSql(row.block_hash, 'indexer_block.block_hash') as Hex,
    parentHash: strFromSql(row.parent_hash, 'indexer_block.parent_hash') as Hex,
    timestampUnix: countFromSql(row.timestamp_unix, 'indexer_block.timestamp_unix'),
  }
}

function rowToOverride(row: Record<string, unknown>): PendingOverride {
  const f = 'indexer_pending_override'
  return {
    token: strFromSql(row.token, `${f}.token`),
    currentRecipient: strFromSql(row.current_recipient, `${f}.current_recipient`),
    newRecipient: strFromSql(row.new_recipient, `${f}.new_recipient`),
    effectiveAtUnix: countFromSql(row.effective_at_unix, `${f}.effective_at_unix`),
    expiresAtUnix: countFromSql(row.expires_at_unix, `${f}.expires_at_unix`),
    proposedAtUnix: countFromSql(row.proposed_at_unix, `${f}.proposed_at_unix`),
    txHash: strFromSql(row.tx_hash, `${f}.tx_hash`),
    blockHash: strFromSql(row.block_hash, `${f}.block_hash`) as Hex,
    blockNumber: bigIntFromSql(row.block_number, `${f}.block_number`),
  }
}

export class PgIndexerStore implements IndexerStore {
  constructor(private readonly driver: SqlDriver) {}

  async putBindings(bindings: readonly CoinBinding[]): Promise<void> {
    if (bindings.length === 0) return
    await guarded('indexer_binding', () =>
      this.driver.transaction(async (tx) => {
        for (const b of bindings) {
          await tx.execute(
            `INSERT INTO indexer_binding (${BINDING_COLUMNS})
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9, $10, $11, $12)
             ON CONFLICT (token) DO UPDATE SET
                 vault = EXCLUDED.vault, curve = EXCLUDED.curve, pool_id = EXCLUDED.pool_id,
                 candidate_pool_id = EXCLUDED.candidate_pool_id, quote_asset = EXCLUDED.quote_asset,
                 launched_at_unix = EXCLUDED.launched_at_unix, launch_block_number = EXCLUDED.launch_block_number,
                 buyback_enabled = EXCLUDED.buyback_enabled, creator_tax_bps = EXCLUDED.creator_tax_bps,
                 coverage_start_unix = EXCLUDED.coverage_start_unix, graduated_at_unix = EXCLUDED.graduated_at_unix`,
            [
              b.token.toLowerCase(),
              b.vault.toLowerCase(),
              b.curve.toLowerCase(),
              b.poolId === undefined ? null : b.poolId.toLowerCase(),
              b.candidatePoolId === undefined ? null : b.candidatePoolId.toLowerCase(),
              b.quoteAsset.toLowerCase(),
              b.launchedAtUnix,
              b.launchBlockNumber.toString(),
              b.buybackEnabled,
              b.creatorTaxBps,
              b.coverageStartUnix,
              b.graduatedAtUnix ?? null,
            ],
          )
        }
      }),
    )
  }

  async bindings(): Promise<CoinBinding[]> {
    const rows = await guarded('indexer_binding', () =>
      this.driver.query<BindingRow>(`SELECT ${BINDING_COLUMNS} FROM indexer_binding ORDER BY launch_block_number, token`),
    )
    return rows.map(rowToBinding)
  }

  async #binding(where: string, param: string): Promise<CoinBinding | undefined> {
    const rows = await guarded('indexer_binding', () =>
      this.driver.query<BindingRow>(`SELECT ${BINDING_COLUMNS} FROM indexer_binding WHERE ${where} = $1`, [param]),
    )
    const row = rows[0]
    return row === undefined ? undefined : rowToBinding(row)
  }

  bindingByToken(token: Address): Promise<CoinBinding | undefined> {
    return this.#binding('token', token.toLowerCase())
  }

  bindingByCurve(curve: Address): Promise<CoinBinding | undefined> {
    return this.#binding('curve', curve.toLowerCase())
  }

  bindingByPoolId(poolId: PoolId): Promise<CoinBinding | undefined> {
    return this.#binding('pool_id', poolId.toLowerCase())
  }

  async putPostings(postings: readonly FeePosting[]): Promise<number> {
    if (postings.length === 0) return 0
    return guarded('indexer_fee_posting', () =>
      this.driver.transaction(async (tx) => {
        let added = 0
        for (const p of postings) {
          const result = await tx.execute(
            `INSERT INTO indexer_fee_posting
                 (id, vault, token, asset, credited_minor, gross_fee_minor, derivation, volume_minor,
                  source, phase, classification, side, counterparty, block_number, block_hash, tx_hash,
                  log_index, occurred_at_unix, finalized, buyback_amount_minor, tokens_locked)
             VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7, $8::numeric, $9, $10, $11, $12, $13,
                     $14::bigint, $15, $16, $17, $18, $19, $20::numeric, $21::numeric)
             ON CONFLICT (id) DO NOTHING`,
            [
              p.id,
              p.vault.toLowerCase(),
              p.token.toLowerCase(),
              p.asset.toLowerCase(),
              p.creditedMinor.toString(),
              p.grossFeeMinor.toString(),
              p.derivation,
              p.volumeMinor.toString(),
              p.source,
              p.phase,
              p.classification,
              p.side,
              p.counterparty === undefined ? null : p.counterparty.toLowerCase(),
              p.blockNumber.toString(),
              p.blockHash,
              p.txHash,
              p.logIndex,
              p.occurredAtUnix,
              p.finalized,
              p.buybackAmountMinor === undefined ? null : p.buybackAmountMinor.toString(),
              p.tokensLocked === undefined ? null : p.tokensLocked.toString(),
            ],
          )
          added += result.rowsAffected
        }
        return added
      }),
    )
  }

  async postings(query: PostingQuery): Promise<FeePosting[]> {
    const where: string[] = []
    const params: SqlValue[] = []
    const bind = (clause: string, value: SqlValue): void => {
      params.push(value)
      where.push(clause.replace('?', `$${params.length}`))
    }
    if (query.vault !== undefined) bind('vault = ?', query.vault.toLowerCase())
    if (query.token !== undefined) bind('token = ?', query.token.toLowerCase())
    if (query.fromUnix !== undefined) bind('occurred_at_unix >= ?', query.fromUnix)
    if (query.toUnix !== undefined) bind('occurred_at_unix < ?', query.toUnix)
    if (query.finalizedOnly === true) where.push('finalized')
    const rows = await guarded('indexer_fee_posting', () =>
      this.driver.query<PostingRow>(
        `SELECT ${POSTING_COLUMNS} FROM indexer_fee_posting
          ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
          ORDER BY block_number, log_index`,
        params,
      ),
    )
    return rows.map(rowToPosting)
  }

  async rollbackAboveBlock(blockNumber: bigint): Promise<FeePosting[]> {
    const rows = await guarded('indexer_fee_posting', () =>
      this.driver.query<PostingRow>(
        `DELETE FROM indexer_fee_posting WHERE block_number > $1::bigint RETURNING ${POSTING_COLUMNS}`,
        [blockNumber.toString()],
      ),
    )
    return rows.map(rowToPosting).sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex)
  }

  async markFinalizedThrough(blockNumber: bigint): Promise<number> {
    const result = await guarded('indexer_fee_posting', () =>
      this.driver.execute(
        `UPDATE indexer_fee_posting AS p SET finalized = TRUE
           FROM indexer_block AS b
          WHERE NOT p.finalized
            AND p.block_number <= $1::bigint
            AND b.block_number = p.block_number
            AND b.block_hash = p.block_hash`,
        [blockNumber.toString()],
      ),
    )
    return result.rowsAffected
  }

  async putBlock(block: BlockRef): Promise<void> {
    await guarded('indexer_block', () =>
      this.driver.execute(
        `INSERT INTO indexer_block (block_number, block_hash, parent_hash, timestamp_unix)
         VALUES ($1::bigint, $2, $3, $4)
         ON CONFLICT (block_number) DO UPDATE SET
             block_hash = EXCLUDED.block_hash, parent_hash = EXCLUDED.parent_hash,
             timestamp_unix = EXCLUDED.timestamp_unix`,
        [block.number.toString(), block.hash, block.parentHash, block.timestampUnix],
      ),
    )
  }

  async block(blockNumber: bigint): Promise<BlockRef | undefined> {
    const rows = await guarded('indexer_block', () =>
      this.driver.query(
        'SELECT block_number, block_hash, parent_hash, timestamp_unix FROM indexer_block WHERE block_number = $1::bigint',
        [blockNumber.toString()],
      ),
    )
    const row = rows[0]
    return row === undefined ? undefined : rowToBlock(row)
  }

  async highestTrackedBlock(): Promise<BlockRef | undefined> {
    const rows = await guarded('indexer_block', () =>
      this.driver.query(
        'SELECT block_number, block_hash, parent_hash, timestamp_unix FROM indexer_block ORDER BY block_number DESC LIMIT 1',
      ),
    )
    const row = rows[0]
    return row === undefined ? undefined : rowToBlock(row)
  }

  async deleteBlocksAbove(blockNumber: bigint): Promise<void> {
    await guarded('indexer_block', () =>
      this.driver.execute('DELETE FROM indexer_block WHERE block_number > $1::bigint', [blockNumber.toString()]),
    )
  }

  async pruneBlocksBelow(blockNumber: bigint): Promise<void> {
    await guarded('indexer_block', () =>
      this.driver.execute('DELETE FROM indexer_block WHERE block_number < $1::bigint', [blockNumber.toString()]),
    )
  }

  async getCursor(key: CursorKey): Promise<bigint | undefined> {
    const rows = await guarded('indexer_cursor', () =>
      this.driver.query<{ block_number: unknown }>('SELECT block_number FROM indexer_cursor WHERE key = $1', [key]),
    )
    const row = rows[0]
    return row === undefined ? undefined : bigIntFromSql(row.block_number, 'indexer_cursor.block_number')
  }

  async setCursor(key: CursorKey, blockNumber: bigint): Promise<void> {
    await guarded('indexer_cursor', () =>
      this.driver.execute(
        `INSERT INTO indexer_cursor (key, block_number) VALUES ($1, $2::bigint)
         ON CONFLICT (key) DO UPDATE SET block_number = EXCLUDED.block_number`,
        [key, blockNumber.toString()],
      ),
    )
  }

  async putOverride(override: PendingOverride): Promise<void> {
    await guarded('indexer_pending_override', () =>
      this.driver.execute(
        `INSERT INTO indexer_pending_override
             (token, current_recipient, new_recipient, effective_at_unix, expires_at_unix,
              proposed_at_unix, tx_hash, block_hash, block_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint)
         ON CONFLICT (token, effective_at_unix, tx_hash) DO NOTHING`,
        [
          override.token.toLowerCase(),
          override.currentRecipient.toLowerCase(),
          override.newRecipient.toLowerCase(),
          override.effectiveAtUnix,
          override.expiresAtUnix,
          override.proposedAtUnix,
          override.txHash,
          override.blockHash,
          override.blockNumber.toString(),
        ],
      ),
    )
  }

  async overrides(token?: Address): Promise<PendingOverride[]> {
    const columns =
      'token, current_recipient, new_recipient, effective_at_unix, expires_at_unix, proposed_at_unix, tx_hash, block_hash, block_number'
    const rows = await guarded('indexer_pending_override', () =>
      token === undefined
        ? this.driver.query(`SELECT ${columns} FROM indexer_pending_override ORDER BY token, effective_at_unix, tx_hash`)
        : this.driver.query(
            `SELECT ${columns} FROM indexer_pending_override WHERE token = $1 ORDER BY effective_at_unix, tx_hash`,
            [token.toLowerCase()],
          ),
    )
    return rows.map(rowToOverride)
  }

  async clearOverride(token: Address, effectiveAtUnix: number): Promise<void> {
    await guarded('indexer_pending_override', () =>
      this.driver.execute('DELETE FROM indexer_pending_override WHERE token = $1 AND effective_at_unix = $2', [
        token.toLowerCase(),
        effectiveAtUnix,
      ]),
    )
  }

  async putRecipientObservation(observation: RecipientObservation): Promise<void> {
    await guarded('indexer_recipient_observation', () =>
      this.driver.execute(
        `INSERT INTO indexer_recipient_observation
             (token, recipient, expected, matches, block_hash, block_number, observed_at_unix)
         VALUES ($1, $2, $3, $4, $5, $6::bigint, $7)
         ON CONFLICT (token) DO UPDATE SET
             recipient = EXCLUDED.recipient, expected = EXCLUDED.expected, matches = EXCLUDED.matches,
             block_hash = EXCLUDED.block_hash, block_number = EXCLUDED.block_number,
             observed_at_unix = EXCLUDED.observed_at_unix`,
        [
          observation.token.toLowerCase(),
          observation.recipient.toLowerCase(),
          observation.expected.toLowerCase(),
          observation.matches,
          observation.blockHash,
          observation.blockNumber.toString(),
          observation.observedAtUnix,
        ],
      ),
    )
  }

  async recipientObservation(token: Address): Promise<RecipientObservation | undefined> {
    const rows = await guarded('indexer_recipient_observation', () =>
      this.driver.query(
        `SELECT token, recipient, expected, matches, block_hash, block_number, observed_at_unix
           FROM indexer_recipient_observation WHERE token = $1`,
        [token.toLowerCase()],
      ),
    )
    const row = rows[0]
    if (row === undefined) return undefined
    const f = 'indexer_recipient_observation'
    return {
      token: strFromSql(row.token, `${f}.token`),
      recipient: strFromSql(row.recipient, `${f}.recipient`),
      expected: strFromSql(row.expected, `${f}.expected`),
      matches: boolFromSql(row.matches, `${f}.matches`),
      blockHash: strFromSql(row.block_hash, `${f}.block_hash`) as Hex,
      blockNumber: bigIntFromSql(row.block_number, `${f}.block_number`),
      observedAtUnix: countFromSql(row.observed_at_unix, `${f}.observed_at_unix`),
    }
  }
}

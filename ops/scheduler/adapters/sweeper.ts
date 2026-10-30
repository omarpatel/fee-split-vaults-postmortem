/**
 * The escrow sweep, executed on chain: CoinVault.claim / claimToken in
 * bounded chunks, with the outbox that makes a crash recoverable.
 *
 * WHY claim/claimToken AND NOT sweep(). The vault's sweep(address[]) claims
 * with type(uint256).max and is the right tool for an uncapped asset with
 * nothing to plan; but every approved quote asset may impose a per-transfer
 * cap, and the port hands this executor `maxChunkMinor` for exactly that
 * reason. claim(max) and claimToken(asset, max) are the bounded forms, and
 * each of them runs _settle(asset) in the same transaction, so there is no
 * second call to make: a confirmed claim is a settled claim.
 *
 * WHAT LANDED IS READ FROM THE CHAIN, NOT ASSUMED. Each confirmed chunk's
 * receipt carries the vault's own Claimed(asset, received, maxAmount) log,
 * and `received` is what is added to the receipt. A chunk with no Claimed
 * log is refused rather than counted: money that cannot be seen was not
 * received.
 *
 * THE ESCROW MAY CAP OR REVERT. Its verified ABI declares
 * InsufficientBalance(requested, available). If a chunk's simulation comes
 * back with it, the chunk is re-issued at `available` - once, typed, and only
 * downward - and a zero available ends the run. Nothing is retried blind.
 *
 * THE OUTBOX (0019 ops_sweep_outbox) is opened before the first broadcast
 * and closed after the last confirmation; see the migration for why. A row
 * with a pending hash is resolved from the receipt before anything else
 * happens under that run key, and an attempt that cannot resolve it refuses:
 * claiming on top of an in-flight claim is the double claim the run key
 * exists to prevent.
 */

import type { Address, AssetAddress, TxHash } from '@fee-split-vaults/core'
import {
  VAULT_CLAIMED,
  VaultOpError,
  decodeClaim,
  isNativeAsset,
  type VaultOperatorClient,
  type VaultTxReceipt,
} from '@fee-split-vaults/adapters'
import { addressEquals, type BlockRef, type ChainWriteClient, type Hex, type RpcLog } from '@fee-split-vaults/indexer'
import { canonicalDigest } from '../../lib/ids.js'
import type { Clock } from '../../lib/time.js'
import type { SqlDriver, SqlRow } from '../../migrations/driver.js'
import { SWEEP } from '../config.js'
import type { SweepExecutor, SweepReceipt, SweepRequest } from '../ports.js'
import { OpsAdapterError, bigIntOf, intOf, strOf } from './errors.js'

export interface ChainSweepExecutorDeps {
  rpc: Pick<ChainWriteClient, 'getTransactionReceipt' | 'getBlockByNumber'>
  operator: VaultOperatorClient
  driver: SqlDriver
  clock: Clock
}

interface OutboxRow {
  runKey: string
  sweepId: string
  vault: Address
  asset: AssetAddress
  expectedMinor: bigint
  claimedMinor: bigint
  chunks: number
  txHashes: TxHash[]
  blockHash: string | null
  pendingTxHash: string | null
  updatedAtUnix: number
  completedAtUnix: number | null
}

const SELECT_ROW = `SELECT run_key, sweep_id, vault, asset, expected_minor, claimed_minor, chunks, tx_hashes,
                           block_hash, pending_tx_hash, updated_at_unix, completed_at_unix
                      FROM ops_sweep_outbox`

function rowOf(raw: SqlRow): OutboxRow {
  const hashes = typeof raw.tx_hashes === 'string' ? (JSON.parse(raw.tx_hashes) as unknown) : raw.tx_hashes
  if (!Array.isArray(hashes) || hashes.some((h) => typeof h !== 'string')) {
    throw new OpsAdapterError('row_malformed', `ops_sweep_outbox.tx_hashes is not a string array`)
  }
  return {
    runKey: strOf(raw.run_key, 'run_key'),
    sweepId: strOf(raw.sweep_id, 'sweep_id'),
    vault: strOf(raw.vault, 'vault'),
    asset: strOf(raw.asset, 'asset'),
    expectedMinor: bigIntOf(raw.expected_minor, 'expected_minor'),
    claimedMinor: bigIntOf(raw.claimed_minor, 'claimed_minor'),
    chunks: intOf(raw.chunks, 'chunks'),
    txHashes: hashes as string[],
    blockHash: raw.block_hash === null ? null : strOf(raw.block_hash, 'block_hash'),
    pendingTxHash: raw.pending_tx_hash === null ? null : strOf(raw.pending_tx_hash, 'pending_tx_hash'),
    updatedAtUnix: intOf(raw.updated_at_unix, 'updated_at_unix'),
    completedAtUnix: raw.completed_at_unix === null ? null : intOf(raw.completed_at_unix, 'completed_at_unix'),
  }
}

/** Sum of the vault's Claimed.received for `asset` in one receipt. Undefined when the log is absent. */
export function receivedInReceipt(
  logs: readonly RpcLog[],
  block: BlockRef,
  vault: Address,
  asset: AssetAddress,
): bigint | undefined {
  let total: bigint | undefined
  for (const log of logs) {
    if (log.removed || !addressEquals(log.address, vault) || log.topics[0] !== VAULT_CLAIMED.topic0) continue
    const claim = decodeClaim(log, block)
    if (!addressEquals(claim.asset, asset)) continue
    total = (total ?? 0n) + claim.amountMinor
  }
  return total
}

export class ChainSweepExecutor implements SweepExecutor {
  constructor(private readonly deps: ChainSweepExecutorDeps) {}

  async sweep(request: SweepRequest): Promise<SweepReceipt> {
    if (request.expectedMinor <= 0n) {
      throw new OpsAdapterError('row_malformed', `sweep of ${request.expectedMinor} minor units is not a claim`)
    }
    const vault = request.vault.toLowerCase()
    const asset = request.asset.toLowerCase()
    let row = await this.#resolvePending(await this.#find(request.runKey))
    if (row === undefined) {
      row = await this.#open(request, vault, asset)
    } else if (row.completedAtUnix !== null) {
      if (row.chunks === 0) {
        throw new OpsAdapterError('nothing_claimed', `run key ${request.runKey} already closed with nothing claimed`)
      }
      return toReceipt(row)
    } else if (!addressEquals(row.vault, vault) || !addressEquals(row.asset, asset)) {
      throw new OpsAdapterError(
        'outbox_row_conflict',
        `run key ${request.runKey} is open for ${row.vault}/${row.asset}, not ${vault}/${asset}`,
      )
    }

    let remaining = row.expectedMinor - row.claimedMinor
    const cap = request.maxChunkMinor
    while (remaining > 0n) {
      const chunk = cap === undefined || cap <= 0n ? remaining : remaining < cap ? remaining : cap
      const landed = await this.#claimChunk(row, chunk)
      // Less than asked is the escrow saying it is empty: the next chunk
      // would be a paid-for no-op.
      if (landed === null || landed < chunk) break
      remaining -= landed
      row = await this.#require(row.runKey)
    }

    const completedAtUnix = this.deps.clock.nowUnix()
    row = await this.#require(row.runKey)
    if (row.chunks === 0) {
      // The escrow held nothing for this asset by the time the claim was
      // simulated (a permissionless sweep() by a stranger drains it just as
      // well). There is no receipt to report and nothing for the ledger; the
      // row is closed so the outbox does not carry it.
      await this.deps.driver.execute(
        `UPDATE ops_sweep_outbox SET completed_at_unix = $2, recorded_at_unix = $2, updated_at_unix = $2 WHERE run_key = $1`,
        [row.runKey, completedAtUnix],
      )
      throw new OpsAdapterError('nothing_claimed', `escrow reported no claimable ${asset} for ${vault} under ${request.runKey}`)
    }
    await this.deps.driver.execute(
      `UPDATE ops_sweep_outbox SET completed_at_unix = $2, updated_at_unix = $2 WHERE run_key = $1 AND completed_at_unix IS NULL`,
      [row.runKey, completedAtUnix],
    )
    return toReceipt(await this.#require(row.runKey))
  }

  /**
   * The recovery point. A completed row is its receipt. A row whose attempt
   * died (no touch inside the lease) is finalised as it stands: the chunks
   * that landed are the sweep, and the rest is still in escrow for a later
   * run to find. A row with a pending hash is resolved first. A row a live
   * attempt is still working on is not a prior sweep.
   */
  async findByRunKey(runKey: string): Promise<SweepReceipt | undefined> {
    const row = await this.#resolvePending(await this.#find(runKey))
    if (row === undefined) return undefined
    if (row.completedAtUnix !== null) return row.chunks === 0 ? undefined : toReceipt(row)
    const nowUnix = this.deps.clock.nowUnix()
    if (row.updatedAtUnix > nowUnix - SWEEP.outboxStaleSeconds) return undefined
    if (row.chunks === 0) {
      // Nothing was ever broadcast. There is no sweep to report; the row is
      // closed so the outbox does not carry it forever, and the next run
      // opens a new one under its own key.
      await this.deps.driver.execute(
        `UPDATE ops_sweep_outbox SET completed_at_unix = $2, recorded_at_unix = $2, updated_at_unix = $2 WHERE run_key = $1`,
        [runKey, nowUnix],
      )
      return undefined
    }
    await this.deps.driver.execute(
      `UPDATE ops_sweep_outbox SET completed_at_unix = $2, updated_at_unix = $2 WHERE run_key = $1 AND completed_at_unix IS NULL`,
      [runKey, nowUnix],
    )
    return toReceipt(await this.#require(runKey))
  }

  /**
   * Completed rows the ledger has not acknowledged. A dead attempt with landed
   * chunks (no touch inside the lease, nothing pending) is finalised here
   * first: what landed is the sweep, and the outbox is how it reaches the
   * books. Rows with a pending hash are left for findByRunKey to resolve.
   */
  async unrecorded(limit: number): Promise<SweepReceipt[]> {
    const nowUnix = this.deps.clock.nowUnix()
    await this.deps.driver.execute(
      `UPDATE ops_sweep_outbox SET completed_at_unix = $1, updated_at_unix = $1
        WHERE completed_at_unix IS NULL AND pending_tx_hash IS NULL AND chunks > 0 AND updated_at_unix <= $2`,
      [nowUnix, nowUnix - SWEEP.outboxStaleSeconds],
    )
    const rows = await this.deps.driver.query<SqlRow>(
      `${SELECT_ROW}
        WHERE recorded_at_unix IS NULL AND completed_at_unix IS NOT NULL AND chunks > 0
        ORDER BY completed_at_unix, run_key
        LIMIT $1`,
      [limit],
    )
    return rows.map((raw) => toReceipt(rowOf(raw)))
  }

  async confirmRecorded(sweepId: string): Promise<void> {
    await this.deps.driver.execute(
      `UPDATE ops_sweep_outbox SET recorded_at_unix = $2 WHERE sweep_id = $1 AND recorded_at_unix IS NULL`,
      [sweepId, this.deps.clock.nowUnix()],
    )
  }

  // -- chunks ---------------------------------------------------------------

  /**
   * One bounded claim. Returns what the vault's Claimed log says landed, or
   * null when the escrow reported nothing left to give. A chunk of unknown
   * fate is recorded as pending and the error is re-thrown for the job to
   * fail this attempt on.
   */
  async #claimChunk(row: OutboxRow, maxAmount: bigint): Promise<bigint | null> {
    await this.deps.driver.execute(`UPDATE ops_sweep_outbox SET updated_at_unix = $2 WHERE run_key = $1`, [
      row.runKey,
      this.deps.clock.nowUnix(),
    ])
    let receipt: VaultTxReceipt
    try {
      receipt = await this.#send(row, maxAmount)
    } catch (error) {
      if (error instanceof VaultOpError && error.code === 'escrow_insufficient_balance') {
        // InsufficientBalance(requested, available): the escrow holds less than
        // the chunk asked for. Re-issue at what it holds, once, downward only.
        const available = error.contractError?.args[1] ?? 0n
        if (available <= 0n || available >= maxAmount) return null
        receipt = await this.#send(row, available)
      } else {
        if (error instanceof VaultOpError && error.pendingTxHash !== null) {
          await this.deps.driver.execute(
            `UPDATE ops_sweep_outbox SET pending_tx_hash = $2, updated_at_unix = $3 WHERE run_key = $1`,
            [row.runKey, error.pendingTxHash, this.deps.clock.nowUnix()],
          )
        }
        throw error
      }
    }
    return this.#fold(row.runKey, row.vault, row.asset, receipt.txHash, receipt.logs, receipt.block)
  }

  #send(row: OutboxRow, maxAmount: bigint): Promise<VaultTxReceipt> {
    return isNativeAsset(row.asset)
      ? this.deps.operator.claim(row.vault, maxAmount)
      : this.deps.operator.claimToken(row.vault, row.asset, maxAmount)
  }

  /** Adds one confirmed chunk to the row from the vault's own Claimed log. */
  async #fold(
    runKey: string,
    vault: Address,
    asset: AssetAddress,
    txHash: Hex,
    logs: readonly RpcLog[],
    block: BlockRef,
  ): Promise<bigint> {
    const received = receivedInReceipt(logs, block, vault, asset)
    if (received === undefined) {
      throw new OpsAdapterError(
        'claim_event_missing',
        `tx ${txHash} succeeded but carries no Claimed(${asset}) log from ${vault}; not counting it`,
      )
    }
    const row = await this.#require(runKey)
    await this.deps.driver.execute(
      `UPDATE ops_sweep_outbox
          SET claimed_minor = $2, chunks = $3, tx_hashes = $4::jsonb, block_hash = $5,
              pending_tx_hash = NULL, updated_at_unix = $6
        WHERE run_key = $1`,
      [
        runKey,
        (row.claimedMinor + received).toString(10),
        row.chunks + 1,
        JSON.stringify([...row.txHashes, txHash]),
        block.hash,
        this.deps.clock.nowUnix(),
      ],
    )
    return received
  }

  /**
   * A broadcast chunk whose receipt never arrived is settled from the chain
   * before the row is used for anything: landed -> folded in; reverted ->
   * cleared; still absent -> refused.
   */
  async #resolvePending(row: OutboxRow | undefined): Promise<OutboxRow | undefined> {
    if (row === undefined || row.pendingTxHash === null) return row
    const hash = row.pendingTxHash as Hex
    const receipt = await this.deps.rpc.getTransactionReceipt(hash)
    if (receipt === null) {
      throw new OpsAdapterError('claim_pending_unresolved', `chunk ${hash} of ${row.runKey} has no receipt yet`)
    }
    if (receipt.status === 1) {
      const block = await this.deps.rpc.getBlockByNumber(receipt.blockNumber)
      if (block === null || block.hash !== receipt.blockHash) {
        throw new OpsAdapterError('claim_pending_unresolved', `chunk ${hash} of ${row.runKey} is not on the canonical chain`)
      }
      await this.#fold(row.runKey, row.vault, row.asset, hash, receipt.logs, block)
    } else {
      await this.deps.driver.execute(
        `UPDATE ops_sweep_outbox SET pending_tx_hash = NULL, updated_at_unix = $2 WHERE run_key = $1`,
        [row.runKey, this.deps.clock.nowUnix()],
      )
    }
    return this.#require(row.runKey)
  }

  // -- rows -----------------------------------------------------------------

  async #open(request: SweepRequest, vault: Address, asset: AssetAddress): Promise<OutboxRow> {
    const nowUnix = this.deps.clock.nowUnix()
    const sweepId = `sweep-${canonicalDigest({ runKey: request.runKey }).slice(0, 24)}`
    await this.deps.driver.execute(
      `INSERT INTO ops_sweep_outbox
           (run_key, sweep_id, vault, asset, expected_minor, claimed_minor, chunks, tx_hashes,
            opened_at_unix, updated_at_unix)
       VALUES ($1, $2, $3, $4, $5, '0', 0, '[]'::jsonb, $6, $6)
       ON CONFLICT (run_key) DO NOTHING`,
      [request.runKey, sweepId, vault, asset, request.expectedMinor.toString(10), nowUnix],
    )
    return this.#require(request.runKey)
  }

  async #find(runKey: string): Promise<OutboxRow | undefined> {
    const rows = await this.deps.driver.query<SqlRow>(`${SELECT_ROW} WHERE run_key = $1`, [runKey])
    const raw = rows[0]
    return raw === undefined ? undefined : rowOf(raw)
  }

  async #require(runKey: string): Promise<OutboxRow> {
    const row = await this.#find(runKey)
    if (row === undefined) throw new OpsAdapterError('sweep_unknown', `ops_sweep_outbox has no row for ${runKey}`)
    return row
  }
}

/** A receipt is a landed sweep: it has a block. A row without one is not reported as money. */
function toReceipt(row: OutboxRow): SweepReceipt {
  if (row.blockHash === null || row.chunks === 0 || row.completedAtUnix === null) {
    throw new OpsAdapterError('row_malformed', `ops_sweep_outbox row ${row.runKey} has no confirmed chunk to report`)
  }
  return {
    sweepId: row.sweepId,
    runKey: row.runKey,
    vault: row.vault,
    asset: row.asset,
    claimedMinor: row.claimedMinor,
    chunks: row.chunks,
    txHashes: row.txHashes,
    blockHash: row.blockHash,
    completedAtUnix: row.completedAtUnix,
  }
}

/**
 * CoinVault.settle(asset), executed and reported from the chain.
 *
 * WHAT "UNSETTLED" IS ON CHAIN. settle() credits `balanceOf(vault, asset) -
 * (dev + budget + operator + referrer)`, and checkSolvency(asset) returns
 * exactly those two numbers. That difference is what this executor reports
 * as unsettled. It is usually zero right after a sweep, because claim() and
 * claimToken() run _settle in the same transaction; what remains for this
 * job is anything that reached the vault another way - a direct transfer, an
 * airdrop, the launch token itself - which the contract credits 100% to the
 * dev when it is not a quote-asset fee in the ACTIVE state.
 *
 * THE SPLIT IS THE CONTRACT'S. The receipt's legs are read from the vault's
 * own Credited(asset, amount, toDev, toBudget, toOperator, toReferrer) log
 * in the confirming receipt - never recomputed here - and cross-checked
 * against legOf before and after the call. The settle job compares them with
 * the consent's operatorBps and the current dial; a vault whose ceiling has
 * ratcheted down reports a smaller operator leg, and that mismatch is the
 * job's to refuse, not this file's to hide. The referrer's cut is folded
 * into the operator figure, as the port and the ledger both carry it.
 *
 * Money never moves. settle() is a partition of a balance the vault already
 * holds; the dev leg is credited, not transferred.
 */

import type { Address, AssetAddress } from '@fee-split-vaults/core'
import {
  VAULT_CREDITED,
  VaultOpError,
  VaultReadClient,
  decodeAllocation,
  type VaultLegs,
  type VaultOperatorClient,
} from '@fee-split-vaults/adapters'
import { addressEquals, type BlockRef, type ChainWriteClient, type Hex, type RpcLog } from '@fee-split-vaults/indexer'
import { canonicalDigest } from '../../lib/ids.js'
import type { Clock } from '../../lib/time.js'
import type { SqlDriver, SqlRow } from '../../migrations/driver.js'
import type { AssetRegistry, SettlementExecutor, SettlementReceipt, SettlementRequest } from '../ports.js'
import { OpsAdapterError, bigIntOf, intOf, strOf } from './errors.js'

export interface ChainSettlementExecutorDeps {
  rpc: Pick<ChainWriteClient, 'call' | 'getBlockByTag' | 'getTransactionReceipt' | 'getBlockByNumber'>
  operator: VaultOperatorClient
  assets: AssetRegistry
  driver: SqlDriver
  clock: Clock
}

/** The split settle() emitted, as the receipt reports it, leg by leg. */
export interface CreditedSplit {
  creditedMinor: bigint
  devLegMinor: bigint
  budgetMinor: bigint
  operatorMinor: bigint
  referrerMinor: bigint
}

interface OutboxRow {
  runKey: string
  settlementId: string
  vault: Address
  asset: AssetAddress
  requestedMinor: bigint
  before: VaultLegs
  credited: CreditedSplit | null
  txHash: string | null
  blockHash: string | null
  pendingTxHash: string | null
  settledAtUnix: number | null
}

const SELECT_ROW = `SELECT run_key, settlement_id, vault, asset, requested_minor,
                           dev_before_minor, budget_before_minor, operator_before_minor, referrer_before_minor,
                           credited_minor, dev_leg_minor, budget_minor, operator_minor, referrer_minor,
                           tx_hash, block_hash, pending_tx_hash, settled_at_unix
                      FROM ops_settlement_outbox`

function rowOf(raw: SqlRow): OutboxRow {
  return {
    runKey: strOf(raw.run_key, 'run_key'),
    settlementId: strOf(raw.settlement_id, 'settlement_id'),
    vault: strOf(raw.vault, 'vault'),
    asset: strOf(raw.asset, 'asset'),
    requestedMinor: bigIntOf(raw.requested_minor, 'requested_minor'),
    before: {
      dev: bigIntOf(raw.dev_before_minor, 'dev_before_minor'),
      budget: bigIntOf(raw.budget_before_minor, 'budget_before_minor'),
      operator: bigIntOf(raw.operator_before_minor, 'operator_before_minor'),
      referrer: bigIntOf(raw.referrer_before_minor, 'referrer_before_minor'),
    },
    credited:
      raw.credited_minor === null
        ? null
        : {
            creditedMinor: bigIntOf(raw.credited_minor, 'credited_minor'),
            devLegMinor: bigIntOf(raw.dev_leg_minor, 'dev_leg_minor'),
            budgetMinor: bigIntOf(raw.budget_minor, 'budget_minor'),
            operatorMinor: bigIntOf(raw.operator_minor, 'operator_minor'),
            referrerMinor: bigIntOf(raw.referrer_minor, 'referrer_minor'),
          },
    txHash: raw.tx_hash === null ? null : strOf(raw.tx_hash, 'tx_hash'),
    blockHash: raw.block_hash === null ? null : strOf(raw.block_hash, 'block_hash'),
    pendingTxHash: raw.pending_tx_hash === null ? null : strOf(raw.pending_tx_hash, 'pending_tx_hash'),
    settledAtUnix: raw.settled_at_unix === null ? null : intOf(raw.settled_at_unix, 'settled_at_unix'),
  }
}

/** The vault's Credited log for `asset` in one receipt: exactly one is expected from settle(). */
export function creditedInReceipt(
  logs: readonly RpcLog[],
  block: BlockRef,
  vault: Address,
  asset: AssetAddress,
): CreditedSplit | undefined {
  let found: CreditedSplit | undefined
  for (const log of logs) {
    if (log.removed || !addressEquals(log.address, vault) || log.topics[0] !== VAULT_CREDITED.topic0) continue
    const allocation = decodeAllocation(log, block)
    if (!addressEquals(allocation.asset, asset)) continue
    const legs = allocation.devMinor + allocation.budgetMinor + allocation.operatorMinor + allocation.referrerMinor
    found = {
      creditedMinor: (found?.creditedMinor ?? 0n) + legs,
      devLegMinor: (found?.devLegMinor ?? 0n) + allocation.devMinor,
      budgetMinor: (found?.budgetMinor ?? 0n) + allocation.budgetMinor,
      operatorMinor: (found?.operatorMinor ?? 0n) + allocation.operatorMinor,
      referrerMinor: (found?.referrerMinor ?? 0n) + allocation.referrerMinor,
    }
  }
  return found
}

export class ChainSettlementExecutor implements SettlementExecutor {
  readonly #reads: VaultReadClient

  constructor(private readonly deps: ChainSettlementExecutorDeps) {
    this.#reads = new VaultReadClient({ rpc: deps.rpc })
  }

  /** balance - accounted, per enabled asset, at one pinned block. Zero rows are omitted. */
  async unsettled(vault: Address): Promise<Array<{ asset: AssetAddress; amountMinor: bigint }>> {
    const head = await this.#reads.head()
    const out: Array<{ asset: AssetAddress; amountMinor: bigint }> = []
    for (const asset of await this.deps.assets.list()) {
      if (!asset.enabled) continue
      const solvency = await this.#reads.checkSolvency(vault, asset.address, head.hash)
      const amountMinor = solvency.balance - solvency.accounted
      if (amountMinor > 0n) out.push({ asset: asset.address, amountMinor })
    }
    return out
  }

  async settle(request: SettlementRequest): Promise<SettlementReceipt> {
    const vault = request.vault.toLowerCase()
    const asset = request.asset.toLowerCase()
    let row = await this.#resolvePending(await this.#find(request.runKey))
    if (row !== undefined) {
      if (row.settledAtUnix !== null) return toReceipt(row)
      if (!addressEquals(row.vault, vault) || !addressEquals(row.asset, asset)) {
        throw new OpsAdapterError(
          'outbox_row_conflict',
          `run key ${request.runKey} is open for ${row.vault}/${row.asset}, not ${vault}/${asset}`,
        )
      }
    } else {
      const head = await this.#reads.head()
      const solvency = await this.#reads.checkSolvency(vault, asset, head.hash)
      if (solvency.balance <= solvency.accounted) {
        throw new OpsAdapterError('nothing_to_settle', `${vault} holds no unaccounted ${asset} at block ${head.hash}`)
      }
      row = await this.#open(request, vault, asset, await this.#reads.legOf(vault, asset, head.hash))
    }

    let receipt
    try {
      receipt = await this.deps.operator.settle(vault, asset)
    } catch (error) {
      if (error instanceof VaultOpError && error.pendingTxHash !== null) {
        await this.deps.driver.execute(`UPDATE ops_settlement_outbox SET pending_tx_hash = $2 WHERE run_key = $1`, [
          row.runKey,
          error.pendingTxHash,
        ])
      }
      throw error
    }
    await this.#complete(row, receipt.txHash, receipt.logs, receipt.block)
    return toReceipt(await this.#require(row.runKey))
  }

  async findByRunKey(runKey: string): Promise<SettlementReceipt | undefined> {
    const row = await this.#resolvePending(await this.#find(runKey))
    return row === undefined || row.settledAtUnix === null ? undefined : toReceipt(row)
  }

  // -- completion -----------------------------------------------------------

  /**
   * Closes the row from the vault's own Credited log and checks it against
   * the legs read before the call: after - before must equal what the log
   * says was credited, leg by leg, or the ABI compiled against here is not
   * the one deployed and the receipt is refused.
   */
  async #complete(row: OutboxRow, txHash: Hex, logs: readonly RpcLog[], block: BlockRef): Promise<void> {
    const credited = creditedInReceipt(logs, block, row.vault, row.asset)
    if (credited === undefined) {
      throw new OpsAdapterError(
        'settlement_event_missing',
        `tx ${txHash} succeeded but carries no Credited(${row.asset}) log from ${row.vault}`,
      )
    }
    const after = await this.#reads.legOf(row.vault, row.asset, block.hash)
    const delta = {
      dev: after.dev - row.before.dev,
      budget: after.budget - row.before.budget,
      operator: after.operator - row.before.operator,
      referrer: after.referrer - row.before.referrer,
    }
    if (
      delta.dev !== credited.devLegMinor ||
      delta.budget !== credited.budgetMinor ||
      delta.operator !== credited.operatorMinor ||
      delta.referrer !== credited.referrerMinor
    ) {
      throw new OpsAdapterError(
        'legs_mismatch',
        `legOf delta (${delta.dev}, ${delta.budget}, ${delta.operator}, ${delta.referrer}) disagrees with Credited ` +
          `(${credited.devLegMinor}, ${credited.budgetMinor}, ${credited.operatorMinor}, ${credited.referrerMinor}) in tx ${txHash}`,
      )
    }
    await this.deps.driver.execute(
      `UPDATE ops_settlement_outbox
          SET credited_minor = $2, dev_leg_minor = $3, budget_minor = $4, operator_minor = $5, referrer_minor = $6,
              tx_hash = $7, block_hash = $8, pending_tx_hash = NULL, settled_at_unix = $9
        WHERE run_key = $1 AND settled_at_unix IS NULL`,
      [
        row.runKey,
        credited.creditedMinor.toString(10),
        credited.devLegMinor.toString(10),
        credited.budgetMinor.toString(10),
        credited.operatorMinor.toString(10),
        credited.referrerMinor.toString(10),
        txHash,
        block.hash,
        block.timestampUnix,
      ],
    )
  }

  async #resolvePending(row: OutboxRow | undefined): Promise<OutboxRow | undefined> {
    if (row === undefined || row.pendingTxHash === null) return row
    const hash = row.pendingTxHash as Hex
    const receipt = await this.deps.rpc.getTransactionReceipt(hash)
    if (receipt === null) {
      throw new OpsAdapterError('claim_pending_unresolved', `settle tx ${hash} of ${row.runKey} has no receipt yet`)
    }
    if (receipt.status === 1) {
      const block = await this.deps.rpc.getBlockByNumber(receipt.blockNumber)
      if (block === null || block.hash !== receipt.blockHash) {
        throw new OpsAdapterError('claim_pending_unresolved', `settle tx ${hash} of ${row.runKey} is not canonical`)
      }
      await this.#complete(row, hash, receipt.logs, block)
    } else {
      await this.deps.driver.execute(`UPDATE ops_settlement_outbox SET pending_tx_hash = NULL WHERE run_key = $1`, [row.runKey])
    }
    return this.#require(row.runKey)
  }

  // -- rows -----------------------------------------------------------------

  async #open(request: SettlementRequest, vault: Address, asset: AssetAddress, before: VaultLegs): Promise<OutboxRow> {
    const settlementId = `settle-${canonicalDigest({ runKey: request.runKey }).slice(0, 24)}`
    await this.deps.driver.execute(
      `INSERT INTO ops_settlement_outbox
           (run_key, settlement_id, vault, asset, requested_minor,
            dev_before_minor, budget_before_minor, operator_before_minor, referrer_before_minor, opened_at_unix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (run_key) DO NOTHING`,
      [
        request.runKey,
        settlementId,
        vault,
        asset,
        request.amountMinor.toString(10),
        before.dev.toString(10),
        before.budget.toString(10),
        before.operator.toString(10),
        before.referrer.toString(10),
        this.deps.clock.nowUnix(),
      ],
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
    if (row === undefined) throw new OpsAdapterError('sweep_unknown', `ops_settlement_outbox has no row for ${runKey}`)
    return row
  }
}

function toReceipt(row: OutboxRow): SettlementReceipt {
  if (row.credited === null || row.txHash === null || row.settledAtUnix === null) {
    throw new OpsAdapterError('row_malformed', `ops_settlement_outbox row ${row.runKey} is not settled`)
  }
  return {
    settlementId: row.settlementId,
    vault: row.vault,
    asset: row.asset,
    devLegMinor: row.credited.devLegMinor,
    budgetMinor: row.credited.budgetMinor,
    operatorMinor: row.credited.operatorMinor,
    referrerMinor: row.credited.referrerMinor,
    txHash: row.txHash,
    settledAtUnix: row.settledAtUnix,
  }
}

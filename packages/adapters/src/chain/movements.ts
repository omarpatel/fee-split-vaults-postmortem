/**
 * Where observed vault money-movements live between the scan that found them
 * and the tick that reads them.
 *
 * A store is needed rather than a pass-through because the two sides speak
 * different languages. The scan moves forward in blocks and sees each log
 * exactly once; the tick loop asks for a WINDOW in unix time and asks again on
 * the next tick with an overlapping window. Without somewhere to put them, a
 * claim observed at 12:00:03 would be invisible to the 12:05 tick.
 *
 * IDEMPOTENT ON CHAIN POSITION. The id is `${txHash}:${logIndex}`, so a
 * re-scanned range, a restart mid-range, or an overlapping chunk all converge
 * on the same rows. That is what lets the scanner be careless about overlap and
 * careful about correctness.
 */

import type { Address } from '@fee-split-vaults/core'
import type { AllocationObservation, ClaimObservation } from '@fee-split-vaults/orchestrator'
import { SourceUnavailableError } from '../errors.js'
import { bigIntFromSql, countFromSql, type SqlDriver, type SqlValue } from '../pg/sql.js'

export interface VaultMovementStore {
  /** Returns how many rows were new. Existing ids are left untouched. */
  putClaims(claims: readonly (ClaimObservation & { id: string; blockNumber: bigint })[]): Promise<number>
  putAllocations(
    allocations: readonly (AllocationObservation & { id: string; blockNumber: bigint })[],
  ): Promise<number>
  claims(vault: Address, fromUnix: number, toUnix: number): Promise<ClaimObservation[]>
  allocations(vault: Address, fromUnix: number, toUnix: number): Promise<AllocationObservation[]>
  /** A reorg took these blocks away. Removes everything strictly above. */
  rollbackAboveBlock(vault: Address, blockNumber: bigint): Promise<number>
}

type StoredClaim = ClaimObservation & { id: string; blockNumber: bigint }
type StoredAllocation = AllocationObservation & { id: string; blockNumber: bigint }

/**
 * Strip the storage-only fields.
 *
 * `id` and `blockNumber` are how a row is deduped and rolled back; they are not
 * part of `ClaimObservation` or `AllocationObservation`. The Postgres store
 * drops them by selecting only the observation columns, and the in-memory one
 * has to drop them too - otherwise the two implementations return different
 * shapes and a consumer can come to depend on a field that exists in tests and
 * vanishes in production.
 */
function toClaim(stored: StoredClaim): ClaimObservation {
  const { id: _id, blockNumber: _blockNumber, ...observation } = stored
  return observation
}

function toAllocation(stored: StoredAllocation): AllocationObservation {
  const { id: _id, blockNumber: _blockNumber, ...observation } = stored
  return observation
}

function inWindow(occurredAtUnix: number, fromUnix: number, toUnix: number): boolean {
  // Inclusive at both ends, matching InMemoryChainReadModel and what coin.ts
  // expects: the tick's `from` is the previous tick's `now`, and an observation
  // landing exactly on the boundary must be seen by exactly one of them.
  return occurredAtUnix >= fromUnix && occurredAtUnix <= toUnix
}

export class InMemoryVaultMovementStore implements VaultMovementStore {
  readonly #claims = new Map<string, StoredClaim>()
  readonly #allocations = new Map<string, StoredAllocation>()
  /** Set to make every call throw, so the fail-closed paths can be exercised. */
  unavailable = false

  #guard(what: string): void {
    if (this.unavailable) throw new SourceUnavailableError(what, 'injected fault')
  }

  async putClaims(claims: readonly StoredClaim[]): Promise<number> {
    this.#guard('vault movement store')
    let added = 0
    for (const claim of claims) {
      if (this.#claims.has(claim.id)) continue
      this.#claims.set(claim.id, claim)
      added++
    }
    return added
  }

  async putAllocations(allocations: readonly StoredAllocation[]): Promise<number> {
    this.#guard('vault movement store')
    let added = 0
    for (const allocation of allocations) {
      if (this.#allocations.has(allocation.id)) continue
      this.#allocations.set(allocation.id, allocation)
      added++
    }
    return added
  }

  async claims(vault: Address, fromUnix: number, toUnix: number): Promise<ClaimObservation[]> {
    this.#guard('vault movement store')
    return [...this.#claims.values()]
      .filter(
        (claim) =>
          claim.vault.toLowerCase() === vault.toLowerCase() &&
          inWindow(claim.occurredAtUnix, fromUnix, toUnix),
      )
      .sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex)
      .map(toClaim)
  }

  async allocations(
    vault: Address,
    fromUnix: number,
    toUnix: number,
  ): Promise<AllocationObservation[]> {
    this.#guard('vault movement store')
    return [...this.#allocations.values()]
      .filter(
        (allocation) =>
          allocation.vault.toLowerCase() === vault.toLowerCase() &&
          inWindow(allocation.occurredAtUnix, fromUnix, toUnix),
      )
      .sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex)
      .map(toAllocation)
  }

  async rollbackAboveBlock(vault: Address, blockNumber: bigint): Promise<number> {
    this.#guard('vault movement store')
    let removed = 0
    for (const [id, claim] of this.#claims) {
      if (claim.vault.toLowerCase() === vault.toLowerCase() && claim.blockNumber > blockNumber) {
        this.#claims.delete(id)
        removed++
      }
    }
    for (const [id, allocation] of this.#allocations) {
      if (
        allocation.vault.toLowerCase() === vault.toLowerCase() &&
        allocation.blockNumber > blockNumber
      ) {
        this.#allocations.delete(id)
        removed++
      }
    }
    return removed
  }
}

interface ClaimRow {
  vault: string
  asset: string
  amount_minor: unknown
  occurred_at_unix: unknown
  tx_hash: string
  log_index: unknown
  block_hash: string | null
}

interface AllocationRow extends Omit<ClaimRow, 'amount_minor'> {
  dev_minor: unknown
  budget_minor: unknown
  operator_minor: unknown
  referrer_minor: unknown
}

export class PgVaultMovementStore implements VaultMovementStore {
  constructor(private readonly driver: SqlDriver) {}

  async putClaims(claims: readonly StoredClaim[]): Promise<number> {
    if (claims.length === 0) return 0
    try {
      let added = 0
      for (const claim of claims) {
        const result = await this.driver.execute(
          `INSERT INTO vault_claim_observation
               (id, vault, asset, amount_minor, occurred_at_unix, tx_hash, log_index, block_number, block_hash)
           VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8::bigint, $9)
           ON CONFLICT (id) DO NOTHING`,
          [
            claim.id,
            claim.vault.toLowerCase(),
            claim.asset.toLowerCase(),
            claim.amountMinor.toString(),
            claim.occurredAtUnix,
            claim.txHash.toLowerCase(),
            claim.logIndex,
            claim.blockNumber.toString(),
            claim.blockHash ?? null,
          ],
        )
        added += result.rowsAffected
      }
      return added
    } catch (error) {
      throw new SourceUnavailableError('vault_claim_observation', String(error), error)
    }
  }

  async putAllocations(allocations: readonly StoredAllocation[]): Promise<number> {
    if (allocations.length === 0) return 0
    try {
      let added = 0
      for (const allocation of allocations) {
        const result = await this.driver.execute(
          `INSERT INTO vault_allocation_observation
               (id, vault, asset, dev_minor, budget_minor, operator_minor, referrer_minor,
                occurred_at_unix, tx_hash, log_index, block_number, block_hash)
           VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8, $9, $10, $11::bigint, $12)
           ON CONFLICT (id) DO NOTHING`,
          [
            allocation.id,
            allocation.vault.toLowerCase(),
            allocation.asset.toLowerCase(),
            allocation.devMinor.toString(),
            allocation.budgetMinor.toString(),
            allocation.operatorMinor.toString(),
            allocation.referrerMinor.toString(),
            allocation.occurredAtUnix,
            allocation.txHash.toLowerCase(),
            allocation.logIndex,
            allocation.blockNumber.toString(),
            allocation.blockHash ?? null,
          ],
        )
        added += result.rowsAffected
      }
      return added
    } catch (error) {
      throw new SourceUnavailableError('vault_allocation_observation', String(error), error)
    }
  }

  async claims(vault: Address, fromUnix: number, toUnix: number): Promise<ClaimObservation[]> {
    let rows: ClaimRow[]
    try {
      rows = await this.driver.query<ClaimRow>(
        `SELECT vault, asset, amount_minor, occurred_at_unix, tx_hash, log_index, block_hash
           FROM vault_claim_observation
          WHERE vault = $1 AND occurred_at_unix >= $2 AND occurred_at_unix <= $3
          ORDER BY block_number, log_index`,
        [vault.toLowerCase(), fromUnix, toUnix],
      )
    } catch (error) {
      throw new SourceUnavailableError('vault_claim_observation', String(error), error)
    }
    return rows.map((row) => {
      const observation: ClaimObservation = {
        vault: row.vault,
        asset: row.asset,
        amountMinor: bigIntFromSql(row.amount_minor, 'vault_claim_observation.amount_minor'),
        occurredAtUnix: countFromSql(row.occurred_at_unix, 'vault_claim_observation.occurred_at_unix'),
        txHash: row.tx_hash,
        logIndex: countFromSql(row.log_index, 'vault_claim_observation.log_index'),
      }
      return row.block_hash === null ? observation : { ...observation, blockHash: row.block_hash }
    })
  }

  async allocations(
    vault: Address,
    fromUnix: number,
    toUnix: number,
  ): Promise<AllocationObservation[]> {
    let rows: AllocationRow[]
    try {
      rows = await this.driver.query<AllocationRow>(
        `SELECT vault, asset, dev_minor, budget_minor, operator_minor, referrer_minor,
                occurred_at_unix, tx_hash, log_index, block_hash
           FROM vault_allocation_observation
          WHERE vault = $1 AND occurred_at_unix >= $2 AND occurred_at_unix <= $3
          ORDER BY block_number, log_index`,
        [vault.toLowerCase(), fromUnix, toUnix],
      )
    } catch (error) {
      throw new SourceUnavailableError('vault_allocation_observation', String(error), error)
    }
    return rows.map((row) => {
      const observation: AllocationObservation = {
        vault: row.vault,
        asset: row.asset,
        devMinor: bigIntFromSql(row.dev_minor, 'vault_allocation_observation.dev_minor'),
        budgetMinor: bigIntFromSql(row.budget_minor, 'vault_allocation_observation.budget_minor'),
        operatorMinor: bigIntFromSql(row.operator_minor, 'vault_allocation_observation.operator_minor'),
        referrerMinor: bigIntFromSql(row.referrer_minor, 'vault_allocation_observation.referrer_minor'),
        occurredAtUnix: countFromSql(
          row.occurred_at_unix,
          'vault_allocation_observation.occurred_at_unix',
        ),
        txHash: row.tx_hash,
        logIndex: countFromSql(row.log_index, 'vault_allocation_observation.log_index'),
      }
      return row.block_hash === null ? observation : { ...observation, blockHash: row.block_hash }
    })
  }

  async rollbackAboveBlock(vault: Address, blockNumber: bigint): Promise<number> {
    const params: readonly SqlValue[] = [vault.toLowerCase(), blockNumber.toString()]
    try {
      const claims = await this.driver.execute(
        'DELETE FROM vault_claim_observation WHERE vault = $1 AND block_number > $2::bigint',
        params,
      )
      const allocations = await this.driver.execute(
        'DELETE FROM vault_allocation_observation WHERE vault = $1 AND block_number > $2::bigint',
        params,
      )
      return claims.rowsAffected + allocations.rowsAffected
    } catch (error) {
      throw new SourceUnavailableError('vault movement rollback', String(error), error)
    }
  }
}

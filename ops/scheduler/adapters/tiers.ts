/**
 * The tier registry: vault_record.tier plus its history.
 *
 * `current()` reads the tier off the vault record, which is the same row the
 * tick's own tier phase writes, so the daily job and the tick can never hold
 * two opinions about a coin's tier. `apply()` writes back through the vault
 * repository - the one writer of vault_record - and appends the decision, with
 * the measurement that justified it, to ops_tier_history. Nothing here reads
 * config for a tier; the decision arrives already made.
 *
 * `daysBelowGate()` is the trailing run of below-gate days in
 * ops_qf_observation, one row per UTC day. Idempotent per day: observing the
 * same day twice overwrites the same row.
 */

import type { Address } from '@fee-split-vaults/core'
import type { VaultRepository } from '@fee-split-vaults/orchestrator'
import { canonicalDigest } from '../../lib/ids.js'
import { DAY } from '../../lib/time.js'
import type { TierId } from '../../lib/protocol.js'
import type { SqlDriver } from '../../migrations/driver.js'
import type { TierDecision, TierRegistry } from '../ports.js'
import { OpsAdapterError, boolOf, strOf } from './errors.js'

/** `yyyy-mm-dd` in UTC. */
export function utcDayKey(unix: number): string {
  return new Date(Math.floor(unix / DAY) * DAY * 1000).toISOString().slice(0, 10)
}

export class PgTierRegistry implements TierRegistry {
  constructor(
    private readonly driver: SqlDriver,
    private readonly vaults: VaultRepository,
  ) {}

  async current(vault: Address): Promise<TierId> {
    const record = await this.vaults.get(vault)
    if (record === undefined) throw new OpsAdapterError('vault_unknown', `no vault_record for ${vault}`)
    return record.tier
  }

  async daysBelowGate(vault: Address): Promise<number> {
    const rows = await this.driver.query<{ day_key: string; below_gate: boolean }>(
      `SELECT day_key, below_gate FROM ops_qf_observation WHERE vault = $1 ORDER BY day_key DESC`,
      [vault.toLowerCase()],
    )
    let run = 0
    for (const row of rows) {
      if (!boolOf(row.below_gate, 'ops_qf_observation.below_gate')) break
      run += 1
    }
    return run
  }

  async observe(input: { vault: Address; atUnix: number; qfPerDay: number; belowGate: boolean }): Promise<void> {
    await this.driver.execute(
      `INSERT INTO ops_qf_observation (vault, day_key, qf_per_day_usd, below_gate, observed_at_unix)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (vault, day_key) DO UPDATE SET
           qf_per_day_usd = EXCLUDED.qf_per_day_usd, below_gate = EXCLUDED.below_gate,
           observed_at_unix = EXCLUDED.observed_at_unix`,
      [input.vault.toLowerCase(), utcDayKey(input.atUnix), input.qfPerDay, input.belowGate, input.atUnix],
    )
  }

  async apply(decision: TierDecision): Promise<void> {
    const record = await this.vaults.get(decision.vault)
    if (record === undefined) throw new OpsAdapterError('vault_unknown', `no vault_record for ${decision.vault}`)
    if (record.tier !== decision.from) {
      throw new OpsAdapterError(
        'tier_stale',
        `tier decision for ${decision.vault} moves from ${decision.from} but the record holds ${record.tier}`,
      )
    }
    const id = `th_${canonicalDigest({
      vault: decision.vault.toLowerCase(),
      to: decision.to,
      at: decision.decidedAtUnix,
    }).slice(0, 32)}`
    await this.driver.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO ops_tier_history
             (id, vault, from_tier, to_tier, direction, qf_per_day_usd, observed_days, sustained_days, reason, decided_at_unix)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          id,
          decision.vault.toLowerCase(),
          decision.from,
          decision.to,
          decision.direction,
          decision.qfPerDay,
          decision.observedDays,
          decision.sustainedDays,
          decision.reason,
          decision.decidedAtUnix,
        ],
      )
      // The trailing run resets with the tier: the gate it was measured
      // against is no longer the gate.
      await tx.execute(`DELETE FROM ops_qf_observation WHERE vault = $1`, [decision.vault.toLowerCase()])
    })
    await this.vaults.put({ ...record, tier: decision.to })
  }

  /** Downgrades applied since `sinceUnix`. The monitoring collector reads this. */
  async downgradesSince(sinceUnix: number): Promise<Array<{ vault: string; from: string; to: string; qfPerDay: number }>> {
    const rows = await this.driver.query<{ vault: string; from_tier: string; to_tier: string; qf_per_day_usd: number | string }>(
      `SELECT vault, from_tier, to_tier, qf_per_day_usd FROM ops_tier_history
        WHERE direction = 'down' AND decided_at_unix >= $1
        ORDER BY decided_at_unix DESC`,
      [sinceUnix],
    )
    return rows.map((row) => ({
      vault: strOf(row.vault, 'ops_tier_history.vault'),
      from: strOf(row.from_tier, 'ops_tier_history.from_tier'),
      to: strOf(row.to_tier, 'ops_tier_history.to_tier'),
      qfPerDay: Number(row.qf_per_day_usd),
    }))
  }
}

/**
 * Re-screening, over the real engine and the real verdict store.
 *
 * The rescreen job hands this service an opaque `metadataRef`. It is a chain
 * coordinate (see metadata.ts), and this is the ONE place in ops that turns it
 * back into text: the two ERC-20 strings are read at the pinned block and
 * handed straight to the screening engine as its subject. Nothing between the
 * read and the engine logs, stores or returns them.
 *
 * The engine is constructed by the composition root with the same lexicon and
 * SDN sources the onboarding screen uses, so a token cannot pass onboarding
 * under one dictionary and re-screen under another. Without an adjudicator
 * every verdict is RESTRICTED - the engine's own posture - and the root records
 * that as a fake in the banner.
 *
 * `record()` writes the verdict through the orchestrator's store, which is
 * the only writer of screening_result, and keeps the metadata hash in
 * ops_screening_hash beside it so a repeat observation is recognised.
 *
 * A token whose metadata is observed on chain is, by that observation,
 * mutable: `metadataMutable` is true on every re-screen.
 */

import type { Address, ScreeningResult } from '@fee-split-vaults/core'
import type { ScreeningStore } from '@fee-split-vaults/orchestrator'
import { toScreeningResult, type ScreeningEngine } from '@fee-split-vaults/screening'
import type { Clock } from '../../lib/time.js'
import type { SqlDriver } from '../../migrations/driver.js'
import type { ScreeningService } from '../ports.js'
import { strOf } from './errors.js'
import { parseMetadataRef, type TokenMetadataReader } from './metadata.js'

export interface PgScreeningServiceDeps {
  driver: SqlDriver
  store: ScreeningStore
  engine: Pick<ScreeningEngine, 'screen'>
  reader: TokenMetadataReader
  clock: Clock
}

export class PgScreeningService implements ScreeningService {
  constructor(private readonly deps: PgScreeningServiceDeps) {}

  async rescreen(input: { token: Address; vault: Address; metadataRef: string }): Promise<ScreeningResult> {
    const { token, blockHash } = parseMetadataRef(input.metadataRef)
    const metadata = await this.deps.reader.read(token, blockHash)
    const report = await this.deps.engine.screen({
      token,
      name: metadata.name,
      symbol: metadata.symbol,
      metadataMutable: true,
      observedAtUnix: this.deps.clock.nowUnix(),
    })
    return toScreeningResult(report)
  }

  async lastResult(token: Address): Promise<(ScreeningResult & { metadataHash?: string }) | undefined> {
    const latest = await this.deps.store.latest(token)
    if (latest === undefined) return undefined
    const rows = await this.deps.driver.query<{ metadata_hash: string; screened_at_unix: number | string }>(
      `SELECT metadata_hash, screened_at_unix FROM ops_screening_hash WHERE token = $1`,
      [token.toLowerCase()],
    )
    const row = rows[0]
    // The hash belongs to the verdict it was recorded with. An older hash
    // beside a newer verdict (the API re-screened at onboarding, say) is not
    // this verdict's hash, so it is not returned as one.
    if (row === undefined || Number(row.screened_at_unix) !== latest.screenedAtUnix) return latest
    return { ...latest, metadataHash: strOf(row.metadata_hash, 'ops_screening_hash.metadata_hash') }
  }

  async record(result: ScreeningResult & { metadataHash: string }): Promise<void> {
    const { metadataHash, ...verdict } = result
    await this.deps.store.put(verdict)
    await this.deps.driver.execute(
      `INSERT INTO ops_screening_hash (token, metadata_hash, screened_at_unix) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET
           metadata_hash = EXCLUDED.metadata_hash, screened_at_unix = EXCLUDED.screened_at_unix`,
      [result.token.toLowerCase(), metadataHash, result.screenedAtUnix],
    )
  }
}

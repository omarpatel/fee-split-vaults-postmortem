/**
 * Token metadata, watched on chain.
 *
 * WHAT A VENUE MEMECOIN EXPOSES. The launch token is a plain ERC-20 and the
 * factory's LaunchedToken struct carries no URI, so the metadata that exists
 * on chain is `name()` and `symbol()`. Those are what this watcher reads, at
 * the head block both providers agree on, once per sweep for every observed
 * vault. An image, a description or a link would live off chain and there is
 * no on-chain pointer to one, so they are not fields this watcher can claim to
 * have observed - `changedFields` only ever names `name` or `symbol`.
 *
 * OPS NEVER READS THE TEXT. The change row carries a REF and a HASH. The ref
 * is a chain coordinate, `chain:<token>@<blockHash>`, that the screening
 * service dereferences by re-reading the same two calls at the same pinned
 * block; the hash is a digest over the two strings. The observed text is
 * decoded here only long enough to hash it and is not stored, not logged and
 * not returned.
 *
 * A first observation of a token is a change from nothing: the token is
 * screened at onboarding against what the dev submitted, and this is the first
 * time the chain's own words are compared against that.
 */

import type { Address } from '@fee-split-vaults/core'
import { selector, type BlockRef, type Hex, type PinnedCall } from '@fee-split-vaults/indexer'
import { canonicalDigest, sha256Hex } from '../../lib/ids.js'
import type { Clock } from '../../lib/time.js'
import type { SqlDriver } from '../../migrations/driver.js'
import type { MetadataChange, MetadataField, MetadataWatcher, VaultDirectory } from '../ports.js'
import { OBSERVED_STATES } from '../config.js'
import { OpsAdapterError, intOf, strOf } from './errors.js'

const NAME_CALL = selector('name()')
const SYMBOL_CALL = selector('symbol()')
const WORD = 64
const MAX_STRING_BYTES = 256

export interface PinnedReads {
  getBlockByTag(tag: 'latest'): Promise<BlockRef>
  call(request: PinnedCall): Promise<Hex>
}

export interface TokenMetadata {
  name: string
  symbol: string
}

const REF = /^chain:(0x[0-9a-f]{40})@(0x[0-9a-f]{64})$/

export function metadataRef(token: string, blockHash: string): string {
  return `chain:${token.toLowerCase()}@${blockHash.toLowerCase()}`
}

export function parseMetadataRef(ref: string): { token: Address; blockHash: Hex } {
  const match = REF.exec(ref)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new OpsAdapterError('metadata_ref_invalid', `not a chain metadata ref: ${ref}`)
  }
  return { token: match[1], blockHash: match[2] as Hex }
}

export function metadataHash(metadata: TokenMetadata): string {
  return sha256Hex(canonicalDigest({ name: metadata.name, symbol: metadata.symbol }))
}

/** ABI `string`: offset word, length word, bytes right-padded to a word. */
function decodeString(result: Hex, token: string, what: string): string {
  const body = result.slice(2)
  const word = (index: number): bigint => {
    const slice = body.slice(index * WORD, index * WORD + WORD)
    if (slice.length !== WORD) throw new OpsAdapterError('metadata_unreadable', `${token} ${what} is shorter than a word`)
    return BigInt(`0x${slice}`)
  }
  if (word(0) !== 32n) throw new OpsAdapterError('metadata_unreadable', `${token} ${what} is not a single ABI string`)
  const length = word(1)
  if (length > BigInt(MAX_STRING_BYTES)) {
    throw new OpsAdapterError('metadata_unreadable', `${token} ${what} is ${length.toString()} bytes; refusing over ${String(MAX_STRING_BYTES)}`)
  }
  const hex = body.slice(2 * WORD, 2 * WORD + Number(length) * 2)
  if (hex.length !== Number(length) * 2) throw new OpsAdapterError('metadata_unreadable', `${token} ${what} is truncated`)
  return Buffer.from(hex, 'hex').toString('utf8')
}

export class TokenMetadataReader {
  constructor(private readonly rpc: PinnedReads) {}

  async read(token: Address, blockHash: Hex): Promise<TokenMetadata> {
    const to = token.toLowerCase()
    let nameRaw: Hex
    let symbolRaw: Hex
    try {
      ;[nameRaw, symbolRaw] = await Promise.all([
        this.rpc.call({ to, data: NAME_CALL, blockHash }),
        this.rpc.call({ to, data: SYMBOL_CALL, blockHash }),
      ])
    } catch (error) {
      throw new OpsAdapterError('metadata_unreadable', `${to} at ${blockHash}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { name: decodeString(nameRaw, to, 'name()'), symbol: decodeString(symbolRaw, to, 'symbol()') }
  }
}

export interface ChainMetadataWatcherDeps {
  driver: SqlDriver
  rpc: PinnedReads
  reader: TokenMetadataReader
  vaults: VaultDirectory
  clock: Clock
}

const CURSOR_NAME = 'token_metadata'

interface ObservationRow {
  id: string
  token: string
  vault: string | null
  metadata_ref: string
  metadata_hash: string
  changed_fields: string
  observed_at_unix: number | string
  block_hash: string
}

const FIELDS: readonly MetadataField[] = ['name', 'symbol', 'image', 'description', 'links', 'socials']

export class ChainMetadataWatcher implements MetadataWatcher {
  constructor(private readonly deps: ChainMetadataWatcherDeps) {}

  /**
   * Observe every watched token at the current head and record the ones whose
   * name or symbol differs from the last observation. Returns the number of
   * rows written. The rescreen job then reads them through changedSince().
   */
  async observe(): Promise<number> {
    const at = await this.deps.rpc.getBlockByTag('latest')
    const nowUnix = this.deps.clock.nowUnix()
    let written = 0
    for (const vault of await this.deps.vaults.listByState(OBSERVED_STATES)) {
      const token = vault.token.toLowerCase()
      const metadata = await this.deps.reader.read(token, at.hash)
      const hash = metadataHash(metadata)
      const last = await this.deps.driver.query<{ metadata_hash: string; metadata_ref: string }>(
        `SELECT metadata_hash, metadata_ref FROM token_metadata_observation
          WHERE token = $1 ORDER BY observed_at_unix DESC LIMIT 1`,
        [token],
      )
      const lastRow = last[0]
      if (lastRow !== undefined && strOf(lastRow.metadata_hash, 'token_metadata_observation.metadata_hash') === hash) continue

      const changed: MetadataField[] = []
      if (lastRow === undefined) {
        changed.push('name', 'symbol')
      } else {
        const { token: prevToken, blockHash: prevBlock } = parseMetadataRef(strOf(lastRow.metadata_ref, 'token_metadata_observation.metadata_ref'))
        const previous = await this.deps.reader.read(prevToken, prevBlock)
        if (previous.name !== metadata.name) changed.push('name')
        if (previous.symbol !== metadata.symbol) changed.push('symbol')
        // Same hash inputs cannot differ in neither; a hash collision is not a reading.
        if (changed.length === 0) throw new OpsAdapterError('metadata_unreadable', `${token}: hash changed but neither field did`)
      }
      const ref = metadataRef(token, at.hash)
      const id = `mo_${canonicalDigest({ token, hash }).slice(0, 32)}`
      const result = await this.deps.driver.execute(
        `INSERT INTO token_metadata_observation
             (id, token, vault, metadata_ref, metadata_hash, changed_fields, observed_at_unix, block_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (token, metadata_hash) DO NOTHING`,
        [id, token, vault.address.toLowerCase(), ref, hash, changed.join(','), nowUnix, at.hash],
      )
      written += result.rowsAffected
    }
    return written
  }

  /**
   * Observes first, then reads: the rescreen job's sweep is the watcher's
   * cadence, and a chain that cannot be read makes the sweep fail rather than
   * report "no changes" over a book it did not look at.
   */
  async changedSince(cursorUnix: number, limit: number): Promise<MetadataChange[]> {
    await this.observe()
    const rows = await this.deps.driver.query<ObservationRow>(
      `SELECT id, token, vault, metadata_ref, metadata_hash, changed_fields, observed_at_unix, block_hash
         FROM token_metadata_observation
        WHERE observed_at_unix > $1
        ORDER BY observed_at_unix, id
        LIMIT $2`,
      [cursorUnix, limit],
    )
    const f = 'token_metadata_observation'
    return rows.map((row) => {
      const vault = row.vault
      if (vault === null || vault === undefined) throw new OpsAdapterError('row_malformed', `${f}.vault is null for ${row.token}`)
      const changedFields = strOf(row.changed_fields, `${f}.changed_fields`)
        .split(',')
        .filter((field) => field.length > 0)
        .map((field) => {
          if (!(FIELDS as readonly string[]).includes(field)) {
            throw new OpsAdapterError('row_malformed', `${f}.changed_fields names unknown field ${field}`)
          }
          return field as MetadataField
        })
      return {
        token: strOf(row.token, `${f}.token`),
        vault: strOf(vault, `${f}.vault`),
        metadataRef: strOf(row.metadata_ref, `${f}.metadata_ref`),
        metadataHash: strOf(row.metadata_hash, `${f}.metadata_hash`),
        changedFields,
        observedAtUnix: intOf(row.observed_at_unix, `${f}.observed_at_unix`),
        blockHash: strOf(row.block_hash, `${f}.block_hash`),
      }
    })
  }

  async cursor(): Promise<number> {
    const rows = await this.deps.driver.query<{ position_unix: number | string }>(
      `SELECT position_unix FROM ops_cursor WHERE name = $1`,
      [CURSOR_NAME],
    )
    const row = rows[0]
    return row === undefined ? 0 : intOf(row.position_unix, 'ops_cursor.position_unix')
  }

  async advanceCursor(toUnix: number): Promise<void> {
    await this.deps.driver.execute(
      `INSERT INTO ops_cursor (name, position_unix, updated_at_unix) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET
           position_unix = GREATEST(ops_cursor.position_unix, EXCLUDED.position_unix),
           updated_at_unix = EXCLUDED.updated_at_unix`,
      [CURSOR_NAME, toUnix, this.deps.clock.nowUnix()],
    )
  }
}

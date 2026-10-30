/**
 * Quote assets, described by the chain and governed by the operator.
 *
 * A report divides minor units by 10^decimals, so "USDG is 6 decimals" is a
 * money fact, and the one place it is true is the token contract. `describe`
 * reads `decimals()` and `symbol()` over the quorum, pinned by hash to the
 * head both providers agree on (the public providers serve no state as old as
 * `finalized`; see recipients.ts), once per asset, and refuses an asset that
 * answers with anything other than a uint8 and a string. There is no default
 * decimals value anywhere in this file.
 *
 * WHAT THE CHAIN CANNOT SAY. Whether an asset is ACCEPTED, whether its proxy
 * is pausable, and the per-transfer cap a claim must be chunked to are
 * operator decisions, and they live in the `quote_asset` table (0002) because
 * that is the one place they can be flipped WITHOUT a deploy - which is the
 * whole response to a pause event. `read` joins the two: the contract's own
 * symbol and decimals, cross-checked against the row, plus the row's policy.
 * An address with no row is not "enabled by default"; it is refused, because
 * a coin trading in an asset nobody approved is a coin whose fees cannot be
 * priced, claimed or reimbursed in anything this operator agreed to touch.
 */

import type { Asset } from '@fee-split-vaults/core'
import type { AssetRegistry } from '@fee-split-vaults/orchestrator'
import { normalizeAddress, selector, type BlockRef, type Hex } from '@fee-split-vaults/indexer'
import { boolFromSql, guarded, optStrFromSql, strFromSql } from '../pg/rows.js'
import { bigIntFromSql, countFromSql, type SqlDriver } from '../pg/sql.js'
import type { PinnedChainReads } from './recipients.js'

const DECIMALS_CALL = selector('decimals()')
const SYMBOL_CALL = selector('symbol()')
const WORD = 64

export type AssetReadErrorCode =
  /** decimals()/symbol() did not decode as a uint8 and a printable string. */
  | 'malformed'
  /** `read` was asked for policy and the reader was built without a policy source. */
  | 'no_policy'
  /** The address has no quote_asset row: nobody approved it. */
  | 'not_approved'
  /** The row and the contract disagree on symbol or decimals. */
  | 'contradiction'

export class AssetReadError extends Error {
  constructor(
    message: string,
    readonly asset: string,
    readonly code: AssetReadErrorCode = 'malformed',
  ) {
    super(`asset ${asset}: ${message}`)
    this.name = 'AssetReadError'
  }
}

/** What the token contract says about itself. Nothing here is a decision. */
export interface ChainAssetFacts {
  readonly address: string
  readonly symbol: string
  readonly decimals: number
  /** The block the reads were pinned to. */
  readonly blockHash: Hex
}

/** The operator's decisions about an asset, as the quote_asset row holds them. */
export interface AssetPolicy {
  readonly symbol: string
  readonly decimals: number
  readonly enabled: boolean
  readonly isPausableProxy: boolean
  readonly maxTransferMinor?: bigint
  readonly disabledReason?: string
}

export interface AssetPolicySource {
  /** The row for an address, or undefined when nobody approved it. */
  policy(address: string): Promise<AssetPolicy | undefined>
  /** Every approved address, enabled or not. */
  approved(): Promise<string[]>
}

function wordAt(body: string, index: number, asset: string, what: string): bigint {
  const slice = body.slice(index * WORD, index * WORD + WORD)
  if (slice.length !== WORD) throw new AssetReadError(`${what} is shorter than a word`, asset)
  return BigInt(`0x${slice}`)
}

/** ABI `string`: an offset word, a length word, then the bytes, right-padded. */
function decodeString(result: Hex, asset: string, what: string): string {
  const body = result.slice(2)
  const offset = wordAt(body, 0, asset, what)
  if (offset !== 32n) throw new AssetReadError(`${what} is not a single ABI string (offset ${offset})`, asset)
  const length = wordAt(body, 1, asset, what)
  if (length === 0n || length > 64n) throw new AssetReadError(`${what} length ${length} is not a symbol`, asset)
  const hex = body.slice(2 * WORD, 2 * WORD + Number(length) * 2)
  if (hex.length !== Number(length) * 2) throw new AssetReadError(`${what} is truncated`, asset)
  const text = Buffer.from(hex, 'hex').toString('utf8')
  if (!/^[\x20-\x7e]+$/.test(text)) throw new AssetReadError(`${what} is not printable ASCII`, asset)
  return text
}

export class ChainAssetReader {
  readonly #rpc: PinnedChainReads
  readonly #policy: AssetPolicySource | undefined
  readonly #known = new Map<string, ChainAssetFacts>()

  constructor(rpc: PinnedChainReads, policy?: AssetPolicySource) {
    this.#rpc = rpc
    this.#policy = policy
  }

  /** The contract's own symbol and decimals, pinned at `at`. Not cached: the block is the caller's. */
  async facts(address: string, at: BlockRef): Promise<ChainAssetFacts> {
    const key = normalizeAddress(address)
    const [decimalsRaw, symbolRaw] = await Promise.all([
      this.#rpc.call({ to: key, data: DECIMALS_CALL, blockHash: at.hash }),
      this.#rpc.call({ to: key, data: SYMBOL_CALL, blockHash: at.hash }),
    ])
    if (decimalsRaw.length !== 2 + WORD) throw new AssetReadError('decimals() did not return one word', key)
    const decimals = wordAt(decimalsRaw.slice(2), 0, key, 'decimals()')
    if (decimals > 255n) throw new AssetReadError(`decimals() ${decimals} is not a uint8`, key)
    return { address: key, symbol: decodeString(symbolRaw, key, 'symbol()'), decimals: Number(decimals), blockHash: at.hash }
  }

  /** The asset as its contract describes it, read once at the agreed head and kept. */
  async describe(address: string): Promise<ChainAssetFacts> {
    const key = normalizeAddress(address)
    const cached = this.#known.get(key)
    if (cached !== undefined) return cached
    await this.#rpc.assertChain()
    const facts = await this.facts(key, await this.#rpc.head())
    this.#known.set(key, facts)
    return facts
  }

  /**
   * The full asset: the contract's facts at `at`, joined to the operator's
   * policy row. Every disagreement between the two is a refusal - a row that
   * says 6 decimals over a contract that says 18 is a 10^12 error waiting for
   * the first reimbursement, and the honest reading of it is "someone changed
   * something and nobody re-verified".
   */
  async read(address: string, at: BlockRef): Promise<Asset> {
    const key = normalizeAddress(address)
    if (this.#policy === undefined) {
      throw new AssetReadError('no asset policy source; enabled/pausable/cap cannot be read from a contract', key, 'no_policy')
    }
    const policy = await this.#policy.policy(key)
    if (policy === undefined) {
      throw new AssetReadError('no quote_asset row; an asset nobody approved is not an asset this operator handles', key, 'not_approved')
    }
    const facts = await this.facts(key, at)
    if (facts.symbol !== policy.symbol || facts.decimals !== policy.decimals) {
      throw new AssetReadError(
        `the contract says ${facts.symbol}/${String(facts.decimals)} at ${at.hash} and quote_asset says ` +
          `${policy.symbol}/${String(policy.decimals)}; re-verify the row before this asset is touched`,
        key,
        'contradiction',
      )
    }
    return {
      address: key,
      symbol: facts.symbol,
      decimals: facts.decimals,
      isPausableProxy: policy.isPausableProxy,
      enabled: policy.enabled,
      ...(policy.maxTransferMinor === undefined ? {} : { maxTransferMinor: policy.maxTransferMinor }),
    }
  }
}

interface PolicyRow {
  address: string
  symbol: unknown
  decimals: unknown
  is_pausable_proxy: unknown
  enabled: unknown
  max_transfer_minor: unknown
  disabled_reason: unknown
}

/** The quote_asset table, as the policy source. Written by the ops CLI, read here. */
export class PgAssetPolicy implements AssetPolicySource {
  constructor(private readonly driver: SqlDriver) {}

  async policy(address: string): Promise<AssetPolicy | undefined> {
    const rows = await guarded('quote_asset', () =>
      this.driver.query<PolicyRow>(
        `SELECT address, symbol, decimals, is_pausable_proxy, enabled, max_transfer_minor, disabled_reason
           FROM quote_asset WHERE address = $1`,
        [normalizeAddress(address)],
      ),
    )
    const row = rows[0]
    if (row === undefined) return undefined
    const f = 'quote_asset'
    const cap = optStrFromSql(row.max_transfer_minor, `${f}.max_transfer_minor`)
    const disabledReason = optStrFromSql(row.disabled_reason, `${f}.disabled_reason`)
    return {
      symbol: strFromSql(row.symbol, `${f}.symbol`),
      decimals: countFromSql(row.decimals, `${f}.decimals`),
      enabled: boolFromSql(row.enabled, `${f}.enabled`),
      isPausableProxy: boolFromSql(row.is_pausable_proxy, `${f}.is_pausable_proxy`),
      ...(cap === undefined ? {} : { maxTransferMinor: bigIntFromSql(cap, `${f}.max_transfer_minor`) }),
      ...(disabledReason === undefined ? {} : { disabledReason }),
    }
  }

  async approved(): Promise<string[]> {
    const rows = await guarded('quote_asset', () =>
      this.driver.query<{ address: string }>('SELECT address FROM quote_asset ORDER BY address'),
    )
    return rows.map((row) => normalizeAddress(row.address))
  }
}

/**
 * The orchestrator's synchronous registry, loaded once at startup from the
 * chain and the policy table. `at` is kept so the run record can say which
 * block the decimals were read at; a registry that cannot say is a registry
 * whose numbers cannot be reproduced.
 */
export class ChainAssetRegistry implements AssetRegistry {
  readonly #byAddress = new Map<string, Asset>()

  constructor(
    assets: readonly Asset[],
    readonly at: BlockRef,
  ) {
    for (const asset of assets) this.#byAddress.set(normalizeAddress(asset.address), asset)
  }

  get(asset: string): Asset | undefined {
    return this.#byAddress.get(normalizeAddress(asset))
  }

  all(): readonly Asset[] {
    return [...this.#byAddress.values()]
  }
}

export interface LoadAssetRegistryOptions {
  readonly reader: ChainAssetReader
  /** The addresses the fleet's coins trade in. Every one is read; any refusal refuses the load. */
  readonly addresses: readonly string[]
  readonly at: BlockRef
}

export async function loadAssetRegistry(options: LoadAssetRegistryOptions): Promise<ChainAssetRegistry> {
  const assets: Asset[] = []
  const seen = new Set<string>()
  for (const address of options.addresses) {
    const key = normalizeAddress(address)
    if (seen.has(key)) continue
    seen.add(key)
    assets.push(await options.reader.read(key, options.at))
  }
  return new ChainAssetRegistry(assets, options.at)
}

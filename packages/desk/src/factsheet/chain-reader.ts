/**
 * Chain access for the FactSheet.
 *
 * Two rules shape this port.
 *
 * First, the desk never triggers a read from an inbound message. Reads happen on
 * a fixed schedule into a cache (see cache.ts); an attacker who can make the bot
 * talk cannot make the bot spend RPC. This mirrors the airlock's fixed-window
 * rule - there is no wake-on-mention path here either.
 *
 * Second, every read is pinned to a block HASH. A reorg changes what a block
 * number means; it never changes what a hash means. A field that cannot be read
 * comes back undefined and becomes an ABSENT fact, never a guessed one.
 *
 * The ERC-20 calls below are hardcoded because their selectors are universal.
 * The Venue-specific views are NOT: this package does not own the Venue ABI, so
 * they arrive as injected call descriptors from the adapter that does. An
 * unconfigured descriptor yields an absent field - it never yields a default.
 */

import type { Address, PoolId, UsdValue } from '@fee-split-vaults/core'

export interface BlockRef {
  hash: string
  number: number
  timestampUnix: number
}

export interface TokenIdentityRead {
  name?: string
  symbol?: string
  decimals?: number
}

export interface SupplyRead {
  totalSupplyMinor?: bigint
  burnedMinor?: bigint
  lockedMinor?: bigint
}

export interface PoolRead {
  poolId?: PoolId
  quoteAssetAddress?: Address
  quoteAssetSymbol?: string
  quoteAssetDecimals?: number
  quoteReserveMinor?: bigint
  tokenReserveMinor?: bigint
  /** Priced by a source the desk does not own; provenance travels with it. */
  liquidityUsd?: UsdValue
}

export interface FeeConfigRead {
  buybackEnabled?: boolean
  creatorTaxBps?: number
  feeRecipient?: Address
  /**
   * The Venue owner holds a 3-day-timelocked override that can reassign any
   * coin's fee recipient. A pending proposal is a fact holders are entitled to,
   * and an escalation to the dev.
   */
  feeRecipientChangeProposedUnix?: number
}

export interface LockRead {
  lpLocked?: boolean
  unlockUnix?: number
}

export interface AntiSnipeRead {
  initialBps?: number
  windowSeconds?: number
  exemptWallets?: Address[]
}

export interface LaunchRead {
  launchUnix?: number
}

export interface DeskChainReader {
  chainId(): Promise<number>
  latestBlock(): Promise<BlockRef>
  readTokenIdentity(token: Address, at: BlockRef): Promise<TokenIdentityRead>
  readSupply(token: Address, at: BlockRef): Promise<SupplyRead>
  readPool(token: Address, at: BlockRef): Promise<PoolRead>
  readFeeConfig(token: Address, at: BlockRef): Promise<FeeConfigRead>
  readLock(token: Address, at: BlockRef): Promise<LockRead>
  readAntiSnipe(token: Address, at: BlockRef): Promise<AntiSnipeRead>
  readLaunch(token: Address, at: BlockRef): Promise<LaunchRead>
}

export interface HolderRead {
  holderCount?: number
  top10SharePct?: number
  deployerSharePct?: number
  observedAtUnix: number
}

/** Holder concentration cannot come from one call; it needs an index. */
export interface DeskHolderIndex {
  readHolders(token: Address): Promise<HolderRead>
}

export interface CreditedFeesRead {
  last24hUsd?: UsdValue
  lifetimeUsd?: UsdValue
  observedAtUnix: number
}

/**
 * Per-coin fee attribution comes from the ledger, which drives receipts off the
 * hook's PoolFeesSwept(poolId, ...) events. It CANNOT come from escrow events:
 * post-graduation every client shares one depositor and no escrow event carries
 * a coin identifier.
 */
export interface DeskFeeLedger {
  readCreditedFees(vault: Address): Promise<CreditedFeesRead>
}

// ---------------------------------------------------------------------------
// JSON-RPC implementation
// ---------------------------------------------------------------------------

export interface JsonRpcTransport {
  request(method: string, params: unknown[]): Promise<unknown>
}

export type ReturnKind = 'uint256' | 'address' | 'bool' | 'bytes32' | 'string' | 'address[]'

/** A view call the desk does not own the ABI for. Supplied by the Venue adapter. */
export interface ViewCallSpec {
  to: Address
  /** 4-byte selector, 0x-prefixed. */
  selector: string
  /** Whether the token address is appended as the sole argument. */
  tokenArg: boolean
  returns: ReturnKind
}

/**
 * Venue view calls, injected. Any key left out makes its field absent rather
 * than defaulted, which is the whole point: this desk never invents a value.
 */
export interface VenueViewCalls {
  poolId?: ViewCallSpec
  quoteAsset?: ViewCallSpec
  quoteReserve?: ViewCallSpec
  tokenReserve?: ViewCallSpec
  buybackEnabled?: ViewCallSpec
  creatorTaxBps?: ViewCallSpec
  feeRecipient?: ViewCallSpec
  feeRecipientChangeProposedUnix?: ViewCallSpec
  lpLocked?: ViewCallSpec
  lpUnlockUnix?: ViewCallSpec
  antiSnipeInitialBps?: ViewCallSpec
  antiSnipeWindowSeconds?: ViewCallSpec
  antiSnipeExemptWallets?: ViewCallSpec
  launchUnix?: ViewCallSpec
}

const ERC20 = {
  /** totalSupply() */
  totalSupply: '0x18160ddd',
  /** balanceOf(address) */
  balanceOf: '0x70a08231',
  /** decimals() */
  decimals: '0x313ce567',
  /** symbol() */
  symbol: '0x95d89b41',
  /** name() */
  name: '0x06fdde03',
} as const

const BURN_ADDRESSES: readonly Address[] = [
  '0x000000000000000000000000000000000000dEaD',
  '0x0000000000000000000000000000000000000000',
]

function stripHex(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
}

function padAddress(address: Address): string {
  const clean = stripHex(address).toLowerCase()
  if (clean.length !== 40) throw new Error(`not an address: ${address}`)
  return clean.padStart(64, '0')
}

function word(data: string, index: number): string {
  return data.slice(index * 64, index * 64 + 64)
}

/** Legacy bytes32 name/symbol values are NUL-padded to a full word. */
function trimNulls(input: string): string {
  let end = input.length
  while (end > 0 && input.charCodeAt(end - 1) === 0) end--
  return input.slice(0, end)
}

export function decodeUint(data: string): bigint | undefined {
  const clean = stripHex(data)
  if (clean.length < 64) return undefined
  return BigInt('0x' + word(clean, 0))
}

export function decodeAddress(data: string): Address | undefined {
  const clean = stripHex(data)
  if (clean.length < 64) return undefined
  const raw = word(clean, 0).slice(24)
  if (/^0+$/.test(raw)) return undefined
  return '0x' + raw
}

export function decodeBool(data: string): boolean | undefined {
  const v = decodeUint(data)
  if (v === undefined) return undefined
  if (v !== 0n && v !== 1n) return undefined
  return v === 1n
}

/** Handles both the ABI string encoding and the legacy bytes32 form. */
export function decodeString(data: string): string | undefined {
  const clean = stripHex(data)
  if (clean.length === 0) return undefined
  if (clean.length === 64) {
    const bytes = Buffer.from(clean, 'hex')
    const text = trimNulls(bytes.toString('utf8'))
    return text.length > 0 ? text : undefined
  }
  if (clean.length < 128) return undefined
  const offset = Number(BigInt('0x' + word(clean, 0)))
  if (!Number.isSafeInteger(offset) || offset % 32 !== 0) return undefined
  const lengthWord = clean.slice(offset * 2, offset * 2 + 64)
  if (lengthWord.length < 64) return undefined
  const length = Number(BigInt('0x' + lengthWord))
  if (!Number.isSafeInteger(length) || length > 1024) return undefined
  const body = clean.slice(offset * 2 + 64, offset * 2 + 64 + length * 2)
  if (body.length < length * 2) return undefined
  return Buffer.from(body, 'hex').toString('utf8')
}

export function decodeAddressArray(data: string, max = 64): Address[] | undefined {
  const clean = stripHex(data)
  if (clean.length < 128) return undefined
  const offset = Number(BigInt('0x' + word(clean, 0)))
  if (!Number.isSafeInteger(offset) || offset % 32 !== 0) return undefined
  const base = offset * 2
  const lengthWord = clean.slice(base, base + 64)
  if (lengthWord.length < 64) return undefined
  const length = Number(BigInt('0x' + lengthWord))
  if (!Number.isSafeInteger(length) || length > max) return undefined
  const out: Address[] = []
  for (let i = 0; i < length; i++) {
    const w = clean.slice(base + 64 + i * 64, base + 64 + (i + 1) * 64)
    if (w.length < 64) return undefined
    out.push('0x' + w.slice(24))
  }
  return out
}

interface RpcBlock {
  hash?: string
  number?: string
  timestamp?: string
}

/**
 * Reads over a JSON-RPC endpoint. Every failure - transport error, revert,
 * short return data - resolves to an absent field. Nothing here throws its way
 * into an answer, and nothing here substitutes a default.
 */
export class RpcDeskChainReader implements DeskChainReader {
  constructor(
    private readonly transport: JsonRpcTransport,
    private readonly calls: VenueViewCalls,
    private readonly launchLocker?: Address,
  ) {}

  async chainId(): Promise<number> {
    const raw = await this.transport.request('eth_chainId', [])
    if (typeof raw !== 'string') throw new Error('eth_chainId returned a non-string')
    return Number(BigInt(raw))
  }

  async latestBlock(): Promise<BlockRef> {
    const raw = (await this.transport.request('eth_getBlockByNumber', ['latest', false])) as
      | RpcBlock
      | null
    if (!raw || typeof raw.hash !== 'string' || typeof raw.number !== 'string') {
      throw new Error('eth_getBlockByNumber returned no usable head')
    }
    return {
      hash: raw.hash,
      number: Number(BigInt(raw.number)),
      timestampUnix: typeof raw.timestamp === 'string' ? Number(BigInt(raw.timestamp)) : 0,
    }
  }

  /** EIP-1898 block-hash pinning. Never `latest`, never a block number. */
  private async call(to: Address, data: string, at: BlockRef): Promise<string | undefined> {
    try {
      const raw = await this.transport.request('eth_call', [
        { to, data },
        { blockHash: at.hash, requireCanonical: true },
      ])
      return typeof raw === 'string' ? raw : undefined
    } catch {
      return undefined
    }
  }

  /**
   * A descriptor whose declared return type does not match what the caller is
   * about to decode is a configuration error, and a configuration error decodes
   * to a plausible-looking wrong number. Fail closed instead.
   */
  private async view(
    spec: ViewCallSpec | undefined,
    token: Address,
    at: BlockRef,
    expected: ReturnKind,
  ): Promise<string | undefined> {
    if (!spec || spec.returns !== expected) return undefined
    const data = spec.tokenArg ? spec.selector + padAddress(token) : spec.selector
    return this.call(spec.to, data, at)
  }

  private async viewUint(
    spec: ViewCallSpec | undefined,
    token: Address,
    at: BlockRef,
  ): Promise<bigint | undefined> {
    const raw = await this.view(spec, token, at, 'uint256')
    return raw === undefined ? undefined : decodeUint(raw)
  }

  private async viewNumber(
    spec: ViewCallSpec | undefined,
    token: Address,
    at: BlockRef,
    max: number,
  ): Promise<number | undefined> {
    const v = await this.viewUint(spec, token, at)
    if (v === undefined || v > BigInt(max)) return undefined
    return Number(v)
  }

  async readTokenIdentity(token: Address, at: BlockRef): Promise<TokenIdentityRead> {
    const [name, symbol, decimals] = await Promise.all([
      this.call(token, ERC20.name, at),
      this.call(token, ERC20.symbol, at),
      this.call(token, ERC20.decimals, at),
    ])
    const decimalsValue = decimals === undefined ? undefined : decodeUint(decimals)
    return {
      name: name === undefined ? undefined : decodeString(name),
      symbol: symbol === undefined ? undefined : decodeString(symbol),
      decimals:
        decimalsValue === undefined || decimalsValue > 36n ? undefined : Number(decimalsValue),
    }
  }

  async readSupply(token: Address, at: BlockRef): Promise<SupplyRead> {
    const totalRaw = await this.call(token, ERC20.totalSupply, at)
    const burnRaws = await Promise.all(
      BURN_ADDRESSES.map((burn) => this.call(token, ERC20.balanceOf + padAddress(burn), at)),
    )
    const lockedRaw = this.launchLocker
      ? await this.call(token, ERC20.balanceOf + padAddress(this.launchLocker), at)
      : undefined

    let burned: bigint | undefined
    for (const raw of burnRaws) {
      if (raw === undefined) {
        burned = undefined
        break
      }
      const v = decodeUint(raw)
      if (v === undefined) {
        burned = undefined
        break
      }
      burned = (burned ?? 0n) + v
    }

    return {
      totalSupplyMinor: totalRaw === undefined ? undefined : decodeUint(totalRaw),
      burnedMinor: burned,
      lockedMinor: lockedRaw === undefined ? undefined : decodeUint(lockedRaw),
    }
  }

  async readPool(token: Address, at: BlockRef): Promise<PoolRead> {
    const [poolIdRaw, quoteRaw, quoteReserveRaw, tokenReserveRaw] = await Promise.all([
      this.view(this.calls.poolId, token, at, 'bytes32'),
      this.view(this.calls.quoteAsset, token, at, 'address'),
      this.viewUint(this.calls.quoteReserve, token, at),
      this.viewUint(this.calls.tokenReserve, token, at),
    ])

    const quoteAssetAddress = quoteRaw === undefined ? undefined : decodeAddress(quoteRaw)
    let quoteAssetSymbol: string | undefined
    let quoteAssetDecimals: number | undefined
    if (quoteAssetAddress) {
      const [symbolRaw, decimalsRaw] = await Promise.all([
        this.call(quoteAssetAddress, ERC20.symbol, at),
        this.call(quoteAssetAddress, ERC20.decimals, at),
      ])
      quoteAssetSymbol = symbolRaw === undefined ? undefined : decodeString(symbolRaw)
      const d = decimalsRaw === undefined ? undefined : decodeUint(decimalsRaw)
      quoteAssetDecimals = d === undefined || d > 36n ? undefined : Number(d)
    }

    return {
      poolId: poolIdRaw === undefined ? undefined : poolIdRaw,
      quoteAssetAddress,
      quoteAssetSymbol,
      quoteAssetDecimals,
      quoteReserveMinor: quoteReserveRaw,
      tokenReserveMinor: tokenReserveRaw,
    }
  }

  async readFeeConfig(token: Address, at: BlockRef): Promise<FeeConfigRead> {
    const [buybackRaw, recipientRaw] = await Promise.all([
      this.view(this.calls.buybackEnabled, token, at, 'bool'),
      this.view(this.calls.feeRecipient, token, at, 'address'),
    ])
    const [creatorTaxBps, proposedUnix] = await Promise.all([
      this.viewNumber(this.calls.creatorTaxBps, token, at, 10_000),
      this.viewNumber(this.calls.feeRecipientChangeProposedUnix, token, at, 2_000_000_000),
    ])
    return {
      buybackEnabled: buybackRaw === undefined ? undefined : decodeBool(buybackRaw),
      creatorTaxBps,
      feeRecipient: recipientRaw === undefined ? undefined : decodeAddress(recipientRaw),
      feeRecipientChangeProposedUnix:
        proposedUnix === undefined || proposedUnix === 0 ? undefined : proposedUnix,
    }
  }

  async readLock(token: Address, at: BlockRef): Promise<LockRead> {
    const lockedRaw = await this.view(this.calls.lpLocked, token, at, 'bool')
    const unlockUnix = await this.viewNumber(this.calls.lpUnlockUnix, token, at, 2_000_000_000)
    return {
      lpLocked: lockedRaw === undefined ? undefined : decodeBool(lockedRaw),
      unlockUnix: unlockUnix === 0 ? undefined : unlockUnix,
    }
  }

  async readAntiSnipe(token: Address, at: BlockRef): Promise<AntiSnipeRead> {
    const [initialBps, windowSeconds] = await Promise.all([
      this.viewNumber(this.calls.antiSnipeInitialBps, token, at, 10_000),
      this.viewNumber(this.calls.antiSnipeWindowSeconds, token, at, 86_400),
    ])
    const exemptRaw = await this.view(this.calls.antiSnipeExemptWallets, token, at, 'address[]')
    return {
      initialBps,
      windowSeconds,
      exemptWallets: exemptRaw === undefined ? undefined : decodeAddressArray(exemptRaw),
    }
  }

  async readLaunch(token: Address, at: BlockRef): Promise<LaunchRead> {
    const launchUnix = await this.viewNumber(this.calls.launchUnix, token, at, 2_000_000_000)
    return { launchUnix: launchUnix === 0 ? undefined : launchUnix }
  }
}

// ---------------------------------------------------------------------------
// In-memory fake
// ---------------------------------------------------------------------------

export interface FakeChainState {
  chainId: number
  block: BlockRef
  identity: TokenIdentityRead
  supply: SupplyRead
  pool: PoolRead
  feeConfig: FeeConfigRead
  lock: LockRead
  antiSnipe: AntiSnipeRead
  launch: LaunchRead
}

/**
 * Deterministic reader for tests and for the T0 cost model, where a full day of
 * traffic must cost about a cent. Setting any field to undefined is how a test
 * expresses "this read failed" - which must produce an absent fact.
 */
export class FakeDeskChainReader implements DeskChainReader {
  calls = 0

  constructor(public state: FakeChainState) {}

  async chainId(): Promise<number> {
    this.calls++
    return this.state.chainId
  }
  async latestBlock(): Promise<BlockRef> {
    this.calls++
    return this.state.block
  }
  async readTokenIdentity(): Promise<TokenIdentityRead> {
    this.calls++
    return this.state.identity
  }
  async readSupply(): Promise<SupplyRead> {
    this.calls++
    return this.state.supply
  }
  async readPool(): Promise<PoolRead> {
    this.calls++
    return this.state.pool
  }
  async readFeeConfig(): Promise<FeeConfigRead> {
    this.calls++
    return this.state.feeConfig
  }
  async readLock(): Promise<LockRead> {
    this.calls++
    return this.state.lock
  }
  async readAntiSnipe(): Promise<AntiSnipeRead> {
    this.calls++
    return this.state.antiSnipe
  }
  async readLaunch(): Promise<LaunchRead> {
    this.calls++
    return this.state.launch
  }
}

export class FakeHolderIndex implements DeskHolderIndex {
  constructor(public read: HolderRead) {}
  async readHolders(): Promise<HolderRead> {
    return this.read
  }
}

export class FakeFeeLedger implements DeskFeeLedger {
  constructor(public read: CreditedFeesRead) {}
  async readCreditedFees(): Promise<CreditedFeesRead> {
    return this.read
  }
}

/**
 * The desk's chain reader, over the same two-provider quorum the indexer uses.
 *
 * The desk package ships `RpcDeskChainReader`, which knows ERC-20 and takes a
 * table of single-value Venue view calls it does not own the ABI for. The live
 * Venue surface has no such views: everything about a launched token comes back
 * from one struct-returning call, `factory.getLaunchedToken(token)`, which the
 * indexer already decodes. So this class keeps the desk reader for the ERC-20
 * half and answers the Venue half from that struct, at the same pinned block.
 *
 * WHAT IS ABSENT STAYS ABSENT. The pool id is a candidate until a
 * PoolRegistered log confirms it, the LP lock and the live anti-snipe curve
 * have no view we have verified, and the launch instant lives in a log the
 * onboarding reader scans for. None of those is guessed here: an absent field
 * makes the desk answer "I have not verified that", which is the design.
 */

import type { Address } from '@fee-split-vaults/core'
import {
  RpcDeskChainReader,
  type AntiSnipeRead,
  type BlockRef,
  type DeskChainReader,
  type FeeConfigRead,
  type JsonRpcTransport,
  type LaunchRead,
  type LockRead,
  type PoolRead,
  type SupplyRead,
  type TokenIdentityRead,
} from '@fee-split-vaults/desk'
import {
  GET_LAUNCHED_TOKEN_SELECTOR,
  decodeLaunchedToken,
  encodeAddressArgCall,
  isHex,
  normalizeHash32,
  type LaunchedToken,
  type RpcClient,
} from '@fee-split-vaults/indexer'
import { VENUE } from '../../../../config/protocol.js'

/** The reads this class makes, in the shape QuorumRpc offers them. */
export type DeskChainReads = Pick<RpcClient, 'getChainId' | 'getBlockByTag' | 'call'>

/**
 * The desk reader speaks raw JSON-RPC; the quorum speaks typed, pinned calls.
 * This bridge accepts exactly the three methods the desk reader issues and
 * refuses anything else, so the desk cannot reach an unpinned read by naming
 * a method the quorum does not vet.
 */
export class QuorumDeskTransport implements JsonRpcTransport {
  constructor(private readonly rpc: DeskChainReads) {}

  async request(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case 'eth_chainId':
        return `0x${(await this.rpc.getChainId()).toString(16)}`
      case 'eth_getBlockByNumber': {
        const block = await this.rpc.getBlockByTag(params[0] === 'finalized' ? 'finalized' : 'latest')
        return {
          hash: block.hash,
          number: `0x${block.number.toString(16)}`,
          timestamp: `0x${block.timestampUnix.toString(16)}`,
        }
      }
      case 'eth_call': {
        const [call, at] = params
        const to = call !== null && typeof call === 'object' && 'to' in call ? call.to : undefined
        const data = call !== null && typeof call === 'object' && 'data' in call ? call.data : undefined
        const blockHash = at !== null && typeof at === 'object' && 'blockHash' in at ? at.blockHash : undefined
        if (typeof to !== 'string' || !isHex(data) || !isHex(blockHash)) {
          throw new Error('eth_call: the desk reader must pin every call to a block hash')
        }
        return this.rpc.call({ to, data, blockHash })
      }
      default:
        throw new Error(`${method} is not a read the desk may make`)
    }
  }
}

export interface VenueDeskChainReaderOptions {
  /** Defaults to VENUE.contracts.v2Factory. */
  factory?: Address
  /** Defaults to VENUE.contracts.v2LaunchLocker; balances held here count as locked supply. */
  launchLocker?: Address
}

export class VenueDeskChainReader implements DeskChainReader {
  readonly #rpc: DeskChainReads
  readonly #erc20: RpcDeskChainReader
  readonly #factory: Address

  constructor(rpc: DeskChainReads, options: VenueDeskChainReaderOptions = {}) {
    this.#rpc = rpc
    this.#factory = options.factory ?? VENUE.contracts.v2Factory
    this.#erc20 = new RpcDeskChainReader(
      new QuorumDeskTransport(rpc),
      {},
      options.launchLocker ?? VENUE.contracts.v2LaunchLocker,
    )
  }

  chainId(): Promise<number> {
    return this.#rpc.getChainId()
  }

  async latestBlock(): Promise<BlockRef> {
    const block = await this.#rpc.getBlockByTag('latest')
    return { hash: block.hash, number: Number(block.number), timestampUnix: block.timestampUnix }
  }

  readTokenIdentity(token: Address, at: BlockRef): Promise<TokenIdentityRead> {
    return this.#erc20.readTokenIdentity(token, at)
  }

  readSupply(token: Address, at: BlockRef): Promise<SupplyRead> {
    return this.#erc20.readSupply(token, at)
  }

  /**
   * One pinned read of the factory's LaunchedToken. A revert, a transport
   * failure, a malformed struct, or `exists == false` all resolve to
   * undefined - every field that depends on it becomes absent, never a guess.
   */
  async #launched(token: Address, at: BlockRef): Promise<LaunchedToken | undefined> {
    try {
      const raw = await this.#rpc.call({
        to: this.#factory,
        data: encodeAddressArgCall(GET_LAUNCHED_TOKEN_SELECTOR, token),
        blockHash: normalizeHash32(at.hash),
      })
      const launched = decodeLaunchedToken(raw)
      return launched.exists ? launched : undefined
    } catch {
      return undefined
    }
  }

  async readPool(token: Address, at: BlockRef): Promise<PoolRead> {
    const launched = await this.#launched(token, at)
    if (launched === undefined) return {}
    const quoteAssetAddress = launched.pairToken
    const identity = await this.#erc20.readTokenIdentity(quoteAssetAddress, at)
    return {
      quoteAssetAddress,
      ...(identity.symbol === undefined ? {} : { quoteAssetSymbol: identity.symbol }),
      ...(identity.decimals === undefined ? {} : { quoteAssetDecimals: identity.decimals }),
    }
  }

  async readFeeConfig(token: Address, at: BlockRef): Promise<FeeConfigRead> {
    const launched = await this.#launched(token, at)
    if (launched === undefined) return {}
    return {
      buybackEnabled: launched.buybackEnabled,
      creatorTaxBps: launched.creatorTaxBps,
      feeRecipient: launched.creatorFeeRecipient,
    }
  }

  async readLock(): Promise<LockRead> {
    return {}
  }

  async readAntiSnipe(): Promise<AntiSnipeRead> {
    return {}
  }

  async readLaunch(): Promise<LaunchRead> {
    return {}
  }
}

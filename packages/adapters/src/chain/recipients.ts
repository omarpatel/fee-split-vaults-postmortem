/**
 * Who the chain says a token pays, read at a pinned block.
 *
 * The onboarding machine asks two questions of a token before it will take a
 * dev's money: is the creator fee recipient the vault we predicted, and when
 * did the token launch. Both answers come from the Venue launch factory and
 * nowhere else - the first from `getLaunchedToken(token).creatorFeeRecipient`,
 * the second from the block that carried the `TokenLaunched` log. Every read
 * goes through the two-provider quorum and is pinned by hash to the block
 * `rpc.head()` hands back, because the answer decides whether service starts.
 *
 * THE PIN IS NOT `finalized`. On this chain finalized trails the head by
 * thousands of blocks and the public providers serve no state that old: an
 * eth_call there answers "historical state is not available". What `head()`
 * returns is the caller's choice - the raw quorum gives the agreed tip; the
 * API hands in a settled block a few minutes below it, since the public
 * endpoints are load balancers whose backend nodes lag each other. Nothing
 * here grants budget authority; it decides whether the dev's pointing is
 * visible yet, and a later pin only delays a yes.
 *
 * A read that fails THROWS. There is no "probably still pointed" path: the
 * caller turns the throw into a refusal, which is the correct answer to a
 * chain we could not read.
 */

import {
  GET_LAUNCHED_TOKEN_SELECTOR,
  TOKEN_LAUNCHED,
  addressEquals,
  addressToTopic,
  decodeLaunchedToken,
  encodeAddressArgCall,
  normalizeAddress,
  DEFAULT_QUERY_LIMITS,
  type BlockRef,
  type Hex,
  type LaunchedToken,
  type LogQuery,
  type PinnedCall,
  type QueryLimits,
  type RpcLog,
} from '@fee-split-vaults/indexer'
import { VENUE } from '../../../../config/protocol.js'

/**
 * The reads this adapter makes, in the shape QuorumRpc offers them. Typed
 * structurally so a test can hand in a recording fake and so nothing here can
 * reach a write method by accident.
 */
export interface PinnedChainReads {
  assertChain(): Promise<void>
  head(): Promise<BlockRef>
  blockByNumber(blockNumber: bigint): Promise<BlockRef | null>
  blockByHash(blockHash: Hex): Promise<BlockRef | null>
  getLogs(query: LogQuery): Promise<RpcLog[]>
  call(request: PinnedCall): Promise<Hex>
}

export type RecipientReadErrorCode =
  | 'token_not_launched'
  | 'registry_contradiction'
  | 'launch_block_unreadable'

export class RecipientReadError extends Error {
  constructor(
    message: string,
    readonly code: RecipientReadErrorCode,
  ) {
    super(`recipients: ${message}`)
    this.name = new.target.name
  }
}

export interface ChainRecipientReaderOptions {
  readonly rpc: PinnedChainReads
  /** The Venue launch factory. Defaults to VENUE.contracts.v2Factory. */
  readonly registry?: string
  /**
   * How far below the agreed head the TokenLaunched scan reaches before it
   * stops. Bounded because the quorum refuses unbounded log queries and the
   * chain answers under one request a second; the default covers hours of
   * blocks, which is many multiples of the anti-snipe hold this feeds.
   */
  readonly launchScanBlocks?: bigint
  readonly queryLimits?: QueryLimits
}

/** ~3 hours of ~0.25s blocks: twenty 2000-block queries, twelve times the anti-snipe hold. */
const DEFAULT_LAUNCH_SCAN_BLOCKS = 40_000n

export class ChainRecipientReader {
  readonly #rpc: PinnedChainReads
  readonly #registry: string
  readonly #launchScanBlocks: bigint
  readonly #chunkBlocks: bigint
  #chainVerified = false

  constructor(options: ChainRecipientReaderOptions) {
    this.#rpc = options.rpc
    this.#registry = normalizeAddress(options.registry ?? VENUE.contracts.v2Factory)
    this.#launchScanBlocks = options.launchScanBlocks ?? DEFAULT_LAUNCH_SCAN_BLOCKS
    if (this.#launchScanBlocks < 1n) throw new RangeError('launchScanBlocks must be >= 1')
    this.#chunkBlocks = (options.queryLimits ?? DEFAULT_QUERY_LIMITS).maxBlockSpan
  }

  /** The factory's record for `token` at the agreed head, or a refusal when it has none. */
  async launchedToken(token: string): Promise<{ launched: LaunchedToken; at: BlockRef }> {
    await this.#assertChain()
    const at = await this.#rpc.head()
    const raw = await this.#rpc.call({
      to: this.#registry,
      data: encodeAddressArgCall(GET_LAUNCHED_TOKEN_SELECTOR, token),
      blockHash: at.hash,
    })
    const launched = decodeLaunchedToken(raw)
    if (!launched.exists) {
      throw new RecipientReadError(`the launch factory has no record of ${token}`, 'token_not_launched')
    }
    if (!addressEquals(launched.token, token)) {
      // A struct for a different token under this key is a registry we do not
      // understand, and the recipient in it is somebody else's.
      throw new RecipientReadError(
        `getLaunchedToken(${token}) describes ${launched.token}`,
        'registry_contradiction',
      )
    }
    return { launched, at }
  }

  async creatorFeeRecipient(token: string): Promise<string> {
    const { launched } = await this.launchedToken(token)
    return normalizeAddress(launched.creatorFeeRecipient)
  }

  /**
   * When the token launched: the timestamp of the block carrying its
   * TokenLaunched log, found by scanning the factory backwards from the
   * agreed head within `launchScanBlocks`.
   *
   * A launch older than the scan window is not dated exactly. The token
   * demonstrably exists (getLaunchedToken says so), so its launch precedes the
   * oldest scanned block, and THAT block's timestamp is returned: an upper
   * bound, never later than the truth. The one consumer - the anti-snipe hold,
   * which asks whether enough time has passed SINCE launch - is conservative
   * under an upper bound, and a launch this old has long cleared it anyway.
   */
  async launchedAtUnix(token: string): Promise<number> {
    const { at } = await this.launchedToken(token)
    const topics: LogQuery['topics'] = [TOKEN_LAUNCHED.topic0, addressToTopic(token)]
    const floor = at.number >= this.#launchScanBlocks ? at.number - this.#launchScanBlocks + 1n : 0n

    let toBlock = at.number
    while (toBlock >= floor) {
      const fromBlock = toBlock - this.#chunkBlocks + 1n > floor ? toBlock - this.#chunkBlocks + 1n : floor
      const logs = await this.#rpc.getLogs({ fromBlock, toBlock, address: [this.#registry], topics })
      const launch = logs.find((log) => !log.removed)
      if (launch !== undefined) {
        const block = await this.#rpc.blockByHash(launch.blockHash)
        if (block === null) {
          throw new RecipientReadError(
            `block ${launch.blockHash} carrying the launch of ${token} is not canonical`,
            'launch_block_unreadable',
          )
        }
        return block.timestampUnix
      }
      if (fromBlock === floor) break
      toBlock = fromBlock - 1n
    }

    const oldest = await this.#rpc.blockByNumber(floor)
    if (oldest === null) {
      throw new RecipientReadError(`block ${floor} at the edge of the launch scan is unreadable`, 'launch_block_unreadable')
    }
    return oldest.timestampUnix
  }

  async #assertChain(): Promise<void> {
    if (this.#chainVerified) return
    await this.#rpc.assertChain()
    this.#chainVerified = true
  }
}

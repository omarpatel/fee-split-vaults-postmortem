/**
 * Fraud diligence, as far as chain 4663 can actually answer it.
 *
 * Every read here is pinned to the block the API's settled quorum hands back
 * and every answer names what it is: a bytecode fact, a locker view, a curve
 * quote. Where the chain cannot establish a check the answer is `unknown`,
 * which the gate counts as a failure - and the boot banner says which checks
 * this probe makes real, so nobody reads a refusal as a verdict.
 *
 * WHAT IS REAL.
 *
 * - mint / freeze authority: a walk of the token's runtime bytecode collecting
 *   PUSH4 immediates, which is where a Solidity dispatcher keeps its function
 *   selectors. A token whose code carries no mint(...) selector cannot mint;
 *   one that carries it has a mint path we cannot prove is disabled, so it
 *   FAILS rather than passes on the strength of an owner() read. A contract
 *   that delegates (DELEGATECALL in its code, or an EIP-1167 clone) can hide
 *   anything behind the implementation and is `unknown`.
 * - LP lock: the Venue launch locker's `isLocked(token)` view (Sourcify-
 *   verified ABI, 0x267444D0…; no unlock, withdraw or transfer function
 *   exists on it, so a lock is permanent). Before graduation the liquidity
 *   sits inside the factory-deployed launch curve that getLaunchedToken names,
 *   which is reported as protocol custody by the launch factory.
 * - exit tax: quoted from the curve's `feeBps()` and `currentSnipeTaxBps()`
 *   views while the token is on its curve - the two components of the tax a
 *   sell pays on a Venue curve. No trade is executed and nothing is signed.
 *   After graduation there is no quote view on the v4 pool this probe can
 *   discover, and the answer is `unknown`.
 * - launch time: the TokenLaunched log, through ChainRecipientReader.
 */

import { VENUE } from '../../../../config/protocol.js'
import type {
  AuthorityStatus,
  ChainDiligenceProbe as DiligenceProbePort,
  LpLockStatus,
  SellSimulation,
} from '@fee-split-vaults/screening'
import { decodeBool, decodeUint256 } from '@fee-split-vaults/adapters'
import { encodeAddressArgCall, selector, type BlockRef, type Hex, type LaunchedToken, type PinnedCall } from '@fee-split-vaults/indexer'
import { normalizeAddress } from '../crypto/address.js'

export interface DiligenceChainReads {
  head(): Promise<BlockRef>
  call(request: PinnedCall): Promise<Hex>
  getCode(address: string, blockHash: Hex): Promise<Hex>
}

export interface LaunchReader {
  launchedToken(token: string): Promise<{ launched: LaunchedToken; at: BlockRef }>
  launchedAtUnix(token: string): Promise<number>
}

export interface ChainDiligenceProbeOptions {
  rpc: DiligenceChainReads
  launches: LaunchReader
  /** Defaults to VENUE.contracts.v2LaunchLocker. */
  locker?: string
  /** Defaults to VENUE.contracts.v2Factory: reported as custodian of pre-graduation liquidity. */
  factory?: string
  /** The address the snipe-tax quote is asked for. Any non-exempt address; never the operator. */
  probeFrom?: string
}

/** Selectors that mint. Any one present means a mint path exists. */
export const MINT_SELECTORS: ReadonlyArray<{ signature: string; selector: Hex }> = [
  'mint(address,uint256)',
  'mint(uint256)',
  'mintTo(address,uint256)',
  'mint(address,uint256,bytes)',
].map((signature) => ({ signature, selector: selector(signature) }))

/** Selectors that freeze, pause or blacklist. */
export const FREEZE_SELECTORS: ReadonlyArray<{ signature: string; selector: Hex }> = [
  'pause()',
  'setBlacklist(address,bool)',
  'setBlacklisted(address,bool)',
  'blacklist(address)',
  'addBlacklist(address)',
  'setBlocked(address,bool)',
  'blockAccount(address)',
  'freeze(address)',
  'freezeAccount(address)',
  'setFrozen(address,bool)',
].map((signature) => ({ signature, selector: selector(signature) }))

const IS_LOCKED = selector('isLocked(address)')
const CURVE_GRADUATED = selector('graduated()')
const CURVE_FEE_BPS = selector('feeBps()')
const CURVE_SNIPE_TAX = selector('currentSnipeTaxBps(address)')
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEFAULT_PROBE_FROM = '0x0000000000000000000000000000000000000001'

/** EIP-1167 minimal proxy runtime: 363d3d373d3d3d363d73 <impl> 5af43d82803e903d91602b57fd5bf3 */
const EIP1167_PREFIX = '363d3d373d3d3d363d73'
const DELEGATECALL = 0xf4

export interface BytecodeScan {
  /** Every PUSH4 immediate, lowercased 0x-prefixed. */
  selectors: ReadonlySet<string>
  /** DELEGATECALL appears as an opcode outside push data, or the code is a minimal proxy. */
  delegates: boolean
  /** No code at the address. */
  empty: boolean
}

/**
 * Walks the runtime bytecode as opcodes, skipping PUSH immediates, so a
 * selector-looking byte sequence inside push data is not mistaken for a
 * dispatcher entry and a 0xf4 byte inside an address is not mistaken for
 * DELEGATECALL.
 */
export function scanBytecode(code: Hex): BytecodeScan {
  const hex = code.startsWith('0x') ? code.slice(2) : code
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new TypeError('bytecode is not hex')
  const bytes = Buffer.from(hex, 'hex')
  const selectors = new Set<string>()
  let delegates = hex.toLowerCase().startsWith(EIP1167_PREFIX)
  let i = 0
  while (i < bytes.length) {
    const op = bytes[i] ?? 0
    if (op === DELEGATECALL) delegates = true
    if (op >= 0x60 && op <= 0x7f) {
      const width = op - 0x5f
      if (width === 4 && i + 5 <= bytes.length) {
        selectors.add(`0x${bytes.subarray(i + 1, i + 5).toString('hex')}`)
      }
      i += 1 + width
    } else {
      i += 1
    }
  }
  return { selectors, delegates, empty: bytes.length === 0 }
}

export type SelectorPresence = 'present' | 'absent' | 'unknown'

export function selectorPresence(
  scan: BytecodeScan,
  wanted: ReadonlyArray<{ signature: string; selector: Hex }>,
): { presence: SelectorPresence; found: string[] } {
  if (scan.empty || scan.delegates) return { presence: 'unknown', found: [] }
  const found = wanted.filter((w) => scan.selectors.has(w.selector.toLowerCase())).map((w) => w.signature)
  return { presence: found.length > 0 ? 'present' : 'absent', found }
}

export class ChainDiligenceProbe implements DiligenceProbePort {
  readonly #rpc: DiligenceChainReads
  readonly #launches: LaunchReader
  readonly #locker: string
  readonly #factory: string
  readonly #probeFrom: string

  constructor(options: ChainDiligenceProbeOptions) {
    this.#rpc = options.rpc
    this.#launches = options.launches
    this.#locker = normalizeAddress(options.locker ?? VENUE.contracts.v2LaunchLocker)
    this.#factory = normalizeAddress(options.factory ?? VENUE.contracts.v2Factory)
    this.#probeFrom = normalizeAddress(options.probeFrom ?? DEFAULT_PROBE_FROM)
  }

  /** What this probe makes real, in the words the banner prints. */
  static describe(): string {
    return (
      'mint/freeze authority by PUSH4 selector scan of the token bytecode (delegating code is unknown); ' +
      'LP lock via LaunchLocker.isLocked (permanent, no unlock path) or factory custody of the launch curve; ' +
      'exit tax quoted from the curve views feeBps()+currentSnipeTaxBps() (curve phase only, no trade executed); ' +
      'launch time from TokenLaunched'
    )
  }

  async mintAuthority(token: string): Promise<AuthorityStatus> {
    return this.#authority(token, MINT_SELECTORS)
  }

  async freezeAuthority(token: string): Promise<AuthorityStatus> {
    return this.#authority(token, FREEZE_SELECTORS)
  }

  async #authority(token: string, wanted: ReadonlyArray<{ signature: string; selector: Hex }>): Promise<AuthorityStatus> {
    const at = await this.#rpc.head()
    const scan = scanBytecode(await this.#rpc.getCode(normalizeAddress(token), at.hash))
    const { presence } = selectorPresence(scan, wanted)
    return {
      revoked: presence === 'absent' ? 'pass' : presence === 'present' ? 'fail' : 'unknown',
      blockHash: at.hash,
    }
  }

  async lpLock(token: string): Promise<LpLockStatus> {
    const { launched, at } = await this.#launches.launchedToken(token)
    const locked = decodeBool(
      await this.#rpc.call({ to: this.#locker, data: encodeAddressArgCall(IS_LOCKED, token), blockHash: at.hash }),
    )
    if (locked) {
      return { locked: 'pass', lockerAddress: this.#locker, permanent: true, blockHash: at.hash }
    }
    const curve = normalizeAddress(launched.curve)
    if (curve === ZERO_ADDRESS) return { locked: 'fail', blockHash: at.hash }
    const graduated = await this.#curveGraduated(curve, at)
    if (graduated === undefined) return { locked: 'unknown', blockHash: at.hash }
    if (graduated) {
      // Graduated and not in the locker: the position went somewhere we do not credit.
      return { locked: 'fail', blockHash: at.hash }
    }
    // Pre-graduation: the reserves sit in the curve the factory deployed and
    // registered under this token; the factory is what can move them.
    return { locked: 'pass', lockerAddress: this.#factory, permanent: true, blockHash: at.hash }
  }

  /** `probeAmountMinor` is unused: the quote is a rate, and no exit is ever executed. */
  async simulateSell(token: string, _probeAmountMinor: bigint): Promise<SellSimulation> {
    const { launched, at } = await this.#launches.launchedToken(token)
    const curve = normalizeAddress(launched.curve)
    if (curve === ZERO_ADDRESS) return { outcome: 'unknown', revertReason: 'no launch curve registered for the token' }
    const scan = scanBytecode(await this.#rpc.getCode(curve, at.hash))
    if (!scan.selectors.has(CURVE_FEE_BPS) || !scan.selectors.has(CURVE_SNIPE_TAX) || !scan.selectors.has(CURVE_GRADUATED)) {
      return { outcome: 'unknown', revertReason: 'no quote view discoverable on the launch curve' }
    }
    const graduated = decodeBool(await this.#rpc.call({ to: curve, data: CURVE_GRADUATED, blockHash: at.hash }))
    if (graduated) {
      return { outcome: 'unknown', revertReason: 'post-graduation: no quote view on the v4 pool' }
    }
    const feeBps = decodeUint256(await this.#rpc.call({ to: curve, data: CURVE_FEE_BPS, blockHash: at.hash }))
    const snipeBps = decodeUint256(
      await this.#rpc.call({ to: curve, data: encodeAddressArgCall(CURVE_SNIPE_TAX, this.#probeFrom), blockHash: at.hash }),
    )
    const total = feeBps + snipeBps
    if (total > 10_000n) return { outcome: 'unknown', revertReason: `curve quoted ${total} bps, above 100%` }
    return { outcome: 'pass', effectiveTaxBps: Number(total) }
  }

  async launchedAtUnix(token: string): Promise<number | undefined> {
    return this.#launches.launchedAtUnix(token)
  }

  async #curveGraduated(curve: string, at: BlockRef): Promise<boolean | undefined> {
    const scan = scanBytecode(await this.#rpc.getCode(curve, at.hash))
    if (!scan.selectors.has(CURVE_GRADUATED)) return undefined
    return decodeBool(await this.#rpc.call({ to: curve, data: CURVE_GRADUATED, blockHash: at.hash }))
  }
}

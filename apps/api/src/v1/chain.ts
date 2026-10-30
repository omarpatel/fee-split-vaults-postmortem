/**
 * The chain reads the dev dashboard and the retrofit preflight need, over the
 * same settled quorum pin every other read in this process uses (chain.ts).
 *
 * Every getter below is a `public` on CoinVault (contracts/src/CoinVault.sol)
 * or ERC-20 metadata; the selectors are keccak of the exact Solidity
 * declaration at module load, never a literal.
 */

import type { Address } from '@fee-split-vaults/core'
import { VaultReadClient, decodeUint256 } from '@fee-split-vaults/adapters'

import type { SettledChainReads } from '../chain.js'
import { hexToBytes, keccakHex, normalizeAddress, utf8 } from '../crypto/address.js'
import type { TokenMetadata, VaultDialView, VaultLegsView, VaultViews } from './ports.js'

function selector(signature: string): string {
  return keccakHex(utf8(signature)).slice(0, 10)
}

const VAULT_GETTERS = {
  budgetBps: selector('budgetBps()'),
  pendingBudgetBps: selector('pendingBudgetBps()'),
  pendingDialUnix: selector('pendingDialUnix()'),
  operatorNoticeUnix: selector('operatorNoticeUnix()'),
  lastOperatorActionUnix: selector('lastOperatorActionUnix()'),
  deadManDeadline: selector('deadManDeadline()'),
  devPayout: selector('DEV_PAYOUT()'),
} as const

const NAME = selector('name()')
const SYMBOL = selector('symbol()')

function smallUint(hex: string, what: string): number {
  const value = decodeUint256(hex as `0x${string}`)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${what} is ${String(value)}, not a small integer`)
  return Number(value)
}

/**
 * ABI `string`: offset word, length word, bytes. A token that returns a bare
 * bytes32 (the MKR shape) is read as that word, trimmed.
 */
export function decodeAbiString(hex: string): string {
  const bytes = hexToBytes(hex)
  if (bytes.length === 32) {
    let end = bytes.indexOf(0)
    if (end < 0) end = 32
    return new TextDecoder().decode(bytes.subarray(0, end))
  }
  if (bytes.length < 64) throw new RangeError('string return too short')
  const offset = Number(decodeUint256(`0x${Buffer.from(bytes.subarray(0, 32)).toString('hex')}`))
  const length = Number(decodeUint256(`0x${Buffer.from(bytes.subarray(offset, offset + 32)).toString('hex')}`))
  const start = offset + 32
  if (start + length > bytes.length) throw new RangeError('string return truncated')
  return new TextDecoder().decode(bytes.subarray(start, start + length))
}

export class ChainVaultViews implements VaultViews {
  readonly #reads: SettledChainReads
  readonly #vaults: VaultReadClient

  constructor(reads: SettledChainReads) {
    this.#reads = reads
    this.#vaults = new VaultReadClient({ rpc: reads })
  }

  async dial(vault: Address): Promise<VaultDialView> {
    const to = normalizeAddress(vault)
    const at = (await this.#reads.head()).hash
    const read = (data: string): Promise<string> => this.#reads.call({ to, data: data as `0x${string}`, blockHash: at })
    const [budgetBps, pendingBudgetBps, pendingDialUnix, operatorNoticeUnix, lastOperatorActionUnix, deadMan, devPayout] =
      await Promise.all([
        read(VAULT_GETTERS.budgetBps),
        read(VAULT_GETTERS.pendingBudgetBps),
        read(VAULT_GETTERS.pendingDialUnix),
        read(VAULT_GETTERS.operatorNoticeUnix),
        read(VAULT_GETTERS.lastOperatorActionUnix),
        read(VAULT_GETTERS.deadManDeadline),
        read(VAULT_GETTERS.devPayout),
      ])
    return {
      budgetBps: smallUint(budgetBps, 'budgetBps'),
      pendingBudgetBps: smallUint(pendingBudgetBps, 'pendingBudgetBps'),
      pendingDialUnix: smallUint(pendingDialUnix, 'pendingDialUnix'),
      operatorNoticeUnix: smallUint(operatorNoticeUnix, 'operatorNoticeUnix'),
      lastOperatorActionUnix: smallUint(lastOperatorActionUnix, 'lastOperatorActionUnix'),
      deadManUnix: smallUint(deadMan, 'deadManDeadline'),
      devPayout: normalizeAddress(`0x${devPayout.slice(-40)}`),
    }
  }

  async legOf(vault: Address, asset: string): Promise<VaultLegsView> {
    const legs = await this.#vaults.legOf(vault, asset)
    return { dev: legs.dev, budget: legs.budget, operator: legs.operator, referrer: legs.referrer }
  }
}

export class ChainTokenMetadata implements TokenMetadata {
  constructor(private readonly reads: SettledChainReads) {}

  async describe(token: Address): Promise<{ name: string; symbol: string }> {
    const to = normalizeAddress(token)
    const at = (await this.reads.head()).hash
    const [name, symbol] = await Promise.all([
      this.reads.call({ to, data: NAME as `0x${string}`, blockHash: at }),
      this.reads.call({ to, data: SYMBOL as `0x${string}`, blockHash: at }),
    ])
    return { name: decodeAbiString(name), symbol: decodeAbiString(symbol) }
  }
}

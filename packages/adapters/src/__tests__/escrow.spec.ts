import { RpcError, type BlockRef, type Hex, type PinnedCall } from '@fee-split-vaults/indexer'
import { describe, expect, it } from 'vitest'
import { VENUE } from '../../../../config/protocol.js'
import {
  AbiEncodeError,
  ESCROW_BALANCE_OF_SELECTOR,
  ESCROW_BALANCE_OF_TOKEN_SELECTOR,
  encodeEscrowBalanceOf,
  encodeEscrowBalanceOfToken,
} from '../chain/abi-encode.js'
import { EscrowReadClient } from '../chain/escrow.js'

const VAULT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const ASSET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NATIVE = '0x0000000000000000000000000000000000000000'
const HEAD: BlockRef = { number: 50n, hash: `0x${'ab'.repeat(32)}`, parentHash: `0x${'ac'.repeat(32)}`, timestampUnix: 1 }
const addr = (a: string): string => a.slice(2).toLowerCase().padStart(64, '0')

class ScriptedEscrow {
  readonly calls: PinnedCall[] = []
  native = 0n
  token = new Map<string, bigint>()

  async head(): Promise<BlockRef> {
    return HEAD
  }

  async call(request: PinnedCall): Promise<Hex> {
    this.calls.push(request)
    const selector = request.data.slice(0, 10)
    if (selector === ESCROW_BALANCE_OF_SELECTOR) return `0x${this.native.toString(16).padStart(64, '0')}`
    if (selector === ESCROW_BALANCE_OF_TOKEN_SELECTOR) {
      const token = `0x${request.data.slice(10 + 64 + 24)}`
      return `0x${(this.token.get(token) ?? 0n).toString(16).padStart(64, '0')}`
    }
    throw new RpcError(`unscripted ${selector}`, 'scripted')
  }
}

describe('escrow view calldata', () => {
  it('balanceOf(address) is the ERC-20 selector by coincidence of signature; balanceOfToken(address,address) is two words', () => {
    expect(ESCROW_BALANCE_OF_SELECTOR).toBe('0x70a08231')
    expect(ESCROW_BALANCE_OF_TOKEN_SELECTOR).toBe('0xf59e38b7')
    expect(encodeEscrowBalanceOf(VAULT)).toBe(`0x70a08231${addr(VAULT)}`)
    expect(encodeEscrowBalanceOfToken(VAULT, ASSET)).toBe(`0xf59e38b7${addr(VAULT)}${addr(ASSET)}`)
    expect(() => encodeEscrowBalanceOfToken(VAULT, NATIVE)).toThrow(AbiEncodeError)
  })
})

describe('EscrowReadClient', () => {
  it('reads native credit via balanceOf and ERC-20 credit via balanceOfToken, pinned to head, against the pinned escrow', async () => {
    const rpc = new ScriptedEscrow()
    rpc.native = 123n
    rpc.token.set(ASSET, 456n)
    const escrow = new EscrowReadClient({ rpc })

    expect(await escrow.credits(VAULT, NATIVE)).toBe(123n)
    expect(await escrow.credits(VAULT, ASSET)).toBe(456n)
    expect(await escrow.credits(VAULT, '0xdddddddddddddddddddddddddddddddddddddddd')).toBe(0n)
    expect(rpc.calls.map((c) => c.to)).toEqual(Array(3).fill(VENUE.contracts.v2FeeEscrow.toLowerCase()))
    expect(rpc.calls.map((c) => c.blockHash)).toEqual(Array(3).fill(HEAD.hash))
    expect(rpc.calls[0]?.data).toBe(encodeEscrowBalanceOf(VAULT))
    expect(rpc.calls[1]?.data).toBe(encodeEscrowBalanceOfToken(VAULT, ASSET))
  })

  it('honours a caller-supplied pin and a test escrow address', async () => {
    const rpc = new ScriptedEscrow()
    const escrow = new EscrowReadClient({ rpc, escrow: '0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE' })
    const pin = `0x${'11'.repeat(32)}` as Hex
    await escrow.credits(VAULT, NATIVE, pin)
    expect(rpc.calls[0]?.blockHash).toBe(pin)
    expect(rpc.calls[0]?.to).toBe('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
  })

  it('a read failure throws rather than reporting zero credit', async () => {
    const escrow = new EscrowReadClient({
      rpc: {
        head: async () => HEAD,
        call: async () => {
          throw new RpcError('unreachable', 'scripted')
        },
      },
    })
    await expect(escrow.credits(VAULT, NATIVE)).rejects.toThrow(RpcError)
  })
})

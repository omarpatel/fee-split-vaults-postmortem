import { recoverPublicKeyAsync } from '@noble/secp256k1'
import { keccak256 } from '@fee-split-vaults/indexer'
import { describe, expect, it } from 'vitest'
import { PrivateKeySigner, SignerKeyError, addressOfPublicKey } from '../chain/signer.js'

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

describe('PrivateKeySigner', () => {
  it('derives the well-known address for secret key 1', () => {
    // secp256k1 generator point -> 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf, the
    // address every EVM toolchain prints for private key 0x...01.
    const signer = new PrivateKeySigner(`0x${'0'.repeat(63)}1`)
    expect(signer.address).toBe('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf')
  })

  it('derives the web3.js documentation key to its documented address', () => {
    // web3.eth.accounts.privateKeyToAccount('0x4c0883a6...2318') documents
    // 0x2c7536E3605D9C16a7a3D7b1898e529396a65c23.
    const signer = new PrivateKeySigner('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318')
    expect(signer.address).toBe('0x2c7536e3605d9c16a7a3d7b1898e529396a65c23')
  })

  it('refuses zero, out-of-range and wrong-length keys at construction', () => {
    expect(() => new PrivateKeySigner(`0x${'0'.repeat(64)}`)).toThrow(SignerKeyError)
    expect(() => new PrivateKeySigner(`0x${N.toString(16)}`)).toThrow(SignerKeyError)
    expect(() => new PrivateKeySigner(`0x${'1'.repeat(62)}`)).toThrow(SignerKeyError)
    expect(() => new PrivateKeySigner('1'.repeat(64))).toThrow(SignerKeyError)
  })

  it('signs a digest with a recovery bit that leads back to its own address', async () => {
    const signer = new PrivateKeySigner('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318')
    const digest = keccak256(new TextEncoder().encode('venue settlement'))
    const sig = await signer.sign(digest)

    expect(sig.s <= N / 2n).toBe(true)
    const recovered = new Uint8Array(65)
    recovered[0] = sig.yParity
    recovered.set(bytes32(sig.r), 1)
    recovered.set(bytes32(sig.s), 33)
    const pub = await recoverPublicKeyAsync(recovered, digest, { prehash: false, isCompressed: false })
    expect(addressOfPublicKey(pub)).toBe(signer.address)
  })

  it('refuses to sign anything that is not a 32-byte digest', async () => {
    const signer = new PrivateKeySigner(`0x${'0'.repeat(63)}1`)
    await expect(signer.sign(new Uint8Array(31))).rejects.toBeInstanceOf(SignerKeyError)
  })
})

function bytes32(value: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let v = value
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

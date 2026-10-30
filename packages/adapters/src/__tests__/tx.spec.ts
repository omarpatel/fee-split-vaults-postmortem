import { recoverPublicKeyAsync } from '@noble/secp256k1'
import { bytesToHex, hexToBytes, keccak256, type Hex } from '@fee-split-vaults/indexer'
import { describe, expect, it } from 'vitest'
import { PrivateKeySigner, addressOfPublicKey } from '../chain/signer.js'
import {
  TransactionEncodingError,
  bigIntToMinimalBytes,
  rlpEncode,
  serializeSigned,
  signTransaction,
  signingDigest,
  type Eip1559Transaction,
} from '../chain/tx.js'

const utf8 = (s: string) => new TextEncoder().encode(s)

describe('rlpEncode', () => {
  // Vectors from the Ethereum wiki RLP page (github.com/ethereum/wiki/wiki/RLP).
  it('matches the canonical vectors', () => {
    expect(bytesToHex(rlpEncode(utf8('dog')))).toBe('0x83646f67')
    expect(bytesToHex(rlpEncode([utf8('cat'), utf8('dog')]))).toBe('0xc88363617483646f67')
    expect(bytesToHex(rlpEncode(new Uint8Array(0)))).toBe('0x80')
    expect(bytesToHex(rlpEncode([]))).toBe('0xc0')
    expect(bytesToHex(rlpEncode(bigIntToMinimalBytes(0n)))).toBe('0x80')
    expect(bytesToHex(rlpEncode(bigIntToMinimalBytes(15n)))).toBe('0x0f')
    expect(bytesToHex(rlpEncode(bigIntToMinimalBytes(1024n)))).toBe('0x820400')
    expect(bytesToHex(rlpEncode([[], [[]], [[], [[]]]]))).toBe('0xc7c0c1c0c3c0c1c0')
    const lorem = utf8('Lorem ipsum dolor sit amet, consectetur adipisicing elit')
    expect(bytesToHex(rlpEncode(lorem))).toBe(`0xb838${bytesToHex(lorem).slice(2)}`)
  })

  it('encodes a single byte below 0x80 as itself and 0x80 with a length prefix', () => {
    expect(bytesToHex(rlpEncode(Uint8Array.of(0x7f)))).toBe('0x7f')
    expect(bytesToHex(rlpEncode(Uint8Array.of(0x80)))).toBe('0x8180')
  })
})

const TO = '0x1111111111111111111111111111111111111111'
const TX: Eip1559Transaction = {
  chainId: 4663n,
  nonce: 0n,
  maxPriorityFeePerGas: 1_000_000_000n,
  maxFeePerGas: 2_000_000_000n,
  gasLimit: 21_000n,
  to: TO,
  value: 0n,
  data: '0x',
}

// Derived by hand from EIP-1559 / EIP-2718:
//   chainId 4663 = 0x1237            -> 82 1237
//   nonce 0                          -> 80
//   priority 1 gwei = 0x3b9aca00     -> 84 3b9aca00
//   maxFee 2 gwei = 0x77359400       -> 84 77359400
//   gasLimit 21000 = 0x5208          -> 82 5208
//   to (20 bytes)                    -> 94 11..11
//   value 0                          -> 80
//   data empty                       -> 80
//   accessList []                    -> c0
//   list body = 41 bytes = 0x29      -> e9 prefix; type byte 02 in front.
const UNSIGNED_PAYLOAD: Hex = `0x02e982123780843b9aca00847735940082520894${TO.slice(2)}8080c0`

describe('EIP-1559 encoding', () => {
  it('hashes exactly 0x02 || rlp(unsigned fields)', () => {
    expect(bytesToHex(signingDigest(TX))).toBe(bytesToHex(keccak256(hexToBytes(UNSIGNED_PAYLOAD))))
  })

  it('serialises the signed form as the same fields followed by yParity, r, s', () => {
    const r = 0x0102n
    const s = 0x03n
    const serialized = serializeSigned(TX, { r, s, yParity: 1 })
    // body grows by: yParity 01 (1) + r 82 0102 (3) + s 03 (1) = 46 bytes = 0x2e
    expect(bytesToHex(serialized)).toBe(
      `0x02ee82123780843b9aca00847735940082520894${TO.slice(2)}8080c0${'01'}${'820102'}${'03'}`,
    )
  })

  it('refuses a priority fee above the fee cap and a zero gas limit', () => {
    expect(() => signingDigest({ ...TX, maxPriorityFeePerGas: TX.maxFeePerGas + 1n })).toThrow(
      TransactionEncodingError,
    )
    expect(() => signingDigest({ ...TX, gasLimit: 0n })).toThrow(TransactionEncodingError)
  })

  it('produces a signed tx whose hash is keccak of the bytes and whose signature recovers the signer', async () => {
    const signer = new PrivateKeySigner('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318')
    const signed = await signTransaction(TX, signer)

    expect(signed.hash).toBe(bytesToHex(keccak256(hexToBytes(signed.raw))))
    expect(signed.raw.startsWith('0x02')).toBe(true)

    const recovered = new Uint8Array(65)
    recovered[0] = signed.signature.yParity
    recovered.set(hexToBytes(`0x${signed.signature.r.toString(16).padStart(64, '0')}`), 1)
    recovered.set(hexToBytes(`0x${signed.signature.s.toString(16).padStart(64, '0')}`), 33)
    const pub = await recoverPublicKeyAsync(recovered, signingDigest(TX), { prehash: false, isCompressed: false })
    expect(addressOfPublicKey(pub)).toBe(signer.address)
  })

  it('is deterministic: RFC 6979 nonces make the same tx sign to the same bytes', async () => {
    const signer = new PrivateKeySigner(`0x${'0'.repeat(63)}1`)
    const a = await signTransaction(TX, signer)
    const b = await signTransaction(TX, signer)
    expect(a.raw).toBe(b.raw)
  })
})

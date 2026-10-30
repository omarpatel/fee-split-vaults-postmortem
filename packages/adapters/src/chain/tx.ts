/**
 * EIP-1559 (type 2) transaction encoding.
 *
 *   signingPayload = 0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
 *                                 gasLimit, to, value, data, accessList])
 *   digest         = keccak256(signingPayload)
 *   serialized     = 0x02 || rlp([...same nine fields, yParity, r, s])
 *   txHash         = keccak256(serialized)
 *
 * The RLP encoder is written here rather than depended upon: it is forty lines,
 * the spec is frozen, and it sits on the path that decides what the operator
 * key signs. accessList is always empty; nothing this system sends needs one.
 */

import { bytesToHex, hexToBytes, keccak256, normalizeAddress, type Hex } from '@fee-split-vaults/indexer'
import type { RecoverableSignature, TransactionSigner } from './signer.js'

export interface Eip1559Transaction {
  readonly chainId: bigint
  readonly nonce: bigint
  readonly maxPriorityFeePerGas: bigint
  readonly maxFeePerGas: bigint
  readonly gasLimit: bigint
  readonly to: string
  readonly value: bigint
  readonly data: Hex
}

export interface SignedTransaction {
  readonly raw: Hex
  readonly hash: Hex
  readonly signature: RecoverableSignature
}

export class TransactionEncodingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

const TYPE_2 = 0x02

// ---------------------------------------------------------------------------
// RLP
// ---------------------------------------------------------------------------

type RlpItem = Uint8Array | readonly RlpItem[]

function lengthPrefix(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length)
  const lengthBytes = bigIntToMinimalBytes(BigInt(length))
  const out = new Uint8Array(1 + lengthBytes.length)
  out[0] = offset + 55 + lengthBytes.length
  out.set(lengthBytes, 1)
  return out
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && (item[0] ?? 0) < 0x80) return item
    return concat([lengthPrefix(item.length, 0x80), item])
  }
  const encoded = item.map(rlpEncode)
  const body = concat(encoded)
  return concat([lengthPrefix(body.length, 0xc0), body])
}

/** Big-endian, no leading zeros; zero encodes as the empty string, as RLP requires. */
export function bigIntToMinimalBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new TransactionEncodingError(`negative quantity: ${value}`)
  if (value === 0n) return new Uint8Array(0)
  let hex = value.toString(16)
  if (hex.length % 2 === 1) hex = `0${hex}`
  return hexToBytes(`0x${hex}`)
}

// ---------------------------------------------------------------------------
// Type 2
// ---------------------------------------------------------------------------

function unsignedFields(tx: Eip1559Transaction): RlpItem[] {
  if (tx.maxPriorityFeePerGas > tx.maxFeePerGas) {
    throw new TransactionEncodingError('maxPriorityFeePerGas exceeds maxFeePerGas')
  }
  if (tx.gasLimit <= 0n) throw new TransactionEncodingError('gasLimit must be positive')
  return [
    bigIntToMinimalBytes(tx.chainId),
    bigIntToMinimalBytes(tx.nonce),
    bigIntToMinimalBytes(tx.maxPriorityFeePerGas),
    bigIntToMinimalBytes(tx.maxFeePerGas),
    bigIntToMinimalBytes(tx.gasLimit),
    hexToBytes(normalizeAddress(tx.to) as Hex),
    bigIntToMinimalBytes(tx.value),
    hexToBytes(tx.data),
    [],
  ]
}

function typed(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1)
  out[0] = TYPE_2
  out.set(payload, 1)
  return out
}

/** keccak256(0x02 || rlp(unsigned fields)) - what the signer sees. */
export function signingDigest(tx: Eip1559Transaction): Uint8Array {
  return keccak256(typed(rlpEncode(unsignedFields(tx))))
}

export function serializeSigned(tx: Eip1559Transaction, sig: RecoverableSignature): Uint8Array {
  return typed(
    rlpEncode([
      ...unsignedFields(tx),
      bigIntToMinimalBytes(BigInt(sig.yParity)),
      bigIntToMinimalBytes(sig.r),
      bigIntToMinimalBytes(sig.s),
    ]),
  )
}

export async function signTransaction(
  tx: Eip1559Transaction,
  signer: TransactionSigner,
): Promise<SignedTransaction> {
  const signature = await signer.sign(signingDigest(tx))
  const serialized = serializeSigned(tx, signature)
  return { raw: bytesToHex(serialized), hash: bytesToHex(keccak256(serialized)), signature }
}

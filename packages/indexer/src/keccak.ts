/**
 * Keccak-256, vendored.
 *
 * Ethereum's variant: sponge over Keccak-f[1600] at rate 136 with pad byte 0x01.
 * SHA3-256 is the SAME sponge with pad byte 0x06, which is why _sponge256 takes
 * the pad byte - the test suite drives it with 0x06 and compares against Node's
 * own SHA3-256 across every input length from 0 to several blocks. That check
 * validates the permutation, the absorb loop and the multi-block path against an
 * independent implementation, which is the only way to be sure of a hand-written
 * primitive.
 *
 * Vendored rather than depended upon deliberately: these 200 lines decide which
 * event topic maps to which coin's fee credit. A compromised transitive
 * dependency here would misattribute money silently, and the algorithm is frozen
 * so there is nothing to keep up to date.
 */

import { bytesToHex, utf8ToBytes, type Hex } from './hex.js'

const MASK64 = (1n << 64n) - 1n

const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]

/** rho offsets, flattened as [x + 5y]. */
const ROTATION: readonly number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
]

function rotl64(lane: bigint, bits: number): bigint {
  if (bits === 0) return lane
  const n = BigInt(bits)
  return ((lane << n) | (lane >> (64n - n))) & MASK64
}

/**
 * All indices below are x + 5y for x,y in [0,5), or a round in [0,24), so every
 * access is provably in range for the fixed 25-lane state. The `?? 0n` is the
 * cost of noUncheckedIndexedAccess, not a real branch.
 */
function keccakF1600(state: bigint[]): void {
  const c = new Array<bigint>(5).fill(0n)
  const b = new Array<bigint>(25).fill(0n)
  const s = (index: number): bigint => state[index] ?? 0n
  const cAt = (index: number): bigint => c[index] ?? 0n
  const bAt = (index: number): bigint => b[index] ?? 0n

  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      c[x] = s(x) ^ s(x + 5) ^ s(x + 10) ^ s(x + 15) ^ s(x + 20)
    }
    for (let x = 0; x < 5; x++) {
      const d = cAt((x + 4) % 5) ^ rotl64(cAt((x + 1) % 5), 1)
      for (let y = 0; y < 5; y++) state[x + 5 * y] = s(x + 5 * y) ^ d
    }

    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(s(x + 5 * y), ROTATION[x + 5 * y] ?? 0)
      }
    }

    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state[x + 5 * y] =
          bAt(x + 5 * y) ^ (~bAt(((x + 1) % 5) + 5 * y) & MASK64 & bAt(((x + 2) % 5) + 5 * y))
      }
    }

    state[0] = s(0) ^ (ROUND_CONSTANTS[round] ?? 0n)
  }
}

const RATE_BYTES_256 = 136

function absorbBlock(state: bigint[], block: Uint8Array): void {
  for (let lane = 0; lane < block.length / 8; lane++) {
    let value = 0n
    for (let byte = 7; byte >= 0; byte--) {
      value = (value << 8n) | BigInt(block[lane * 8 + byte] ?? 0)
    }
    state[lane] = (state[lane] ?? 0n) ^ value
  }
  keccakF1600(state)
}

/**
 * The shared sponge. padByte is 0x01 for Keccak-256 (Ethereum) and 0x06 for
 * SHA3-256 (FIPS 202). Exported only so the test suite can cross-check the
 * permutation against Node's SHA3-256.
 */
export function _sponge256(input: Uint8Array, padByte: number): Uint8Array {
  const state = new Array<bigint>(25).fill(0n)

  let offset = 0
  while (input.length - offset >= RATE_BYTES_256) {
    absorbBlock(state, input.subarray(offset, offset + RATE_BYTES_256))
    offset += RATE_BYTES_256
  }

  const tail = new Uint8Array(RATE_BYTES_256)
  const remaining = input.length - offset
  tail.set(input.subarray(offset), 0)
  // XOR rather than assign: at remaining == rate-1 the pad byte and the 0x80
  // terminator share a byte, and that case must not lose either bit.
  tail[remaining] = (tail[remaining] ?? 0) ^ padByte
  tail[RATE_BYTES_256 - 1] = (tail[RATE_BYTES_256 - 1] ?? 0) ^ 0x80
  absorbBlock(state, tail)

  const out = new Uint8Array(32)
  for (let lane = 0; lane < 4; lane++) {
    let value = state[lane] ?? 0n
    for (let byte = 0; byte < 8; byte++) {
      out[lane * 8 + byte] = Number(value & 0xffn)
      value >>= 8n
    }
  }
  return out
}

export function keccak256(input: Uint8Array): Uint8Array {
  return _sponge256(input, 0x01)
}

export function keccak256Hex(input: Uint8Array | string): Hex {
  return bytesToHex(keccak256(typeof input === 'string' ? utf8ToBytes(input) : input))
}

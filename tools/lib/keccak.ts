/**
 * Keccak-256 (the pre-NIST padding used by Ethereum), pure TypeScript.
 *
 * Vendored rather than depended on: these tools must run from a bare checkout
 * with only the repo's existing devDependencies installed, and the only thing
 * they need from a crypto library is event topic hashing and 4-byte selectors.
 *
 * Correctness is pinned by known-answer vectors in __tests__/keccak.spec.ts.
 * Do not "optimise" this file without re-running them.
 */

const MASK64 = (1n << 64n) - 1n

const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
]

/** r[x][y] flattened as [x + 5y]. */
const ROTATION: readonly number[] = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
]

function rotl64(v: bigint, n: number): bigint {
  if (n === 0) return v & MASK64
  const b = BigInt(n)
  return ((v << b) | (v >> (64n - b))) & MASK64
}

function keccakF1600(state: bigint[]): void {
  const c = new Array<bigint>(5).fill(0n)
  const d = new Array<bigint>(5).fill(0n)
  const b = new Array<bigint>(25).fill(0n)

  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!
    }
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5]! ^ rotl64(c[(x + 1) % 5]!, 1)
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state[x + 5 * y] = state[x + 5 * y]! ^ d[x]!
      }
    }

    // rho + pi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y]!, ROTATION[x + 5 * y]!)
      }
    }

    // chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state[x + 5 * y] =
          b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & b[((x + 2) % 5) + 5 * y]!) & MASK64
      }
    }

    // iota
    state[0] = state[0]! ^ ROUND_CONSTANTS[round]!
  }
}

/** Keccak-256 over raw bytes. Rate 136 bytes, Ethereum's 0x01 domain padding. */
export function keccak256Bytes(input: Uint8Array): Uint8Array {
  const rate = 136
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate)
  padded.set(input)
  padded[input.length] = 0x01
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80

  const state = new Array<bigint>(25).fill(0n)
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane++) {
      let value = 0n
      for (let byte = 7; byte >= 0; byte--) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte]!)
      }
      state[lane] = state[lane]! ^ value
    }
    keccakF1600(state)
  }

  const out = new Uint8Array(32)
  for (let lane = 0; lane < 4; lane++) {
    let value = state[lane]!
    for (let byte = 0; byte < 8; byte++) {
      out[lane * 8 + byte] = Number(value & 0xffn)
      value >>= 8n
    }
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '0x'
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`)
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error(`non-hex character in: ${hex}`)
    out[i] = byte
  }
  return out
}

/** Keccak-256 of a UTF-8 string, as 0x-prefixed hex. */
export function keccak256Utf8(text: string): string {
  return bytesToHex(keccak256Bytes(new TextEncoder().encode(text)))
}

/** Keccak-256 of 0x-prefixed hex input, as 0x-prefixed hex. */
export function keccak256Hex(hex: string): string {
  return bytesToHex(keccak256Bytes(hexToBytes(hex)))
}

/** EIP-55 mixed-case checksum form. Used only for display. */
export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error(`not an address: ${address}`)
  const hash = keccak256Utf8(lower).slice(2)
  let out = '0x'
  for (let i = 0; i < 40; i++) {
    out += Number.parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!
  }
  return out
}

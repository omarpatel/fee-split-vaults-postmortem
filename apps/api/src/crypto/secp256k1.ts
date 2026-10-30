/**
 * secp256k1, enough of it to recover a signer.
 *
 * WHY THIS IS HERE AND NOT A DEPENDENCY. This code decides who signed a consent,
 * and a consent is the document that fixes an operator's fee for the life of a
 * vault. It is thirty lines of modular arithmetic; the alternative is a
 * transitive dependency tree in the one place where a supply-chain compromise
 * lets an attacker deploy a vault under somebody else's signature.
 *
 * WHAT IT IS NOT. There is no signing function that a server should ever call
 * with a real key - `signRecoverable` exists so the test suite can prove the
 * recovery math against the published private-key-to-address vectors, and the
 * service itself never holds a dev key. The operator's own signing happens in a
 * signer the API cannot reach.
 *
 * MALLEABILITY. Only low-s signatures are accepted, matching the contracts'
 * SignatureLib. A high-s signature over the same digest recovers a different
 * point and is refused rather than normalised, because normalising would let one
 * consent have two valid signatures and therefore two audit trails.
 */

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const HALF_N = N >> 1n
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n

export interface Point {
  x: bigint
  y: bigint
}

/** Point at infinity, represented as x = y = 0 (not on the curve). */
const INFINITY: Point = { x: 0n, y: 0n }

function isInfinity(p: Point): boolean {
  return p.x === 0n && p.y === 0n
}

function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m
  return r < 0n ? r + m : r
}

/** Extended Euclid. Constant-timeness is not claimed and is not needed: every
 *  input here is public (a signature and a digest), never a secret key. */
function invert(a: bigint, m: bigint = P): bigint {
  if (a === 0n) throw new Error('secp256k1: no inverse of zero')
  let [old_r, r] = [mod(a, m), m]
  let [old_s, s] = [1n, 0n]
  while (r !== 0n) {
    const q = old_r / r
    ;[old_r, r] = [r, old_r - q * r]
    ;[old_s, s] = [s, old_s - q * s]
  }
  return mod(old_s, m)
}

export function pointAdd(a: Point, b: Point): Point {
  if (isInfinity(a)) return b
  if (isInfinity(b)) return a
  if (a.x === b.x && mod(a.y + b.y) === 0n) return INFINITY
  const lambda =
    a.x === b.x && a.y === b.y
      ? mod(3n * a.x * a.x * invert(2n * a.y))
      : mod((b.y - a.y) * invert(mod(b.x - a.x)))
  const x = mod(lambda * lambda - a.x - b.x)
  return { x, y: mod(lambda * (a.x - x) - a.y) }
}

export function pointMul(k: bigint, point: Point): Point {
  let result = INFINITY
  let addend = point
  let n = mod(k, N)
  while (n > 0n) {
    if (n & 1n) result = pointAdd(result, addend)
    addend = pointAdd(addend, addend)
    n >>= 1n
  }
  return result
}

export const G: Point = { x: GX, y: GY }

export function isOnCurve(p: Point): boolean {
  if (isInfinity(p)) return false
  return mod(p.y * p.y - p.x * p.x * p.x - 7n) === 0n
}

function sqrtMod(a: bigint): bigint {
  // p % 4 === 3, so the square root is a^((p+1)/4).
  let result = 1n
  let base = mod(a)
  let exponent = (P + 1n) / 4n
  while (exponent > 0n) {
    if (exponent & 1n) result = mod(result * base)
    base = mod(base * base)
    exponent >>= 1n
  }
  return result
}

export class SignatureError extends Error {
  constructor(message: string) {
    super(`secp256k1: ${message}`)
    this.name = 'SignatureError'
  }
}

export interface RecoverableSignature {
  r: bigint
  s: bigint
  /** 0 or 1. The 27/28 and 0/1 encodings are both accepted on the way in. */
  recovery: number
}

/** Split a 65-byte r||s||v signature. Accepts v in {0,1,27,28}. */
export function parseSignature(bytes: Uint8Array): RecoverableSignature {
  if (bytes.length !== 65) {
    throw new SignatureError(`signature must be 65 bytes, got ${String(bytes.length)}`)
  }
  const r = bytesToBigInt(bytes.subarray(0, 32))
  const s = bytesToBigInt(bytes.subarray(32, 64))
  const rawV = bytes[64] ?? 0
  const recovery = rawV >= 27 ? rawV - 27 : rawV
  if (recovery !== 0 && recovery !== 1) {
    throw new SignatureError(`unsupported recovery id ${String(rawV)}`)
  }
  if (r <= 0n || r >= N) throw new SignatureError('r out of range')
  if (s <= 0n || s >= N) throw new SignatureError('s out of range')
  if (s > HALF_N) {
    // The contracts refuse high-s too. Refusing rather than normalising keeps
    // one consent to one signature to one audit trail.
    throw new SignatureError('high-s signature refused (malleable)')
  }
  return { r, s, recovery }
}

/** Recover the signer's public key point from a 32-byte digest. */
export function recoverPublicKey(digest: Uint8Array, sig: RecoverableSignature): Point {
  if (digest.length !== 32) throw new SignatureError('digest must be 32 bytes')
  const z = bytesToBigInt(digest)
  const { r, s, recovery } = sig

  const x = r
  if (x >= P) throw new SignatureError('r is not a valid x coordinate')
  const alpha = mod(x * x * x + 7n)
  const beta = sqrtMod(alpha)
  if (mod(beta * beta) !== alpha) throw new SignatureError('r is not on the curve')
  const y = (beta & 1n) === BigInt(recovery) ? beta : P - beta
  const R: Point = { x, y }
  if (!isOnCurve(R)) throw new SignatureError('recovered point is not on the curve')

  const rInv = invert(r, N)
  // Q = r^-1 * (s*R - z*G)
  const sR = pointMul(s, R)
  const zG = pointMul(mod(z, N), G)
  const negZG: Point = isInfinity(zG) ? zG : { x: zG.x, y: mod(P - zG.y) }
  const Q = pointMul(rInv, pointAdd(sR, negZG))
  if (isInfinity(Q)) throw new SignatureError('recovery produced the point at infinity')
  return Q
}

/** 64 raw bytes: x || y. This is what an Ethereum address is hashed from. */
export function publicKeyBytes(point: Point): Uint8Array {
  const out = new Uint8Array(64)
  out.set(bigIntTo32Bytes(point.x), 0)
  out.set(bigIntTo32Bytes(point.y), 32)
  return out
}

export function publicKeyFromPrivate(privateKey: bigint): Point {
  if (privateKey <= 0n || privateKey >= N) throw new SignatureError('private key out of range')
  return pointMul(privateKey, G)
}

/**
 * TEST-ONLY SIGNING.
 *
 * `k` is supplied by the caller rather than derived, so this is NOT safe for a
 * real key: a repeated k leaks the private key. It exists so the suite can
 * generate a signature, recover it, and check the recovered address against the
 * published private-key-to-address vectors - which is what actually validates
 * the curve arithmetic above.
 */
export function signRecoverable(
  digest: Uint8Array,
  privateKey: bigint,
  k: bigint,
): RecoverableSignature {
  if (digest.length !== 32) throw new SignatureError('digest must be 32 bytes')
  const z = mod(bytesToBigInt(digest), N)
  const kk = mod(k, N)
  if (kk === 0n) throw new SignatureError('k must be non-zero')
  const R = pointMul(kk, G)
  const r = mod(R.x, N)
  if (r === 0n) throw new SignatureError('r is zero; choose another k')
  let s = mod(invert(kk, N) * mod(z + r * mod(privateKey, N), N), N)
  if (s === 0n) throw new SignatureError('s is zero; choose another k')
  let recovery = Number(R.y & 1n) ^ (R.x >= N ? 2 : 0)
  if (s > HALF_N) {
    s = N - s
    recovery ^= 1
  }
  return { r, s, recovery: recovery & 1 }
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let out = 0n
  for (const byte of bytes) out = (out << 8n) | BigInt(byte)
  return out
}

export function bigIntTo32Bytes(value: bigint): Uint8Array {
  if (value < 0n) throw new SignatureError('negative value')
  const out = new Uint8Array(32)
  let v = value
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  if (v !== 0n) throw new SignatureError('value exceeds 32 bytes')
  return out
}

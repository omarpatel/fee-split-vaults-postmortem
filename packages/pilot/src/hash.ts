/**
 * Deterministic hashing, canonical serialization and a seeded PRNG.
 *
 * Everything in the pilot that looks random must be recomputable by a third
 * party from published inputs alone: the treatment assignment, the bootstrap
 * resamples and the permutation draws. A wall-clock or Math.random() dependency
 * anywhere in this package would make the experiment unauditable, which is the
 * same as making it worthless.
 */

import { createHash } from 'node:crypto'

export class CanonicalizationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`canonicalize: ${message} at ${path}`)
    this.name = 'CanonicalizationError'
  }
}

/**
 * JSON with recursively sorted object keys and no tolerance for values whose
 * serialization is ambiguous. Key order must not change a plan hash, and an
 * unserializable value must not silently vanish from a committed plan.
 */
export function canonicalJson(value: unknown, path = '$'): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError('non-finite number', path)
      }
      return Number.isInteger(value) ? String(value) : JSON.stringify(value)
    case 'bigint':
      // Minor-unit amounts never belong in a hashed plan; they are data, not policy.
      throw new CanonicalizationError('bigint is not representable in a plan', path)
    case 'undefined':
      throw new CanonicalizationError('undefined is not representable', path)
    case 'function':
    case 'symbol':
      throw new CanonicalizationError(`${typeof value} is not representable`, path)
  }

  if (Array.isArray(value)) {
    return `[${value.map((v, i) => canonicalJson(v, `${path}[${i}]`)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  )
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const body = entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, `${path}.${k}`)}`)
    .join(',')
  return `{${body}}`
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export function hashObject(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

/**
 * The per-block draw key. Published with the assignment so that anyone holding
 * (seed, pilotId, coinRef, nonce) can recompute every arm from scratch.
 */
export function drawKey(
  seed: string,
  pilotId: string,
  coinRef: string,
  nonce: number,
  blockStartUnix: number,
): string {
  return sha256Hex(`vault-pilot/v1|${seed}|${pilotId}|${coinRef}|${nonce}|${blockStartUnix}`)
}

/** Leading 64 bits of a hex digest as an unsigned integer, for ordering. */
export function keyRank(hexDigest: string): bigint {
  return BigInt(`0x${hexDigest.slice(0, 16)}`)
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform integer in [0, bound). */
  nextInt(bound: number): number
}

/**
 * sfc32, seeded from a digest. Chosen over BigInt-based generators because the
 * bootstrap draws tens of millions of variates and BigInt arithmetic makes that
 * slow enough that people reduce the iteration count, which is worse.
 */
export function makeRng(seedMaterial: string): Rng {
  const digest = sha256Hex(`vault-pilot/rng/v1|${seedMaterial}`)
  let a = Number.parseInt(digest.slice(0, 8), 16) >>> 0
  let b = Number.parseInt(digest.slice(8, 16), 16) >>> 0
  let c = Number.parseInt(digest.slice(16, 24), 16) >>> 0
  let d = Number.parseInt(digest.slice(24, 32), 16) >>> 0

  const next = (): number => {
    a |= 0
    b |= 0
    c |= 0
    d |= 0
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
    return (t >>> 0) / 4_294_967_296
  }

  // Discard the first draws so that similar seeds do not produce similar heads.
  for (let i = 0; i < 12; i += 1) next()

  return {
    next,
    nextInt(bound: number): number {
      if (!Number.isInteger(bound) || bound <= 0) {
        throw new RangeError(`nextInt bound must be a positive integer, got ${bound}`)
      }
      return Math.floor(next() * bound)
    },
  }
}

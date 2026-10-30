import { createHash } from 'node:crypto'

/**
 * Content addressing for archived rate cards and catalog snapshots.
 *
 * The seal-and-verify cycle is what makes a hand-edited price detectable: a
 * price changed in a rate card file without re-running `npm run seal` produces
 * a hash mismatch, and a hash mismatch refuses to load. There is deliberately
 * no "recompute on load" path, because that would make the seal decorative.
 */
export function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex')
}

/**
 * Canonical JSON: object keys sorted, no insignificant whitespace, bigint
 * refused. Two documents that differ only in key order hash identically, so a
 * reformatting pass over the data directory does not invalidate every seal.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (typeof value === 'bigint') {
    throw new TypeError('canonicalJson: bigint has no canonical JSON form; render it as a string')
  }
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    const entry = source[key]
    if (entry === undefined) continue
    out[key] = canonicalize(entry)
  }
  return out
}

/**
 * The hash a sealed document commits to: every field EXCEPT the seal itself.
 * Excluding the seal is what lets the seal live inside the document it seals.
 */
export function sealHash(document: Record<string, unknown>, sealField: string): string {
  const copy: Record<string, unknown> = { ...document }
  delete copy[sealField]
  return sha256Hex(canonicalJson(copy))
}

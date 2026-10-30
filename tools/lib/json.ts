/**
 * Bigint-safe JSON.
 *
 * Money is bigint minor units everywhere in this repo. `JSON.stringify` throws
 * on a bigint, and the tempting fix - Number(amount) - is exactly the bug the
 * money rule exists to prevent. So every amount crosses a file or a pipe as a
 * DECIMAL STRING, and is parsed back as a bigint.
 *
 * Two encodings are supported on the way out:
 *   - `tagged`: {"$bigint":"123"} - round-trips exactly, used for the cache.
 *   - `string`: "123" - used for the tools' own stdout, so the JSON stays
 *     readable by jq and by other people's scripts. Fields carrying minor units
 *     are named with a `Minor` suffix by convention so the reader knows.
 */

export type BigintEncoding = 'tagged' | 'string'

export function stringifyJson(value: unknown, encoding: BigintEncoding = 'string', indent = 2): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => {
      if (typeof v === 'bigint') return encoding === 'tagged' ? { $bigint: v.toString() } : v.toString()
      return v
    },
    indent,
  )
}

export function parseJson<T = unknown>(text: string): T {
  return JSON.parse(text, (_key, v: unknown) => {
    if (typeof v === 'object' && v !== null && '$bigint' in v) {
      const tagged = (v as { $bigint: unknown }).$bigint
      if (typeof tagged === 'string' && /^-?\d+$/.test(tagged)) return BigInt(tagged)
    }
    return v
  }) as T
}

/**
 * Coerce a JSON-carried amount back to bigint. Accepts a decimal string or an
 * already-bigint value. REJECTS a number: a float that reached an amount field
 * has already lost precision and must not be laundered into a bigint here.
 */
export function toMinor(value: unknown, field = 'amount'): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  if (typeof value === 'number') {
    throw new Error(
      `${field}: refusing to read a JSON number as minor units (precision is already lost); emit a decimal string`,
    )
  }
  throw new Error(`${field}: not a minor-unit amount: ${JSON.stringify(value)}`)
}

/**
 * JSON in and out, with the money discipline enforced at the boundary.
 *
 * BIGINT NEVER CROSSES THE WIRE AS A NUMBER. JSON.stringify throws on a bigint,
 * which is the correct behaviour and we keep it: serialising 10n as 10 would
 * hand a client a value that silently loses its low digits above 2^53. Callers
 * convert money to a decimal STRING before it reaches here, and `serialize`
 * refuses anything that still holds a bigint rather than guessing.
 */

export class JsonError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'JsonError'
  }
}

export const MAX_BODY_BYTES = 256 * 1024

export function parseJsonBody(raw: string): unknown {
  if (raw.length === 0) return undefined
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    throw new JsonError('request body too large', 'body_too_large')
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new JsonError('body is not valid JSON', 'malformed_json')
  }
}

export function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') {
      throw new JsonError(
        'a bigint reached the response serialiser; convert money to a decimal string first',
        'bigint_in_response',
      )
    }
    return v
  })
}

// ---------------------------------------------------------------------------
// Field readers. Every one of them refuses rather than coerces.
// ---------------------------------------------------------------------------

export function requireObject(value: unknown, field = 'body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JsonError(`${field} must be an object`, 'bad_field')
  }
  return value as Record<string, unknown>
}

export function requireString(
  source: Record<string, unknown>,
  field: string,
  maxLength = 512,
): string {
  const value = source[field]
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new JsonError(`${field} must be a non-empty string of at most ${String(maxLength)} chars`, 'bad_field')
  }
  return value
}

export function optionalString(
  source: Record<string, unknown>,
  field: string,
  maxLength = 512,
): string | undefined {
  if (source[field] === undefined) return undefined
  return requireString(source, field, maxLength)
}

export function requireInteger(
  source: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number {
  const value = source[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new JsonError(
      `${field} must be an integer in [${String(min)}, ${String(max)}]`,
      'bad_field',
    )
  }
  return value
}

export function optionalInteger(
  source: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (source[field] === undefined) return undefined
  return requireInteger(source, field, min, max)
}

export function requireStringArray(
  source: Record<string, unknown>,
  field: string,
  maxItems = 32,
  maxLength = 512,
): string[] {
  const value = source[field]
  if (!Array.isArray(value)) throw new JsonError(`${field} must be an array`, 'bad_field')
  if (value.length > maxItems) throw new JsonError(`${field} has too many items`, 'bad_field')
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.length > maxLength) {
      throw new JsonError(`${field}[${String(index)}] must be a short string`, 'bad_field')
    }
    return item
  })
}

/**
 * Refuse any key the schema does not name.
 *
 * A closed key set is the difference between "we ignored your extra field" and
 * "you thought you set something and we silently did not". It also stops a
 * client smuggling a field that a future version starts honouring.
 */
export function assertExactKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  field = 'body',
): void {
  const permitted = new Set(allowed)
  for (const key of Object.keys(source)) {
    if (!permitted.has(key)) {
      throw new JsonError(`${field} has an unexpected field "${key}"`, 'unknown_field')
    }
  }
}

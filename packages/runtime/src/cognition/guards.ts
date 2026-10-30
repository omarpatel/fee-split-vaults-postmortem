import { AirlockViolation, assertNoDestination } from '@fee-split-vaults/core'
import { sanitizeUntrusted } from '../corpus/sanitize.js'

/**
 * Boundary guards applied to every string a model authors before that string is
 * allowed to leave the cognition plane.
 *
 * These are defence in depth. The primary control is that no tool on either
 * plane accepts a payee or an amount in the first place - a purchase is a SKU id
 * and a quantity, and a link is an allowlist id. This file exists because the
 * primary control has to be paired with a check that fails loudly when someone
 * later widens a schema and forgets why it was narrow.
 */

/**
 * DELEGATES. It used to re-implement a superset of core's rules - its own handle
 * pattern, its own TLD list, its own amount list - which is how the two drifted
 * apart until core's boundary was materially weaker than the guard sitting on
 * top of it, and how a `.top` host could be a domain to neither of them. There
 * is now one definition of every destination shape, in
 * packages/core/src/destinations.ts, and this function's whole job is to
 * normalise and hand over.
 */
export function assertNoDestinationOrAmount(value: string, field: string): void {
  // Normalise first: a payload written in fullwidth digits or split by a
  // zero-width space defeats every pattern until NFKC folds it. NFKC can lengthen
  // a string, so the cap is generous: truncating here would hide a payload parked
  // at the end of the value. assertNoDestination folds again on its own behalf -
  // it is a boundary, so it does not rely on its caller having done this.
  const normalised = sanitizeUntrusted(value, Math.max(value.length * 4, 1))

  assertNoDestination(normalised, field)
}

/** True when the value would be rejected. For filtering rather than failing. */
export function carriesDestinationOrAmount(value: string, field = 'value'): boolean {
  try {
    assertNoDestinationOrAmount(value, field)
    return false
  } catch (error: unknown) {
    if (error instanceof AirlockViolation) return true
    throw error
  }
}

export class MalformedModelOutput extends Error {
  constructor(message: string) {
    super(`model output rejected: ${message}`)
    this.name = 'MalformedModelOutput'
  }
}

/**
 * Parse exactly one JSON object out of a model's text turn. Fail closed: no
 * "find the first {", no repair pass, no partial acceptance. A model that cannot
 * follow the output contract is a model whose output is not trustworthy enough
 * to guess at.
 */
export function parseStrictJsonObject(raw: string): Record<string, unknown> {
  let text = raw.trim()
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(text)
  if (fence?.[1] !== undefined) text = fence[1].trim()

  if (!text.startsWith('{') || !text.endsWith('}')) {
    throw new MalformedModelOutput('expected a single JSON object and nothing else')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new MalformedModelOutput(
      `not valid JSON: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MalformedModelOutput('top level value is not an object')
  }
  return parsed as Record<string, unknown>
}

/** Closed-key check. An unexpected key is a schema change, so it is a violation. */
export function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const permitted = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      throw new AirlockViolation(`unexpected field "${key}" - schema is closed`, field)
    }
  }
}

export function requireInteger(
  value: unknown,
  field: string,
  bounds: { min: number; max: number },
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AirlockViolation(`${field} must be an integer`, field)
  }
  if (value < bounds.min || value > bounds.max) {
    throw new AirlockViolation(`${field} out of range`, field)
  }
  return value
}

export function requireBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new AirlockViolation(`${field} must be a string`, field)
  const cleaned = sanitizeUntrusted(value, maxLength)
  if (cleaned.length === 0) throw new AirlockViolation(`${field} must not be empty`, field)
  return cleaned
}

export function requireMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new AirlockViolation(`unknown ${field} "${String(value)}"`, field)
  }
  return value as T
}

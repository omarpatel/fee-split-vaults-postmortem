/**
 * Row decoding shared by the Postgres stores.
 *
 * EVERY COLUMN IS DECODED THROUGH A CHECK, never a cast. `pg` hands BIGINT and
 * NUMERIC back as strings, INTEGER and BOOLEAN as themselves, JSONB as a
 * parsed object; pglite (the test engine) agrees on all but BIGINT, which it
 * returns as a number when it fits. The helpers here accept every honest
 * representation and refuse anything else, so a schema drift surfaces as a
 * typed throw at the read rather than as a `undefined` that flows into a cap.
 *
 * `guarded` is the one rule every store shares with counters.ts: a driver
 * failure becomes `SourceUnavailableError`, and the caller must treat that as
 * unknown - never as an empty result. A refusal the store raised on purpose
 * (an `AdapterError`) passes through untouched.
 */

import { AdapterError, SourceUnavailableError } from '../errors.js'
import { bigIntFromSql, countFromSql } from './sql.js'

export async function guarded<T>(source: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof AdapterError) throw error
    throw new SourceUnavailableError(source, String(error), error)
  }
}

export function strFromSql(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`${field} is ${typeof value}, not a string`)
  return value
}

export function optStrFromSql(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined
  return strFromSql(value, field)
}

export function boolFromSql(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${field} is ${typeof value}, not a boolean`)
  return value
}

export function optCountFromSql(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) return undefined
  return countFromSql(value, field)
}

export function optBigIntFromSql(value: unknown, field: string): bigint | undefined {
  if (value === null || value === undefined) return undefined
  return bigIntFromSql(value, field)
}

export function enumFromSql<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const text = strFromSql(value, field)
  if (!(allowed as readonly string[]).includes(text)) {
    throw new TypeError(`${field} holds ${JSON.stringify(text)}, which this build does not recognise`)
  }
  return text as T
}

/** A JSONB column: an object from the driver, or its text if the driver did not parse it. */
export function jsonFromSql(value: unknown, field: string): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch (error) {
      throw new TypeError(`${field} is not valid JSON: ${String(error)}`)
    }
  }
  if (value === null || value === undefined) throw new TypeError(`${field} is null, not JSON`)
  return value
}

export function stringArrayFromSql(value: unknown, field: string): string[] {
  const parsed = jsonFromSql(value, field)
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${field} is not an array of strings`)
  }
  return parsed as string[]
}

export function objectFromSql(value: unknown, field: string): Record<string, unknown> {
  const parsed = jsonFromSql(value, field)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${field} is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/** Absent for undefined so a row round-trips to the exact optional shape. */
export function withOptional<T extends object, K extends string, V>(
  base: T,
  key: K,
  value: V | undefined,
): T | (T & Record<K, V>) {
  return value === undefined ? base : { ...base, [key]: value }
}

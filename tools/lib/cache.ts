/**
 * On-disk results cache.
 *
 * A full escrow scan is tens of thousands of eth_getLogs calls. Re-running a
 * tool to change a threshold must not re-pay for the chain read, and must not
 * silently produce a DIFFERENT answer than the run before it - so cached
 * entries are keyed by every input that could change the result, and carry the
 * tool version that wrote them.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseJson, stringifyJson } from './json.ts'

export interface CacheEntry<T> {
  key: string
  writtenAtUnix: number
  /** Bumped when a decoder changes shape, invalidating older entries. */
  schemaVersion: string
  value: T
}

export interface Cache {
  get<T>(key: string, schemaVersion: string, maxAgeSeconds?: number): Promise<T | undefined>
  set<T>(key: string, schemaVersion: string, value: T): Promise<void>
  readonly hits: number
  readonly misses: number
}

export function cacheKey(parts: Record<string, unknown>): string {
  // Sorted keys so an equivalent request always hashes the same.
  const canonical = stringifyJson(
    Object.fromEntries(Object.entries(parts).sort(([a], [b]) => a.localeCompare(b))),
    'tagged',
    0,
  )
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

export class FileCache implements Cache {
  #hits = 0
  #misses = 0
  readonly #dir: string
  readonly #now: () => number

  constructor(dir: string, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.#dir = dir
    this.#now = now
  }

  get hits(): number {
    return this.#hits
  }
  get misses(): number {
    return this.#misses
  }

  #path(key: string): string {
    // Two-level fan-out keeps directory listings usable at tens of thousands of entries.
    return join(this.#dir, key.slice(0, 2), `${key}.json`)
  }

  async get<T>(key: string, schemaVersion: string, maxAgeSeconds?: number): Promise<T | undefined> {
    let raw: string
    try {
      raw = await readFile(this.#path(key), 'utf8')
    } catch {
      this.#misses++
      return undefined
    }
    let entry: CacheEntry<T>
    try {
      entry = parseJson<CacheEntry<T>>(raw)
    } catch {
      this.#misses++
      return undefined
    }
    if (entry.schemaVersion !== schemaVersion) {
      this.#misses++
      return undefined
    }
    if (maxAgeSeconds !== undefined && this.#now() - entry.writtenAtUnix > maxAgeSeconds) {
      this.#misses++
      return undefined
    }
    this.#hits++
    return entry.value
  }

  async set<T>(key: string, schemaVersion: string, value: T): Promise<void> {
    const path = this.#path(key)
    await mkdir(dirname(path), { recursive: true })
    const entry: CacheEntry<T> = {
      key,
      writtenAtUnix: this.#now(),
      schemaVersion,
      value,
    }
    // Write-then-rename so an interrupted run cannot leave a truncated entry
    // that would later be read back as a real, short result set.
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, stringifyJson(entry, 'tagged', 0), 'utf8')
    const { rename } = await import('node:fs/promises')
    await rename(temp, path)
  }

  async clear(): Promise<void> {
    await rm(this.#dir, { recursive: true, force: true })
  }
}

export class MemoryCache implements Cache {
  readonly store = new Map<string, CacheEntry<unknown>>()
  #hits = 0
  #misses = 0
  readonly #now: () => number

  constructor(now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.#now = now
  }

  get hits(): number {
    return this.#hits
  }
  get misses(): number {
    return this.#misses
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get<T>(key: string, schemaVersion: string, maxAgeSeconds?: number): Promise<T | undefined> {
    const entry = this.store.get(key)
    if (
      entry === undefined ||
      entry.schemaVersion !== schemaVersion ||
      (maxAgeSeconds !== undefined && this.#now() - entry.writtenAtUnix > maxAgeSeconds)
    ) {
      this.#misses++
      return undefined
    }
    this.#hits++
    return entry.value as T
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async set<T>(key: string, schemaVersion: string, value: T): Promise<void> {
    this.store.set(key, { key, schemaVersion, writtenAtUnix: this.#now(), value })
  }
}

/** Used behind --no-cache. Never reads, never writes. */
export class NullCache implements Cache {
  readonly hits = 0
  readonly misses = 0
  // eslint-disable-next-line @typescript-eslint/require-await
  async get<T>(): Promise<T | undefined> {
    return undefined
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async set(): Promise<void> {
    /* intentionally empty */
  }
}

export function buildCache(dir: string, disabled: boolean): Cache {
  return disabled ? new NullCache() : new FileCache(dir)
}

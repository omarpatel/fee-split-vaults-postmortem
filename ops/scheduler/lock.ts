/**
 * Singleton locks.
 *
 * LEASE, NOT MUTEX. A holder that dies without releasing must not wedge the job
 * forever, so a lock has an expiry. That means a lease can expire while the
 * holder is still working, which is why every job is ALSO idempotent: the lock
 * makes double execution rare, the idempotency key makes it harmless.
 *
 * FAIL CLOSED. acquire() returning null and acquire() throwing are different
 * things and the scheduler treats them differently: null is "someone else has
 * it, skip"; a throw is "the lock backend is unreachable, refuse to run".
 */

import type { Clock } from '../lib/time.js'

export interface Lease {
  key: string
  /** Random per acquisition. Release is refused unless the token matches. */
  token: string
  expiresAtUnix: number
}

export interface LockBackend {
  /** Returns null when held by someone else. Throws when the backend is unavailable. */
  acquire(key: string, leaseSeconds: number, owner: string): Promise<Lease | null>
  /** Extends a lease we still hold. Returns false when the lease was lost. */
  renew(lease: Lease, leaseSeconds: number): Promise<boolean>
  /** Idempotent. Releasing a lease we no longer hold is a no-op, not an error. */
  release(lease: Lease): Promise<void>
}

export class LockBackendUnavailable extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`lock backend unavailable: ${message}`)
    this.name = 'LockBackendUnavailable'
  }
}

interface Held {
  token: string
  owner: string
  expiresAtUnix: number
}

/**
 * In-process lock. Correct for a single scheduler process and for tests; it is
 * NOT a distributed lock and says so, because the failure mode of pretending
 * otherwise is two boxes sweeping the same escrow.
 */
export class InMemoryLockBackend implements LockBackend {
  readonly #held = new Map<string, Held>()
  readonly #clock: Clock
  #counter = 0
  /** Set to make every call throw, so fail-closed behaviour can be tested. */
  unavailable = false

  constructor(clock: Clock) {
    this.#clock = clock
  }

  async acquire(key: string, leaseSeconds: number, owner: string): Promise<Lease | null> {
    if (this.unavailable) throw new LockBackendUnavailable('injected fault')
    const now = this.#clock.nowUnix()
    const current = this.#held.get(key)
    if (current && current.expiresAtUnix > now) return null
    this.#counter += 1
    const token = `${owner}#${this.#counter}`
    const expiresAtUnix = now + leaseSeconds
    this.#held.set(key, { token, owner, expiresAtUnix })
    return { key, token, expiresAtUnix }
  }

  async renew(lease: Lease, leaseSeconds: number): Promise<boolean> {
    if (this.unavailable) throw new LockBackendUnavailable('injected fault')
    const current = this.#held.get(lease.key)
    if (!current || current.token !== lease.token) return false
    const expiresAtUnix = this.#clock.nowUnix() + leaseSeconds
    this.#held.set(lease.key, { ...current, expiresAtUnix })
    lease.expiresAtUnix = expiresAtUnix
    return true
  }

  async release(lease: Lease): Promise<void> {
    if (this.unavailable) throw new LockBackendUnavailable('injected fault')
    const current = this.#held.get(lease.key)
    if (current && current.token === lease.token) this.#held.delete(lease.key)
  }

  /** Test helper: how many keys are currently held and unexpired. */
  heldCount(): number {
    const now = this.#clock.nowUnix()
    let n = 0
    for (const held of this.#held.values()) if (held.expiresAtUnix > now) n += 1
    return n
  }
}

/**
 * SQL-backed lease lock. Written against the narrow driver in
 * ops/migrations/driver.ts so it works on Postgres without importing a client
 * library into this package.
 *
 * The correctness argument is one statement: the conditional UPDATE below
 * changes a row only when the existing lease has expired, and the driver reports
 * how many rows it changed. Two racing schedulers both issue it; exactly one
 * sees rowsAffected = 1.
 */
export interface LockSqlDriver {
  execute(sql: string, params: readonly (string | number | null)[]): Promise<{ rowsAffected: number }>
}

export const LOCK_TABLE = 'ops_job_lock'

export class SqlLockBackend implements LockBackend {
  readonly #driver: LockSqlDriver
  readonly #clock: Clock
  #counter = 0

  constructor(driver: LockSqlDriver, clock: Clock) {
    this.#driver = driver
    this.#clock = clock
  }

  async acquire(key: string, leaseSeconds: number, owner: string): Promise<Lease | null> {
    const now = this.#clock.nowUnix()
    const expiresAtUnix = now + leaseSeconds
    this.#counter += 1
    const token = `${owner}#${now}#${this.#counter}`
    try {
      const inserted = await this.#driver.execute(
        `INSERT INTO ${LOCK_TABLE} (lock_key, token, owner, acquired_at_unix, expires_at_unix)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (lock_key) DO UPDATE
           SET token = EXCLUDED.token,
               owner = EXCLUDED.owner,
               acquired_at_unix = EXCLUDED.acquired_at_unix,
               expires_at_unix = EXCLUDED.expires_at_unix
         WHERE ${LOCK_TABLE}.expires_at_unix <= $4`,
        [key, token, owner, now, expiresAtUnix],
      )
      return inserted.rowsAffected === 1 ? { key, token, expiresAtUnix } : null
    } catch (error) {
      throw new LockBackendUnavailable('acquire failed', error)
    }
  }

  async renew(lease: Lease, leaseSeconds: number): Promise<boolean> {
    const expiresAtUnix = this.#clock.nowUnix() + leaseSeconds
    try {
      const result = await this.#driver.execute(
        `UPDATE ${LOCK_TABLE} SET expires_at_unix = $1 WHERE lock_key = $2 AND token = $3`,
        [expiresAtUnix, lease.key, lease.token],
      )
      if (result.rowsAffected === 1) {
        lease.expiresAtUnix = expiresAtUnix
        return true
      }
      return false
    } catch (error) {
      throw new LockBackendUnavailable('renew failed', error)
    }
  }

  async release(lease: Lease): Promise<void> {
    try {
      await this.#driver.execute(`DELETE FROM ${LOCK_TABLE} WHERE lock_key = $1 AND token = $2`, [
        lease.key,
        lease.token,
      ])
    } catch (error) {
      throw new LockBackendUnavailable('release failed', error)
    }
  }
}

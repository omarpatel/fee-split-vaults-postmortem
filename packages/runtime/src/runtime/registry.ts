import type { ModelClient } from '../model/client.js'
import { CoinRuntime } from './coinRuntime.js'
import type { CoinRuntimeConfig } from './coinRuntime.js'
import { sameUserId } from '../isolation/userId.js'

/**
 * Holds one runtime per coin.
 *
 * The registry deliberately exposes no aggregate view of state. There is no
 * "all proposals", no shared cost pool, and no cross-coin query, because every
 * such convenience is a path by which one client's context reaches another's
 * planner - and because a shared budget is a cross-coin subsidy, which the
 * commitment rule forbids outright.
 */

export class CrossCoinAccess extends Error {
  constructor(expected: string, actual: string) {
    super(`cross-coin access refused: expected ${expected}, got ${actual}`)
    this.name = 'CrossCoinAccess'
  }
}

export class CoinRuntimeRegistry {
  private readonly runtimes = new Map<string, CoinRuntime>()

  constructor(private readonly model: ModelClient) {}

  register(config: CoinRuntimeConfig): CoinRuntime {
    if (this.runtimes.has(config.coinRef)) {
      throw new Error(`coin ${config.coinRef} is already registered`)
    }
    const runtime = new CoinRuntime(config, this.model)
    // Two coins sharing a user_id would merge their abuse signals and defeat the
    // per-client attribution the field exists for.
    for (const existing of this.runtimes.values()) {
      if (sameUserId(existing.userIdHash, runtime.userIdHash)) {
        throw new Error(`user id collision between ${existing.coinRef} and ${config.coinRef}`)
      }
    }
    this.runtimes.set(config.coinRef, runtime)
    return runtime
  }

  get(coinRef: string): CoinRuntime | undefined {
    return this.runtimes.get(coinRef)
  }

  require(coinRef: string): CoinRuntime {
    const runtime = this.runtimes.get(coinRef)
    if (runtime === undefined) throw new Error(`coin ${coinRef} is not registered`)
    return runtime
  }

  remove(coinRef: string): boolean {
    return this.runtimes.delete(coinRef)
  }

  get size(): number {
    return this.runtimes.size
  }

  /** Coin references only. Never state. */
  refs(): string[] {
    return [...this.runtimes.keys()].sort()
  }

  /** Guard for any call site that carries a coin reference alongside coin data. */
  static assertSameCoin(expected: string, actual: string): void {
    if (expected !== actual) throw new CrossCoinAccess(expected, actual)
  }
}

import type { Address, AssetAddress } from '@fee-split-vaults/core'

export const VAULT: Address = '0x1111111111111111111111111111111111111111'
export const VAULT_B: Address = '0x2222222222222222222222222222222222222222'
export const USDG: AssetAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export const WETH: AssetAddress = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'
export const POOL = '0xpool000000000000000000000000000000000000000000000000000000000001'

export const T0 = 1_757_000_000

/** xorshift32, so a fuzz failure is reproducible from its seed alone. */
export class Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0 || 1
  }

  next(): number {
    let x = this.state
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.state = x >>> 0
    return this.state / 0x1_0000_0000
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive)
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)]
    if (item === undefined) throw new Error('pick from empty array')
    return item
  }
}

import { describe, expect, it } from 'vitest'
import { CoinIsolationError, InMemoryMessageSource } from '@fee-split-vaults/orchestrator'
import type { RawMessage } from '@fee-split-vaults/runtime'
import { MergedMessageSource } from '../telegram/merged.js'

const NOW = 1_800_000_000

function raw(overrides: Partial<RawMessage>): RawMessage {
  return { sourceId: '1', authorId: 'a', text: 'hi', postedAtUnix: NOW, origin: 'telegram', boundCoinRef: 'coin-alpha', ...overrides }
}

describe('MergedMessageSource', () => {
  it('unions its sources into one chronological window', async () => {
    const telegram = new InMemoryMessageSource()
    const x = new InMemoryMessageSource()
    telegram.add(raw({ sourceId: '2', postedAtUnix: NOW + 2 }))
    x.add(raw({ sourceId: '1834567890123456789', origin: 'x_mention', postedAtUnix: NOW + 1 }))
    const merged = new MergedMessageSource([telegram, x])

    const window = await merged.since('coin-alpha', NOW, NOW + 10)
    expect(window.map((m) => `${m.origin}:${m.sourceId}`)).toEqual(['x_mention:1834567890123456789', 'telegram:2'])
  })

  it("refuses the whole window when any source hands over another coin's row", async () => {
    const telegram = new InMemoryMessageSource()
    const leaky = { since: async () => [raw({ boundCoinRef: 'coin-beta' })] }
    telegram.add(raw({}))
    const merged = new MergedMessageSource([telegram, leaky])
    await expect(merged.since('coin-alpha', NOW, NOW + 10)).rejects.toBeInstanceOf(CoinIsolationError)
  })

  it('fails the window when any source fails, rather than reading half a world', async () => {
    const broken = { since: async (): Promise<readonly RawMessage[]> => { throw new Error('down') } }
    const merged = new MergedMessageSource([new InMemoryMessageSource(), broken])
    await expect(merged.since('coin-alpha', NOW, NOW + 10)).rejects.toThrow('down')
  })
})

/**
 * One MessageSource over several: a coin's Telegram chat and its X mentions,
 * read as one window.
 *
 * Each underlying source stamps and asserts its own binding; this one adds
 * the same assertion on the union so that a source which forgot its half
 * cannot slip a foreign row through the merge. A failure in ANY source is a
 * failure of the window - a corpus assembled from half the sources is a
 * confident reading of a world that was not observed.
 */

import type { RawMessage } from '@fee-split-vaults/runtime'
import { CoinIsolationError, type MessageSource } from '@fee-split-vaults/orchestrator'

export class MergedMessageSource implements MessageSource {
  readonly #sources: readonly MessageSource[]

  constructor(sources: readonly MessageSource[]) {
    if (sources.length === 0) throw new Error('a merged message source needs at least one source')
    this.#sources = sources
  }

  async since(coinRef: string, fromUnix: number, toUnix: number): Promise<readonly RawMessage[]> {
    const windows = await Promise.all(this.#sources.map((source) => source.since(coinRef, fromUnix, toUnix)))
    const merged: RawMessage[] = []
    for (const window of windows) {
      for (const message of window) {
        if (message.boundCoinRef !== coinRef) {
          throw new CoinIsolationError(coinRef, message.boundCoinRef, `merged source, ${message.origin} row`)
        }
        merged.push(message)
      }
    }
    // Chronological across sources; ties by origin then source id so a replay
    // of the same window renders the same corpus byte for byte.
    return merged.sort(
      (a, b) =>
        a.postedAtUnix - b.postedAtUnix ||
        a.origin.localeCompare(b.origin) ||
        a.sourceId.length - b.sourceId.length ||
        a.sourceId.localeCompare(b.sourceId),
    )
  }
}

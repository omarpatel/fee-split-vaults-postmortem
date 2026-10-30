import { ModelCallFailed } from './client.js'
import type { BatchItem, BatchOutcome, ModelClient, ModelRequest, ModelResponse } from './client.js'

/**
 * Route a single call through the Batch API.
 *
 * Non-urgent work bills at half rate, which is the difference between a T1 desk
 * that fits its COGS budget and one that does not. The trade is latency: a batch
 * usually lands within an hour and may take a day. Anything a community would
 * notice waiting for must stay on the synchronous path.
 */
export function batchRouted(client: ModelClient, customId = 'single'): ModelClient {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const results = await client.completeBatch([{ customId, request }])
      const outcome = results.get(customId)
      if (outcome === undefined) throw new ModelCallFailed('batch returned no result')
      if (outcome.status === 'failed') throw new ModelCallFailed(`batch failed: ${outcome.reason}`)
      return outcome.response
    },
    completeBatch(items: BatchItem[]): Promise<Map<string, BatchOutcome>> {
      return client.completeBatch(items)
    },
  }
}

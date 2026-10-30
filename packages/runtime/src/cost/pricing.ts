import { MODEL } from '../model/ids.js'
import type { ModelId } from '../model/ids.js'
import type { ModelUsage } from '../model/client.js'

/**
 * List prices, USD per million tokens, as published on 2026-06-24. These are a
 * parameter, not a constant of nature: pass an override into CostGovernor when
 * the rate card moves rather than editing a call site.
 */
export interface ModelPrice {
  inputPerMTokUsd: number
  outputPerMTokUsd: number
  /** Cache writes bill above the input rate. */
  cacheWriteMultiplier: number
  /** Cache reads bill well below it. */
  cacheReadMultiplier: number
}

export const MODEL_PRICES: Record<ModelId, ModelPrice> = {
  [MODEL.haiku45]: {
    inputPerMTokUsd: 1.0,
    outputPerMTokUsd: 5.0,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
  [MODEL.sonnet5]: {
    inputPerMTokUsd: 2.0,
    outputPerMTokUsd: 10.0,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
}

/** The Batch API bills at half the synchronous rate. */
export const BATCH_DISCOUNT = 0.5

export interface PriceOptions {
  batch?: boolean
  prices?: Record<ModelId, ModelPrice>
}

/**
 * USD cost of one call. Floating point is correct here and only here: this is a
 * cost estimate for a spend governor, never an amount that moves on chain.
 */
export function priceUsd(model: ModelId, usage: ModelUsage, opts: PriceOptions = {}): number {
  const table = opts.prices ?? MODEL_PRICES
  const p = table[model]
  if (p === undefined) throw new Error(`no price for model ${model}; refusing to estimate`)

  const perToken = (rate: number): number => rate / 1_000_000
  const gross =
    usage.inputTokens * perToken(p.inputPerMTokUsd) +
    usage.cacheCreationInputTokens * perToken(p.inputPerMTokUsd) * p.cacheWriteMultiplier +
    usage.cacheReadInputTokens * perToken(p.inputPerMTokUsd) * p.cacheReadMultiplier +
    usage.outputTokens * perToken(p.outputPerMTokUsd)

  return opts.batch === true ? gross * BATCH_DISCOUNT : gross
}

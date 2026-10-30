import { TIERS } from '../protocol.js'
import type { TierId } from '../protocol.js'

/**
 * Model ids are the exact published strings. Do not append a date suffix - the
 * API rejects ids that do not exist, and a 400 here is a fail-open opportunity
 * for anyone who catches it too broadly.
 */
export const MODEL = {
  /** T1 desk and the reader at every tier. 200K context, cheapest per token. */
  haiku45: 'claude-haiku-4-5',
  /** T2+ planner. */
  sonnet5: 'claude-sonnet-5',
} as const

export type ModelId = (typeof MODEL)[keyof typeof MODEL]

export const MODEL_IDS: readonly ModelId[] = [MODEL.haiku45, MODEL.sonnet5] as const

/** The three call shapes this runtime makes. There are no others. */
export type PlaneRole = 'reader' | 'planner' | 'desk'

export class TierHasNoModel extends Error {
  constructor(readonly tier: TierId) {
    super(`tier ${tier} is deterministic by design; it makes no model calls`)
    this.name = 'TierHasNoModel'
  }
}

/**
 * Tier -> model. The reader is always the cheap model: it reads attacker text
 * and its only job is to emit closed-enum counts, which does not improve with a
 * larger model but does get more expensive under a mention flood.
 */
export function modelForRole(role: PlaneRole, tier: TierId): ModelId {
  if (!TIERS[tier].usesModel) throw new TierHasNoModel(tier)
  switch (role) {
    case 'reader':
    case 'desk':
      return MODEL.haiku45
    case 'planner':
      return tier === 'T1' ? MODEL.haiku45 : MODEL.sonnet5
  }
}

/**
 * output_config.effort errors on Haiku 4.5. Sending it anyway is a 400 on every
 * reader call, i.e. a total outage of the community arm.
 */
export function supportsEffort(model: ModelId): boolean {
  return model === MODEL.sonnet5
}

/** Adaptive thinking is the only on-mode on Sonnet 5; Haiku 4.5 takes a budget. */
export function supportsAdaptiveThinking(model: ModelId): boolean {
  return model === MODEL.sonnet5
}

/** Published context window, used to refuse a request that cannot fit. */
export const MODEL_CONTEXT_TOKENS: Record<ModelId, number> = {
  [MODEL.haiku45]: 200_000,
  [MODEL.sonnet5]: 1_000_000,
}

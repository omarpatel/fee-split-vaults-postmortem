/**
 * The broker's single import surface for protocol economics.
 *
 * config/protocol.ts is the only place these numbers exist. Nothing in this
 * package may re-declare one of them, and every file below imports from here so
 * the coupling to the config module is one edge rather than thirty.
 */
export {
  TERMS,
  TIERS,
  TIER_ORDER,
  SPEND_LIMITS,
  COMMITMENT_RULE,
  QUALIFICATION_FLOOR_MONTHLY_USD,
} from '../../../config/protocol.js'

export type { Tier, TierId } from '../../../config/protocol.js'

/**
 * The catalog's single import surface for protocol economics.
 *
 * config/protocol.ts is the only place these numbers exist. Nothing in this
 * package re-declares one, and every other file imports from here so the
 * coupling to the config module is one edge rather than twenty.
 */
export {
  TERMS,
  TIERS,
  TIER_ORDER,
  SPEND_LIMITS,
  DISCLOSURE,
  QUALIFICATION_FLOOR_MONTHLY_USD,
} from '../../../config/protocol.js'

export type { Tier, TierId } from '../../../config/protocol.js'

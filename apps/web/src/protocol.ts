/**
 * This app's single import surface for protocol economics.
 *
 * config/protocol.ts is the only place these numbers exist. Nothing else in
 * apps/web may re-declare one of them, and no component may hardcode a rate.
 * In particular the creator rate BRANCHES on the per-token buyback setting, so
 * every rate the page renders comes from creatorNetBps() at render time.
 */
export {
  VENUE,
  TERMS,
  TIERS,
  TIER_ORDER,
  SPEND_LIMITS,
  COMMITMENT_RULE,
  DISCLOSURE,
  REFUSAL_CLASSES,
  QUALIFICATION_FLOOR_MONTHLY_USD,
  breakEvenMultiple,
  creatorNetBps,
  devBps,
  volumeForQf,
} from '../../../config/protocol.js'

export type { RefusalClass, Tier, TierId } from '../../../config/protocol.js'

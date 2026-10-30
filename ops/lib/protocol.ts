/**
 * The ONLY place in ops/ that reaches into config/protocol.ts.
 *
 * Every economic number the operations plane uses comes through here, so there
 * is exactly one path to audit and exactly one file to change when the pricing
 * decision lands. In particular: nothing under ops/ may compute a creator rate.
 * It calls creatorNetBps(buybackEnabled, creatorTaxBps) and branches on the
 * per-token setting, because the rate is 0.70%/0.35% depending on a flag that
 * only the chain knows.
 *
 * ops/ci/no-hardcoded-rates.ts is the machine that enforces that.
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
  creatorNetBps,
  volumeForQf,
  devBps,
  breakEvenMultiple,
} from '../../config/protocol.js'

export type { Tier, TierId, RefusalClass } from '../../config/protocol.js'

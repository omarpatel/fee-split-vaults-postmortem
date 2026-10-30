/**
 * Single re-export point for the root protocol config.
 *
 * Every other module in this package imports protocol values from here so that
 * exactly one file carries the deep relative path out of the package. Nothing is
 * redefined and no constant is copied - config/protocol.ts remains the only
 * definition.
 */

export { TIERS, TIER_ORDER, REFUSAL_CLASSES, SPEND_LIMITS, DISCLOSURE } from '../../../config/protocol.js'
export type { TierId, Tier, RefusalClass } from '../../../config/protocol.js'

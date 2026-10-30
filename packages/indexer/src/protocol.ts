/**
 * Single re-export point for the root protocol config.
 *
 * Every other module in this package imports protocol values from here so that
 * exactly one file carries the deep relative path out of the package. Nothing is
 * redefined and no constant is copied - config/protocol.ts remains the only
 * definition. In particular the creator rate is never a literal in this package:
 * it is always creatorNetBps(buybackEnabled, creatorTaxBps), which halves when
 * buyback is on.
 */

export { VENUE, TIERS, TIER_ORDER, creatorNetBps, volumeForQf } from '../../../config/protocol.js'
export type { TierId, Tier } from '../../../config/protocol.js'

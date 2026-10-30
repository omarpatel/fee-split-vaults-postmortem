/**
 * ONE COIN, SHARED BY EVERY SUBCOMMAND.
 *
 * Every scene in `demo` happens to the same client - a launched Venue token
 * called MOONDOG, its vault, its dev, its operator - so that watching the six
 * subcommands in a row is watching one engagement rather than six unrelated
 * demonstrations. The numbers are derived from the coin's qualified fee and the
 * dev's dial (see broker.ts) rather than invented, because a fixture that
 * contradicts its own premise is a trap for whoever tunes a limit against it.
 *
 * NOTHING HERE IS LIVE. No key, no endpoint, no chain, no vendor. The addresses
 * below are structurally valid and deliberately unmistakable as fixtures.
 */

import { VENUE } from '../../../config/protocol.ts'

/** Fixed instant. Every timestamp in the demo is relative to it, so two runs
 * a week apart print the same report. 2026-09-04T12:00:00Z. */
export const NOW = 1_788_609_600

export const DAY = 86_400

/** The operating entity. Must not be a placeholder: see core/disclosure.ts. */
export const OPERATOR_NAME = 'Northgate Ops Ltd'

export const COIN = {
  name: 'Moon Dog',
  symbol: 'MDOG',
  ticker: 'MDOG',
  /** Opaque per-coin reference. The airlock refuses anything but [A-Za-z0-9_-]. */
  ref: 'mdog-4663',
  token: '0x2222222222222222222222222222222222222222',
  vault: '0x1111111111111111111111111111111111111111',
  devPayout: '0x3333333333333333333333333333333333333333',
  devSigner: '0x3333333333333333333333333333333333333333',
  poolId: '0x0000000000000000000000000000000000000000000000000000000000000042',
} as const

export const OPERATOR_TREASURY = '0x4444444444444444444444444444444444444444'
export const VENDOR_PAYOUT = '0x5555555555555555555555555555555555555555'
export const QUOTE_ASSET = '0x6666666666666666666666666666666666666666'
export const AFFILIATE_PAYOUT = '0x9999999999999999999999999999999999999999'
export const ROUTER = '0x7777777777777777777777777777777777777777'
export const VENUE_ADAPTER = '0x8888888888888888888888888888888888888888'

/** A different client on the same book. Exists only to be NOT cross-promoted. */
export const RIVAL = {
  ticker: 'PUPPY',
  token: '0xaaaa000000000000000000000000000000000aaa',
  vault: '0xbbbb000000000000000000000000000000000bbb',
} as const

/**
 * The address a hostile message keeps trying to get in front of a holder. It
 * appears in the airlock, publisher and desk scenes; the point of the demo is
 * that it never once reaches an output.
 */
export const ATTACKER = '0x651c06a1a38c5727f0d3ef7420d90e02e0fee33d'

export const EXPLORER_BASE = 'https://explorer.example'
export const RECEIPTS_BASE = 'https://receipts.example'
export const OFFICIAL_SITE = 'moondog.example'

export const CHAIN_ID = VENUE.chainId

export const BLOCK = {
  hash: '0x9f2c41d0b7a83e5648c1fe0d2b93a7145c6e08fa31d7b249e05c8a6f43b19d70',
  number: 56_321_180,
  timestampUnix: NOW,
} as const

/** Seconds ago, as an absolute instant. Reads sit slightly behind `now`. */
export function ago(seconds: number): number {
  return NOW - seconds
}

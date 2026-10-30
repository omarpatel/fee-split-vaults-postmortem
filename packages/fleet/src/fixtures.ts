/**
 * THE FIXTURE COINS.
 *
 * Three coins, chosen so that one pass of the fleet shows the three things a
 * dev actually needs to see: a team working, a team working with one arm tied
 * behind its back, and a team that has been switched off on purpose.
 *
 *   coin_alpha   A healthy T1 desk. Fourteen days of credits at the T1 gate,
 *                a CLEAR screening, holders asking questions. Everything runs.
 *   coin_bravo   The same demand, but NO SCREENING ON FILE. The desk still
 *                answers - a missing screening is not a reason to stop talking
 *                to holders - and paid media is refused, loudly, every tick.
 *   coin_ceres   Screening BLOCKED. The team is switched off. Note the ORDER
 *                the refusal comes out in: a blocked screening drops the tier
 *                to T0 on the first evaluation, and T0 is deterministic by
 *                design, so the visible refusal is `tier_has_no_model` rather
 *                than `operations_not_permitted`. Both are true; the tier check
 *                runs first. A coin whose team is deliberately silent is the
 *                case most worth being able to see.
 *
 * These addresses are obviously synthetic on purpose. A fixture that looked
 * like a real vault is a fixture someone eventually pays.
 */

import type { CoinDefinition } from './coins.js'
import type { SandboxSeed } from './sandbox.js'
import { TERMS, TIERS } from '../../../config/protocol.js'

const LISTING_SKU = 'dexscreener.eti'
const QUOTE_ASSET = '0x6666666666666666666666666666666666666666'

function definition(
  coinRef: string,
  vault: string,
  token: string,
  tier: CoinDefinition['tier'],
): CoinDefinition {
  return {
    coinRef,
    symbol: coinRef.slice(0, 10).toUpperCase(),
    name: `Fixture ${coinRef}`,
    vault,
    token,
    quoteAsset: QUOTE_ASSET,
    tier,
    budgetBps: TERMS.budgetBpsDefault,
    sweepIntervalSeconds: 3_600,
    relatedPartyOptIn: false,
    catalog: [
      {
        id: LISTING_SKU,
        description: 'listing on a major aggregator',
        category: 'listing',
        costBand: 'medium',
      },
    ],
    linkRefs: [{ id: 'receipts', description: 'this coin’s public receipts page' }],
    linkUrls: new Map([['receipts', `https://receipts.example.test/v/${vault}`]]),
    accounts: new Map([['telegram', `tg-${coinRef}`]]),
    // No approved narrative and no rendered images: a fixture coin's planner
    // sees the same empty creative surface a freshly onboarded coin does.
    narrative: null,
    imageRefs: [],
  }
}

export const FIXTURE_COIN_REFS = ['coin_alpha', 'coin_bravo', 'coin_ceres'] as const

/**
 * The seeds, built relative to `nowUnix` so the fixture fleet is runnable at any
 * wall-clock time rather than only inside one recorded week.
 *
 * The demand is read from the tier gate in config, not written down here: the
 * day the T1 gate moves, these fixtures move with it and keep demonstrating
 * what they were written to demonstrate.
 */
export function fixtureSeeds(): SandboxSeed[] {
  return [
    {
      definition: definition(
        'coin_alpha',
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222',
        'T1',
      ),
      postingDays: 14,
      usdPerDay: TIERS.T1.gateQfPerDay,
      screening: 'CLEAR',
      windowMessages: 6,
      devPayout: '0x3333333333333333333333333333333333333333',
    },
    {
      definition: definition(
        'coin_bravo',
        '0xaaaa111111111111111111111111111111111111',
        '0xaaaa222222222222222222222222222222222222',
        'T1',
      ),
      postingDays: 14,
      usdPerDay: TIERS.T1.gateQfPerDay,
      // No screening on file. The desk keeps answering; paid media is refused.
      screening: 'missing',
      windowMessages: 4,
      devPayout: '0xaaaa333333333333333333333333333333333333',
    },
    {
      definition: definition(
        'coin_ceres',
        '0xcccc111111111111111111111111111111111111',
        '0xcccc222222222222222222222222222222222222',
        'T1',
      ),
      postingDays: 14,
      usdPerDay: TIERS.T1.gateQfPerDay,
      screening: 'BLOCKED',
      windowMessages: 5,
      devPayout: '0xcccc333333333333333333333333333333333333',
    },
  ]
}

/** The definitions alone, for a caller that brings its own world. */
export function fixtureDefinitions(): CoinDefinition[] {
  return fixtureSeeds().map((seed) => seed.definition)
}

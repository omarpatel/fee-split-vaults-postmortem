/**
 * Protocol economics. Every number here is a parameter, not a constant of nature.
 *
 * Phase 0 verification (6 Sep 2026, block 56321180) read these from verified
 * source on chain 4663 and they take precedence over any aggregator figure:
 *
 *   hookFeeBps           = 100    (1.00% base pool fee)
 *   protocolFeeShareBps  = 3000   (Venue takes 30% of the base fee FIRST)
 *   buybackBurnBps       = 5000   (of the post-protocol remainder, if enabled)
 *
 * The creator's net therefore BRANCHES on one per-token setting:
 *   buyback OFF -> 0.70% of volume
 *   buyback ON  -> 0.35% of volume, plus 0.35% locked in a 5-year vest
 *
 * Nothing downstream may assume a single creator rate. Call creatorNetBps().
 */

export const VENUE = {
  chainId: 4663,

  /** Base pool fee in bps of trade volume. Verified on-chain. */
  hookFeeBps: 100,
  /** Venue's share of the base fee, taken first. Verified on-chain. */
  protocolFeeShareBps: 3000,
  /** Buyback slice of the post-protocol remainder, when enabled. Verified on-chain. */
  buybackBurnBps: 5000,

  /** Dev-elected, immutable per token, paid 100% to creator and never split. */
  creatorTaxBpsMax: 1000,

  contracts: {
    v2Factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
    v2MemeHook: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
    v2FeeEscrow: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
    v2BuybackVault: '0x42df2a798f82289E177311362e8f5ccC45c1219c',
    v2LaunchLocker: '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952',
    weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  },

  /**
   * topic0 of every Venue V2 event the indexer consumes, as OBSERVED on chain
   * 4663 in the 2026-09-07 census and cross-checked against Sourcify-verified
   * source (tools/__tests__/fixtures/verified-event-signatures.json). The indexer
   * derives its own topics from signature strings and refuses to boot if any
   * differ from these. CREATOR_FEE_RECIPIENT_CHANGE_PROPOSED and
   * CREATOR_FEE_RECIPIENT_CHANGE_CANCELLED were not in the census window; their
   * values are keccak of the verified factory ABI text, not observed logs.
   * CURVE_BUY / CURVE_SELL are preimage-recovered shapes (curves are unverified
   * on Sourcify); parameter names were established from 175 live logs across
   * 27 curves, see tools/artifacts/CURVE-SHAPE.md.
   */
  topics: {
    CURVE_BUY: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
    CURVE_SELL: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
    POOL_FEES_SWEPT: '0x2f3c43579b9064b6f28edcf41608f3815792d274a56afe024359703cb4ea9b30',
    POOL_REGISTERED: '0x01bf263a1db1652580721573296e1a1fa70b3d4c87f61d02a69c4e1109d2d573',
    TOKEN_LAUNCHED: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
    CREATOR_FEE_RECIPIENT_CHANGE_PROPOSED:
      '0x7f119e44c84a715429bee60d30ad2e14afdef6c60bb1a7eaa01290ecf6d1b2e5',
    CREATOR_FEE_RECIPIENT_CHANGE_CANCELLED:
      '0xbe2de91c1cbef653c760573fff8355c0c851d35ed2a898342b4db556301cccf4',
    CREATOR_FEE_RECIPIENT_UPDATED: '0x308c390ed1ab5873392818e036cabdf408bc8ad042fbaead3108954ff75ba980',
  },

  /**
   * V1 is deliberately unsupported. Phase 0: 3.3% of fees, zero new launches in
   * 25 days, and recipiency is immutable so none of it is addressable.
   * Do not add a V1 adapter without re-running the market measurement.
   */
  supportedVersions: ['v2'] as const,
} as const

/**
 * Creator net, in bps of trade volume, for a given token configuration.
 *
 * @param buybackEnabled per-token setting, read from buybackEnabled()
 * @param creatorTaxBps  per-token, immutable, 0..creatorTaxBpsMax
 * @returns bps of VOLUME that reaches the creator's designated recipient
 */
export function creatorNetBps(buybackEnabled: boolean, creatorTaxBps = 0): number {
  const afterProtocol = VENUE.hookFeeBps * (1 - VENUE.protocolFeeShareBps / 10_000)
  const afterBuyback = buybackEnabled
    ? afterProtocol * (1 - VENUE.buybackBurnBps / 10_000)
    : afterProtocol
  return afterBuyback + (VENUE.hookFeeBps * creatorTaxBps) / 10_000
}

/** Volume per day required to produce a given daily QF, for this token config. */
export function volumeForQf(qfPerDay: number, buybackEnabled: boolean, creatorTaxBps = 0): number {
  const bps = creatorNetBps(buybackEnabled, creatorTaxBps)
  if (bps <= 0) throw new Error('creatorNetBps resolved to zero; refusing to divide')
  return qfPerDay / (bps / 10_000)
}

/**
 * Commercial terms.
 *
 * OPERATOR_BPS WAS 1000 AND IS NOW 500. The change is forced by measurement,
 * not preference. Phase 0 found the live take-rate norms on this platform are
 * venueFlow 0%, Sinjoh 1%, Venue Bot 5% (and that 5% funds a token buyback, not
 * labour); the VenuePad 10% the original spec benchmarked against is unverified
 * and that site shows zero tokens launched. Running tools/reprice.ts against
 * the measured tenure returned STOP at 1000bps: contribution is positive but
 * the book needs 109 signings/week against 65 winnable, so the market cannot
 * supply the clients at any price.
 *
 * 500bps is the market norm and it clears - but ONLY above the revised T1 gate.
 * See the note on TIERS.T1 below; the two changes are a single decision and
 * neither survives alone.
 *
 * operatorBps is in the CREATE2 salt preimage, so it can never be changed for
 * an ALREADY DEPLOYED vault. Changing it here only affects future consents.
 */
export const TERMS = {
  operatorBps: 500,
  budgetBpsDefault: 2000,
  budgetBpsMax: 4000,
  /** Dev may raise the dial instantly; lowering takes effect after this delay. */
  dialLowerNoticeDays: 7,
  /** Operator may fire a client on this notice, with full budget refund. */
  operatorWithdrawNoticeDays: 14,
  /** Dev-only adapter migration timelock. Protects against a frozen adapter. */
  adapterMigrationTimelockDays: 14,
  /** Unproven procurement escrow returns to the dev leg after this. */
  procurementProofWindowDays: 7,
  /** Anyone may release the dev's funds after this much operator silence. */
  deadManDays: 180,
} as const

/** Dev's share of QF at a given dial, in bps. */
export function devBps(budgetBps: number): number {
  return 10_000 - TERMS.operatorBps - budgetBps
}

/** The multiple the service must deliver for the dev to break even. */
export function breakEvenMultiple(budgetBps: number): number {
  return 10_000 / devBps(budgetBps)
}

/**
 * Service tiers, gated on QF (quote-denominated creator fees credited to the
 * coin's own vault, USD, gross, trailing 7-day MEDIAN of daily credits).
 *
 * A median, not a mean: a mean is farmable with a single day of wash volume.
 *
 * Gates are in QF, so they are version- and buyback-agnostic by construction.
 * The VOLUME needed to clear a gate depends on the token's config - see
 * volumeForQf(). Do not publish a volume threshold as if it were universal.
 */
export type TierId = 'T0' | 'T1' | 'T2' | 'T3'

export interface Tier {
  id: TierId
  name: string
  /** Minimum QF/day. */
  gateQfPerDay: number
  /** Consecutive days the gate must hold before the tier is granted. */
  sustainedDays: number
  /** Modelled cost to serve, USD/coin/day. Instrumented from day one. */
  cogsPerDay: number
  /** Whether an LLM is in the loop at all. T0 is deterministic by design. */
  usesModel: boolean
  /** Whether paid third-party media may be purchased at this tier. */
  paidMedia: boolean
}

export const TIERS: Record<TierId, Tier> = {
  T0: {
    id: 'T0',
    name: 'Registered',
    gateQfPerDay: 0,
    sustainedDays: 0,
    cogsPerDay: 0.01,
    usesModel: false,
    paidMedia: false,
  },
  /**
   * T1's gate WAS $250/day and is now $1,000/day. Forced by measurement.
   *
   * At $250/day QF the tier cannot close at any price the market will pay.
   * Its cogsPerDay of $13 is dominated by $10 of human ops (one FTE per 50
   * coins); inference is $1 and X API $1.50. So at the 500bps market norm a
   * $250/day client returns $12.50/day against $13.00/day of cost and LOSES
   * $0.50 a day. No client count fixes a negative contribution. The only way
   * to rescue $250/day was a take of roughly 520bps or more, which is above
   * every rate anyone on this platform actually charges.
   *
   * At $1,000/day the same tier returns $37/day against $13, break-even lands
   * at 10.8 concurrent clients, and the book needs 5.87 signings/week against
   * 10.85 winnable. $750/day also clears but only barely (8.86 needed against
   * 10.85 winnable); $1,000 is the lowest gate with real headroom.
   *
   * This is the same deletion the build spec already performed once, one tier
   * up: the $5/day heartbeat tier was cut because its arithmetic did not close
   * either. A tier whose budget cannot fund its own cheapest deliverable is
   * not a product.
   *
   * THE STANDING TENSION, which the Section 9 pilot resolves either way: the
   * $10 of human ops is exactly what the pilot tests. If a staffed desk shows
   * no lift, drop the humans, cogsPerDay falls to about $3, and a lower gate
   * becomes viable. If it does show lift, the humans are load-bearing and this
   * gate must stay. Do not lower it on optimism before that result is in.
   */
  T1: {
    id: 'T1',
    name: 'Desk',
    gateQfPerDay: 1_000,
    sustainedDays: 7,
    cogsPerDay: 13,
    usesModel: true,
    paidMedia: true,
  },
  T2: {
    id: 'T2',
    name: 'Campaign',
    gateQfPerDay: 2_500,
    sustainedDays: 14,
    cogsPerDay: 30,
    usesModel: true,
    paidMedia: true,
  },
  T3: {
    id: 'T3',
    name: 'Flagship',
    gateQfPerDay: 20_000,
    sustainedDays: 14,
    cogsPerDay: 452,
    usesModel: true,
    paidMedia: true,
  },
}

export const TIER_ORDER: TierId[] = ['T0', 'T1', 'T2', 'T3']

/**
 * Hard floor below which a paid tier cannot fund its own cheapest deliverable.
 * At a 20% dial, monthly budget = QF/day * 0.20 * 30. A Dexscreener Enhanced
 * Token Info listing is $299 one-time. Below roughly $1,500/month of client
 * fees the procurement slice cannot buy even that, so the tier is not offered.
 */
export const QUALIFICATION_FLOOR_MONTHLY_USD = 1_500

/**
 * Spend-gate limits. Deterministic, ordered, first failure wins.
 * These bound the blast radius of a fully compromised cognition plane.
 */
export const SPEND_LIMITS = {
  /** Rolling cap as a fraction of the trailing-14-day MEDIAN daily budget accrual. */
  rollingCapOfMedian: 0.6,
  /** Lifetime spend may never exceed this fraction of cumulative realized fees. */
  lifetimeCapOfRealizedFees: 0.5,
  /** Above this USD amount a human must approve, regardless of tier. */
  humanApprovalThresholdUsd: 500,
  /** Any single vendor, across the whole client book, per day. */
  fleetVendorDailyCapUsd: 25_000,
  /** Related-party vendors capped as a fraction of a coin's 30-day budget. */
  relatedPartyCapOf30dBudget: 0.25,
  /** Signed policy object TTL. No model context can reach or forge this. */
  policyTokenTtlSeconds: 900,
} as const

/**
 * The commitment rule. This single constraint resolves the hold-up problem, the
 * forward-commitment problem, and cross-subsidy simultaneously.
 *
 * It is enforced in code in packages/broker. It must never be relaxed, and the
 * pressure to relax it will come from the best client.
 */
export const COMMITMENT_RULE = {
  /** No obligation may exceed the coin's own banked, escrowed budget at signing. */
  requireFullyBankedAtSigning: true,
  /** No credit line, ever. No cross-coin subsidy, ever. */
  allowCrossCoinSubsidy: false,
  /** Nothing financed against projected flow. */
  allowForwardFinancing: false,
} as const

/**
 * Disclosure. Injected by the publisher, never authored by a model.
 * Three regimes, one fix: FTC Endorsement Guides / Securities Act 17(b) require
 * disclosure IN the communication; EU AI Act Art. 50 and CA SB 1001 require bot
 * identification. A receipts ledger on a separate page cures none of them.
 */
export const DISCLOSURE = {
  paidPromotionTag: '#ad',
  aiOperationTag: 'AI-operated',
  /** Appended to the visible body of every promotional emission. */
  operatorName: 'SET_ME_BEFORE_LAUNCH',
  /** Re-fetch the published post after this delay and delete on token absence. */
  readBackVerifySeconds: 60,
  /** Exactly one ticker per account. No cross-promotion between clients, ever. */
  maxTickersPerAccount: 1,
} as const

/**
 * Refusal classes. Promoted from a prompt instruction to a fail-closed output
 * classifier, per Phase 0: the Anthropic "Finance" High-Risk clause attaches a
 * qualified-professional-review requirement to advice and recommendations, and
 * an autonomous desk cannot satisfy it. The desk answers operational facts only.
 */
export const REFUSAL_CLASSES = [
  'price_prediction',
  'buy_sell_advice',
  'future_value_implication',
  'user_financial_situation',
  'wen_moon',
  'comparative_investment_merit',
] as const

export type RefusalClass = (typeof REFUSAL_CLASSES)[number]

/**
 * STRUCTURAL, NOT CONVENTIONAL.
 *
 * packages/broker/src/policy.ts says "A TOKEN CANNOT LOOSEN A LIMIT. Compiled
 * SPEND_LIMITS is the ceiling", and packages/broker/src/gates.ts installs a
 * load-time tripwire that refuses to load if COMMITMENT_RULE has been relaxed.
 * Both read plain object literals. `as const` is a TypeScript assertion that is
 * ERASED AT EMIT: it constrains what may be written in this repository's source
 * and constrains nothing at runtime. Nothing here was frozen, so the ceiling
 * every money decision is measured against was a mutable global - one assignment
 * anywhere in the process raised it for everyone, and assertNotLoosened then
 * verified a policy token carrying limits ten times the compiled ceiling because
 * it compares against the same mutable object.
 *
 * This is hardening rather than a reachable exploit: it needs code executing
 * in-process, which the cognition plane does not have. It matters because the
 * ceiling is repeatedly cited as structural, and a convention is not a
 * structure - a supply-chain dependency or a future refactor is enough to move
 * one silently.
 *
 * NO VALUE IN THIS FILE CHANGED. Freezing changes what may be done to these
 * objects at runtime; it changes nothing about what they say.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

deepFreeze(VENUE)
deepFreeze(TERMS)
deepFreeze(TIERS)
deepFreeze(TIER_ORDER)
deepFreeze(SPEND_LIMITS)
deepFreeze(COMMITMENT_RULE)
deepFreeze(DISCLOSURE)
deepFreeze(REFUSAL_CLASSES)

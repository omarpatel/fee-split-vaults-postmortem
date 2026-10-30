/**
 * The FactSheet vocabulary.
 *
 * The desk answers ONLY from this structure. Every field carries where it came
 * from, when it was observed, and how long that observation stays usable. A
 * field that is absent, or whose observation has aged out, is not answerable at
 * any tier - the desk says so and hands back a way to check it independently.
 *
 * The vocabulary is closed for the same reason the airlock's topic codes are:
 * a model that cannot name a field cannot invent one.
 */

import type { Address, PoolId, UsdValue } from '@fee-split-vaults/core'

export const FACT_FIELDS = [
  // Identity
  'contract_address',
  'chain_id',
  'venue_version',
  'token_name',
  'token_symbol',
  'token_decimals',
  'launch_unix',
  // Supply
  'total_supply',
  'burned_supply',
  'locked_supply',
  'circulating_supply',
  // Pool and liquidity
  'pool_id',
  'quote_asset_address',
  'quote_asset_symbol',
  'pool_quote_reserve',
  'pool_token_reserve',
  'pool_liquidity_usd',
  // LP lock
  'lp_locked',
  'lp_unlock_unix',
  // Holders
  'holder_count',
  'top10_holder_share_pct',
  'deployer_supply_share_pct',
  // Fees
  'buyback_enabled',
  'creator_tax_bps',
  'creator_net_bps',
  'fee_recipient',
  'fee_recipient_change_proposed_unix',
  'fees_credited_24h_usd',
  'fees_credited_lifetime_usd',
  // Anti-snipe
  'antisnipe_initial_bps',
  'antisnipe_window_seconds',
  'antisnipe_exempt_wallets',
] as const

export type FactFieldId = (typeof FACT_FIELDS)[number]

export type FactSource =
  /** eth_call pinned to a block hash. */
  | 'chain_read'
  /** Decoded from a hook or factory log. Per-coin fee attribution lives here. */
  | 'hook_event'
  /** Aggregation no single call can produce (holder counts, concentration). */
  | 'indexer'
  /** The double-entry ledger, at accrual. */
  | 'ledger'
  /** A documented protocol parameter. NOT a measurement of this token. */
  | 'protocol_doc'
  /** Bound by trusted operator code at onboarding. Never read from user text. */
  | 'operator_bound'
  /** A pure function of other facts in the same sheet. */
  | 'derived'

export interface FactProvenance {
  source: FactSource
  /** Call, event, or function that produced it, e.g. "totalSupply()". */
  method: string
  /** Contract the read was made against, when applicable. */
  contract?: Address
  /**
   * Reads are pinned by block HASH, never by number: a reorg changes what a
   * number means but never what a hash means.
   */
  blockHash?: string
  /** Display only. Never used to pin or compare reads. */
  blockNumber?: number
  observedAtUnix: number
  /** For 'derived', the fields this was computed from. */
  derivedFrom?: FactFieldId[]
}

export type FactValue =
  | { kind: 'address'; address: Address }
  | { kind: 'address_list'; addresses: Address[] }
  | { kind: 'pool_id'; poolId: PoolId }
  | { kind: 'string'; text: string }
  | { kind: 'integer'; value: number }
  | { kind: 'bps'; bps: number }
  | { kind: 'percent'; pct: number }
  | { kind: 'bool'; value: boolean }
  /** Minor units, always bigint. Rendering is code-owned, never model-owned. */
  | { kind: 'token_amount'; minor: bigint; decimals: number; symbol: string }
  | { kind: 'usd'; usd: UsdValue }
  | { kind: 'unix_time'; unix: number }
  | { kind: 'duration_seconds'; seconds: number }

export interface Fact {
  field: FactFieldId
  value: FactValue
  /**
   * The canonical rendering, computed by trusted code at build time. The T1
   * model is shown this string and nothing else, so it cannot round, restate,
   * or re-unit a number on its way out.
   */
  display: string
  provenance: FactProvenance
  /** Observation age, in seconds, past which this fact is refused. */
  ttlSeconds: number
}

/**
 * Freshness budgets. Short where a wrong answer is expensive (a stale fee
 * recipient is a security answer, not a trivia answer), long where the value is
 * immutable by construction.
 */
export const FACT_TTL_SECONDS: Readonly<Record<FactFieldId, number>> = {
  contract_address: 86_400,
  chain_id: 86_400,
  venue_version: 86_400,
  token_name: 86_400,
  token_symbol: 86_400,
  token_decimals: 86_400,
  launch_unix: 86_400,

  total_supply: 3_600,
  burned_supply: 3_600,
  locked_supply: 3_600,
  circulating_supply: 3_600,

  pool_id: 86_400,
  quote_asset_address: 86_400,
  quote_asset_symbol: 86_400,
  pool_quote_reserve: 300,
  pool_token_reserve: 300,
  pool_liquidity_usd: 300,

  lp_locked: 3_600,
  lp_unlock_unix: 3_600,

  holder_count: 900,
  top10_holder_share_pct: 900,
  deployer_supply_share_pct: 900,

  buyback_enabled: 3_600,
  creator_tax_bps: 86_400,
  creator_net_bps: 3_600,
  fee_recipient: 300,
  fee_recipient_change_proposed_unix: 300,
  fees_credited_24h_usd: 900,
  fees_credited_lifetime_usd: 900,

  antisnipe_initial_bps: 86_400,
  antisnipe_window_seconds: 86_400,
  antisnipe_exempt_wallets: 3_600,
}

/** Human labels used in the "I don't have that" template. Code-owned. */
export const FACT_LABELS: Readonly<Record<FactFieldId, string>> = {
  contract_address: 'the contract address',
  chain_id: 'the chain id',
  venue_version: 'the Venue version',
  token_name: 'the token name',
  token_symbol: 'the token symbol',
  token_decimals: 'the token decimals',
  launch_unix: 'the launch time',
  total_supply: 'the total supply',
  burned_supply: 'the burned supply',
  locked_supply: 'the locked supply',
  circulating_supply: 'the circulating supply',
  pool_id: 'the pool id',
  quote_asset_address: 'the quote asset address',
  quote_asset_symbol: 'the quote asset',
  pool_quote_reserve: 'the pool quote reserve',
  pool_token_reserve: 'the pool token reserve',
  pool_liquidity_usd: 'pool liquidity in USD',
  lp_locked: 'whether LP is locked',
  lp_unlock_unix: 'the LP unlock time',
  holder_count: 'the holder count',
  top10_holder_share_pct: 'the top-10 holder share',
  deployer_supply_share_pct: 'the deployer supply share',
  buyback_enabled: 'whether buyback is enabled',
  creator_tax_bps: 'the creator tax',
  creator_net_bps: 'the creator net fee rate',
  fee_recipient: 'the fee recipient',
  fee_recipient_change_proposed_unix: 'a proposed fee-recipient change',
  fees_credited_24h_usd: 'fees credited in the last 24h',
  fees_credited_lifetime_usd: 'lifetime fees credited',
  antisnipe_initial_bps: 'the initial anti-snipe tax',
  antisnipe_window_seconds: 'the anti-snipe window length',
  antisnipe_exempt_wallets: 'the anti-snipe exempt wallets',
}

/**
 * How a holder verifies each field WITHOUT trusting this desk. Emitted verbatim
 * whenever a field is absent or stale, so "I don't know" is still an answer.
 */
export const FACT_SELF_CHECK: Readonly<Record<FactFieldId, string>> = {
  contract_address: 'compare the address on the official channel pin with the one in the pool page',
  chain_id: 'check the network selector in your wallet against the explorer',
  venue_version: 'check which Venue factory deployed the token in the explorer creation trace',
  token_name: 'read name() on the token contract in the explorer Read tab',
  token_symbol: 'read symbol() on the token contract in the explorer Read tab',
  token_decimals: 'read decimals() on the token contract in the explorer Read tab',
  launch_unix: 'open the contract creation transaction in the explorer and read its timestamp',
  total_supply: 'read totalSupply() on the token contract in the explorer Read tab',
  burned_supply: 'read balanceOf() for the burn address in the explorer Read tab',
  locked_supply: 'read balanceOf() for the launch locker in the explorer Read tab',
  circulating_supply: 'subtract the burn and locker balances from totalSupply() yourself',
  pool_id: 'find the PoolInitialized log for this token on the Venue hook in the explorer',
  quote_asset_address: 'read the pool key from the Venue hook in the explorer Read tab',
  quote_asset_symbol: 'read symbol() on the quote asset contract in the explorer Read tab',
  pool_quote_reserve: 'read the pool manager balance for the quote asset in the explorer',
  pool_token_reserve: 'read the pool manager balance for the token in the explorer',
  pool_liquidity_usd: 'price the two pool reserves yourself against a source you trust',
  lp_locked: 'read the launch locker position for this token in the explorer',
  lp_unlock_unix: 'read the unlock timestamp on the launch locker in the explorer',
  holder_count: 'open the token page on the explorer and read the holders tab',
  top10_holder_share_pct: 'open the holders tab on the explorer and add the top ten yourself',
  deployer_supply_share_pct: 'look up the deployer address balance on the explorer',
  buyback_enabled: 'read the per-token buyback flag on the Venue hook in the explorer Read tab',
  creator_tax_bps: 'read the per-token creator tax on the Venue hook in the explorer Read tab',
  creator_net_bps: 'read the hook fee, protocol share and buyback flag and compute it yourself',
  fee_recipient: 'read the creator fee recipient for this token on the Venue hook',
  fee_recipient_change_proposed_unix:
    'search the Venue owner contract for CreatorFeeRecipientChangeProposed logs naming this token',
  fees_credited_24h_usd: 'sum the PoolFeesSwept logs for this pool id over the last day',
  fees_credited_lifetime_usd: 'sum every PoolFeesSwept log for this pool id',
  antisnipe_initial_bps: 'read the anti-snipe parameters on the Venue hook in the explorer Read tab',
  antisnipe_window_seconds: 'read the anti-snipe parameters on the Venue hook in the explorer Read tab',
  antisnipe_exempt_wallets: 'read the exempt list on the Venue hook in the explorer Read tab',
}

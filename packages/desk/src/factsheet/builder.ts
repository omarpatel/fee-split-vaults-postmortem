/**
 * The FactSheet builder.
 *
 * Assembles verified per-field facts from cached chain reads, stamps each with
 * its provenance and freshness budget, and marks anything it could not observe
 * as ABSENT. There is no path in this file that produces a value from anything
 * other than an observation - no defaults, no interpolation, no last-known-good
 * substitution. A read that fails becomes a fact the desk will not answer.
 *
 * The one deliberate exception is documented in buildAntiSnipeFacts(): the two
 * anti-snipe curve parameters may fall back to the DOCUMENTED protocol value,
 * and when they do the provenance says 'protocol_doc' and the rendering says so
 * out loud. That is a labelled protocol constant, not a measurement of a token.
 */

import type { Address, TxHash } from '@fee-split-vaults/core'
import { VENUE, creatorNetBps, type TierId } from '../../../../config/protocol.js'
import {
  FACT_TTL_SECONDS,
  type Fact,
  type FactFieldId,
  type FactProvenance,
  type FactValue,
} from './fields.js'
import { renderFactValue, type ExplorerConfig } from './render.js'
import type {
  AntiSnipeRead,
  BlockRef,
  DeskChainReader,
  DeskFeeLedger,
  DeskHolderIndex,
  FeeConfigRead,
  LaunchRead,
  LockRead,
  PoolRead,
  SupplyRead,
  TokenIdentityRead,
} from './chain-reader.js'

export interface FactSheet {
  vault: Address
  token: Address
  tier: TierId
  chainId: number
  builtAtUnix: number
  /** The head the chain reads were pinned to. */
  builtAtBlock: BlockRef
  facts: Partial<Record<FactFieldId, Fact>>
  /** Fields the builder tried to observe and could not. */
  absent: FactFieldId[]
  explorer: ExplorerConfig
}

export class FactSheetError extends Error {
  constructor(message: string) {
    super(`factsheet: ${message}`)
    this.name = 'FactSheetError'
  }
}

export type FactLookup =
  | { status: 'fresh'; fact: Fact; ageSeconds: number }
  | { status: 'stale'; fact: Fact; ageSeconds: number }
  | { status: 'absent' }

/**
 * The single accessor every answering path must use. Stale is NOT a softer
 * form of fresh: a stale fact is unusable, and the caller is expected to route
 * it to the same "check it yourself" answer an absent field gets.
 */
export function lookupFact(sheet: FactSheet, field: FactFieldId, nowUnix: number): FactLookup {
  const fact = sheet.facts[field]
  if (!fact) return { status: 'absent' }
  const ageSeconds = nowUnix - fact.provenance.observedAtUnix
  if (ageSeconds < 0) return { status: 'stale', fact, ageSeconds }
  if (ageSeconds > fact.ttlSeconds) return { status: 'stale', fact, ageSeconds }
  return { status: 'fresh', fact, ageSeconds }
}

export function usableFacts(sheet: FactSheet, nowUnix: number): Fact[] {
  const out: Fact[] = []
  for (const field of Object.keys(sheet.facts) as FactFieldId[]) {
    const found = lookupFact(sheet, field, nowUnix)
    if (found.status === 'fresh') out.push(found.fact)
  }
  return out
}

export function staleFields(sheet: FactSheet, nowUnix: number): FactFieldId[] {
  const out: FactFieldId[] = []
  for (const field of Object.keys(sheet.facts) as FactFieldId[]) {
    if (lookupFact(sheet, field, nowUnix).status === 'stale') out.push(field)
  }
  return out
}

function makeFact(
  field: FactFieldId,
  value: FactValue,
  provenance: FactProvenance,
  displayOverride?: string,
): Fact {
  return {
    field,
    value,
    display: displayOverride ?? renderFactValue(value),
    provenance,
    ttlSeconds: FACT_TTL_SECONDS[field],
  }
}

export interface BuildFactSheetInput {
  vault: Address
  token: Address
  tier: TierId
  reader: DeskChainReader
  holders?: DeskHolderIndex
  ledger?: DeskFeeLedger
  explorer: ExplorerConfig
  nowUnix: number
  /**
   * Documented anti-snipe curve, used only when the chain read is unavailable
   * and always labelled as a protocol parameter rather than a token reading.
   */
  documentedAntiSnipe?: { initialBps: number; windowSeconds: number }
}

/**
 * Build a sheet. Throws only for conditions that make the whole sheet
 * untrustworthy - wrong chain, no readable head. Everything narrower degrades
 * to an absent field, because a partial sheet with honest gaps is a usable
 * product and a complete sheet with one invented number is not.
 */
export async function buildFactSheet(input: BuildFactSheetInput): Promise<FactSheet> {
  const { reader, token, vault, tier, explorer, nowUnix } = input

  const chainId = await reader.chainId()
  if (chainId !== VENUE.chainId) {
    throw new FactSheetError(`reader is on chain ${chainId}, expected ${VENUE.chainId}`)
  }
  const block = await reader.latestBlock()
  if (!block.hash) throw new FactSheetError('head block has no hash; cannot pin reads')

  const facts: Partial<Record<FactFieldId, Fact>> = {}
  const absent: FactFieldId[] = []

  const add = (fact: Fact): void => {
    facts[fact.field] = fact
  }
  const miss = (field: FactFieldId): void => {
    absent.push(field)
  }

  const chainProvenance = (method: string, contract?: Address): FactProvenance => ({
    source: 'chain_read',
    method,
    contract,
    blockHash: block.hash,
    blockNumber: block.number,
    observedAtUnix: nowUnix,
  })

  add(
    makeFact(
      'contract_address',
      { kind: 'address', address: token },
      { source: 'operator_bound', method: 'bound at onboarding', observedAtUnix: nowUnix },
    ),
  )
  add(
    makeFact(
      'chain_id',
      { kind: 'integer', value: chainId },
      { source: 'chain_read', method: 'eth_chainId', observedAtUnix: nowUnix },
    ),
  )
  add(
    makeFact(
      'venue_version',
      { kind: 'string', text: 'v2' },
      { source: 'operator_bound', method: 'supported version set', observedAtUnix: nowUnix },
    ),
  )

  const [identity, supply, pool, feeConfig, lock, antiSnipe, launch] = await Promise.all([
    reader.readTokenIdentity(token, block).catch((): TokenIdentityRead => ({})),
    reader.readSupply(token, block).catch((): SupplyRead => ({})),
    reader.readPool(token, block).catch((): PoolRead => ({})),
    reader.readFeeConfig(token, block).catch((): FeeConfigRead => ({})),
    reader.readLock(token, block).catch((): LockRead => ({})),
    reader.readAntiSnipe(token, block).catch((): AntiSnipeRead => ({})),
    reader.readLaunch(token, block).catch((): LaunchRead => ({})),
  ])

  // Identity
  if (identity.name !== undefined) {
    add(makeFact('token_name', { kind: 'string', text: identity.name }, chainProvenance('name()', token)))
  } else miss('token_name')

  if (identity.symbol !== undefined) {
    add(
      makeFact(
        'token_symbol',
        { kind: 'string', text: identity.symbol },
        chainProvenance('symbol()', token),
      ),
    )
  } else miss('token_symbol')

  const decimals = identity.decimals
  if (decimals !== undefined) {
    add(
      makeFact('token_decimals', { kind: 'integer', value: decimals }, chainProvenance('decimals()', token)),
    )
  } else miss('token_decimals')

  if (launch.launchUnix !== undefined) {
    add(
      makeFact(
        'launch_unix',
        { kind: 'unix_time', unix: launch.launchUnix },
        chainProvenance('launch timestamp view', token),
      ),
    )
  } else miss('launch_unix')

  // Supply. Every supply figure needs decimals to render, so decimals gates them.
  const symbol = identity.symbol ?? ''
  const amountFact = (
    field: FactFieldId,
    minor: bigint | undefined,
    method: string,
  ): void => {
    if (minor === undefined || decimals === undefined) {
      miss(field)
      return
    }
    add(
      makeFact(
        field,
        { kind: 'token_amount', minor, decimals, symbol },
        chainProvenance(method, token),
      ),
    )
  }

  amountFact('total_supply', supply.totalSupplyMinor, 'totalSupply()')
  amountFact('burned_supply', supply.burnedMinor, 'balanceOf(burn addresses)')
  amountFact('locked_supply', supply.lockedMinor, 'balanceOf(launch locker)')

  if (
    supply.totalSupplyMinor !== undefined &&
    supply.burnedMinor !== undefined &&
    supply.lockedMinor !== undefined &&
    decimals !== undefined
  ) {
    const circulating = supply.totalSupplyMinor - supply.burnedMinor - supply.lockedMinor
    if (circulating >= 0n) {
      add(
        makeFact(
          'circulating_supply',
          { kind: 'token_amount', minor: circulating, decimals, symbol },
          {
            source: 'derived',
            method: 'total_supply - burned_supply - locked_supply',
            blockHash: block.hash,
            blockNumber: block.number,
            observedAtUnix: nowUnix,
            derivedFrom: ['total_supply', 'burned_supply', 'locked_supply'],
          },
        ),
      )
    } else miss('circulating_supply')
  } else miss('circulating_supply')

  // Pool
  if (pool.poolId !== undefined) {
    add(
      makeFact('pool_id', { kind: 'pool_id', poolId: pool.poolId }, chainProvenance('pool id view')),
    )
  } else miss('pool_id')

  if (pool.quoteAssetAddress !== undefined) {
    add(
      makeFact(
        'quote_asset_address',
        { kind: 'address', address: pool.quoteAssetAddress },
        chainProvenance('quote asset view'),
      ),
    )
  } else miss('quote_asset_address')

  if (pool.quoteAssetSymbol !== undefined) {
    add(
      makeFact(
        'quote_asset_symbol',
        { kind: 'string', text: pool.quoteAssetSymbol },
        chainProvenance('symbol()', pool.quoteAssetAddress),
      ),
    )
  } else miss('quote_asset_symbol')

  if (pool.quoteReserveMinor !== undefined && pool.quoteAssetDecimals !== undefined) {
    add(
      makeFact(
        'pool_quote_reserve',
        {
          kind: 'token_amount',
          minor: pool.quoteReserveMinor,
          decimals: pool.quoteAssetDecimals,
          symbol: pool.quoteAssetSymbol ?? '',
        },
        chainProvenance('pool quote reserve'),
      ),
    )
  } else miss('pool_quote_reserve')

  if (pool.tokenReserveMinor !== undefined && decimals !== undefined) {
    add(
      makeFact(
        'pool_token_reserve',
        { kind: 'token_amount', minor: pool.tokenReserveMinor, decimals, symbol },
        chainProvenance('pool token reserve'),
      ),
    )
  } else miss('pool_token_reserve')

  if (pool.liquidityUsd !== undefined) {
    add(
      makeFact(
        'pool_liquidity_usd',
        { kind: 'usd', usd: pool.liquidityUsd },
        {
          source: 'derived',
          method: `pool reserves priced at ${pool.liquidityUsd.priceSource}`,
          blockHash: pool.liquidityUsd.blockHash ?? block.hash,
          observedAtUnix: pool.liquidityUsd.pricedAtUnix,
          derivedFrom: ['pool_quote_reserve', 'pool_token_reserve'],
        },
      ),
    )
  } else miss('pool_liquidity_usd')

  // LP lock
  if (lock.lpLocked !== undefined) {
    add(makeFact('lp_locked', { kind: 'bool', value: lock.lpLocked }, chainProvenance('locker view')))
  } else miss('lp_locked')

  if (lock.unlockUnix !== undefined) {
    add(
      makeFact(
        'lp_unlock_unix',
        { kind: 'unix_time', unix: lock.unlockUnix },
        chainProvenance('locker unlock view'),
      ),
    )
  } else miss('lp_unlock_unix')

  // Fee configuration. The creator rate BRANCHES; it is never a literal.
  if (feeConfig.buybackEnabled !== undefined) {
    add(
      makeFact(
        'buyback_enabled',
        { kind: 'bool', value: feeConfig.buybackEnabled },
        chainProvenance('buybackEnabled view'),
      ),
    )
  } else miss('buyback_enabled')

  if (feeConfig.creatorTaxBps !== undefined) {
    add(
      makeFact(
        'creator_tax_bps',
        { kind: 'bps', bps: feeConfig.creatorTaxBps },
        chainProvenance('creator tax view'),
      ),
    )
  } else miss('creator_tax_bps')

  if (feeConfig.buybackEnabled !== undefined && feeConfig.creatorTaxBps !== undefined) {
    const netBps = creatorNetBps(feeConfig.buybackEnabled, feeConfig.creatorTaxBps)
    add(
      makeFact(
        'creator_net_bps',
        { kind: 'bps', bps: netBps },
        {
          source: 'derived',
          method: 'creatorNetBps(buybackEnabled, creatorTaxBps)',
          blockHash: block.hash,
          blockNumber: block.number,
          observedAtUnix: nowUnix,
          derivedFrom: ['buyback_enabled', 'creator_tax_bps'],
        },
      ),
    )
  } else miss('creator_net_bps')

  if (feeConfig.feeRecipient !== undefined) {
    add(
      makeFact(
        'fee_recipient',
        { kind: 'address', address: feeConfig.feeRecipient },
        chainProvenance('creator fee recipient view'),
      ),
    )
  } else miss('fee_recipient')

  if (feeConfig.feeRecipientChangeProposedUnix !== undefined) {
    add(
      makeFact(
        'fee_recipient_change_proposed_unix',
        { kind: 'unix_time', unix: feeConfig.feeRecipientChangeProposedUnix },
        chainProvenance('CreatorFeeRecipientChangeProposed'),
      ),
    )
  }

  // Anti-snipe
  buildAntiSnipeFacts({ antiSnipe, documented: input.documentedAntiSnipe, nowUnix, block, add, miss })

  // Holders
  if (input.holders) {
    const holders = await input.holders.readHolders(token).catch(() => undefined)
    const holderProvenance = (method: string, observedAtUnix: number): FactProvenance => ({
      source: 'indexer',
      method,
      observedAtUnix,
    })
    if (holders?.holderCount !== undefined) {
      add(
        makeFact(
          'holder_count',
          { kind: 'integer', value: holders.holderCount },
          holderProvenance('holder index', holders.observedAtUnix),
        ),
      )
    } else miss('holder_count')

    if (holders?.top10SharePct !== undefined) {
      add(
        makeFact(
          'top10_holder_share_pct',
          { kind: 'percent', pct: holders.top10SharePct },
          holderProvenance('holder index', holders.observedAtUnix),
        ),
      )
    } else miss('top10_holder_share_pct')

    if (holders?.deployerSharePct !== undefined) {
      add(
        makeFact(
          'deployer_supply_share_pct',
          { kind: 'percent', pct: holders.deployerSharePct },
          holderProvenance('holder index', holders.observedAtUnix),
        ),
      )
    } else miss('deployer_supply_share_pct')
  } else {
    miss('holder_count')
    miss('top10_holder_share_pct')
    miss('deployer_supply_share_pct')
  }

  // Credited fees, from the ledger's PoolFeesSwept-driven attribution.
  if (input.ledger) {
    const credited = await input.ledger.readCreditedFees(vault).catch(() => undefined)
    if (credited?.last24hUsd !== undefined) {
      add(
        makeFact(
          'fees_credited_24h_usd',
          { kind: 'usd', usd: credited.last24hUsd },
          {
            source: 'ledger',
            method: 'PoolFeesSwept credits, 24h',
            observedAtUnix: credited.observedAtUnix,
          },
        ),
      )
    } else miss('fees_credited_24h_usd')

    if (credited?.lifetimeUsd !== undefined) {
      add(
        makeFact(
          'fees_credited_lifetime_usd',
          { kind: 'usd', usd: credited.lifetimeUsd },
          {
            source: 'ledger',
            method: 'PoolFeesSwept credits, lifetime',
            observedAtUnix: credited.observedAtUnix,
          },
        ),
      )
    } else miss('fees_credited_lifetime_usd')
  } else {
    miss('fees_credited_24h_usd')
    miss('fees_credited_lifetime_usd')
  }

  return { vault, token, tier, chainId, builtAtUnix: nowUnix, builtAtBlock: block, facts, absent, explorer }
}

function buildAntiSnipeFacts(args: {
  antiSnipe: { initialBps?: number; windowSeconds?: number; exemptWallets?: Address[] }
  documented?: { initialBps: number; windowSeconds: number }
  nowUnix: number
  block: BlockRef
  add: (fact: Fact) => void
  miss: (field: FactFieldId) => void
}): void {
  const { antiSnipe, documented, nowUnix, block, add, miss } = args

  const docProvenance: FactProvenance = {
    source: 'protocol_doc',
    method: 'documented Venue V2 anti-snipe parameter, not a read of this token',
    observedAtUnix: nowUnix,
  }
  const chainProvenance: FactProvenance = {
    source: 'chain_read',
    method: 'anti-snipe parameter view',
    blockHash: block.hash,
    blockNumber: block.number,
    observedAtUnix: nowUnix,
  }

  if (antiSnipe.initialBps !== undefined) {
    add(
      makeFact('antisnipe_initial_bps', { kind: 'bps', bps: antiSnipe.initialBps }, chainProvenance),
    )
  } else if (documented) {
    add(
      makeFact(
        'antisnipe_initial_bps',
        { kind: 'bps', bps: documented.initialBps },
        docProvenance,
        `${(documented.initialBps / 100).toFixed(2)}% (documented protocol parameter)`,
      ),
    )
  } else miss('antisnipe_initial_bps')

  if (antiSnipe.windowSeconds !== undefined) {
    add(
      makeFact(
        'antisnipe_window_seconds',
        { kind: 'duration_seconds', seconds: antiSnipe.windowSeconds },
        chainProvenance,
      ),
    )
  } else if (documented) {
    add(
      makeFact(
        'antisnipe_window_seconds',
        { kind: 'duration_seconds', seconds: documented.windowSeconds },
        docProvenance,
        `${documented.windowSeconds}s (documented protocol parameter)`,
      ),
    )
  } else miss('antisnipe_window_seconds')

  // Never defaulted. An unread exempt list is an absent exempt list.
  if (antiSnipe.exemptWallets !== undefined) {
    add(
      makeFact(
        'antisnipe_exempt_wallets',
        { kind: 'address_list', addresses: antiSnipe.exemptWallets },
        chainProvenance,
      ),
    )
  } else miss('antisnipe_exempt_wallets')
}

/** A pointer a holder can follow to reproduce a fact. */
export interface Citation {
  field: FactFieldId
  source: string
  observedAtUnix: number
  ageSeconds: number
  blockHash?: string
  verifyUrl?: string
}

export function citeFact(sheet: FactSheet, fact: Fact, nowUnix: number): Citation {
  const { provenance } = fact
  const contract = provenance.contract ?? sheet.token
  const verifyUrl = provenance.blockHash
    ? sheet.explorer.addressUrl(contract)
    : provenance.source === 'indexer' || provenance.source === 'ledger'
      ? sheet.explorer.tokenUrl(sheet.token)
      : undefined
  return {
    field: fact.field,
    source: `${provenance.source}: ${provenance.method}`,
    observedAtUnix: provenance.observedAtUnix,
    ageSeconds: Math.max(0, nowUnix - provenance.observedAtUnix),
    blockHash: provenance.blockHash,
    verifyUrl,
  }
}

/** Convenience for callers that hold a tx hash they want to render a link for. */
export function txLink(sheet: FactSheet, hash: TxHash): string {
  return sheet.explorer.txUrl(hash)
}

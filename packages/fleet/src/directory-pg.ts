/**
 * THE COIN DIRECTORY, READ FROM THE CONTROL PLANE'S TABLES.
 *
 * A coin joins the fleet the day its onboarding reaches `active`: the dev
 * signed, the operator accepted, the vault is pointed at. That row is written
 * by apps/api (PgOnboardingStore) and READ here; this file writes nothing to
 * it. What it assembles from that row and its neighbours is exactly the
 * `CoinDefinition` an operator would otherwise keep in FLEET_COINS_FILE:
 *
 *   onboarding                 coinRef, symbol, name, vault, token, consent,
 *                              approved narrative, deploy tx
 *   indexer_binding            the quote asset the chain says the coin trades in
 *   quote_asset                the assets the operator accepts, when the chain
 *                              has not bound the coin yet
 *   publisher_account_binding  which platform account speaks for the coin
 *   image_asset                the rendered creative the planner may attach
 *   vault_record               the tier and dial a previous run left behind
 *
 * EVERY FIELD IS OPERATOR- OR CHAIN-AUTHORED. The dev's typed links and
 * socials are on the onboarding row and are deliberately NOT read: a link the
 * dev typed is not an allowlisted destination, and the planner's allowlist is
 * ours to write. The only link a database coin gets is its own receipts page.
 *
 * FAILS CLOSED, PER COIN. A row this build cannot turn into a complete
 * definition - no quote asset anyone will vouch for, two accounts on one
 * channel, a narrative that no longer validates, a deploy transaction the
 * chain has never heard of - refuses the whole start. The alternative is a
 * fleet that quietly serves every coin but the broken one, and nobody notices
 * until that coin's dev does.
 */

import type { Channel, Consent, ImageAssetSource, NarrativeProfile, Vault } from '@fee-split-vaults/core'
import { validateNarrativeProfile } from '@fee-split-vaults/core'
import type { VendorCatalog } from '@fee-split-vaults/broker'
import type { SqlDriver } from '@fee-split-vaults/adapters'
import type { VaultRepository } from '@fee-split-vaults/orchestrator'
import type { LinkRef, PlannerSkuView } from '@fee-split-vaults/runtime'
import { TERMS, type TierId } from '../../../config/protocol.js'
import { CoinDirectory, type CoinDefinition } from './coins.js'
import { FleetStartupRefused } from './errors.js'

/** Same floor the fixture coins use. The indexer raises it for a spending vault. */
const DEFAULT_SWEEP_INTERVAL_SECONDS = 3_600
const CHANNELS: readonly Channel[] = ['telegram', 'x_operator', 'x_client_delegated', 'site']

/**
 * Where a SKU's unit cost falls, in the coarse bands the planner is shown.
 *
 * Bands, not prices: the planner cannot name an amount, and a view that
 * carried one would only create the opportunity to try.
 */
const COST_BAND_CEILING_USD = { low: 100, medium: 1_000 } as const

export interface PgCoinDirectoryOptions {
  driver: SqlDriver
  /** Where vault records live. A coin whose record is absent REFUSES the start; see #vaultRecord. */
  vaults: VaultRepository
  images: ImageAssetSource
  /** The planner's catalog view is derived from this. Absent means no purchasable SKU. */
  catalog?: VendorCatalog
  /** The per-coin receipts page. Absent means the coin has no allowlisted link. */
  receiptsBaseUrl?: string
  /**
   * Resolves a deploy transaction to the block it landed in. Absent means no
   * coin carries a deployment block, and a live chain will refuse the fleet -
   * which is the right answer when nothing can ask the chain where the vault
   * came from.
   */
  deployBlock?: (txHash: string) => Promise<bigint | undefined>
}

interface OnboardingRow {
  coin_ref: string
  vault: string
  token: string
  symbol: string
  name: string
  consent: unknown
  narrative: unknown
  deploy_tx_hash: string | null
  deployed_at_unix: number | string | null
  activated_at_unix: number | string | null
  created_at_unix: number | string
}

export class PgCoinDirectory {
  readonly #options: PgCoinDirectoryOptions

  constructor(options: PgCoinDirectoryOptions) {
    this.#options = options
  }

  async load(): Promise<CoinDirectory> {
    const rows = await this.#options.driver.query<OnboardingRow>(
      `SELECT coin_ref, vault, token, symbol, name, consent, narrative, deploy_tx_hash,
              deployed_at_unix, activated_at_unix, created_at_unix
         FROM onboarding
        WHERE state = 'active'
        ORDER BY coin_ref`,
    )
    const definitions: CoinDefinition[] = []
    for (const row of rows) definitions.push(await this.#define(row))
    return new CoinDirectory(definitions)
  }

  async #define(row: OnboardingRow): Promise<CoinDefinition> {
    const coinRef = row.coin_ref
    const vault = row.vault.toLowerCase()
    const token = row.token.toLowerCase()
    const record = await this.#vaultRecord(row, vault, token)

    const [quoteAsset, accounts, imageRefs, vaultDeployedAtBlock] = await Promise.all([
      this.#quoteAsset(coinRef, token),
      this.#accounts(coinRef),
      this.#options.images.list(coinRef),
      this.#deployBlock(coinRef, row.deploy_tx_hash),
    ])

    let narrative: NarrativeProfile | null = null
    if (row.narrative !== null && row.narrative !== undefined) {
      try {
        // JSONB arrives parsed from pg and pglite alike; a TEXT fallback is parsed here.
        narrative = validateNarrativeProfile(
          typeof row.narrative === 'string' ? (JSON.parse(row.narrative) as unknown) : row.narrative,
        )
      } catch (error) {
        throw new FleetStartupRefused(
          `coin "${coinRef}" has an approved narrative on file that no longer validates: ` +
            (error instanceof Error ? error.message : String(error)),
        )
      }
    }

    const { linkRefs, linkUrls } = this.#links(vault)

    return {
      coinRef,
      symbol: row.symbol,
      name: row.name,
      vault,
      token,
      quoteAsset,
      tier: record.tier,
      budgetBps: record.budgetBps,
      sweepIntervalSeconds: DEFAULT_SWEEP_INTERVAL_SECONDS,
      // Off the model path and signed per dev; nothing on the onboarding row
      // records it yet, so no coin opts in.
      relatedPartyOptIn: false,
      catalog: this.#options.catalog === undefined ? [] : plannerCatalogView(this.#options.catalog, record.tier),
      linkRefs,
      linkUrls,
      accounts,
      narrative,
      imageRefs,
      ...(vaultDeployedAtBlock === undefined ? {} : { vaultDeployedAtBlock }),
    }
  }

  /**
   * The record the tick loop reads and writes: tier, state and the dial.
   *
   * READ, NEVER SYNTHESISED. apps/api writes this row at activation (contract:
   * `PgVaultRepository.put` is its only writer) and moves it on every state
   * transition from `deployed` onward. A coin whose onboarding is `active`
   * but whose vault_record is missing is a coin the API did not finish
   * activating, and a record invented here - at the initial tier, with the
   * default dial, in ACTIVE - would serve that coin at a tier nobody granted
   * and a dial nobody signed. It refuses the start instead, naming the coin.
   */
  async #vaultRecord(row: OnboardingRow, vault: string, token: string): Promise<Vault> {
    const held = await this.#options.vaults.get(vault)
    if (held === undefined) {
      throw new FleetStartupRefused(
        `coin "${row.coin_ref}" is active in onboarding but has no vault_record row for ${vault}; ` +
          'the API writes that row at activation and this directory does not invent one',
      )
    }
    if (held.token.toLowerCase() !== token) {
      throw new FleetStartupRefused(
        `coin "${row.coin_ref}": vault_record ${vault} is bound to ${held.token}, onboarding says ${token}`,
      )
    }
    return held
  }

  /**
   * The chain's word first: once the indexer has bound the coin, the binding
   * names the pair token it launched against. Before that, the operator's
   * accepted-asset list - and ONLY when it names exactly one enabled asset,
   * because picking among several is a guess about which one this coin
   * trades in, and a wrong guess prices every fee in the wrong currency.
   */
  async #quoteAsset(coinRef: string, token: string): Promise<string> {
    const bound = await this.#options.driver.query<{ quote_asset: string }>(
      'SELECT quote_asset FROM indexer_binding WHERE token = $1',
      [token],
    )
    const fromChain = bound[0]?.quote_asset
    if (fromChain !== undefined) return fromChain.toLowerCase()

    const accepted = await this.#options.driver.query<{ address: string }>(
      'SELECT address FROM quote_asset WHERE enabled = TRUE ORDER BY address',
    )
    if (accepted.length === 1 && accepted[0] !== undefined) return accepted[0].address.toLowerCase()
    throw new FleetStartupRefused(
      `coin "${coinRef}" has no quote asset: the indexer has not bound ${token} and quote_asset lists ` +
        `${String(accepted.length)} enabled asset(s), so there is no single asset to price its fees in`,
    )
  }

  async #accounts(coinRef: string): Promise<Map<Channel, string>> {
    const rows = await this.#options.driver.query<{ channel: string; account_id: string }>(
      'SELECT channel, account_id FROM publisher_account_binding WHERE coin_ref = $1 ORDER BY channel, account_id',
      [coinRef],
    )
    const accounts = new Map<Channel, string>()
    for (const row of rows) {
      if (!CHANNELS.includes(row.channel as Channel)) {
        throw new FleetStartupRefused(`coin "${coinRef}" is bound to unknown channel "${row.channel}"`)
      }
      const channel = row.channel as Channel
      if (accounts.has(channel)) {
        throw new FleetStartupRefused(
          `coin "${coinRef}" has two ${channel} accounts bound (${String(accounts.get(channel))}, ${row.account_id}); ` +
            'a coin speaks from one account per channel',
        )
      }
      accounts.set(channel, row.account_id)
    }
    return accounts
  }

  async #deployBlock(coinRef: string, txHash: string | null): Promise<bigint | undefined> {
    const resolve = this.#options.deployBlock
    if (resolve === undefined || txHash === null || txHash.length === 0) return undefined
    const block = await resolve(txHash)
    if (block === undefined) {
      throw new FleetStartupRefused(
        `coin "${coinRef}" names deploy transaction ${txHash} and the chain has no receipt for it; ` +
          'a vault whose deployment cannot be found is not a vault this fleet can scan',
      )
    }
    return block
  }

  #links(vault: string): { linkRefs: LinkRef[]; linkUrls: Map<string, string> } {
    const base = this.#options.receiptsBaseUrl
    if (base === undefined) return { linkRefs: [], linkUrls: new Map() }
    return {
      linkRefs: [{ id: 'receipts', description: 'this coin’s public receipts page' }],
      linkUrls: new Map([['receipts', `${base.replace(/\/+$/, '')}/v/${vault}`]]),
    }
  }
}

/** The SKUs a coin at `tier` may be offered, as the planner is allowed to see them. */
export function plannerCatalogView(catalog: VendorCatalog, tier: TierId): PlannerSkuView[] {
  return catalog
    .entriesForTier(tier)
    .map((entry) => ({
      id: entry.sku.id,
      description: entry.sku.description,
      category: entry.sku.category,
      costBand:
        entry.sku.unitCostUsd < COST_BAND_CEILING_USD.low
          ? ('low' as const)
          : entry.sku.unitCostUsd < COST_BAND_CEILING_USD.medium
            ? ('medium' as const)
            : ('high' as const),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// ---------------------------------------------------------------------------

function consentFrom(coinRef: string, raw: unknown): Consent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new FleetStartupRefused(`coin "${coinRef}": onboarding consent is not an object`)
  }
  const o = raw as Record<string, unknown>
  const s = (key: keyof Consent): string => {
    const v = o[key]
    if (typeof v !== 'string' || v.length === 0) {
      throw new FleetStartupRefused(`coin "${coinRef}": onboarding consent.${key} is missing`)
    }
    return v
  }
  const n = (key: keyof Consent): number => {
    const v = o[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new FleetStartupRefused(`coin "${coinRef}": onboarding consent.${key} is not a number`)
    }
    return v
  }
  return {
    devSigner: s('devSigner'),
    devPayout: s('devPayout'),
    token: s('token'),
    termsHash: s('termsHash'),
    operatorBps: n('operatorBps'),
    budgetBpsMax: n('budgetBpsMax'),
    adapter: s('adapter'),
    referrer: s('referrer'),
    referrerBps: n('referrerBps'),
    expiryUnix: n('expiryUnix'),
    nonce: s('nonce'),
  }
}

/** pg returns BIGINT as a string; pglite as a number. NULL is absence. */
function unixOf(value: number | string | null | undefined, coinRef: string, column: string): number | undefined {
  if (value === null || value === undefined) return undefined
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10)
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new FleetStartupRefused(`coin "${coinRef}": onboarding.${column} ${String(value)} is not a unix time`)
  }
  return n
}

/**
 * THE COIN DIRECTORY: which coins the fleet holds, and what each one's team is
 * allowed to do.
 *
 * Everything in a definition is OPERATOR CONFIGURATION. Nothing here is ever
 * derived from a message, a model, or a vendor: the catalog a planner may see,
 * the link ids it may cite, the accounts it may speak from, and the salt that
 * hashes its user id are all written by a person and read by trusted code. A
 * compromised planner can pick the wrong entry from these lists. It cannot add
 * one.
 *
 * THE PARSER FAILS CLOSED. A definition with a missing field is not defaulted -
 * a defaulted vault address is a payment to nobody, and a defaulted salt merges
 * two clients' abuse history. It throws, names the field, and the fleet does
 * not start.
 */

import {
  parseImageAssetId,
  validateNarrativeProfile,
  type Address,
  type AssetAddress,
  type Channel,
  type ImageRef,
  type NarrativeProfile,
} from '@fee-split-vaults/core'
import type { LinkRef, PlannerSkuView } from '@fee-split-vaults/runtime'
import type { TierId } from '../../../config/protocol.js'

export class CoinDefinitionInvalid extends Error {
  constructor(
    readonly coinRef: string,
    readonly field: string,
    message: string,
  ) {
    super(`coin "${coinRef}": ${field}: ${message}`)
    this.name = 'CoinDefinitionInvalid'
  }
}

export interface CoinDefinition {
  /** Operator-assigned, opaque, [A-Za-z0-9_-]. Never the token address. */
  coinRef: string
  /** Ticker without the leading '$'. What the publisher binds an account to. */
  symbol: string
  /** Display name, as onboarded. Rendered by creative, never by a model. */
  name: string
  vault: Address
  token: Address
  quoteAsset: AssetAddress
  /** The tier the coin is served at until a tier evaluation says otherwise. */
  tier: TierId
  /** The dev's procurement dial, in bps of QF. From the signed consent. */
  budgetBps: number
  /** Sweep interval floor for a spending vault, seconds. */
  sweepIntervalSeconds: number
  /** Per-dev, signed, recorded off the model path. */
  relatedPartyOptIn: boolean
  /** What this coin's planner may propose. Ids and cost bands only. */
  catalog: readonly PlannerSkuView[]
  /** Allowlisted destinations by id. The URL never enters a prompt. */
  linkRefs: readonly LinkRef[]
  /** id -> URL. Resolved only after the model is out of the loop. */
  linkUrls: ReadonlyMap<string, string>
  /** Which platform account this coin speaks from, per channel. */
  accounts: ReadonlyMap<Channel, string>
  /** Operator-approved narrative, or null when none has been approved. */
  narrative: NarrativeProfile | null
  /** Rendered images the planner may attach, by id. Bytes live in the image store. */
  imageRefs: readonly ImageRef[]
  /**
   * The block this coin's vault came into existence at.
   *
   * Optional here and REQUIRED by the live chain path, which is the honest
   * split: a sandbox coin has no deployment block because it has no
   * deployment. `resolveLiveChain` refuses a coin without one rather than
   * defaulting, because both available defaults are wrong in ways that look
   * like working - scanning from 0 is an hours-long walk at this chain's rate
   * limit, and scanning from the head silently skips every settlement that has
   * already happened.
   *
   * A bigint, and carried as a STRING in JSON. A block number is already past
   * 2^53 on some chains and this one is at 58 million and climbing, so parsing
   * it as a JSON number is a precision bug waiting for a birthday.
   */
  vaultDeployedAtBlock?: bigint
}

const COIN_REF = /^[A-Za-z0-9_-]{3,64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const TIER_IDS: readonly string[] = ['T0', 'T1', 'T2', 'T3']
/** Ticker without '$': 1-12 of the characters a platform cashtag accepts. */
const SYMBOL = /^[A-Za-z0-9_]{1,12}$/

/**
 * The keys a directory entry may carry. Anything else is refused: a misspelt
 * key would otherwise be silently dropped, and the field it was meant to set
 * would fall to whatever the parser does when it is absent.
 */
const KNOWN_KEYS: Readonly<Record<string, true>> = {
  coinRef: true,
  symbol: true,
  name: true,
  vault: true,
  token: true,
  quoteAsset: true,
  tier: true,
  budgetBps: true,
  sweepIntervalSeconds: true,
  relatedPartyOptIn: true,
  catalog: true,
  linkRefs: true,
  linkUrls: true,
  accounts: true,
  narrative: true,
  imageRefs: true,
  vaultDeployedAtBlock: true,
}

export function assertCoinDefinition(definition: CoinDefinition): CoinDefinition {
  const ref = definition.coinRef
  if (!COIN_REF.test(ref)) {
    throw new CoinDefinitionInvalid(ref, 'coinRef', 'must be 3-64 chars of [A-Za-z0-9_-]')
  }
  if (!SYMBOL.test(definition.symbol)) {
    throw new CoinDefinitionInvalid(ref, 'symbol', 'must be 1-12 chars of [A-Za-z0-9_] without a leading $')
  }
  if (definition.name.trim().length === 0 || definition.name.length > 64) {
    throw new CoinDefinitionInvalid(ref, 'name', 'must be 1-64 characters')
  }
  for (const [field, value] of [
    ['vault', definition.vault],
    ['token', definition.token],
    ['quoteAsset', definition.quoteAsset],
  ] as const) {
    if (!ADDRESS.test(value)) throw new CoinDefinitionInvalid(ref, field, 'is not a 20-byte address')
  }
  if (!TIER_IDS.includes(definition.tier)) {
    throw new CoinDefinitionInvalid(ref, 'tier', `unknown tier "${definition.tier}"`)
  }
  if (!Number.isInteger(definition.budgetBps) || definition.budgetBps < 0 || definition.budgetBps > 10_000) {
    throw new CoinDefinitionInvalid(ref, 'budgetBps', 'must be an integer in [0, 10000]')
  }
  if (!Number.isInteger(definition.sweepIntervalSeconds) || definition.sweepIntervalSeconds <= 0) {
    throw new CoinDefinitionInvalid(ref, 'sweepIntervalSeconds', 'must be a positive integer')
  }
  // A link the planner can cite but trusted code cannot resolve is a dead post.
  for (const link of definition.linkRefs) {
    if (!definition.linkUrls.has(link.id)) {
      throw new CoinDefinitionInvalid(ref, 'linkUrls', `no URL for allowlisted link "${link.id}"`)
    }
  }
  // An image id minted under another coin is another coin's asset. The
  // publisher refuses it again at send time; refusing it here keeps a wrong
  // directory from starting at all.
  for (const image of definition.imageRefs) {
    const parsed = parseImageAssetId(image.id)
    if (parsed === null) throw new CoinDefinitionInvalid(ref, 'imageRefs', `"${image.id}" is not an image asset id`)
    if (parsed.coinRef !== ref) {
      throw new CoinDefinitionInvalid(ref, 'imageRefs', `"${image.id}" belongs to coin "${parsed.coinRef}"`)
    }
    if (parsed.kind !== image.kind) {
      throw new CoinDefinitionInvalid(ref, 'imageRefs', `"${image.id}" is a ${parsed.kind}, not a ${image.kind}`)
    }
  }
  return definition
}

/**
 * The fleet's membership list.
 *
 * Deliberately not a map anyone can mutate: a coin joins the fleet by being in
 * the configuration the process started with, so a running fleet cannot grow a
 * coin nobody signed.
 */
export class CoinDirectory {
  readonly #byRef = new Map<string, CoinDefinition>()

  constructor(definitions: readonly CoinDefinition[]) {
    for (const definition of definitions) {
      assertCoinDefinition(definition)
      if (this.#byRef.has(definition.coinRef)) {
        throw new CoinDefinitionInvalid(definition.coinRef, 'coinRef', 'is listed twice')
      }
      // Two coins on one vault would cross-credit each other's fees.
      for (const held of this.#byRef.values()) {
        if (held.vault.toLowerCase() === definition.vault.toLowerCase()) {
          throw new CoinDefinitionInvalid(definition.coinRef, 'vault', `already held by ${held.coinRef}`)
        }
      }
      this.#byRef.set(definition.coinRef, definition)
    }
  }

  /** Ordered by ref, so two processes compute the same list in the same order. */
  list(): CoinDefinition[] {
    return [...this.#byRef.values()].sort((a, b) => (a.coinRef < b.coinRef ? -1 : 1))
  }

  get(coinRef: string): CoinDefinition | undefined {
    return this.#byRef.get(coinRef)
  }

  require(coinRef: string): CoinDefinition {
    const found = this.#byRef.get(coinRef)
    if (found === undefined) throw new Error(`coin "${coinRef}" is not in the fleet`)
    return found
  }

  get size(): number {
    return this.#byRef.size
  }

  refs(): string[] {
    return this.list().map((c) => c.coinRef)
  }
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Parse a directory from JSON, as an operator would keep it in a config file.
 *
 * Untyped input, so every field is checked. The two Maps are the reason this is
 * not a JSON.parse cast: they are Maps in the definition because a plain object
 * with a `__proto__` key is not a lookup table anyone should be indexing with
 * an id that came out of a file.
 */
export function parseCoinDirectory(text: string): CoinDirectory {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`coin directory is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(raw)) throw new Error('coin directory must be a JSON array of coin definitions')

  return new CoinDirectory(raw.map((entry, index) => parseOne(entry, index)))
}

function parseOne(raw: unknown, index: number): CoinDefinition {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`coin directory entry ${String(index)} is not an object`)
  }
  const o = raw as Record<string, unknown>
  const ref = typeof o.coinRef === 'string' ? o.coinRef : `#${String(index)}`
  for (const key of Object.keys(o)) {
    if (KNOWN_KEYS[key] !== true) throw new CoinDefinitionInvalid(ref, key, 'is not a field of a coin definition')
  }
  const str = (field: string): string => {
    const value = o[field]
    if (typeof value !== 'string' || value.length === 0) {
      throw new CoinDefinitionInvalid(ref, field, 'is required and must be a non-empty string')
    }
    return value
  }
  const int = (field: string): number => {
    const value = o[field]
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new CoinDefinitionInvalid(ref, field, 'is required and must be an integer')
    }
    return value
  }

  const linkUrlsRaw = o.linkUrls
  const linkUrls = new Map<string, string>()
  if (linkUrlsRaw !== undefined) {
    if (typeof linkUrlsRaw !== 'object' || linkUrlsRaw === null || Array.isArray(linkUrlsRaw)) {
      throw new CoinDefinitionInvalid(ref, 'linkUrls', 'must be an object of id -> url')
    }
    for (const [id, url] of Object.entries(linkUrlsRaw as Record<string, unknown>)) {
      if (typeof url !== 'string') throw new CoinDefinitionInvalid(ref, 'linkUrls', `${id} is not a string`)
      linkUrls.set(id, url)
    }
  }

  const accountsRaw = o.accounts
  const accounts = new Map<Channel, string>()
  if (accountsRaw !== undefined) {
    if (typeof accountsRaw !== 'object' || accountsRaw === null || Array.isArray(accountsRaw)) {
      throw new CoinDefinitionInvalid(ref, 'accounts', 'must be an object of channel -> account id')
    }
    for (const [channel, accountId] of Object.entries(accountsRaw as Record<string, unknown>)) {
      if (typeof accountId !== 'string') {
        throw new CoinDefinitionInvalid(ref, 'accounts', `${channel} is not a string`)
      }
      accounts.set(channel as Channel, accountId)
    }
  }

  const catalogRaw = Array.isArray(o.catalog) ? o.catalog : []
  const catalog: PlannerSkuView[] = catalogRaw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new CoinDefinitionInvalid(ref, 'catalog', 'entry is not an object')
    }
    const e = entry as Record<string, unknown>
    const band = e.costBand
    if (band !== 'low' && band !== 'medium' && band !== 'high') {
      throw new CoinDefinitionInvalid(ref, 'catalog', 'costBand must be low|medium|high')
    }
    return {
      id: String(e.id ?? ''),
      description: String(e.description ?? ''),
      category: String(e.category ?? ''),
      costBand: band,
    }
  })

  const linkRefsRaw = Array.isArray(o.linkRefs) ? o.linkRefs : []
  const linkRefs: LinkRef[] = linkRefsRaw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new CoinDefinitionInvalid(ref, 'linkRefs', 'entry is not an object')
    }
    const e = entry as Record<string, unknown>
    return { id: String(e.id ?? ''), description: String(e.description ?? '') }
  })

  let narrative: NarrativeProfile | null = null
  if (o.narrative !== undefined && o.narrative !== null) {
    try {
      narrative = validateNarrativeProfile(o.narrative)
    } catch (error) {
      throw new CoinDefinitionInvalid(ref, 'narrative', error instanceof Error ? error.message : String(error))
    }
  }

  const imageRefsRaw = o.imageRefs === undefined ? [] : o.imageRefs
  if (!Array.isArray(imageRefsRaw)) throw new CoinDefinitionInvalid(ref, 'imageRefs', 'must be an array of ids')
  const imageRefs: ImageRef[] = imageRefsRaw.map((id) => {
    if (typeof id !== 'string') throw new CoinDefinitionInvalid(ref, 'imageRefs', 'entry is not a string')
    const parsed = parseImageAssetId(id)
    if (parsed === null) throw new CoinDefinitionInvalid(ref, 'imageRefs', `"${id}" is not an image asset id`)
    return { id, kind: parsed.kind }
  })

  return assertCoinDefinition({
    coinRef: str('coinRef'),
    symbol: str('symbol'),
    name: str('name'),
    vault: str('vault'),
    token: str('token'),
    quoteAsset: str('quoteAsset'),
    tier: str('tier') as TierId,
    budgetBps: int('budgetBps'),
    sweepIntervalSeconds: int('sweepIntervalSeconds'),
    relatedPartyOptIn: o.relatedPartyOptIn === true,
    catalog,
    linkRefs,
    linkUrls,
    accounts,
    narrative,
    imageRefs,
    ...(o.vaultDeployedAtBlock === undefined
      ? {}
      : { vaultDeployedAtBlock: blockNumber(ref, o.vaultDeployedAtBlock) }),
  })
}

/**
 * A block number from JSON.
 *
 * A JSON number is accepted only while it is a SAFE integer. Beyond that,
 * JSON.parse has already rounded it and there is nothing left here to
 * validate - so this refuses rather than storing a number that is quietly not
 * the one the file said.
 */
function blockNumber(ref: string, raw: unknown): bigint {
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) return BigInt(raw.trim())
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw)
  throw new CoinDefinitionInvalid(
    ref,
    'vaultDeployedAtBlock',
    'must be a non-negative decimal block number, given as a string so a large ' +
      'block number is not rounded by JSON parsing',
  )
}


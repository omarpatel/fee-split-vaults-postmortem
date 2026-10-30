/**
 * THE PROMOTION SURFACE: narrative, accounts, purchases, creative.
 *
 * Every route here is an operator action, gated by the same bearer token as
 * activation and decline (http/server.ts gates every path that is not listed
 * public). Each group is OPTIONAL in RouteDeps: a deployment that has not
 * wired X, or has no fleet reporting purchases, answers 503
 * feature_unconfigured for that group and serves the rest. A route that
 * answered with a default instead would be describing a capability the process
 * does not have.
 *
 * THE AIRLOCK APPLIES IN BOTH DIRECTIONS HERE.
 *
 *   Inbound: the narrative sources are dev-named URLs; they are validated with
 *   the publisher's link rules before storage and fetched by trusted code. The
 *   fetched documents go to the READER plane only; what comes back is a closed
 *   NarrativeCandidate that validateNarrativeProfile refuses if a destination
 *   is hiding in the one prose field. The operator then approves it or not.
 *
 *   Outbound: no OAuth token ever appears in a response. The callback stores
 *   the credential and answers with scopes and an expiry. Socials the dev
 *   claimed stay off every body.
 */

import { createHash, randomBytes } from 'node:crypto'

import {
  AirlockViolation,
  IMAGE_KINDS,
  type Address,
  type ImageAsset,
  type ImageAssetStore,
  type ImageKind,
} from '@fee-split-vaults/core'
import { CreativeError, renderCoinAssets } from '@fee-split-vaults/creative'
import type { NarrativeSource } from '@fee-split-vaults/adapters'
import { NarrativeFetchError } from '@fee-split-vaults/adapters'
import {
  X_OAUTH_SCOPES,
  XOAuthError,
  type AccountCredentialStore,
  type LabelAttestationStore,
  type MutableAccountRegistry,
  type XOAuth2Client,
} from '@fee-split-vaults/publisher'
import type { InvoiceRegistry, PendingPurchaseStore } from '@fee-split-vaults/orchestrator'
import { BrokerError, invoiceHashFor, usdFromCents, type VendorInvoice } from '@fee-split-vaults/broker'

import { isAddress, normalizeAddress } from './crypto/address.js'
import {
  Onboarding,
  OnboardingError,
  PROMOTION_ELIGIBLE_STATES,
  type NarrativeCandidate,
  type OnboardingRecord,
} from './onboarding.js'
import {
  assertExactKeys,
  optionalInteger,
  requireInteger,
  requireObject,
  requireString,
} from './http/json.js'
import {
  Router,
  badRequest,
  conflict,
  notFound,
  serviceUnavailable,
  type RequestContext,
  type Response,
} from './http/router.js'

export interface NarrativeDeps {
  /** fetchNarrativeSource with the operator's fetch options bound. */
  fetchSource(url: string): Promise<NarrativeSource>
  /** deriveNarrativeCandidate with the reader-plane model bound. */
  derive(sources: readonly NarrativeSource[]): Promise<NarrativeCandidate>
}

export interface AccountDeps {
  oauth: XOAuth2Client
  credentials: AccountCredentialStore
  registry: MutableAccountRegistry
  labels: LabelAttestationStore
  /** How long an authorize URL stays redeemable. Default 600s. */
  handshakeTtlSeconds?: number
}

export interface PurchaseDeps {
  /** Shared with the runner: an entry it recorded is cleared here when its invoice lands. */
  pending: PendingPurchaseStore
  invoices: InvoiceRegistry
}

export interface CreativeDeps {
  images: ImageAssetStore
  /** Font files pinned for the render. Empty means the host's fonts. */
  fontFiles: readonly string[]
}

export interface PromotionDeps {
  onboarding: Onboarding
  now: () => number
  narrative?: NarrativeDeps
  accounts?: AccountDeps
  purchases?: PurchaseDeps
  creative?: CreativeDeps
}

/** Where an unredeemed X handshake waits. Ten minutes covers a browser round trip. */
export const DEFAULT_HANDSHAKE_TTL_SECONDS = 600
const MAX_LABEL_ATTESTATION_DAYS = 365
const MAX_INVOICE_QUANTITY = 10_000
/** Clock skew we tolerate on a vendor's issuedAtUnix before calling it a future invoice. */
const INVOICE_SKEW_SECONDS = 300

const OPERATOR_ID = /^[A-Za-z0-9_.-]{1,64}$/
const ACCOUNT_ID = /^[A-Za-z0-9_]{1,64}$/
const TICKER = /^[A-Za-z0-9_]{1,32}$/
const COIN_REF = /^[A-Za-z0-9_-]{1,96}$/
const SKU_OR_VENDOR_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/
const INVOICE_HASH = /^0x[0-9a-f]{64}$/
/** A USD amount as the vendor printed it: digits, at most two decimals, never a float. */
const USD_DECIMAL = /^(0|[1-9]\d{0,8})(?:\.(\d{1,2}))?$/

interface Handshake {
  coinRef: string
  accountId: string
  codeVerifier: string
  expiresAtUnix: number
}

const ok = (body: unknown): Response => ({ status: 200, body })
const created = (body: unknown): Response => ({ status: 201, body })

function narrativeBody(record: OnboardingRecord): Record<string, unknown> {
  return {
    id: record.id,
    state: record.state,
    sources: record.narrativeSources,
    candidate: record.narrativeCandidate,
    approved: record.narrative,
  }
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function addPromotionRoutes(router: Router, deps: PromotionDeps): void {
  const handshakes = new Map<string, Handshake>()

  // -------------------------------------------------------------------------
  // Narrative
  // -------------------------------------------------------------------------

  router.add({
    method: 'GET',
    pattern: '/onboarding/:id/narrative',
    summary: 'The derived narrative candidate and, if the operator approved one, the profile the planner sees.',
    handler: async (ctx) => ok({ narrative: narrativeBody(await requireRecord(ctx)) }),
  })

  router.add({
    method: 'POST',
    pattern: '/onboarding/:id/narrative/derive',
    summary: 'Fetch the dev-named sources, summarise them on the reader plane, hold the result for approval.',
    handler: async (ctx) => {
      const narrative = requireFeature(deps.narrative, 'narrative')
      if (ctx.body !== undefined) assertExactKeys(requireObject(ctx.body), [])
      const record = await requireRecord(ctx)
      if (!PROMOTION_ELIGIBLE_STATES.includes(record.state)) {
        throw conflict('narrative_not_eligible', 'a narrative is derived once the coin has pointed at the vault')
      }
      if (record.narrativeSources.length === 0) {
        throw badRequest('no_narrative_sources', 'the onboarding named no narrative sources')
      }

      const sources: NarrativeSource[] = []
      for (const url of record.narrativeSources) {
        try {
          sources.push(await narrative.fetchSource(url))
        } catch (error) {
          if (error instanceof NarrativeFetchError) {
            // The code says why; the URL is dev-authored and stays off the wire.
            throw badRequest('narrative_source_unavailable', `a source could not be read (${error.code})`)
          }
          throw error
        }
      }

      const candidate = await narrative.derive(sources)
      const updated = await recordCandidate(record.id, candidate)
      return ok({ narrative: narrativeBody(updated) })
    },
  })

  router.add({
    method: 'POST',
    pattern: '/onboarding/:id/narrative/approve',
    summary: 'The operator approves the candidate. Only an approved profile ever reaches the planner.',
    handler: async (ctx) => {
      const body = requireObject(ctx.body)
      assertExactKeys(body, ['approvedBy'])
      const approvedBy = requireString(body, 'approvedBy', 64)
      if (!OPERATOR_ID.test(approvedBy)) throw badRequest('bad_operator_id', 'approvedBy must be an operator id')
      const id = requireId(ctx)
      let updated: OnboardingRecord
      try {
        updated = await deps.onboarding.approveNarrative(id, approvedBy)
      } catch (error) {
        if (error instanceof AirlockViolation) {
          throw badRequest('narrative_invalid', `stored candidate failed validation at ${error.field}`)
        }
        throw error
      }
      // The approval is on file before the render starts: a font that cannot
      // be resolved must not un-approve a narrative. The render's own outcome
      // is reported beside it, and /creative/render retries it alone.
      const creative = deps.creative === undefined ? undefined : await renderOutcome(deps.creative, updated)
      return ok({ narrative: narrativeBody(updated), ...(creative === undefined ? {} : { creative }) })
    },
  })

  // -------------------------------------------------------------------------
  // X accounts. One platform account speaks for exactly one coin.
  // -------------------------------------------------------------------------

  router.add({
    method: 'GET',
    pattern: '/accounts/x/authorize',
    summary: 'Start the X OAuth handshake for an account that will speak for one coin. Returns the URL to visit.',
    handler: async (ctx) => {
      const accounts = requireFeature(deps.accounts, 'x_accounts')
      const coinRef = requireQuery(ctx, 'coinRef', COIN_REF)
      const accountId = requireQuery(ctx, 'accountId', ACCOUNT_ID)
      await requireRecordByCoinRef(coinRef)

      const now = deps.now()
      for (const [state, handshake] of handshakes) {
        if (handshake.expiresAtUnix <= now) handshakes.delete(state)
      }
      const state = base64url(randomBytes(32))
      const codeVerifier = base64url(randomBytes(32))
      const codeChallenge = base64url(createHash('sha256').update(codeVerifier, 'ascii').digest())
      const expiresAtUnix = now + (accounts.handshakeTtlSeconds ?? DEFAULT_HANDSHAKE_TTL_SECONDS)
      handshakes.set(state, { coinRef, accountId, codeVerifier, expiresAtUnix })
      return ok({
        url: accounts.oauth.authorizeUrl(state, codeChallenge, X_OAUTH_SCOPES),
        state,
        expiresAtUnix,
      })
    },
  })

  router.add({
    method: 'GET',
    pattern: '/accounts/x/callback',
    summary: 'Redeem the code X handed back. Stores the credential; the token itself is never returned.',
    handler: async (ctx) => {
      const accounts = requireFeature(deps.accounts, 'x_accounts')
      const state = requireQuery(ctx, 'state', /^[A-Za-z0-9_-]{16,128}$/)
      const code = requireQuery(ctx, 'code', /^[A-Za-z0-9_.~-]{1,512}$/)
      const handshake = handshakes.get(state)
      // Single use either way: a replayed state is gone whether or not it was fresh.
      handshakes.delete(state)
      if (handshake === undefined) throw notFound('unknown_handshake', 'no such handshake')
      if (handshake.expiresAtUnix <= deps.now()) throw badRequest('handshake_expired', 'the handshake expired; start again')

      let credentials
      try {
        credentials = await accounts.oauth.exchange(code, handshake.codeVerifier)
      } catch (error) {
        if (error instanceof XOAuthError) throw badRequest(`x_oauth_${error.code}`, 'X refused the code exchange')
        throw error
      }
      await accounts.credentials.put(handshake.accountId, credentials)
      return ok({
        accountId: handshake.accountId,
        coinRef: handshake.coinRef,
        scopes: credentials.scopes,
        expiresAtUnix: credentials.expiresAtUnix,
        refreshable: credentials.refreshToken !== null,
      })
    },
  })

  router.add({
    method: 'POST',
    pattern: '/accounts/x/bind',
    summary: 'Bind an authorised X account to one coin, as the operator-run channel. Refused without a credential.',
    handler: async (ctx) => {
      const accounts = requireFeature(deps.accounts, 'x_accounts')
      const body = requireObject(ctx.body)
      assertExactKeys(body, ['accountId', 'coinRef', 'ticker'])
      const accountId = requireString(body, 'accountId', 64)
      if (!ACCOUNT_ID.test(accountId)) throw badRequest('bad_account_id', 'accountId must be a platform user id')
      const coinRef = requireString(body, 'coinRef', 96)
      if (!COIN_REF.test(coinRef)) throw badRequest('bad_coin_ref', 'coinRef must be opaque: [A-Za-z0-9_-] only')
      const ticker = requireString(body, 'ticker', 32)
      if (!TICKER.test(ticker)) throw badRequest('bad_ticker', 'ticker must be alphanumeric, no $')

      const record = await requireRecordByCoinRef(coinRef)
      if (!PROMOTION_ELIGIBLE_STATES.includes(record.state)) {
        throw conflict('coin_not_eligible', 'an account is bound once the coin has pointed at the vault')
      }
      if (ticker.toUpperCase() !== record.symbol.toUpperCase()) {
        // The ticker an account speaks for is the coin's symbol. Anything else
        // is an account speaking for a coin that is not the one it was bound to.
        throw badRequest('ticker_mismatch', 'ticker does not match the onboarded symbol')
      }
      if ((await accounts.credentials.get(accountId)) === null) {
        throw conflict('account_not_authorised', 'complete the OAuth handshake for this account first')
      }

      await accounts.registry.bind({
        accountId,
        channel: 'x_operator',
        coinRef,
        vault: record.vault,
        token: record.token,
        ticker,
        delegated: false,
      })
      return created({ binding: { accountId, channel: 'x_operator', coinRef, vault: record.vault, ticker } })
    },
  })

  router.add({
    method: 'POST',
    pattern: '/accounts/x/attest-label',
    summary: 'A named operator attests the Automated label is on the profile. Lapses after `days`.',
    handler: async (ctx) => {
      const accounts = requireFeature(deps.accounts, 'x_accounts')
      const body = requireObject(ctx.body)
      assertExactKeys(body, ['accountId', 'attestedBy', 'days'])
      const accountId = requireString(body, 'accountId', 64)
      if (!ACCOUNT_ID.test(accountId)) throw badRequest('bad_account_id', 'accountId must be a platform user id')
      const attestedBy = requireString(body, 'attestedBy', 64)
      if (!OPERATOR_ID.test(attestedBy)) throw badRequest('bad_operator_id', 'attestedBy must be an operator id')
      const days = requireInteger(body, 'days', 1, MAX_LABEL_ATTESTATION_DAYS)
      const now = deps.now()
      const attestation = { accountId, attestedBy, attestedAtUnix: now, expiresAtUnix: now + days * 86_400 }
      await accounts.labels.put(attestation)
      return created({ attestation })
    },
  })

  // -------------------------------------------------------------------------
  // Purchases and invoices
  // -------------------------------------------------------------------------

  router.add({
    method: 'GET',
    pattern: '/purchases',
    summary: 'Approved purchases the operator still has to buy and evidence, and invoices not yet settled.',
    handler: async (ctx) => {
      const purchases = requireFeature(deps.purchases, 'purchases')
      const vault = requireVaultQuery(ctx)
      const awaiting = await purchases.pending.awaitingInvoice(vault)
      const pendingInvoices = await purchases.invoices.listPending(vault)
      return ok({
        vault,
        atUnix: deps.now(),
        awaitingInvoice: awaiting.map((p) => ({
          vendorId: p.vendorId,
          skuId: p.skuId,
          quantity: p.quantity,
          // Money leaves as a decimal string. Never a number.
          quoteUsdCents: p.quoteCents.toString(),
          proposedAtUnix: p.proposedAtUnix,
        })),
        pendingInvoices: pendingInvoices.map(invoiceBody),
      })
    },
  })

  router.add({
    method: 'POST',
    pattern: '/invoices',
    summary: 'Record a vendor-countersigned invoice for a purchase the operator made as principal.',
    handler: async (ctx) => {
      const purchases = requireFeature(deps.purchases, 'purchases')
      const body = requireObject(ctx.body)
      assertExactKeys(body, [
        'vault',
        'vendorId',
        'skuId',
        'quantity',
        'amountUsd',
        'vendorCountersig',
        'issuedAtUnix',
        'invoiceHash',
        'baseline',
      ])
      const vaultRaw = body.vault
      if (!isAddress(vaultRaw)) throw badRequest('bad_vault', 'vault must be a 0x address')
      const vault = normalizeAddress(vaultRaw)
      const vendorId = requireString(body, 'vendorId', 128)
      const skuId = requireString(body, 'skuId', 128)
      if (!SKU_OR_VENDOR_ID.test(vendorId) || !SKU_OR_VENDOR_ID.test(skuId)) {
        throw badRequest('bad_sku', 'vendorId and skuId must be catalog identifiers')
      }
      const quantity = requireInteger(body, 'quantity', 1, MAX_INVOICE_QUANTITY)
      const amountCents = requireUsdCents(body, 'amountUsd')
      const vendorCountersig = requireString(body, 'vendorCountersig', 4_096)
      if (!HEX_BYTES.test(vendorCountersig)) {
        throw badRequest('bad_countersig', 'vendorCountersig must be 0x-hex bytes')
      }
      const now = deps.now()
      const issuedAtUnix = requireInteger(body, 'issuedAtUnix', 1, now + INVOICE_SKEW_SECONDS)

      const unsigned: Omit<VendorInvoice, 'invoiceHash' | 'vendorCountersig'> = {
        vendorId,
        skuId,
        quantity,
        amountUsd: usdFromCents(amountCents),
        issuedAtUnix,
      }
      const baseline = requireBaseline(body)
      if (baseline !== undefined) unsigned.baseline = baseline
      const invoiceHash = invoiceHashFor(unsigned)
      if (!INVOICE_HASH.test(invoiceHash)) {
        throw new Error('invoiceHashFor produced something other than bytes32')
      }
      if (body.invoiceHash !== undefined) {
        // The vendor's copy names a hash. If ours differs, one of us is looking
        // at a different invoice, and that is not resolved by trusting either.
        if (typeof body.invoiceHash !== 'string' || body.invoiceHash.toLowerCase() !== invoiceHash) {
          throw badRequest('invoice_hash_mismatch', 'the supplied invoiceHash is not the hash of this invoice')
        }
      }
      const invoice: VendorInvoice = { ...unsigned, invoiceHash, vendorCountersig }
      // The registry refuses a reused hash too; checking first turns the common
      // case - an operator submitting the same invoice twice - into a 409
      // rather than a driver-specific failure.
      if ((await purchases.invoices.listPending(vault)).some((i) => i.invoiceHash === invoiceHash)) {
        throw conflict('invoice_conflict', 'an invoice with this hash is already on file for the vault')
      }
      try {
        await purchases.invoices.put(vault, invoice)
      } catch (error) {
        if (error instanceof BrokerError) throw badRequest(error.code, error.message)
        throw error
      }
      // The purchase is evidenced. Off the operator's to-do list, in the same
      // store the runner writes it to.
      await purchases.pending.clear(vault, skuId, quantity)
      return created({ vault, invoice: invoiceBody(invoice) })
    },
  })

  // -------------------------------------------------------------------------
  // Creative handoff
  // -------------------------------------------------------------------------

  router.add({
    method: 'POST',
    pattern: '/onboarding/:id/creative/render',
    summary: 'Render the banner, avatar and card for an eligible coin from its approved narrative, or from none.',
    handler: async (ctx) => {
      const creative = requireFeature(deps.creative, 'creative')
      if (ctx.body !== undefined) assertExactKeys(requireObject(ctx.body), [])
      const record = await requireRecord(ctx)
      if (!PROMOTION_ELIGIBLE_STATES.includes(record.state)) {
        throw conflict('creative_not_eligible', 'creative is rendered once the coin has pointed at the vault')
      }
      let assets: readonly ImageAsset[]
      try {
        assets = await renderAndStore(creative, record)
      } catch (error) {
        if (error instanceof CreativeError) throw serviceUnavailable('creative_render_failed', error.code)
        throw error
      }
      return ok({ id: record.id, creative: { narrative: record.narrative !== undefined, assets: assets.map(assetRef) } })
    },
  })

  router.add({
    method: 'GET',
    pattern: '/onboarding/:id/creative/:kind',
    summary: 'The rendered PNG (banner, avatar, card) for the coin, for the operator to set on the account.',
    handler: async (ctx) => {
      const { images } = requireFeature(deps.creative, 'creative')
      const kind = ctx.params.kind
      if (kind === undefined || !(IMAGE_KINDS as readonly string[]).includes(kind)) {
        throw badRequest('bad_image_kind', `kind must be one of ${IMAGE_KINDS.join(', ')}`)
      }
      const record = await requireRecord(ctx)
      const ref = (await images.list(record.coinRef)).find((r) => r.kind === (kind as ImageKind))
      const asset = ref === undefined ? null : await images.get(ref.id)
      if (asset === null) throw notFound('creative_not_rendered', 'no rendered asset of that kind for this coin')
      return {
        status: 200,
        body: asset.bytes,
        headers: {
          'content-type': asset.mime,
          'content-length': String(asset.bytes.byteLength),
          etag: `"${asset.sha256}"`,
        },
      }
    },
  })

  // -------------------------------------------------------------------------

  async function recordCandidate(id: string, candidate: NarrativeCandidate): Promise<OnboardingRecord> {
    try {
      return await deps.onboarding.recordNarrativeCandidate(id, candidate)
    } catch (error) {
      if (error instanceof AirlockViolation) {
        throw badRequest('narrative_invalid', `derived candidate failed validation at ${error.field}`)
      }
      if (error instanceof OnboardingError) throw conflict(error.code, error.message)
      throw error
    }
  }

  function requireFeature<T>(feature: T | undefined, name: string): T {
    if (feature === undefined) {
      throw serviceUnavailable('feature_unconfigured', `${name} is not configured in this deployment`)
    }
    return feature
  }

  function requireId(ctx: RequestContext): string {
    const id = ctx.params.id
    if (id === undefined || id.length === 0) throw badRequest('bad_id', 'onboarding id required')
    return id
  }

  async function requireRecord(ctx: RequestContext): Promise<OnboardingRecord> {
    const record = await deps.onboarding.store.get(requireId(ctx))
    if (record === undefined) throw notFound('no_such_onboarding', 'no such onboarding')
    return record
  }

  async function requireRecordByCoinRef(coinRef: string): Promise<OnboardingRecord> {
    const record = (await deps.onboarding.store.list()).find((r) => r.coinRef === coinRef)
    if (record === undefined) throw notFound('no_such_coin', 'no onboarding for that coinRef')
    return record
  }

  function requireQuery(ctx: RequestContext, key: string, pattern: RegExp): string {
    const value = ctx.query[key]
    if (value === undefined || !pattern.test(value)) throw badRequest(`bad_${key}`, `${key} is required`)
    return value
  }

  function requireVaultQuery(ctx: RequestContext): Address {
    const raw = ctx.query.vault
    if (raw === undefined || !isAddress(raw)) throw badRequest('bad_vault', 'vault must be a 0x address')
    return normalizeAddress(raw)
  }
}

/**
 * A USD amount arrives as the vendor printed it - a decimal string - and
 * becomes integer cents here. A JSON number is refused outright: 12.30 and
 * 12.299999 are the same double, and an invoice is not allowed to be ambiguous
 * about a cent.
 */
function requireUsdCents(source: Record<string, unknown>, field: string): bigint {
  const raw = source[field]
  if (typeof raw !== 'string') throw badRequest('amount_not_decimal_string', `${field} must be a decimal string, not a number`)
  const match = USD_DECIMAL.exec(raw)
  if (match === null) throw badRequest('bad_amount', `${field} must be digits with at most two decimals`)
  const whole = BigInt(match[1]!)
  const fraction = (match[2] ?? '').padEnd(2, '0')
  const cents = whole * 100n + BigInt(fraction)
  if (cents === 0n) throw badRequest('bad_amount', `${field} must be positive`)
  return cents
}

function requireBaseline(body: Record<string, unknown>): VendorInvoice['baseline'] | undefined {
  if (body.baseline === undefined) return undefined
  const baseline = requireObject(body.baseline, 'baseline')
  assertExactKeys(baseline, ['boosts', 'rank'], 'baseline')
  const result: NonNullable<VendorInvoice['baseline']> = {}
  const boosts = optionalInteger(baseline, 'boosts', 0, 1_000_000_000)
  if (boosts !== undefined) result.boosts = boosts
  const rank = optionalInteger(baseline, 'rank', 0, 1_000_000_000)
  if (rank !== undefined) result.rank = rank
  return result
}

function invoiceBody(invoice: VendorInvoice): Record<string, unknown> {
  return {
    vendorId: invoice.vendorId,
    skuId: invoice.skuId,
    quantity: invoice.quantity,
    amountUsd: invoice.amountUsd.toFixed(2),
    invoiceHash: invoice.invoiceHash,
    issuedAtUnix: invoice.issuedAtUnix,
    ...(invoice.baseline === undefined ? {} : { baseline: invoice.baseline }),
  }
}

/**
 * Render the coin's three assets from its approved narrative - or from none,
 * which the templates accept, so a coin without a narrative still gets a
 * banner - and put each in the store the publisher reads. Deterministic for a
 * fixed font set: re-rendering the same inputs writes the same ids.
 */
async function renderAndStore(creative: CreativeDeps, record: OnboardingRecord): Promise<readonly ImageAsset[]> {
  const assets = await renderCoinAssets(
    { coinRef: record.coinRef, symbol: record.symbol, name: record.name, narrative: record.narrative ?? null },
    { fontFiles: creative.fontFiles },
  )
  for (const asset of assets) await creative.images.put(asset)
  return assets
}

/** The render beside an approval: its ids, or the reason it did not happen. */
async function renderOutcome(creative: CreativeDeps, record: OnboardingRecord): Promise<Record<string, unknown>> {
  try {
    return { assets: (await renderAndStore(creative, record)).map(assetRef) }
  } catch (error) {
    if (error instanceof CreativeError) return { rendered: false, error: error.code }
    throw error
  }
}

function assetRef(asset: ImageAsset): Record<string, unknown> {
  return { id: asset.id, kind: asset.kind, sha256: asset.sha256, bytes: asset.bytes.byteLength }
}

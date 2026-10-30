/**
 * THE WEB CONTRACT: apps/web/src/api/routes.ts, served.
 *
 * The route table over there is the specification and this file is the
 * implementation; a path or a field that differs breaks one page in one
 * place, which is the point of keeping the contract as data.
 *
 * FOUR CONVENTIONS THE SERVER HOLDS TO (routes.ts, apps/web):
 *
 *   1. Amounts are decimal strings of integers. A bigint never becomes a JSON
 *      number here; v1/coins.ts is where every amount is stringified.
 *   2. Every USD figure carries { priceSource, pricedAtUnix, blockHash? }, and
 *      a coin with credits and no pinned price REFUSES (503 price_unavailable)
 *      rather than printing a guess.
 *   3. Public routes take no credential and set no cookie.
 *   4. Dev routes take a session bearer from the signature exchange, and a
 *      dev sees only the vaults whose consent their address signed.
 *   5. NO ROUTE SIGNS OR SENDS. The dial, terminate, retrofit and deploy
 *      controls return an UnsignedTx for the dev's own wallet, and the web
 *      re-encodes each one locally before it shows a button.
 */

import { randomBytes } from 'node:crypto'

import type { Address, Consent } from '@fee-split-vaults/core'
import { RecipientReadError } from '@fee-split-vaults/adapters'
import type { CoinBinding } from '@fee-split-vaults/indexer'
import type { ScreeningEngine } from '@fee-split-vaults/screening'

import { VENUE, TERMS } from '../../../../config/protocol.js'
import { ZERO_ADDRESS, assertCommercialTerms, draftConsent } from '../consent.js'
import { isAddress, normalizeAddress } from '../crypto/address.js'
import { ConsentError, consentDigest, consentSalt, verifyConsent, type Eip712Domain } from '../eip712.js'
import { predictVault, type FactoryDescriptor } from '../deploy.js'
import { requireAddressField, requireBytes32Field, requireNarrativeSources, requireSocials } from '../fields.js'
import { assertExactKeys, requireInteger, requireObject, requireString } from '../http/json.js'
import { HttpError, badRequest, notFound, serviceUnavailable, type RequestContext, type Response, type Router } from '../http/router.js'
import { OnboardingError, type FleetStores, type Onboarding, type OnboardingRecord, type RecipientReader } from '../onboarding.js'
import { buildWeeklyReport } from '../report.js'
import type { RouteDeps } from '../routes.js'
import { encodeEscrowClaim, encodeFactoryDeploy, encodeSetDial, encodeTerminate, encodeTransferCreatorFeeRecipient } from './calldata.js'
import {
  MEMBER_STATES,
  centsOf,
  coinSummaryBody,
  escalationBody,
  pricedAssetOf,
  publicCoinBody,
  receiptItemBody,
  receiptPageBody,
  usdToCents,
  usdWire,
  vendorScorecardsBody,
  type CoinSources,
} from './coins.js'
import {
  ACK_DECISIONS,
  type AckDecision,
  type EscalationQueue,
  type EscrowCredits,
  type OperatedAccounts,
  type ProcurementOutcomes,
  type QfReader,
  type QuoteStore,
  type TokenMetadata,
  type VaultViews,
  type VendorDirectory,
} from './ports.js'
import { CHALLENGE_TTL_SECONDS, type DevAuth } from './sessions.js'

/** What the operator publishes about itself. Absent terms: quote and /v1/protocol answer 503. */
export interface ProtocolTerms {
  adapter: Address
  termsHash: string
  termsUrl: string
  /** The referrer's share of the operator slice, in bps. Absent: a quote naming a referrer is refused. */
  referrerShareBps?: number
}

export interface ProtocolIdentity {
  operatorLegalName: string
  operatorAddresses: Array<{ label: string; address: string; role: string }>
  receiptsBaseUrl: string
  terms?: ProtocolTerms
}

export interface V1Deps extends Pick<RouteDeps, 'ledger' | 'ledgerStore' | 'receipts' | 'reporting' | 'now'> {
  auth: DevAuth
  quotes: QuoteStore
  onboarding: Onboarding
  screening: ScreeningEngine
  factory: FactoryDescriptor
  domain: Eip712Domain
  protocol: ProtocolIdentity
  recipients: RecipientReader
  /** vault_record: tier, state, dial. Absent: every coin reads as T0 at its onboarding-implied state. */
  fleetVaults?: FleetStores['vaults']
  /** The indexer's binding: graduation and launch facts. Absent: not graduated, launch dated by the record. */
  bindings?: { bindingByToken(token: Address): Promise<CoinBinding | undefined> }
  /** CoinVault getters for the dev dashboard. Absent: the dashboard detail answers 503. */
  vaultViews?: VaultViews
  /** The escrow's credited balance for the retrofit preflight. Absent: no claim step can be built. */
  escrow?: EscrowCredits
  /** ERC-20 name/symbol for a retrofit subject. Absent: submit answers 503. */
  tokens?: TokenMetadata
  escalations: EscalationQueue
  outcomes: ProcurementOutcomes
  qf: QfReader
  vendors: VendorDirectory
  accounts: OperatedAccounts
}

const ok = (body: unknown): Response => ({ status: 200, body })
const WEEK = 7 * 86_400
/** Weekly reports a dev can page back through. */
const REPORT_WEEKS = 8
const MAX_ACK_NOTE_CHARS = 512
const QUOTE_TTL_SECONDS = 24 * 3_600

function unsignedTx(to: string, data: string, chainId: number, summary: string): Record<string, unknown> {
  return { to: normalizeAddress(to), data, value: '0', chainId, summary }
}

/** A consent as the client posts it back: every field validated, nothing coerced. */
function requireConsentBody(value: unknown): Consent {
  const body = requireObject(value, 'consent')
  assertExactKeys(
    body,
    ['devSigner', 'devPayout', 'token', 'termsHash', 'operatorBps', 'budgetBpsMax', 'adapter', 'referrer', 'referrerBps', 'expiryUnix', 'nonce'],
    'consent',
  )
  return {
    devSigner: requireAddressField(body, 'devSigner'),
    devPayout: requireAddressField(body, 'devPayout'),
    token: requireAddressField(body, 'token'),
    termsHash: requireBytes32Field(body, 'termsHash'),
    operatorBps: requireInteger(body, 'operatorBps', 0, 10_000),
    budgetBpsMax: requireInteger(body, 'budgetBpsMax', 0, 10_000),
    adapter: requireAddressField(body, 'adapter'),
    referrer: requireAddressField(body, 'referrer'),
    referrerBps: requireInteger(body, 'referrerBps', 0, 10_000),
    expiryUnix: requireInteger(body, 'expiryUnix', 1, 4_102_444_800),
    nonce: requireBytes32Field(body, 'nonce'),
  }
}

export function addV1Routes(router: Router, deps: V1Deps): void {
  const sources: CoinSources = {
    ...(deps.fleetVaults === undefined ? {} : { fleetVaults: deps.fleetVaults }),
    ...(deps.bindings === undefined ? {} : { bindings: deps.bindings }),
    qf: deps.qf,
    reporting: deps.reporting,
    ledger: deps.ledger,
    ledgerStore: deps.ledgerStore,
    accounts: deps.accounts,
    outcomes: deps.outcomes,
    now: deps.now,
  }
  const vendorsById = new Map(deps.vendors.all().map((vendor) => [vendor.id, vendor]))

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  router.add({
    method: 'GET',
    pattern: '/v1/protocol',
    summary: 'Deployment addresses, operator identity and the published terms. Public.',
    handler: () => {
      const terms = requireTerms()
      return ok({
        chainId: deps.factory.chainId,
        operatorLegalName: deps.protocol.operatorLegalName,
        operatorAddresses: deps.protocol.operatorAddresses,
        factory: deps.factory.factory,
        vaultDeployer: deps.factory.deployer,
        vaultInitCodeHash: deps.factory.vaultInitCodeHash,
        adapter: terms.adapter,
        termsUrl: terms.termsUrl,
        termsHash: terms.termsHash,
        operatorBps: TERMS.operatorBps,
        budgetBpsMaxOffered: TERMS.budgetBpsMax,
        receiptsBaseUrl: deps.protocol.receiptsBaseUrl,
      })
    },
  })

  router.add({
    method: 'GET',
    pattern: '/v1/coins',
    summary: 'The member directory: every coin with a vault, scrubbed. Public.',
    handler: async () => {
      const members = await memberRecords()
      const summaries: Record<string, unknown>[] = []
      for (const record of members) summaries.push(await coinSummaryBody(sources, record))
      return ok(summaries)
    },
  })

  router.add({
    method: 'GET',
    pattern: '/v1/coins/:vault',
    summary: 'The receipts artifact for one coin: fee flow, balances, tier, scrubbed subject. Public.',
    handler: async (ctx) => ok(await publicCoinBody(sources, await requireMember(requireVaultParam(ctx)))),
  })

  router.add({
    method: 'GET',
    pattern: '/v1/coins/:vault/receipts',
    summary: 'Published receipts with their delivery checks, newest first, ?cursor= paged. Public.',
    handler: async (ctx) => {
      const record = await requireMember(requireVaultParam(ctx))
      return ok(await receiptPageBody(deps.receipts, deps.outcomes, vendorsById, record.vault, ctx.query.cursor, deps.now()))
    },
  })

  router.add({
    method: 'GET',
    pattern: '/v1/coins/:vault/vendors',
    summary: 'Vendor scorecards for this coin: purchases, delivery checks, withheld cents. Measured. Public.',
    handler: async (ctx) => {
      const record = await requireMember(requireVaultParam(ctx))
      return ok(vendorScorecardsBody(deps.vendors.all(), await deps.outcomes.forVault(record.vault)))
    },
  })

  // -------------------------------------------------------------------------
  // Wallet auth
  // -------------------------------------------------------------------------

  router.add({
    method: 'POST',
    pattern: '/v1/auth/nonce',
    summary: `A single-use sign-in challenge for an address; ${String(CHALLENGE_TTL_SECONDS / 60)} minutes to sign it. Public.`,
    handler: async (ctx) => {
      const body = requireObject(ctx.body)
      assertExactKeys(body, ['address'])
      const challenge = await deps.auth.challenge(requireAddressField(body, 'address'))
      return ok({
        address: challenge.address,
        nonce: challenge.nonce,
        message: challenge.message,
        issuedAtUnix: challenge.issuedAtUnix,
        expiresAtUnix: challenge.expiresAtUnix,
      })
    },
  })

  router.add({
    method: 'POST',
    pattern: '/v1/auth/verify',
    summary: 'Exchange a personal_sign over the challenge for a session bearer. The nonce is consumed either way. Public.',
    handler: async (ctx) => {
      const body = requireObject(ctx.body)
      assertExactKeys(body, ['address', 'message', 'signature'])
      const outcome = await deps.auth.signIn({
        address: requireAddressField(body, 'address'),
        message: requireString(body, 'message', 2_048),
        signature: requireString(body, 'signature', 200),
      })
      if (!outcome.ok) throw new HttpError(401, outcome.reason, 'sign-in refused')
      const owned = await ownedRecords(outcome.session.address)
      return ok({
        token: outcome.token,
        address: outcome.session.address,
        expiresAtUnix: outcome.session.expiresAtUnix,
        vaults: owned.map((record) => record.vault),
      })
    },
  })

  // -------------------------------------------------------------------------
  // Dev dashboard: bearer session, own vaults only
  // -------------------------------------------------------------------------

  router.add({
    method: 'GET',
    pattern: '/v1/dev/vaults',
    summary: 'The signed-in dev’s coins. Dev session.',
    handler: async (ctx) => {
      const owned = await ownedRecords(requireDev(ctx))
      const summaries: Record<string, unknown>[] = []
      for (const record of owned) summaries.push(await coinSummaryBody(sources, record))
      return ok(summaries)
    },
  })

  router.add({
    method: 'GET',
    pattern: '/v1/dev/vaults/:vault',
    summary: 'The public record plus what only the dev acts on: claimable legs, the pending dial, the clocks. Dev session.',
    handler: async (ctx) => {
      const record = await requireOwned(ctx)
      const views = requireVaultViews()
      const [coin, dial, priced] = await Promise.all([
        publicCoinBody(sources, record),
        views.dial(record.vault),
        pricedAssetOf(sources, record.vault),
      ])
      const claimable: Record<string, unknown>[] = []
      if (priced !== undefined) {
        const legs = await views.legOf(record.vault, priced.asset.address)
        if (legs.dev > 0n) {
          claimable.push({
            asset: { address: priced.asset.address, symbol: priced.asset.symbol, decimals: priced.asset.decimals },
            devMinor: String(legs.dev),
            usd: usdWire(legs.dev, priced),
          })
        }
      }
      return ok({
        coin,
        devPayout: record.consent.devPayout,
        claimable,
        pendingDial:
          dial.pendingDialUnix === 0
            ? null
            : { pendingBudgetBps: dial.pendingBudgetBps, effectiveAtUnix: dial.pendingDialUnix },
        operatorNoticeUnix: dial.operatorNoticeUnix === 0 ? null : dial.operatorNoticeUnix,
        deadManUnix: dial.lastOperatorActionUnix === 0 ? null : dial.deadManUnix,
        lastHeartbeatUnix: dial.lastOperatorActionUnix === 0 ? null : dial.lastOperatorActionUnix,
      })
    },
  })

  router.add({
    method: 'GET',
    pattern: '/v1/dev/vaults/:vault/reports',
    summary: `The last ${String(REPORT_WEEKS)} weekly reports, newest first, with the fixed "what we did not do" section. Dev session.`,
    handler: async (ctx) => {
      const record = await requireOwned(ctx)
      const priced = await pricedAssetOf(sources, record.vault)
      if (priced === undefined) return ok([])
      if (priced.price === undefined) {
        throw serviceUnavailable('price_unavailable', 'no pinned price for the period; refusing to report')
      }
      const now = deps.now()
      const reports: Record<string, unknown>[] = []
      for (let week = 0; week < REPORT_WEEKS; week++) {
        const periodEndUnix = now - week * WEEK
        const periodStartUnix = periodEndUnix - WEEK
        const report = await buildWeeklyReport({
          vault: record.vault,
          asset: priced.asset,
          price: priced.price,
          ledger: deps.ledger,
          store: deps.ledgerStore,
          receipts: deps.receipts,
          periodStartUnix,
          periodEndUnix,
          refusals: await deps.reporting.refusalsFor(record.vault, periodStartUnix, periodEndUnix),
          paidMediaPermitted: await deps.reporting.paidMediaPermitted(record.vault),
          tier: await deps.reporting.tierFor(record.vault),
        })
        const lineItems: Record<string, unknown>[] = []
        for (const receipt of report.lineItems) {
          const outcome = receipt.disbursementId === undefined ? undefined : await deps.outcomes.forDisbursement(receipt.disbursementId)
          lineItems.push(receiptItemBody(receipt, outcome, vendorsById))
        }
        reports.push({
          vault: record.vault,
          periodStartUnix,
          periodEndUnix,
          qfReceivedCents: usdToCents(report.qfReceivedUsd),
          devLegCents: usdToCents(report.devLegUsd),
          budgetSpentCents: usdToCents(report.budgetSpentUsd),
          operatorFeeCents: usdToCents(report.operatorFeeUsd),
          lineItems,
          verifiedReachSummary: report.verifiedReachSummary,
          attributedNewBuyers: report.attributedNewBuyers ?? null,
          costPerAttributedBuyerCents:
            report.costPerAttributedBuyerUsd === undefined ? null : usdToCents(report.costPerAttributedBuyerUsd),
          withheldPayments: report.withheldPayments.map((withheld) => ({
            vendorId: withheld.vendorId,
            vendorName: vendorsById.get(withheld.vendorId)?.displayName ?? withheld.vendorId,
            amountCents: usdToCents(withheld.amountUsd),
            reason: withheld.reason,
          })),
          whatWeDidNotDo: report.whatWeDidNotDo,
        })
      }
      return ok(reports)
    },
  })

  router.add({
    method: 'GET',
    pattern: '/v1/dev/vaults/:vault/escalations',
    summary: 'Everything the desk escalated for this coin, newest first. Dev session.',
    handler: async (ctx) => {
      const record = await requireOwned(ctx)
      return ok((await deps.escalations.forVault(record.vault)).map(escalationBody))
    },
  })

  router.add({
    method: 'POST',
    pattern: '/v1/dev/vaults/:vault/escalations/:id/ack',
    summary: 'The dev’s decision on an escalation: acknowledged, action_taken or dismissed, with a note. Dev session.',
    handler: async (ctx) => {
      const address = requireDev(ctx)
      const record = await requireOwned(ctx)
      const body = requireObject(ctx.body)
      assertExactKeys(body, ['decision', 'note'])
      const decision = requireString(body, 'decision', 32)
      if (!(ACK_DECISIONS as readonly string[]).includes(decision)) {
        throw badRequest('bad_decision', `decision must be one of ${ACK_DECISIONS.join(', ')}`)
      }
      const id = ctx.params.id
      if (id === undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw badRequest('bad_id', 'escalation id required')
      const updated = await deps.escalations.acknowledge({
        id,
        vault: record.vault,
        decision: decision as AckDecision,
        note: requireString(body, 'note', MAX_ACK_NOTE_CHARS),
        by: address,
        atUnix: deps.now(),
      })
      if (updated === undefined) throw notFound('no_such_escalation', 'no such escalation for this vault')
      return ok(escalationBody(updated))
    },
  })

  router.add({
    method: 'POST',
    pattern: '/v1/dev/vaults/:vault/dial-tx',
    summary: 'The unsigned setDial(uint16) for the dev’s wallet. Raising is instant; lowering waits the notice. Dev session.',
    handler: async (ctx) => {
      const record = await requireOwned(ctx)
      const body = requireObject(ctx.body)
      assertExactKeys(body, ['budgetBps'])
      const budgetBps = requireInteger(body, 'budgetBps', 0, record.consent.budgetBpsMax)
      return ok(
        unsignedTx(
          record.vault,
          encodeSetDial(budgetBps),
          deps.factory.chainId,
          `Set the procurement dial on ${record.vault} to ${String(budgetBps)} bps (max ${String(record.consent.budgetBpsMax)}). ` +
            `Raising takes effect at once; lowering takes effect after ${String(TERMS.dialLowerNoticeDays)} days' notice.`,
        ),
      )
    },
  })

  router.add({
    method: 'GET',
    pattern: '/v1/dev/vaults/:vault/terminate-tx',
    summary: 'The unsigned terminate() for the dev’s wallet. onlyDev on chain; always succeeds. Dev session.',
    handler: async (ctx) => {
      const record = await requireOwned(ctx)
      return ok(
        unsignedTx(
          record.vault,
          encodeTerminate(),
          deps.factory.chainId,
          `Terminate service on ${record.vault}. Charging stops, the dev leg hands back to ${record.consent.devPayout}, and nothing here can undo it.`,
        ),
      )
    },
  })

  // -------------------------------------------------------------------------
  // Onboarding, as the web does it: quote, sign, submit, retrofit
  // -------------------------------------------------------------------------

  router.add({
    method: 'POST',
    pattern: '/v1/onboarding/quote',
    summary: 'A consent at the published rate, its predicted vault and the digest to sign. Stateless except for the dev’s notes. Public.',
    handler: async (ctx) => {
      const terms = requireTerms()
      const body = requireObject(ctx.body)
      assertExactKeys(body, ['devSigner', 'devPayout', 'token', 'budgetBpsMax', 'referrer', 'narrativeSources', 'socials'])
      const narrativeSources = requireNarrativeSources(body) ?? []
      const socials = requireSocials(body)
      const devSigner = requireAddressField(body, 'devSigner')
      const referrer = body.referrer === undefined ? undefined : requireAddressField(body, 'referrer')
      if (referrer !== undefined && referrer !== ZERO_ADDRESS && terms.referrerShareBps === undefined) {
        throw badRequest('referrals_unconfigured', 'this operator offers no referral share')
      }
      const now = deps.now()
      const nonce = `0x${randomBytes(32).toString('hex')}`
      let consent: Consent
      try {
        consent = draftConsent({
          devSigner,
          devPayout: requireAddressField(body, 'devPayout'),
          token: requireAddressField(body, 'token'),
          termsHash: terms.termsHash,
          adapter: terms.adapter,
          ...(referrer === undefined || referrer === ZERO_ADDRESS
            ? {}
            : { referrer, referrerBps: terms.referrerShareBps ?? 0 }),
          budgetBpsMax: requireInteger(body, 'budgetBpsMax', 0, 10_000),
          nonce,
          nowUnix: now,
        })
      } catch (error) {
        if (error instanceof ConsentError) throw badRequest(`bad_${error.field}`, error.message)
        throw error
      }
      await deps.quotes.put({
        nonce,
        devSigner,
        narrativeSources,
        ...(socials === undefined ? {} : { socials }),
        issuedAtUnix: now,
        expiresAtUnix: now + QUOTE_TTL_SECONDS,
      })
      return ok({
        consent,
        predictedVault: predictedVaultOf(consent),
        salt: consentSalt(consent),
        digest: consentDigest(consent, deps.domain),
        termsUrl: terms.termsUrl,
      })
    },
  })

  router.add({
    method: 'POST',
    pattern: '/v1/onboarding/submit',
    summary: 'A signed consent. Verified, screened, recorded as signed; returns the factory deploy call for the dev’s wallet. Public.',
    handler: async (ctx) => {
      const body = requireObject(ctx.body)
      assertExactKeys(body, ['consent', 'signature'])
      const consent = requireConsentBody(body.consent)
      const signature = requireString(body, 'signature', 200)
      try {
        assertCommercialTerms(consent)
      } catch (error) {
        if (error instanceof ConsentError) throw badRequest(`bad_${error.field}`, error.message)
        throw error
      }
      const now = deps.now()
      const verification = verifyConsent(consent, signature, deps.domain, now)
      if (!verification.ok) throw new HttpError(401, 'signature_invalid', verification.reason)
      if (consent.token === ZERO_ADDRESS) {
        throw new HttpError(
          501,
          'not_supported',
          'a greenfield consent (token 0x0) is not submittable here: the vault binds to a launched token, so launch first and submit the retrofit consent',
        )
      }
      const vault = predictedVaultOf(consent)
      const existing = await deps.onboarding.store.byToken(consent.token)
      if (existing !== undefined && existing.state !== 'declined' && existing.state !== 'withdrawn') {
        if (existing.consent.nonce !== consent.nonce) {
          throw new HttpError(409, 'token_already_onboarding', 'this token already has an onboarding in progress')
        }
        return ok(deploymentTicket(existing, signature, existing.signatureVerifiedAtUnix ?? now))
      }

      const tokens = deps.tokens
      if (tokens === undefined) throw serviceUnavailable('chain_unwired', 'this process cannot describe the token')
      let subject: { name: string; symbol: string }
      try {
        subject = await tokens.describe(consent.token)
      } catch (error) {
        throw new HttpError(409, 'token_unreadable', error instanceof Error ? error.message : String(error))
      }
      // SCREENING FIRST, over the strings the token contract itself reports.
      const report = await deps.screening.screen({
        token: consent.token,
        name: subject.name,
        symbol: subject.symbol,
        metadataMutable: false,
        observedAtUnix: now,
      })
      if (report.verdict === 'BLOCKED') {
        return {
          status: 409,
          body: {
            error: 'screening_blocked',
            code: report.flags.map((f) => f.code).slice(0, 1),
            message: 'we cannot serve this coin',
            devKeepsAllFees: true,
          },
        }
      }
      const extras = await deps.quotes.get(consent.nonce)
      const id = `web_${consent.nonce.slice(2, 26)}`
      try {
        await deps.onboarding.draft({
          id,
          consent,
          coinRef: `web_${vault.slice(2)}`,
          token: consent.token,
          name: subject.name,
          symbol: subject.symbol,
          ...(extras === undefined || extras.narrativeSources.length === 0 ? {} : { narrativeSources: extras.narrativeSources }),
          ...(extras?.socials === undefined ? {} : { socials: extras.socials }),
        })
        const record = await deps.onboarding.submitSignature(id, signature)
        return ok(deploymentTicket(record, signature, now))
      } catch (error) {
        if (error instanceof OnboardingError) throw new HttpError(409, error.code, error.message)
        if (error instanceof ConsentError) throw badRequest(`bad_${error.field}`, error.message)
        throw error
      }
    },
  })

  router.add({
    method: 'GET',
    pattern: '/v1/onboarding/retrofit/:token',
    summary: 'The recipiency transfer for an onboarded token, with the strandable-credit preflight and the claims to zero. Public.',
    handler: async (ctx) => {
      const raw = ctx.params.token
      if (raw === undefined || !isAddress(raw)) throw badRequest('bad_token', 'token must be a 0x address')
      const token = normalizeAddress(raw)
      const vaultQuery = ctx.query.vault
      if (vaultQuery === undefined || !isAddress(vaultQuery)) throw badRequest('bad_vault', 'vault must be a 0x address')
      const vault = normalizeAddress(vaultQuery)
      const record = await deps.onboarding.store.byToken(token)
      if (record === undefined || record.state === 'declined' || record.state === 'withdrawn') {
        throw notFound('no_such_onboarding', 'no onboarding for this token')
      }
      if (record.vault !== vault) throw new HttpError(409, 'vault_mismatch', 'that vault is not the one this token consented to')

      let currentRecipient: Address
      try {
        currentRecipient = normalizeAddress(await deps.recipients.creatorFeeRecipient(token))
      } catch (error) {
        if (error instanceof RecipientReadError) throw new HttpError(409, error.code, error.message)
        throw serviceUnavailable('chain_unavailable', 'the current fee recipient could not be read')
      }

      const chainId = deps.factory.chainId
      const strandableCredits: Record<string, unknown>[] = []
      const claimTxs: Record<string, unknown>[] = []
      const priced = await pricedAssetOf(sources, vault)
      if (priced !== undefined && deps.escrow !== undefined && currentRecipient !== vault) {
        const credited = await deps.escrow.credits(currentRecipient, priced.asset.address)
        if (credited > 0n) {
          strandableCredits.push({
            asset: { address: priced.asset.address, symbol: priced.asset.symbol, decimals: priced.asset.decimals },
            amountMinor: String(credited),
            usd: usdWire(credited, priced),
          })
          claimTxs.push(
            unsignedTx(
              VENUE.contracts.v2FeeEscrow,
              encodeEscrowClaim(priced.asset.address, credited),
              chainId,
              `Claim your credited ${priced.asset.symbol} (${centsOf(credited, priced)} cents) to zero. The escrow is msg.sender-only: ` +
                'nobody, including us, can claim it for you after recipiency moves.',
            ),
          )
        }
      }
      return ok({
        token,
        vault,
        transferTx: unsignedTx(
          VENUE.contracts.v2Factory,
          encodeTransferCreatorFeeRecipient(token, vault),
          chainId,
          `Point this token's creator fees at ${vault}. Send this LAST.`,
        ),
        registry: normalizeAddress(VENUE.contracts.v2Factory),
        currentRecipient,
        strandableCredits,
        claimTxs,
        sweepTx: null,
      })
    },
  })

  // -------------------------------------------------------------------------

  function requireTerms(): ProtocolTerms {
    if (deps.protocol.terms === undefined) {
      throw serviceUnavailable('terms_unconfigured', 'VENUE_ADAPTER, VENUE_TERMS_HASH and VENUE_TERMS_URL are not set')
    }
    return deps.protocol.terms
  }

  function requireVaultViews(): VaultViews {
    if (deps.vaultViews === undefined) throw serviceUnavailable('chain_unwired', 'this process cannot read the vault')
    return deps.vaultViews
  }

  function predictedVaultOf(consent: Consent): Address {
    return predictVault(consent, deps.factory)
  }

  function deploymentTicket(record: OnboardingRecord, signature: string, submittedAtUnix: number): Record<string, unknown> {
    return {
      vault: record.vault,
      tx: unsignedTx(
        deps.factory.factory,
        encodeFactoryDeploy(record.consent, signature),
        deps.factory.chainId,
        `Deploy the vault at ${record.vault} on the terms you signed. Optional: the operator deploys it after diligence; sending it yourself only moves that step earlier.`,
      ),
      submittedAtUnix,
    }
  }

  async function memberRecords(): Promise<OnboardingRecord[]> {
    return (await deps.onboarding.store.list()).filter((record) => MEMBER_STATES[record.state] === true)
  }

  async function requireMember(vault: Address): Promise<OnboardingRecord> {
    const record = (await memberRecords()).find((r) => r.vault === vault)
    if (record === undefined) throw notFound('no_such_vault', 'no such vault')
    return record
  }

  async function ownedRecords(address: Address): Promise<OnboardingRecord[]> {
    return (await memberRecords()).filter((record) => record.consent.devSigner === normalizeAddress(address))
  }

  function requireDev(ctx: RequestContext): Address {
    const principal = ctx.principal
    if (principal === undefined || principal.kind !== 'dev') throw new HttpError(401, 'unauthorized', 'dev session required')
    return normalizeAddress(principal.address)
  }

  /** The vault in the path, and only if the signed-in dev's consent created it. Not theirs reads as absent. */
  async function requireOwned(ctx: RequestContext): Promise<OnboardingRecord> {
    const address = requireDev(ctx)
    const vault = requireVaultParam(ctx)
    const record = (await ownedRecords(address)).find((r) => r.vault === vault)
    if (record === undefined) throw notFound('no_such_vault', 'no such vault')
    return record
  }

  function requireVaultParam(ctx: RequestContext): Address {
    const raw = ctx.params.vault
    if (raw === undefined || !isAddress(raw)) throw badRequest('bad_vault', 'vault must be a 0x address')
    return normalizeAddress(raw)
  }
}

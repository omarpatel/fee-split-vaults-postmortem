/**
 * THE ROUTE MAP. This file is the service's whole attack surface, deliberately
 * on one screen.
 *
 * EVERY INBOUND PATH GOES THROUGH TWO GATES.
 *
 *   SCREENING. Onboarding carries attacker-authored strings - a coin name, a
 *   symbol, a description, links - and those strings are the input to a content
 *   decision that has legal consequences. They go to ScreeningEngine before
 *   anything else looks at them, and a BLOCKED verdict ends the onboarding
 *   before a vault exists, so a declined coin is never charged.
 *
 *   THE AIRLOCK. Nothing a client posts is ever echoed back raw, and nothing a
 *   client posts can become a destination. Free text that leaves this service
 *   passes scrubGist() and assertNoDestination() first. This service holds no
 *   model, so there is no planner to protect - the airlock discipline here is
 *   about what leaves, not what a model reads.
 *
 * WHAT THIS SERVICE CANNOT DO, BY CONSTRUCTION: it holds no dev key, no
 * operator key, and no spending tool. It verifies a signature the dev produced;
 * it asks a signer it cannot reach to deploy; it reads the chain to confirm
 * pointing. The one authority it holds is the authority to REFUSE.
 */

import type { Address } from '@fee-split-vaults/core'
import {
  ScreeningEngine,
  assertOnboardingAdmitted,
  runFraudDiligence,
  toScreeningResult,
  type DiligenceDeps,
  type SubjectMetadata,
} from '@fee-split-vaults/screening'
import type { Ledger, LedgerStore } from '@fee-split-vaults/ledger'
import { AgentRunQueryError, type PinnedUsdPrice, type ReceiptStore } from '@fee-split-vaults/orchestrator'

import { isAddress, normalizeAddress } from './crypto/address.js'
import {
  agentBody,
  agentRolesBody,
  agentRunsBody,
  type AgentPort,
} from './agent.js'
import { draftConsent, summariseConsent } from './consent.js'
import { safeEcho } from './echo.js'
import { signingPayload, verifyConsent, type Eip712Domain } from './eip712.js'
import { predictVault, type FactoryDescriptor } from './deploy.js'
import { requireAddressField, requireBytes32Field, requireNarrativeSources, requireSocials } from './fields.js'
import { ONBOARDING_STATES, Onboarding, type OnboardingRecord, type OnboardingState } from './onboarding.js'
import { KybAttestationError, assertAttestationShape, type KybAttestation, type KybAttestationStore } from './diligence/kyb.js'
import { addPromotionRoutes, type PromotionDeps } from './promotion.js'
import { buildWeeklyReport, type RefusalRecord, type ReportAsset } from './report.js'
import { addV1Routes, type V1Deps } from './v1/routes.js'
import type { AuthScope } from './http/server.js'
import {
  assertExactKeys,
  optionalString,
  requireInteger,
  requireObject,
  requireString,
  requireStringArray,
} from './http/json.js'
import {
  Router,
  badRequest,
  notFound,
  type RequestContext,
  type Response,
} from './http/router.js'

export interface RouteDeps extends Pick<PromotionDeps, 'narrative' | 'accounts' | 'purchases' | 'creative'> {
  onboarding: Onboarding
  screening: ScreeningEngine
  diligence: DiligenceDeps
  factory: FactoryDescriptor
  domain: Eip712Domain
  ledger: Ledger
  ledgerStore: LedgerStore
  receipts: ReceiptStore
  /** Resolves the quote asset and pinned price for a vault's report. */
  reporting: {
    assetFor(vault: Address): Promise<ReportAsset | undefined>
    priceFor(asset: string, atUnix: number): Promise<PinnedUsdPrice | undefined>
    refusalsFor(vault: Address, fromUnix: number, toUnix: number): Promise<RefusalRecord[]>
    tierFor(vault: Address): Promise<string>
    paidMediaPermitted(vault: Address): Promise<boolean>
  }
  /**
   * The per-coin agent team: its roles, its tick history, its model spend.
   *
   * A port rather than a fleet handle, because this service must never be able
   * to make a coin tick. It reads what the fleet already recorded and holds no
   * way to run one.
   */
  agent: AgentPort
  /** Where operator identity attestations are recorded and read by the diligence gate. */
  kyb: KybAttestationStore
  screeningMaxAgeSeconds: number
  now: () => number
  /** The web contract's /v1 group. See v1/routes.ts. */
  v1: V1Deps
}

const MAX_DESCRIPTION_CHARS = 4_000
const MAX_SYMBOL_CHARS = 32
const MAX_NAME_CHARS = 128

/**
 * THE AUTH POLICY. Every path is classified before the router sees it.
 *
 *   public   - the receipts artifact, the agent page, the wallet challenge,
 *              and the onboarding quote/submit/retrofit the dev's own
 *              signature authenticates. Nothing here needs a credential.
 *   dev      - the dashboard: a session bearer from /v1/auth/verify.
 *   operator - everything else, including anything unlisted.
 */
const PUBLIC_EXACT: Readonly<Record<string, true>> = {
  '/health': true,
  // The OAuth callback arrives as a browser redirect from X and cannot carry
  // the operator bearer; the single-use `state` authenticates it instead.
  '/accounts/x/callback': true,
  '/v1/protocol': true,
  '/v1/coins': true,
  '/v1/auth/nonce': true,
  '/v1/auth/verify': true,
  '/v1/onboarding/quote': true,
  '/v1/onboarding/submit': true,
}
const PUBLIC_PATTERNS: readonly RegExp[] = [
  /^\/v1\/coins\/[^/]+(?:\/receipts|\/vendors)?$/,
  /^\/coins\/[^/]+\/agent(?:\/runs|\/roles)?$/,
  /^\/v1\/onboarding\/retrofit\/[^/]+$/,
]

export function authScopeOf(path: string): AuthScope {
  if (PUBLIC_EXACT[path] === true || PUBLIC_PATTERNS.some((pattern) => pattern.test(path))) return 'public'
  if (path.startsWith('/v1/dev/')) return 'dev'
  return 'operator'
}

/**
 * What anybody with the record id may see. The subject strings are scrubbed
 * (safeEcho) because they are dev-authored; the links and narrative sources
 * are destinations and are counted, not listed; socials never appear.
 */
function publicRecord(record: OnboardingRecord): Record<string, unknown> {
  return {
    id: record.id,
    state: record.state,
    vault: record.vault,
    token: record.token,
    coinRef: record.coinRef,
    createdAtUnix: record.createdAtUnix,
    updatedAtUnix: record.updatedAtUnix,
    subject: {
      name: safeEcho(record.name, 'name'),
      symbol: safeEcho(record.symbol, 'symbol'),
      linkCount: record.links.length,
      narrativeSourceCount: record.narrativeSources.length,
    },
    consent: record.consent,
    screening:
      record.screening === undefined
        ? undefined
        : {
            verdict: record.screening.verdict,
            paidMediaPermitted: record.screening.paidMediaPermitted,
            flags: record.screening.flags,
            screenedAtUnix: record.screening.screenedAtUnix,
          },
    diligence:
      record.diligence === undefined
        ? undefined
        : {
            admitted: record.diligence.admitted,
            blockers: record.diligence.blockers,
            retryable: record.diligence.retryable,
          },
    deployedAtUnix: record.deployedAtUnix,
    pointedAtUnix: record.pointedAtUnix,
    activatedAtUnix: record.activatedAtUnix,
    declineReason: record.declineReason,
    narrativeApproved: record.narrative !== undefined,
    history: record.history,
  }
}

const ok = (body: unknown): Response => ({ status: 200, body })
const created = (body: unknown): Response => ({ status: 201, body })

export function buildRouter(deps: RouteDeps): Router {
  const router = new Router()

  router.add({
    method: 'GET',
    pattern: '/health',
    summary: 'Liveness. Says nothing about whether the chain or the ledger is healthy.',
    handler: () => ok({ status: 'ok', atUnix: deps.now() }),
  })

  router.add({
    method: 'GET',
    pattern: '/routes',
    summary: 'This route map.',
    handler: () => ok({ routes: router.routes.map((r) => `${r.method} ${r.pattern} - ${r.summary}`) }),
  })

  // -------------------------------------------------------------------------
  // Consent
  // -------------------------------------------------------------------------

  router.add({
    method: 'POST',
    pattern: '/consent/draft',
    summary: 'Draft a consent at the PUBLISHED rate and return the exact EIP-712 payload to sign.',
    handler: (ctx: RequestContext) => {
      const body = requireObject(ctx.body)
      assertExactKeys(body, [
        'devSigner',
        'devPayout',
        'token',
        'termsHash',
        'adapter',
        'referrer',
        'referrerBps',
        'budgetBpsMax',
        'ttlSeconds',
        'nonce',
      ])
      const consent = draftConsent({
        devSigner: requireAddressField(body, 'devSigner'),
        devPayout: requireAddressField(body, 'devPayout'),
        ...(body.token === undefined ? {} : { token: requireAddressField(body, 'token') }),
        termsHash: requireBytes32Field(body, 'termsHash'),
        adapter: requireAddressField(body, 'adapter'),
        ...(body.referrer === undefined ? {} : { referrer: requireAddressField(body, 'referrer') }),
        ...(body.referrerBps === undefined
          ? {}
          : { referrerBps: requireInteger(body, 'referrerBps', 0, 10_000) }),
        ...(body.budgetBpsMax === undefined
          ? {}
          : { budgetBpsMax: requireInteger(body, 'budgetBpsMax', 0, 10_000) }),
        ...(body.ttlSeconds === undefined
          ? {}
          : { ttlSeconds: requireInteger(body, 'ttlSeconds', 1, 7 * 24 * 3_600) }),
        nonce: requireBytes32Field(body, 'nonce'),
        nowUnix: deps.now(),
      })
      const vault = predictVault(consent, deps.factory)
      return created({
        consent,
        vault,
        summary: summariseConsent(consent, vault),
        sign: signingPayload(consent, deps.domain),
      })
    },
  })

  router.add({
    method: 'POST',
    pattern: '/consent/verify',
    summary: 'Verify a dev signature over a consent without starting an onboarding.',
    handler: (ctx: RequestContext) => {
      const body = requireObject(ctx.body)
      assertExactKeys(body, ['consent', 'signature'])
      const consent = requireObject(body.consent, 'consent')
      const signature = requireString(body, 'signature', 200)
      const verification = verifyConsent(
        consent as unknown as Parameters<typeof verifyConsent>[0],
        signature,
        deps.domain,
        deps.now(),
      )
      return ok(verification)
    },
  })

  // -------------------------------------------------------------------------
  // Onboarding: the dual-consent machine
  // -------------------------------------------------------------------------

  router.add({
    method: 'POST',
    pattern: '/onboarding',
    summary: 'Screen the coin, then draft the consent. A BLOCKED verdict stops here.',
    handler: async (ctx: RequestContext) => {
      const body = requireObject(ctx.body)
      assertExactKeys(body, [
        'id',
        'coinRef',
        'token',
        'name',
        'symbol',
        'description',
        'links',
        'metadataMutable',
        'narrativeSources',
        'socials',
        'devSigner',
        'devPayout',
        'termsHash',
        'adapter',
        'nonce',
        'budgetBpsMax',
      ])
      const narrativeSources = requireNarrativeSources(body)
      const socials = requireSocials(body)

      const token = requireAddressField(body, 'token')
      const coinRef = requireString(body, 'coinRef', 96)
      if (!/^[A-Za-z0-9_-]+$/.test(coinRef)) {
        throw badRequest('bad_coin_ref', 'coinRef must be opaque: [A-Za-z0-9_-] only')
      }

      // SCREENING FIRST. Every string below is attacker-authored and this is
      // the only place they are allowed to be read at full fidelity.
      const metadata: SubjectMetadata = {
        token,
        name: requireString(body, 'name', MAX_NAME_CHARS),
        symbol: requireString(body, 'symbol', MAX_SYMBOL_CHARS),
        ...(body.description === undefined
          ? {}
          : { description: requireString(body, 'description', MAX_DESCRIPTION_CHARS) }),
        ...(body.links === undefined ? {} : { links: requireStringArray(body, 'links', 16, 512) }),
        metadataMutable: body.metadataMutable === true,
        observedAtUnix: deps.now(),
      }

      const report = await deps.screening.screen(metadata)
      if (report.verdict === 'BLOCKED') {
        return {
          status: 409,
          body: {
            error: 'screening_blocked',
            // A coarse public code only. The detailed flags are operator-facing:
            // publishing the exact matcher that fired is an evasion guide.
            code: report.flags.map((f) => f.code).slice(0, 1),
            message: 'we cannot serve this coin',
            devKeepsAllFees: true,
          },
        }
      }

      const consent = draftConsent({
        devSigner: requireAddressField(body, 'devSigner'),
        devPayout: requireAddressField(body, 'devPayout'),
        token,
        termsHash: requireBytes32Field(body, 'termsHash'),
        adapter: requireAddressField(body, 'adapter'),
        ...(body.budgetBpsMax === undefined
          ? {}
          : { budgetBpsMax: requireInteger(body, 'budgetBpsMax', 0, 10_000) }),
        nonce: requireBytes32Field(body, 'nonce'),
        nowUnix: deps.now(),
      })

      const record = await deps.onboarding.draft({
        id: requireString(body, 'id', 64),
        consent,
        coinRef,
        token,
        name: metadata.name,
        symbol: metadata.symbol,
        ...(metadata.description === undefined ? {} : { description: metadata.description }),
        ...(metadata.links === undefined ? {} : { links: metadata.links }),
        ...(narrativeSources === undefined ? {} : { narrativeSources }),
        ...(socials === undefined ? {} : { socials }),
      })

      return created({
        onboarding: publicRecord(record),
        // Echoed back scrubbed, so an address hidden in a coin name cannot ride
        // the response into an operator console.
        subject: {
          name: safeEcho(metadata.name, 'name'),
          symbol: safeEcho(metadata.symbol, 'symbol'),
        },
        screening: { verdict: report.verdict, paidMediaPermitted: report.paidMediaPermitted },
        sign: signingPayload(consent, deps.domain),
        summary: summariseConsent(consent, record.vault),
      })
    },
  })

  router.add({
    method: 'GET',
    pattern: '/onboarding/:id',
    summary: 'Read one onboarding, including every refusal in its history.',
    handler: async (ctx: RequestContext) => {
      const record = await requireRecord(ctx)
      return ok({ onboarding: publicRecord(record) })
    },
  })

  router.add({
    method: 'GET',
    pattern: '/onboarding',
    summary: 'Every onboarding, newest activity first. ?state= narrows to one state.',
    handler: async (ctx: RequestContext) => {
      const state = ctx.query.state
      if (state !== undefined && !(ONBOARDING_STATES as readonly string[]).includes(state)) {
        throw badRequest('bad_state', `state must be one of ${ONBOARDING_STATES.join(', ')}`)
      }
      const records = (await deps.onboarding.store.list())
        .filter((record) => state === undefined || record.state === (state as OnboardingState))
        .sort((a, b) => b.updatedAtUnix - a.updatedAtUnix || (a.id < b.id ? -1 : 1))
      return ok({ onboardings: records.map(publicRecord) })
    },
  })

  router.add({
    method: 'POST',
    pattern: '/onboarding/:id/signature',
    summary: 'CONSENT 1 of 3: the dev signs. Verified here; the service never signs for them.',
    handler: async (ctx: RequestContext) => {
      const body = requireObject(ctx.body)
      assertExactKeys(body, ['signature'])
      const record = await deps.onboarding.submitSignature(
        requireId(ctx),
        requireString(body, 'signature', 200),
      )
      return ok({ onboarding: publicRecord(record) })
    },
  })

  router.add({
    method: 'POST',
    pattern: '/onboarding/:id/diligence',
    summary: 'Fraud diligence plus a re-screen. Both must pass before a vault is deployed.',
    handler: async (ctx: RequestContext) => {
      const id = requireId(ctx)
      const record = await requireRecordById(id)
      const now = deps.now()

      // The verdict recorded here is the one the runner reads from
      // screening_result, so it is taken over the subject as the dev
      // described it - the same strings the first screen saw - not over the
      // opaque coinRef, which would clear anything.
      const report = await deps.screening.screen({
        token: record.token,
        name: record.name,
        symbol: record.symbol,
        ...(record.description === undefined ? {} : { description: record.description }),
        ...(record.links.length === 0 ? {} : { links: record.links }),
        metadataMutable: false,
        observedAtUnix: now,
      })
      const diligence = await runFraudDiligence(
        record.token,
        record.consent.devSigner,
        deps.diligence,
        now,
      )
      const updated = await deps.onboarding.recordScreening(
        id,
        report,
        diligence,
        toScreeningResult,
      )
      if (updated.state !== 'declined') assertOnboardingAdmitted(diligence)
      return ok({ onboarding: publicRecord(updated) })
    },
  })

  router.add({
    method: 'POST',
    pattern: '/onboarding/:id/deploy',
    summary: 'Deploy the vault at the address the consent already fixed. CREATE2, no admin key.',
    handler: async (ctx: RequestContext) => {
      const record = await deps.onboarding.deploy(requireId(ctx))
      return ok({ onboarding: publicRecord(record) })
    },
  })

  router.add({
    method: 'POST',
    pattern: '/onboarding/:id/pointing',
    summary: 'CONSENT 2 of 3: the dev points fee recipiency at the vault. Confirmed on chain.',
    handler: async (ctx: RequestContext) => {
      const record = await deps.onboarding.confirmPointing(requireId(ctx))
      return ok({ onboarding: publicRecord(record) })
    },
  })

  router.add({
    method: 'POST',
    pattern: '/onboarding/:id/acceptance',
    summary: 'The dev called acceptService() on their own vault. Confirmed by reading the vault state, not from a body.',
    handler: async (ctx: RequestContext) => {
      if (ctx.body !== undefined && ctx.body !== null) assertExactKeys(requireObject(ctx.body), [])
      const record = await deps.onboarding.recordAcceptance(requireId(ctx))
      return ok({ onboarding: publicRecord(record) })
    },
  })

  router.add({
    method: 'POST',
    pattern: '/onboarding/:id/activate',
    summary: 'CONSENT 3 of 3: OUR affirmative activation. Charging starts here and nowhere else.',
    handler: async (ctx: RequestContext) => {
      const record = await deps.onboarding.activate(requireId(ctx), {
        screeningMaxAgeSeconds: deps.screeningMaxAgeSeconds,
      })
      return ok({ onboarding: publicRecord(record) })
    },
  })

  router.add({
    method: 'POST',
    pattern: '/onboarding/:id/decline',
    summary: 'The operator declining. Terminal, and the dev keeps every fee.',
    handler: async (ctx: RequestContext) => {
      const body = requireObject(ctx.body)
      assertExactKeys(body, ['code', 'detail'])
      const record = await deps.onboarding.decline(
        requireId(ctx),
        requireString(body, 'code', 64),
        optionalString(body, 'detail', 512),
      )
      return ok({ onboarding: publicRecord(record), devKeepsAllFees: true })
    },
  })

  // -------------------------------------------------------------------------
  // Dev identity attestation
  //
  // No KYB vendor is in the loop. An operator who performed the check outside
  // records that they did, with a handle into the provider's file and an
  // expiry. The diligence gate reads the latest unexpired attestation.
  // -------------------------------------------------------------------------

  router.add({
    method: 'POST',
    pattern: '/diligence/kyb/attest',
    summary: 'Record that a named operator verified the dev signer’s identity outside, with a provider handle and an expiry.',
    handler: async (ctx: RequestContext) => {
      const body = requireObject(ctx.body)
      assertExactKeys(body, ['devSigner', 'attestedBy', 'providerRef', 'attestedAtUnix', 'expiresAtUnix'])
      const now = deps.now()
      const attestation: KybAttestation = {
        devSigner: requireAddressField(body, 'devSigner'),
        attestedBy: requireString(body, 'attestedBy', 128),
        providerRef: requireString(body, 'providerRef', 256),
        attestedAtUnix: body.attestedAtUnix === undefined ? now : requireInteger(body, 'attestedAtUnix', 1, 4_102_444_800),
        expiresAtUnix: requireInteger(body, 'expiresAtUnix', 1, 4_102_444_800),
      }
      try {
        assertAttestationShape(attestation, now)
      } catch (error) {
        if (error instanceof KybAttestationError) throw badRequest(error.code, error.message)
        throw error
      }
      await deps.kyb.put(attestation)
      return created({ attestation })
    },
  })

  router.add({
    method: 'GET',
    pattern: '/diligence/kyb/:devSigner',
    summary: 'The latest identity attestation on file for a dev signer, and whether it is still current.',
    handler: async (ctx: RequestContext) => {
      const raw = ctx.params.devSigner
      if (raw === undefined || !isAddress(raw)) throw badRequest('bad_dev_signer', 'devSigner must be a 0x address')
      const attestation = await deps.kyb.latest(normalizeAddress(raw))
      if (attestation === undefined) throw notFound('no_attestation', 'no identity attestation on file')
      return ok({ attestation, current: attestation.expiresAtUnix > deps.now() })
    },
  })

  // -------------------------------------------------------------------------
  // Receipts and the weekly report
  // -------------------------------------------------------------------------

  router.add({
    method: 'GET',
    pattern: '/vaults/:vault/receipts',
    summary: 'Published receipts. Unexecuted commitments are withheld for 72h, not hidden.',
    handler: async (ctx: RequestContext) => {
      const vault = requireVaultParam(ctx)
      const now = deps.now()
      const receipts = await deps.receipts.list(vault, {
        ...(ctx.query.from === undefined ? {} : { fromUnix: Number(ctx.query.from) }),
        ...(ctx.query.to === undefined ? {} : { toUnix: Number(ctx.query.to) }),
        publishedOnly: true,
        nowUnix: now,
      })
      return ok({ vault, atUnix: now, receipts })
    },
  })

  router.add({
    method: 'GET',
    pattern: '/vaults/:vault/receipts/:id',
    summary: 'One receipt, only once its publication lag has elapsed.',
    handler: async (ctx: RequestContext) => {
      const vault = requireVaultParam(ctx)
      const id = ctx.params.id
      if (id === undefined) throw badRequest('bad_id', 'receipt id required')
      const receipt = await deps.receipts.get(id)
      if (receipt === undefined || normalizeAddress(receipt.vault) !== vault) {
        throw notFound('no_such_receipt', 'no such receipt')
      }
      if (deps.now() < receipt.publishAfterUnix) {
        throw notFound('receipt_not_yet_published', 'no such receipt')
      }
      return ok({ receipt })
    },
  })

  router.add({
    method: 'GET',
    pattern: '/vaults/:vault/report',
    summary: 'The weekly report, including the fixed section on what we did NOT do.',
    handler: async (ctx: RequestContext) => {
      const vault = requireVaultParam(ctx)
      const now = deps.now()
      const periodEndUnix = ctx.query.to === undefined ? now : Number(ctx.query.to)
      const periodStartUnix =
        ctx.query.from === undefined ? periodEndUnix - 7 * 86_400 : Number(ctx.query.from)
      if (!Number.isFinite(periodStartUnix) || !Number.isFinite(periodEndUnix)) {
        throw badRequest('bad_period', 'from and to must be unix seconds')
      }
      if (periodEndUnix <= periodStartUnix) {
        throw badRequest('bad_period', 'to must be after from')
      }

      const asset = await deps.reporting.assetFor(vault)
      if (asset === undefined) throw notFound('no_such_vault', 'no such vault')
      const price = await deps.reporting.priceFor(asset.address, periodEndUnix)
      if (price === undefined) {
        // A report is a money document. Without a pinned price there is no
        // honest USD figure, so it refuses rather than printing a guess.
        throw badRequest('price_unavailable', 'no pinned price for the period; refusing to report')
      }

      const report = await buildWeeklyReport({
        vault,
        asset,
        price,
        ledger: deps.ledger,
        store: deps.ledgerStore,
        receipts: deps.receipts,
        periodStartUnix,
        periodEndUnix,
        refusals: await deps.reporting.refusalsFor(vault, periodStartUnix, periodEndUnix),
        paidMediaPermitted: await deps.reporting.paidMediaPermitted(vault),
        tier: await deps.reporting.tierFor(vault),
      })
      return ok({ report })
    },
  })

  // -------------------------------------------------------------------------
  // The agent team
  //
  // Read-only, and deliberately shaped so that a coin's page can show WHO is
  // working for it and WHAT THEY WERE NOT ALLOWED TO DO. The refusals are the
  // product surface here, not an error path, so they are always present in the
  // body even when empty.
  // -------------------------------------------------------------------------

  router.add({
    method: 'GET',
    pattern: '/coins/:vault/agent',
    summary: 'The six roles, which are awake at this tier, the last tick, and model spend today.',
    handler: async (ctx: RequestContext) => {
      const vault = requireVaultParam(ctx)
      return ok({ vault, atUnix: deps.now(), agent: agentBody(await requireSnapshot(vault)) })
    },
  })

  router.add({
    method: 'GET',
    pattern: '/coins/:vault/agent/runs',
    summary: 'Per-tick history: digest counters, proposals, suppressions, refusals, cost.',
    handler: async (ctx: RequestContext) => {
      const vault = requireVaultParam(ctx)
      // The snapshot is fetched even though only its faked-dependency list is
      // used: a page of runs that did not say the model was a fake would be
      // presenting scripted output as a model's.
      const snapshot = await requireSnapshot(vault)
      try {
        const page = await deps.agent.runs.list(vault, {
          ...(ctx.query.cursor === undefined ? {} : { cursor: ctx.query.cursor }),
          ...(ctx.query.limit === undefined ? {} : { limit: requireLimit(ctx.query.limit) }),
        })
        return ok(agentRunsBody(vault, page, snapshot, deps.now()))
      } catch (error) {
        // A bad cursor is the caller's mistake, not ours, and it must not fall
        // back to page one: a paginator that silently restarts loops forever.
        if (error instanceof AgentRunQueryError) throw badRequest(error.code, error.message)
        throw error
      }
    },
  })

  router.add({
    method: 'GET',
    pattern: '/coins/:vault/agent/roles',
    summary: 'What each of the six roles may and may not do at this vault’s tier.',
    handler: async (ctx: RequestContext) => {
      const vault = requireVaultParam(ctx)
      return ok(agentRolesBody(await requireSnapshot(vault)))
    },
  })

  // Narrative, X accounts, purchases, creative. Each group serves 503
  // feature_unconfigured until its dependencies are wired.
  addPromotionRoutes(router, deps)

  // The web contract: /v1/protocol, /v1/coins*, /v1/auth/*, /v1/dev/*,
  // /v1/onboarding/*. Public and dev-session routes; see authScopeOf.
  addV1Routes(router, deps.v1)

  return router

  function requireId(ctx: RequestContext): string {
    const id = ctx.params.id
    if (id === undefined || id.length === 0) throw badRequest('bad_id', 'onboarding id required')
    return id
  }

  async function requireRecord(ctx: RequestContext): Promise<OnboardingRecord> {
    return requireRecordById(requireId(ctx))
  }

  async function requireRecordById(id: string): Promise<OnboardingRecord> {
    const record = await deps.onboarding.store.get(id)
    if (record === undefined) throw notFound('no_such_onboarding', 'no such onboarding')
    return record
  }

  /** A vault the fleet holds no ticker for is a 404, never an empty team. */
  async function requireSnapshot(vault: Address) {
    const snapshot = await deps.agent.snapshot(vault)
    if (snapshot === undefined) throw notFound('no_such_agent', 'no agent runs for this vault')
    return snapshot
  }

  function requireLimit(raw: string): number {
    if (!/^\d{1,3}$/.test(raw)) throw badRequest('bad_limit', 'limit must be a small integer')
    return Number.parseInt(raw, 10)
  }

  function requireVaultParam(ctx: RequestContext): Address {
    const raw = ctx.params.vault
    if (raw === undefined || !isAddress(raw)) {
      throw badRequest('bad_vault', 'vault must be a 0x address')
    }
    return normalizeAddress(raw)
  }
}


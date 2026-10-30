/**
 * The operator console's API client.
 *
 * These are the routes apps/api serves BEHIND `VENUE_OPERATOR_API_TOKEN`: the
 * onboarding machine, narrative approval, the creative handoff, X account
 * binding, purchases and invoices, and identity attestations. They carry no
 * `/v1` prefix and, unlike the public and dev routes in routes.ts, every one
 * of them takes the operator bearer. The token is passed per call as
 * `OperatorAuth` for the same reason the dev routes take a `Session`: a client
 * that holds a credential in its constructor is a client that outlives it.
 *
 * Wire shapes follow apps/api/src/routes.ts (`publicRecord`) and
 * apps/api/src/promotion.ts verbatim. Decoders are strict in the manner of
 * decode.ts: closed enums are checked, money is a decimal string on the wire
 * and a bigint of cents here, and a field the server says is always present is
 * a decode error when missing rather than an `undefined` that renders as blank.
 */

import type { Cents } from '../domain/money.js'
import { ApiError, refusalFrom } from './client.js'
import { DecodeError, decodeBoolean, decodeCount, decodeEnum } from './decode.js'

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface OperatorAuth {
  /** The value of VENUE_OPERATOR_API_TOKEN. Held in sessionStorage by the gate, never in a URL. */
  token: string
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

export const ONBOARDING_STATES = [
  'drafted',
  'signed',
  'screened',
  'deployed',
  'awaiting_pointing',
  'pointed',
  'accepted',
  'active',
  'declined',
  'withdrawn',
] as const
export type OnboardingState = (typeof ONBOARDING_STATES)[number]

/** States a narrative, an account or a render may be attached in. Mirrors PROMOTION_ELIGIBLE_STATES. */
export const PROMOTION_ELIGIBLE_STATES: readonly OnboardingState[] = ['pointed', 'accepted', 'active']
export const TERMINAL_STATES: readonly OnboardingState[] = ['declined', 'withdrawn']

export const IMAGE_KINDS = ['banner', 'avatar', 'card'] as const
export type ImageKind = (typeof IMAGE_KINDS)[number]

export const NARRATIVE_TONES = ['playful', 'serious', 'technical', 'community'] as const
export type NarrativeTone = (typeof NARRATIVE_TONES)[number]

const SCREENING_VERDICTS = ['CLEAR', 'RESTRICTED', 'BLOCKED'] as const

export interface OnboardingRecordWire {
  id: string
  state: string
  vault: string
  token: string
  coinRef: string
  createdAtUnix: number
  updatedAtUnix: number
  subject: { name: string; symbol: string; linkCount: number; narrativeSourceCount: number }
  consent: {
    devSigner: string
    devPayout: string
    token: string
    termsHash: string
    operatorBps: number
    budgetBpsMax: number
    adapter: string
    referrer: string
    referrerBps: number
    expiryUnix: number
    nonce: string
  }
  screening?: { verdict: string; paidMediaPermitted: boolean; flags: string[]; screenedAtUnix: number }
  diligence?: { admitted: boolean; blockers: string[]; retryable: boolean }
  deployedAtUnix?: number
  pointedAtUnix?: number
  activatedAtUnix?: number
  declineReason?: string
  narrativeApproved: boolean
  history: Array<{ atUnix: number; from: string; to: string; code: string; detail?: string }>
}

export interface NarrativeCandidateWire {
  version: 1
  tagline: string
  themes: string[]
  tone: string
  palette: { primary: string; secondary: string }
  sourceHashes: string[]
}

export interface NarrativeProfileWire extends NarrativeCandidateWire {
  approvedAtUnix: number
  approvedBy: string
}

export interface NarrativeWire {
  id: string
  state: string
  sources: string[]
  candidate?: NarrativeCandidateWire
  approved?: NarrativeProfileWire
}

export interface CreativeAssetRefWire {
  id: string
  kind: string
  sha256: string
  bytes: number
}

export interface CreativeRenderWire {
  id: string
  creative: { narrative: boolean; assets: CreativeAssetRefWire[] }
}

/** Beside a narrative approval: the render's ids, or the reason it did not happen. */
export type CreativeOutcomeWire =
  | { rendered: true; narrative: boolean; assets: CreativeAssetRefWire[] }
  | { rendered: false; error: string }

export interface XAuthorizationWire {
  url: string
  state: string
  expiresAtUnix: number
}

export interface XBindingWire {
  accountId: string
  channel: string
  coinRef: string
  vault: string
  ticker: string
}

export interface LabelAttestationWire {
  accountId: string
  attestedBy: string
  attestedAtUnix: number
  expiresAtUnix: number
}

export interface InvoiceWire {
  vendorId: string
  skuId: string
  quantity: number
  /** "12.34": dollars with at most two decimals, exactly as the vendor printed it. */
  amountUsd: string
  invoiceHash: string
  issuedAtUnix: number
  baseline?: { boosts?: number; rank?: number }
}

export interface PurchaseQueueWire {
  vault: string
  atUnix: number
  awaitingInvoice: Array<{
    vendorId: string
    skuId: string
    quantity: number
    quoteUsdCents: string
    proposedAtUnix: number
  }>
  pendingInvoices: InvoiceWire[]
}

export interface KybAttestationWire {
  devSigner: string
  attestedBy: string
  providerRef: string
  attestedAtUnix: number
  expiresAtUnix: number
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface OnboardingEvent {
  atUnix: number
  from: OnboardingState
  to: OnboardingState
  code: string
  detail: string | null
}

export interface OnboardingRecordView {
  id: string
  state: OnboardingState
  vault: string
  token: string
  coinRef: string
  createdAtUnix: number
  updatedAtUnix: number
  subject: { name: string; symbol: string; linkCount: number; narrativeSourceCount: number }
  consent: {
    devSigner: string
    devPayout: string
    operatorBps: number
    budgetBpsMax: number
    referrer: string
    referrerBps: number
    expiryUnix: number
  }
  screening: {
    verdict: (typeof SCREENING_VERDICTS)[number]
    paidMediaPermitted: boolean
    flags: string[]
    screenedAtUnix: number
  } | null
  diligence: { admitted: boolean; blockers: string[]; retryable: boolean } | null
  deployedAtUnix: number | null
  pointedAtUnix: number | null
  activatedAtUnix: number | null
  declineReason: string | null
  narrativeApproved: boolean
  history: OnboardingEvent[]
}

export interface NarrativeCandidateView {
  tagline: string
  themes: string[]
  tone: NarrativeTone
  palette: { primary: string; secondary: string }
  sourceHashes: string[]
}

export interface NarrativeProfileView extends NarrativeCandidateView {
  approvedAtUnix: number
  approvedBy: string
}

export interface NarrativeView {
  id: string
  state: OnboardingState
  sources: string[]
  candidate: NarrativeCandidateView | null
  approved: NarrativeProfileView | null
}

export interface CreativeAssetRef {
  id: string
  kind: ImageKind
  sha256: string
  bytes: number
}

export interface CreativeRender {
  id: string
  /** False when the render fell back to the no-narrative layout. */
  narrative: boolean
  assets: CreativeAssetRef[]
}

export type CreativeOutcome = { rendered: true; narrative: boolean; assets: CreativeAssetRef[] } | { rendered: false; error: string }

export interface NarrativeApproval {
  narrative: NarrativeView
  /** Absent when the creative feature is not configured on the server. */
  creative: CreativeOutcome | null
}

/** The bytes of one rendered image, with what the server said about them. */
export interface CreativeImage {
  kind: ImageKind
  mime: string
  bytes: Uint8Array
  /** From the ETag; null when the server sent none. */
  sha256: string | null
}

export interface XAuthorization {
  url: string
  state: string
  expiresAtUnix: number
}

export interface XBinding {
  accountId: string
  channel: string
  coinRef: string
  vault: string
  ticker: string
}

export interface LabelAttestation {
  accountId: string
  attestedBy: string
  attestedAtUnix: number
  expiresAtUnix: number
}

export interface AwaitingInvoice {
  vendorId: string
  skuId: string
  quantity: number
  quoteCents: Cents
  proposedAtUnix: number
}

export interface InvoiceView {
  vendorId: string
  skuId: string
  quantity: number
  amountCents: Cents
  invoiceHash: string
  issuedAtUnix: number
  baseline: { boosts: number | null; rank: number | null } | null
}

export interface PurchaseQueue {
  vault: string
  atUnix: number
  awaitingInvoice: AwaitingInvoice[]
  pendingInvoices: InvoiceView[]
}

export interface InvoiceInput {
  vault: string
  vendorId: string
  skuId: string
  quantity: number
  /** Decimal string, e.g. "12.34". Never a number: see requireUsdCents in apps/api. */
  amountUsd: string
  vendorCountersig: string
  issuedAtUnix: number
  /** The hash on the vendor's copy. The server refuses if its own differs. */
  invoiceHash?: string
  baseline?: { boosts?: number; rank?: number }
}

export interface KybAttestation {
  devSigner: string
  attestedBy: string
  providerRef: string
  attestedAtUnix: number
  expiresAtUnix: number
}

export interface KybLookup {
  attestation: KybAttestation
  current: boolean
}

export interface KybAttestationInput {
  devSigner: string
  attestedBy: string
  providerRef: string
  /** Omitted means "now" on the server. */
  attestedAtUnix?: number
  expiresAtUnix: number
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEX_COLOUR = /^#[0-9a-f]{6}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const USD_DECIMAL = /^(0|[1-9]\d{0,8})(?:\.(\d{1,2}))?$/

function decodeString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new DecodeError('expected a string', field)
  return value
}

function decodeStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new DecodeError('expected an array', field)
  return value.map((item, i) => decodeString(item, `${field}[${String(i)}]`))
}

function decodeAddress(value: unknown, field: string): string {
  const raw = decodeString(value, field)
  if (!ADDRESS.test(raw)) throw new DecodeError('expected a 0x address', field)
  return raw.toLowerCase()
}

function decodeOptionalCount(value: unknown, field: string): number | null {
  return value === undefined || value === null ? null : decodeCount(value, field)
}

function decodeOptionalString(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : decodeString(value, field)
}

export function decodeOnboardingState(value: string, field: string): OnboardingState {
  return decodeEnum(value, ONBOARDING_STATES, field)
}

export function decodeImageKind(value: string, field: string): ImageKind {
  return decodeEnum(value, IMAGE_KINDS, field)
}

/** "12.34" -> 1234n. Refuses anything the server's own USD_DECIMAL would refuse. */
export function decodeUsdDecimal(value: unknown, field: string): Cents {
  const raw = decodeString(value, field)
  const match = USD_DECIMAL.exec(raw)
  if (match === null) throw new DecodeError(`expected dollars with at most two decimals, got ${JSON.stringify(raw)}`, field)
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
}

export function decodeOnboardingRecord(wire: OnboardingRecordWire, field = 'onboarding'): OnboardingRecordView {
  if (wire === null || typeof wire !== 'object') throw new DecodeError('expected an object', field)
  const subject = wire.subject
  if (subject === null || typeof subject !== 'object') throw new DecodeError('expected an object', `${field}.subject`)
  const consent = wire.consent
  if (consent === null || typeof consent !== 'object') throw new DecodeError('expected an object', `${field}.consent`)

  return {
    id: decodeString(wire.id, `${field}.id`),
    state: decodeOnboardingState(wire.state, `${field}.state`),
    vault: decodeAddress(wire.vault, `${field}.vault`),
    token: decodeAddress(wire.token, `${field}.token`),
    coinRef: decodeString(wire.coinRef, `${field}.coinRef`),
    createdAtUnix: decodeCount(wire.createdAtUnix, `${field}.createdAtUnix`),
    updatedAtUnix: decodeCount(wire.updatedAtUnix, `${field}.updatedAtUnix`),
    subject: {
      name: decodeString(subject.name, `${field}.subject.name`),
      symbol: decodeString(subject.symbol, `${field}.subject.symbol`),
      linkCount: decodeCount(subject.linkCount, `${field}.subject.linkCount`),
      narrativeSourceCount: decodeCount(subject.narrativeSourceCount, `${field}.subject.narrativeSourceCount`),
    },
    consent: {
      devSigner: decodeAddress(consent.devSigner, `${field}.consent.devSigner`),
      devPayout: decodeAddress(consent.devPayout, `${field}.consent.devPayout`),
      operatorBps: decodeCount(consent.operatorBps, `${field}.consent.operatorBps`),
      budgetBpsMax: decodeCount(consent.budgetBpsMax, `${field}.consent.budgetBpsMax`),
      referrer: decodeAddress(consent.referrer, `${field}.consent.referrer`),
      referrerBps: decodeCount(consent.referrerBps, `${field}.consent.referrerBps`),
      expiryUnix: decodeCount(consent.expiryUnix, `${field}.consent.expiryUnix`),
    },
    screening:
      wire.screening === undefined || wire.screening === null
        ? null
        : {
            verdict: decodeEnum(wire.screening.verdict, SCREENING_VERDICTS, `${field}.screening.verdict`),
            paidMediaPermitted: decodeBoolean(wire.screening.paidMediaPermitted, `${field}.screening.paidMediaPermitted`),
            flags: decodeStringArray(wire.screening.flags, `${field}.screening.flags`),
            screenedAtUnix: decodeCount(wire.screening.screenedAtUnix, `${field}.screening.screenedAtUnix`),
          },
    diligence:
      wire.diligence === undefined || wire.diligence === null
        ? null
        : {
            admitted: decodeBoolean(wire.diligence.admitted, `${field}.diligence.admitted`),
            blockers: decodeStringArray(wire.diligence.blockers, `${field}.diligence.blockers`),
            retryable: decodeBoolean(wire.diligence.retryable, `${field}.diligence.retryable`),
          },
    deployedAtUnix: decodeOptionalCount(wire.deployedAtUnix, `${field}.deployedAtUnix`),
    pointedAtUnix: decodeOptionalCount(wire.pointedAtUnix, `${field}.pointedAtUnix`),
    activatedAtUnix: decodeOptionalCount(wire.activatedAtUnix, `${field}.activatedAtUnix`),
    declineReason: decodeOptionalString(wire.declineReason, `${field}.declineReason`),
    narrativeApproved: decodeBoolean(wire.narrativeApproved, `${field}.narrativeApproved`),
    history: (Array.isArray(wire.history) ? wire.history : []).map((event, i) => ({
      atUnix: decodeCount(event.atUnix, `${field}.history[${String(i)}].atUnix`),
      from: decodeOnboardingState(event.from, `${field}.history[${String(i)}].from`),
      to: decodeOnboardingState(event.to, `${field}.history[${String(i)}].to`),
      code: decodeString(event.code, `${field}.history[${String(i)}].code`),
      detail: decodeOptionalString(event.detail, `${field}.history[${String(i)}].detail`),
    })),
  }
}

export function decodeNarrativeCandidate(wire: NarrativeCandidateWire, field: string): NarrativeCandidateView {
  if (wire === null || typeof wire !== 'object') throw new DecodeError('expected an object', field)
  if (wire.version !== 1) throw new DecodeError('expected version 1', `${field}.version`)
  const palette = wire.palette
  if (palette === null || typeof palette !== 'object') throw new DecodeError('expected an object', `${field}.palette`)
  const primary = decodeString(palette.primary, `${field}.palette.primary`)
  const secondary = decodeString(palette.secondary, `${field}.palette.secondary`)
  if (!HEX_COLOUR.test(primary)) throw new DecodeError('expected #rrggbb', `${field}.palette.primary`)
  if (!HEX_COLOUR.test(secondary)) throw new DecodeError('expected #rrggbb', `${field}.palette.secondary`)
  const sourceHashes = decodeStringArray(wire.sourceHashes, `${field}.sourceHashes`)
  sourceHashes.forEach((hash, i) => {
    if (!SHA256_HEX.test(hash)) throw new DecodeError('expected sha256 hex', `${field}.sourceHashes[${String(i)}]`)
  })
  return {
    tagline: decodeString(wire.tagline, `${field}.tagline`),
    themes: decodeStringArray(wire.themes, `${field}.themes`),
    tone: decodeEnum(wire.tone, NARRATIVE_TONES, `${field}.tone`),
    palette: { primary, secondary },
    sourceHashes,
  }
}

export function decodeNarrativeProfile(wire: NarrativeProfileWire, field: string): NarrativeProfileView {
  return {
    ...decodeNarrativeCandidate(wire, field),
    approvedAtUnix: decodeCount(wire.approvedAtUnix, `${field}.approvedAtUnix`),
    approvedBy: decodeString(wire.approvedBy, `${field}.approvedBy`),
  }
}

export function decodeNarrative(wire: NarrativeWire, field = 'narrative'): NarrativeView {
  if (wire === null || typeof wire !== 'object') throw new DecodeError('expected an object', field)
  return {
    id: decodeString(wire.id, `${field}.id`),
    state: decodeOnboardingState(wire.state, `${field}.state`),
    sources: decodeStringArray(wire.sources, `${field}.sources`),
    candidate: wire.candidate === undefined || wire.candidate === null ? null : decodeNarrativeCandidate(wire.candidate, `${field}.candidate`),
    approved: wire.approved === undefined || wire.approved === null ? null : decodeNarrativeProfile(wire.approved, `${field}.approved`),
  }
}

function decodeAssetRef(wire: CreativeAssetRefWire, field: string): CreativeAssetRef {
  const sha256 = decodeString(wire.sha256, `${field}.sha256`)
  if (!SHA256_HEX.test(sha256)) throw new DecodeError('expected sha256 hex', `${field}.sha256`)
  return {
    id: decodeString(wire.id, `${field}.id`),
    kind: decodeImageKind(wire.kind, `${field}.kind`),
    sha256,
    bytes: decodeCount(wire.bytes, `${field}.bytes`),
  }
}

function decodeAssetRefs(value: unknown, field: string): CreativeAssetRef[] {
  if (!Array.isArray(value)) throw new DecodeError('expected an array', field)
  return (value as CreativeAssetRefWire[]).map((ref, i) => decodeAssetRef(ref, `${field}[${String(i)}]`))
}

export function decodeCreativeRender(wire: CreativeRenderWire, field = 'creative'): CreativeRender {
  if (wire === null || typeof wire !== 'object' || wire.creative === null || typeof wire.creative !== 'object') {
    throw new DecodeError('expected an object', field)
  }
  return {
    id: decodeString(wire.id, `${field}.id`),
    narrative: decodeBoolean(wire.creative.narrative, `${field}.narrative`),
    assets: decodeAssetRefs(wire.creative.assets, `${field}.assets`),
  }
}

export function decodeCreativeOutcome(wire: CreativeOutcomeWire, field: string): CreativeOutcome {
  if (wire === null || typeof wire !== 'object') throw new DecodeError('expected an object', field)
  if (wire.rendered === true) {
    return {
      rendered: true,
      narrative: decodeBoolean(wire.narrative, `${field}.narrative`),
      assets: decodeAssetRefs(wire.assets, `${field}.assets`),
    }
  }
  if (wire.rendered === false) return { rendered: false, error: decodeString(wire.error, `${field}.error`) }
  throw new DecodeError('expected a boolean', `${field}.rendered`)
}

export function decodeXAuthorization(wire: XAuthorizationWire): XAuthorization {
  const url = decodeString(wire.url, 'url')
  if (!url.startsWith('https://')) throw new DecodeError('expected an https URL', 'url')
  return {
    url,
    state: decodeString(wire.state, 'state'),
    expiresAtUnix: decodeCount(wire.expiresAtUnix, 'expiresAtUnix'),
  }
}

export function decodeXBinding(wire: XBindingWire, field = 'binding'): XBinding {
  if (wire === null || typeof wire !== 'object') throw new DecodeError('expected an object', field)
  return {
    accountId: decodeString(wire.accountId, `${field}.accountId`),
    channel: decodeString(wire.channel, `${field}.channel`),
    coinRef: decodeString(wire.coinRef, `${field}.coinRef`),
    vault: decodeAddress(wire.vault, `${field}.vault`),
    ticker: decodeString(wire.ticker, `${field}.ticker`),
  }
}

export function decodeLabelAttestation(wire: LabelAttestationWire, field = 'attestation'): LabelAttestation {
  if (wire === null || typeof wire !== 'object') throw new DecodeError('expected an object', field)
  return {
    accountId: decodeString(wire.accountId, `${field}.accountId`),
    attestedBy: decodeString(wire.attestedBy, `${field}.attestedBy`),
    attestedAtUnix: decodeCount(wire.attestedAtUnix, `${field}.attestedAtUnix`),
    expiresAtUnix: decodeCount(wire.expiresAtUnix, `${field}.expiresAtUnix`),
  }
}

export function decodeInvoice(wire: InvoiceWire, field: string): InvoiceView {
  if (wire === null || typeof wire !== 'object') throw new DecodeError('expected an object', field)
  return {
    vendorId: decodeString(wire.vendorId, `${field}.vendorId`),
    skuId: decodeString(wire.skuId, `${field}.skuId`),
    quantity: decodeCount(wire.quantity, `${field}.quantity`),
    amountCents: decodeUsdDecimal(wire.amountUsd, `${field}.amountUsd`),
    invoiceHash: decodeString(wire.invoiceHash, `${field}.invoiceHash`),
    issuedAtUnix: decodeCount(wire.issuedAtUnix, `${field}.issuedAtUnix`),
    baseline:
      wire.baseline === undefined || wire.baseline === null
        ? null
        : {
            boosts: decodeOptionalCount(wire.baseline.boosts, `${field}.baseline.boosts`),
            rank: decodeOptionalCount(wire.baseline.rank, `${field}.baseline.rank`),
          },
  }
}

export function decodePurchaseQueue(wire: PurchaseQueueWire): PurchaseQueue {
  if (wire === null || typeof wire !== 'object') throw new DecodeError('expected an object', 'purchases')
  if (!Array.isArray(wire.awaitingInvoice)) throw new DecodeError('expected an array', 'awaitingInvoice')
  if (!Array.isArray(wire.pendingInvoices)) throw new DecodeError('expected an array', 'pendingInvoices')
  return {
    vault: decodeAddress(wire.vault, 'vault'),
    atUnix: decodeCount(wire.atUnix, 'atUnix'),
    awaitingInvoice: wire.awaitingInvoice.map((item, i) => {
      const field = `awaitingInvoice[${String(i)}]`
      const quote = item.quoteUsdCents
      if (typeof quote !== 'string' || !/^\d+$/.test(quote)) {
        throw new DecodeError('expected a decimal integer string of cents', `${field}.quoteUsdCents`)
      }
      return {
        vendorId: decodeString(item.vendorId, `${field}.vendorId`),
        skuId: decodeString(item.skuId, `${field}.skuId`),
        quantity: decodeCount(item.quantity, `${field}.quantity`),
        quoteCents: BigInt(quote),
        proposedAtUnix: decodeCount(item.proposedAtUnix, `${field}.proposedAtUnix`),
      }
    }),
    pendingInvoices: wire.pendingInvoices.map((invoice, i) => decodeInvoice(invoice, `pendingInvoices[${String(i)}]`)),
  }
}

export function decodeKybAttestation(wire: KybAttestationWire, field = 'attestation'): KybAttestation {
  if (wire === null || typeof wire !== 'object') throw new DecodeError('expected an object', field)
  return {
    devSigner: decodeAddress(wire.devSigner, `${field}.devSigner`),
    attestedBy: decodeString(wire.attestedBy, `${field}.attestedBy`),
    providerRef: decodeString(wire.providerRef, `${field}.providerRef`),
    attestedAtUnix: decodeCount(wire.attestedAtUnix, `${field}.attestedAtUnix`),
    expiresAtUnix: decodeCount(wire.expiresAtUnix, `${field}.expiresAtUnix`),
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** No /v1 prefix: these are apps/api's own operator paths, verbatim. */
export const OPERATOR_ROUTES = {
  onboardings: () => '/onboarding',
  onboarding: (id: string) => `/onboarding/${encodeURIComponent(id)}`,
  diligence: (id: string) => `/onboarding/${encodeURIComponent(id)}/diligence`,
  deploy: (id: string) => `/onboarding/${encodeURIComponent(id)}/deploy`,
  pointing: (id: string) => `/onboarding/${encodeURIComponent(id)}/pointing`,
  acceptance: (id: string) => `/onboarding/${encodeURIComponent(id)}/acceptance`,
  activate: (id: string) => `/onboarding/${encodeURIComponent(id)}/activate`,
  decline: (id: string) => `/onboarding/${encodeURIComponent(id)}/decline`,
  narrative: (id: string) => `/onboarding/${encodeURIComponent(id)}/narrative`,
  narrativeDerive: (id: string) => `/onboarding/${encodeURIComponent(id)}/narrative/derive`,
  narrativeApprove: (id: string) => `/onboarding/${encodeURIComponent(id)}/narrative/approve`,
  creativeRender: (id: string) => `/onboarding/${encodeURIComponent(id)}/creative/render`,
  creative: (id: string, kind: ImageKind) => `/onboarding/${encodeURIComponent(id)}/creative/${kind}`,
  xAuthorize: () => '/accounts/x/authorize',
  xBind: () => '/accounts/x/bind',
  xAttestLabel: () => '/accounts/x/attest-label',
  purchases: () => '/purchases',
  invoices: () => '/invoices',
  kybAttest: () => '/diligence/kyb/attest',
  kyb: (devSigner: string) => `/diligence/kyb/${devSigner}`,
} as const

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface OperatorApiClient {
  // the onboarding machine
  listOnboardings(auth: OperatorAuth, state?: OnboardingState): Promise<OnboardingRecordView[]>
  getOnboarding(auth: OperatorAuth, id: string): Promise<OnboardingRecordView>
  runDiligence(auth: OperatorAuth, id: string): Promise<OnboardingRecordView>
  deploy(auth: OperatorAuth, id: string): Promise<OnboardingRecordView>
  confirmPointing(auth: OperatorAuth, id: string): Promise<OnboardingRecordView>
  recordAcceptance(auth: OperatorAuth, id: string): Promise<OnboardingRecordView>
  activate(auth: OperatorAuth, id: string): Promise<OnboardingRecordView>
  decline(auth: OperatorAuth, id: string, code: string, detail?: string): Promise<OnboardingRecordView>

  // narrative
  getNarrative(auth: OperatorAuth, id: string): Promise<NarrativeView>
  deriveNarrative(auth: OperatorAuth, id: string): Promise<NarrativeView>
  approveNarrative(auth: OperatorAuth, id: string, approvedBy: string): Promise<NarrativeApproval>

  // creative
  renderCreative(auth: OperatorAuth, id: string): Promise<CreativeRender>
  getCreative(auth: OperatorAuth, id: string, kind: ImageKind): Promise<CreativeImage>

  // X accounts
  authorizeX(auth: OperatorAuth, coinRef: string, accountId: string): Promise<XAuthorization>
  bindX(auth: OperatorAuth, binding: { accountId: string; coinRef: string; ticker: string }): Promise<XBinding>
  attestLabel(auth: OperatorAuth, input: { accountId: string; attestedBy: string; days: number }): Promise<LabelAttestation>

  // purchases
  listPurchases(auth: OperatorAuth, vault: string): Promise<PurchaseQueue>
  recordInvoice(auth: OperatorAuth, invoice: InvoiceInput): Promise<{ vault: string; invoice: InvoiceView }>

  // identity
  attestKyb(auth: OperatorAuth, input: KybAttestationInput): Promise<KybAttestation>
  getKyb(auth: OperatorAuth, devSigner: string): Promise<KybLookup>
}

export interface HttpOperatorApiClientOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
}

export class HttpOperatorApiClient implements OperatorApiClient {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch

  constructor(options: HttpOperatorApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  async #raw(
    auth: OperatorAuth,
    route: string,
    init?: { method?: string; body?: unknown; query?: Record<string, string>; accept?: string },
  ): Promise<Response> {
    const url = new URL(`${this.#baseUrl}${route}`, 'http://local.invalid')
    for (const [key, value] of Object.entries(init?.query ?? {})) url.searchParams.set(key, value)
    const target = this.#baseUrl.startsWith('http') ? url.toString() : `${url.pathname}${url.search}`

    const headers: Record<string, string> = {
      accept: init?.accept ?? 'application/json',
      authorization: `Bearer ${auth.token}`,
    }
    if (init?.body !== undefined) headers['content-type'] = 'application/json'

    const response = await this.#fetch(target, {
      method: init?.method ?? 'GET',
      headers,
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    if (!response.ok) throw await refusalFrom(response, route)
    return response
  }

  async #request<T>(
    auth: OperatorAuth,
    route: string,
    init?: { method?: string; body?: unknown; query?: Record<string, string> },
  ): Promise<T> {
    const response = await this.#raw(auth, route, init)
    return (await response.json()) as T
  }

  async #record(auth: OperatorAuth, route: string, init?: { method?: string; body?: unknown }): Promise<OnboardingRecordView> {
    const wire = await this.#request<{ onboarding: OnboardingRecordWire }>(auth, route, init)
    return decodeOnboardingRecord(wire.onboarding)
  }

  async listOnboardings(auth: OperatorAuth, state?: OnboardingState): Promise<OnboardingRecordView[]> {
    const wire = await this.#request<{ onboardings: OnboardingRecordWire[] }>(auth, OPERATOR_ROUTES.onboardings(), {
      ...(state === undefined ? {} : { query: { state } }),
    })
    if (!Array.isArray(wire.onboardings)) throw new DecodeError('expected an array', 'onboardings')
    return wire.onboardings.map((record, i) => decodeOnboardingRecord(record, `onboardings[${String(i)}]`))
  }

  getOnboarding(auth: OperatorAuth, id: string): Promise<OnboardingRecordView> {
    return this.#record(auth, OPERATOR_ROUTES.onboarding(id))
  }

  runDiligence(auth: OperatorAuth, id: string): Promise<OnboardingRecordView> {
    return this.#record(auth, OPERATOR_ROUTES.diligence(id), { method: 'POST' })
  }

  deploy(auth: OperatorAuth, id: string): Promise<OnboardingRecordView> {
    return this.#record(auth, OPERATOR_ROUTES.deploy(id), { method: 'POST' })
  }

  confirmPointing(auth: OperatorAuth, id: string): Promise<OnboardingRecordView> {
    return this.#record(auth, OPERATOR_ROUTES.pointing(id), { method: 'POST' })
  }

  recordAcceptance(auth: OperatorAuth, id: string): Promise<OnboardingRecordView> {
    return this.#record(auth, OPERATOR_ROUTES.acceptance(id), { method: 'POST' })
  }

  activate(auth: OperatorAuth, id: string): Promise<OnboardingRecordView> {
    return this.#record(auth, OPERATOR_ROUTES.activate(id), { method: 'POST' })
  }

  decline(auth: OperatorAuth, id: string, code: string, detail?: string): Promise<OnboardingRecordView> {
    return this.#record(auth, OPERATOR_ROUTES.decline(id), {
      method: 'POST',
      body: { code, ...(detail === undefined || detail.length === 0 ? {} : { detail }) },
    })
  }

  async getNarrative(auth: OperatorAuth, id: string): Promise<NarrativeView> {
    const wire = await this.#request<{ narrative: NarrativeWire }>(auth, OPERATOR_ROUTES.narrative(id))
    return decodeNarrative(wire.narrative)
  }

  async deriveNarrative(auth: OperatorAuth, id: string): Promise<NarrativeView> {
    const wire = await this.#request<{ narrative: NarrativeWire }>(auth, OPERATOR_ROUTES.narrativeDerive(id), {
      method: 'POST',
    })
    return decodeNarrative(wire.narrative)
  }

  async approveNarrative(auth: OperatorAuth, id: string, approvedBy: string): Promise<NarrativeApproval> {
    const wire = await this.#request<{ narrative: NarrativeWire; creative?: CreativeOutcomeWire }>(
      auth,
      OPERATOR_ROUTES.narrativeApprove(id),
      { method: 'POST', body: { approvedBy } },
    )
    return {
      narrative: decodeNarrative(wire.narrative),
      creative: wire.creative === undefined ? null : decodeCreativeOutcome(wire.creative, 'creative'),
    }
  }

  async renderCreative(auth: OperatorAuth, id: string): Promise<CreativeRender> {
    const wire = await this.#request<CreativeRenderWire>(auth, OPERATOR_ROUTES.creativeRender(id), { method: 'POST' })
    return decodeCreativeRender(wire)
  }

  async getCreative(auth: OperatorAuth, id: string, kind: ImageKind): Promise<CreativeImage> {
    const response = await this.#raw(auth, OPERATOR_ROUTES.creative(id, kind), { accept: 'image/png' })
    const etag = response.headers.get('etag')
    const sha256 = etag === null ? null : etag.replace(/^"|"$/g, '')
    return {
      kind,
      mime: response.headers.get('content-type') ?? 'application/octet-stream',
      bytes: new Uint8Array(await response.arrayBuffer()),
      sha256: sha256 !== null && SHA256_HEX.test(sha256) ? sha256 : null,
    }
  }

  async authorizeX(auth: OperatorAuth, coinRef: string, accountId: string): Promise<XAuthorization> {
    const wire = await this.#request<XAuthorizationWire>(auth, OPERATOR_ROUTES.xAuthorize(), {
      query: { coinRef, accountId },
    })
    return decodeXAuthorization(wire)
  }

  async bindX(auth: OperatorAuth, binding: { accountId: string; coinRef: string; ticker: string }): Promise<XBinding> {
    const wire = await this.#request<{ binding: XBindingWire }>(auth, OPERATOR_ROUTES.xBind(), {
      method: 'POST',
      body: binding,
    })
    return decodeXBinding(wire.binding)
  }

  async attestLabel(
    auth: OperatorAuth,
    input: { accountId: string; attestedBy: string; days: number },
  ): Promise<LabelAttestation> {
    const wire = await this.#request<{ attestation: LabelAttestationWire }>(auth, OPERATOR_ROUTES.xAttestLabel(), {
      method: 'POST',
      body: input,
    })
    return decodeLabelAttestation(wire.attestation)
  }

  async listPurchases(auth: OperatorAuth, vault: string): Promise<PurchaseQueue> {
    const wire = await this.#request<PurchaseQueueWire>(auth, OPERATOR_ROUTES.purchases(), { query: { vault } })
    return decodePurchaseQueue(wire)
  }

  async recordInvoice(auth: OperatorAuth, invoice: InvoiceInput): Promise<{ vault: string; invoice: InvoiceView }> {
    const wire = await this.#request<{ vault: string; invoice: InvoiceWire }>(auth, OPERATOR_ROUTES.invoices(), {
      method: 'POST',
      body: invoice,
    })
    return { vault: decodeAddress(wire.vault, 'vault'), invoice: decodeInvoice(wire.invoice, 'invoice') }
  }

  async attestKyb(auth: OperatorAuth, input: KybAttestationInput): Promise<KybAttestation> {
    const wire = await this.#request<{ attestation: KybAttestationWire }>(auth, OPERATOR_ROUTES.kybAttest(), {
      method: 'POST',
      body: input,
    })
    return decodeKybAttestation(wire.attestation)
  }

  async getKyb(auth: OperatorAuth, devSigner: string): Promise<KybLookup> {
    const wire = await this.#request<{ attestation: KybAttestationWire; current: boolean }>(
      auth,
      OPERATOR_ROUTES.kyb(devSigner),
    )
    return { attestation: decodeKybAttestation(wire.attestation), current: decodeBoolean(wire.current, 'current') }
  }
}

/** True when the refusal is the operator token being wrong, as opposed to the request. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

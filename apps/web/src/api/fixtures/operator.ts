/**
 * The operator fixture.
 *
 * The same idea as FixtureApiClient: a small in-memory backend behind the
 * OperatorApiClient interface, not canned responses. It runs the onboarding
 * state machine with the same legal transitions apps/api enforces, refuses
 * with the same machine codes (`illegal_transition`, `narrative_not_eligible`,
 * `account_not_authorised`, `invoice_hash_mismatch`, ...), and gates every call
 * on a bearer, so the console's refusal rendering and its token gate are
 * exercised in the demo rather than only in production.
 *
 * Diligence, deployment and pointing are simulated: there is no chain and no
 * screening model here. What is NOT simulated is the shape of the refusals -
 * a demo that never refused would teach that the console never has to show one.
 */

import { bytesToHex } from '../../crypto/hex.js'
import { keccak256 } from '../../crypto/keccak.js'
import { ApiError } from '../client.js'
import {
  IMAGE_KINDS,
  PROMOTION_ELIGIBLE_STATES,
  TERMINAL_STATES,
  type CreativeAssetRef,
  type CreativeImage,
  type CreativeRender,
  type ImageKind,
  type InvoiceInput,
  type InvoiceView,
  type KybAttestation,
  type KybAttestationInput,
  type KybLookup,
  type LabelAttestation,
  type NarrativeApproval,
  type NarrativeCandidateView,
  type NarrativeProfileView,
  type NarrativeView,
  type OnboardingRecordView,
  type OnboardingState,
  type OperatorApiClient,
  type OperatorAuth,
  type PurchaseQueue,
  type XAuthorization,
  type XBinding,
} from '../operator.js'
import { TERMS } from '../../protocol.js'
import { fixtureAddressFor, fixtureBytes32For, type FixtureDataset } from './dataset.js'

/**
 * The bearer the demo accepts. Printed on the gate in demo mode: a fixture
 * whose token was secret would only be demonstrating that the operator cannot
 * get in.
 */
export const FIXTURE_OPERATOR_TOKEN = 'demo-operator'

const DAY = 86_400
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const OPERATOR_ID = /^[A-Za-z0-9_.-]{1,64}$/
const ACCOUNT_ID = /^[A-Za-z0-9_]{1,64}$/
const USD_DECIMAL = /^(0|[1-9]\d{0,8})(?:\.(\d{1,2}))?$/
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/

const IMAGE_DIMENSIONS: Readonly<Record<ImageKind, { width: number; height: number }>> = {
  banner: { width: 1500, height: 500 },
  avatar: { width: 400, height: 400 },
  card: { width: 1200, height: 675 },
}

/** Same table as apps/api/src/onboarding.ts. Anything not listed is refused. */
const TRANSITIONS: Readonly<Record<OnboardingState, readonly OnboardingState[]>> = {
  drafted: ['signed', 'declined', 'withdrawn'],
  signed: ['screened', 'declined', 'withdrawn'],
  screened: ['deployed', 'declined', 'withdrawn'],
  deployed: ['awaiting_pointing', 'declined', 'withdrawn'],
  awaiting_pointing: ['pointed', 'declined', 'withdrawn'],
  pointed: ['accepted', 'declined', 'withdrawn'],
  accepted: ['active', 'declined', 'withdrawn'],
  active: ['withdrawn'],
  declined: [],
  withdrawn: [],
}

interface QueueSpec {
  key: string
  name: string
  symbol: string
  state: OnboardingState
  /** Days since the record was created; the history is laid out backwards from now. */
  ageDays: number
  narrativeSources: string[]
  socials?: { x?: string }
  screening?: { verdict: 'CLEAR' | 'RESTRICTED' | 'BLOCKED'; paidMediaPermitted: boolean; flags: string[] }
  diligence?: { admitted: boolean; blockers: string[]; retryable: boolean }
  declineReason?: string
  candidate?: NarrativeCandidateView
}

/** Coins that have not reached the member directory yet: the queue itself. */
const QUEUE_SPECS: QueueSpec[] = [
  {
    key: 'ferrule',
    name: 'Ferrule',
    symbol: 'FERR',
    state: 'signed',
    ageDays: 1,
    narrativeSources: ['https://ferrule.example/launch', 'https://ferrule.example/docs'],
    socials: { x: 'ferrule_coin' },
  },
  {
    key: 'quill',
    name: 'Quill',
    symbol: 'QUIL',
    state: 'screened',
    ageDays: 2,
    narrativeSources: ['https://quill.example/post'],
    screening: { verdict: 'CLEAR', paidMediaPermitted: true, flags: [] },
    diligence: { admitted: true, blockers: [], retryable: false },
  },
  {
    key: 'moth',
    name: 'Moth',
    symbol: 'MOTH',
    state: 'awaiting_pointing',
    ageDays: 3,
    narrativeSources: [],
    screening: { verdict: 'RESTRICTED', paidMediaPermitted: false, flags: ['gambling_adjacent'] },
    diligence: { admitted: true, blockers: [], retryable: false },
  },
  {
    key: 'kettle',
    name: 'Kettle',
    symbol: 'KETL',
    state: 'pointed',
    ageDays: 5,
    narrativeSources: ['https://kettle.example/launch'],
    socials: { x: 'kettle_ops' },
    screening: { verdict: 'CLEAR', paidMediaPermitted: true, flags: [] },
    diligence: { admitted: true, blockers: [], retryable: false },
    candidate: {
      tagline: 'A slow-brew community coin that rewards people who stick around.',
      themes: ['community', 'patience'],
      tone: 'community',
      palette: { primary: '#2f5d50', secondary: '#f0c987' },
      sourceHashes: [fixtureBytes32For('source/kettle/launch').slice(2)],
    },
  },
  {
    key: 'lantern',
    name: 'Lantern',
    symbol: 'LNTN',
    state: 'accepted',
    ageDays: 6,
    narrativeSources: ['https://lantern.example/why'],
    screening: { verdict: 'CLEAR', paidMediaPermitted: true, flags: [] },
    diligence: { admitted: true, blockers: [], retryable: false },
  },
  {
    key: 'rug',
    name: 'Definitely Not A Rug',
    symbol: 'RUG',
    state: 'declined',
    ageDays: 9,
    narrativeSources: [],
    screening: { verdict: 'BLOCKED', paidMediaPermitted: false, flags: ['impersonation'] },
    diligence: { admitted: false, blockers: ['deployer_flagged'], retryable: false },
    declineReason: 'diligence_failed',
  },
]

/** The path each state took to get here, for the history column. */
const STATE_PATH: readonly OnboardingState[] = [
  'drafted',
  'signed',
  'screened',
  'deployed',
  'awaiting_pointing',
  'pointed',
  'accepted',
  'active',
]

const TRANSITION_CODES: Readonly<Record<OnboardingState, string>> = {
  drafted: 'drafted',
  signed: 'signature_verified',
  screened: 'diligence_passed',
  deployed: 'vault_deployed',
  awaiting_pointing: 'bound',
  pointed: 'recipient_confirmed',
  accepted: 'acceptance_confirmed',
  active: 'operator_activated',
  declined: 'declined',
  withdrawn: 'withdrawn',
}

interface FixtureRecord extends OnboardingRecordView {
  narrativeSources: string[]
  socials: { x?: string } | undefined
  candidate: NarrativeCandidateView | null
  approved: NarrativeProfileView | null
  assets: Map<ImageKind, { ref: CreativeAssetRef; image: CreativeImage }>
}

function refuse(status: number, code: string, message: string, route: string): ApiError {
  return new ApiError(`${code}: ${message}`, status, route, code)
}

function buildRecord(
  spec: QueueSpec,
  nowUnix: number,
  vault: string,
  token: string,
  narrativeApproved: NarrativeProfileView | null,
): FixtureRecord {
  const createdAtUnix = nowUnix - spec.ageDays * DAY
  const history: OnboardingRecordView['history'] = []
  const path: readonly OnboardingState[] = TERMINAL_STATES.includes(spec.state)
    ? ['drafted', 'signed', spec.state]
    : STATE_PATH.slice(0, STATE_PATH.indexOf(spec.state) + 1)
  for (let i = 1; i < path.length; i += 1) {
    const to = path[i]!
    history.push({
      atUnix: createdAtUnix + i * 3_600,
      from: path[i - 1]!,
      to,
      code: to === 'declined' ? (spec.declineReason ?? 'declined') : TRANSITION_CODES[to],
      detail: to === 'deployed' ? fixtureBytes32For(`deploy/${spec.key}`) : null,
    })
  }
  const at = (state: OnboardingState): number | null => history.find((e) => e.to === state)?.atUnix ?? null

  return {
    id: `onb_${spec.key}`,
    state: spec.state,
    vault,
    token,
    coinRef: `coin_${spec.key}`,
    createdAtUnix,
    updatedAtUnix: history.at(-1)?.atUnix ?? createdAtUnix,
    subject: {
      name: spec.name,
      symbol: spec.symbol,
      linkCount: spec.narrativeSources.length > 0 ? 1 : 0,
      narrativeSourceCount: spec.narrativeSources.length,
    },
    consent: {
      devSigner: fixtureAddressFor(`dev/${spec.key}`),
      devPayout: fixtureAddressFor(`devpayout/${spec.key}`),
      operatorBps: TERMS.operatorBps,
      budgetBpsMax: TERMS.budgetBpsMax,
      referrer: ZERO_ADDRESS,
      referrerBps: 0,
      expiryUnix: createdAtUnix + 7 * DAY,
    },
    screening: spec.screening === undefined ? null : { ...spec.screening, flags: [...spec.screening.flags], screenedAtUnix: at('screened') ?? createdAtUnix },
    diligence: spec.diligence === undefined ? null : { ...spec.diligence, blockers: [...spec.diligence.blockers] },
    deployedAtUnix: at('deployed'),
    pointedAtUnix: at('pointed'),
    activatedAtUnix: at('active'),
    declineReason: spec.declineReason ?? null,
    narrativeApproved: narrativeApproved !== null,
    history,
    narrativeSources: [...spec.narrativeSources],
    socials: spec.socials,
    candidate: spec.candidate ?? null,
    approved: narrativeApproved,
    assets: new Map(),
  }
}

/** What the reader plane would derive, stated deterministically from the sources' names. */
function deriveCandidate(record: FixtureRecord): NarrativeCandidateView {
  const seed = keccak256(new TextEncoder().encode(`narrative/${record.coinRef}`))
  const hex = (offset: number): string => `#${bytesToHex(seed.slice(offset, offset + 3)).slice(2)}`
  return {
    tagline: `${record.subject.name} is a ${record.subject.symbol.toLowerCase()} community coin with a plan it wrote down.`,
    themes: ['community', 'roadmap'],
    tone: 'community',
    palette: { primary: hex(0), secondary: hex(3) },
    sourceHashes: record.narrativeSources.map((url) => bytesToHex(keccak256(new TextEncoder().encode(url))).slice(2)),
  }
}

/**
 * An SVG stand-in for the PNG the real renderer produces. The MIME says what
 * it is; an <img> renders either, and the demo's job is to show the handoff,
 * not to ship a rasteriser to the browser.
 */
function renderSvg(kind: ImageKind, record: FixtureRecord): Uint8Array {
  const { width, height } = IMAGE_DIMENSIONS[kind]
  const palette = record.approved?.palette ?? { primary: '#1f2933', secondary: '#9aa5b1' }
  const tagline = record.approved?.tagline ?? ''
  const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${palette.primary}"/>`,
    `<circle cx="${width * 0.82}" cy="${height * 0.5}" r="${Math.min(width, height) * 0.28}" fill="${palette.secondary}" opacity="0.85"/>`,
    `<text x="${width * 0.06}" y="${height * 0.52}" font-family="system-ui, sans-serif" font-size="${Math.round(height * 0.22)}" font-weight="700" fill="#ffffff">${escape(record.subject.symbol)}</text>`,
    kind === 'avatar'
      ? ''
      : `<text x="${width * 0.06}" y="${height * 0.72}" font-family="system-ui, sans-serif" font-size="${Math.round(height * 0.07)}" fill="#ffffff" opacity="0.9">${escape(tagline)}</text>`,
    `<text x="${width * 0.06}" y="${height * 0.92}" font-family="system-ui, sans-serif" font-size="${Math.round(height * 0.05)}" fill="#ffffff" opacity="0.7">AI-operated · demo render</text>`,
    '</svg>',
  ].join('')
  return new TextEncoder().encode(svg)
}

export interface FixtureOperatorOptions {
  now: () => number
  latencyMs: number
  dataset: FixtureDataset
}

export class FixtureOperatorClient implements OperatorApiClient {
  readonly #now: () => number
  readonly #latencyMs: number
  readonly #records = new Map<string, FixtureRecord>()
  readonly #credentials = new Set<string>()
  readonly #bindings = new Map<string, XBinding>()
  readonly #labels = new Map<string, LabelAttestation>()
  readonly #handshakes = new Map<string, { coinRef: string; accountId: string; expiresAtUnix: number }>()
  readonly #invoices = new Map<string, InvoiceView[]>()
  readonly #awaiting = new Map<string, PurchaseQueue['awaitingInvoice']>()
  readonly #kyb = new Map<string, KybAttestation>()
  #counter = 0

  constructor(options: FixtureOperatorOptions) {
    this.#now = options.now
    this.#latencyMs = options.latencyMs
    const now = this.#now()
    const { dataset } = options

    // Members first: every coin on the public directory is an active record here.
    for (const vault of dataset.order) {
      const entry = dataset.coins.get(vault)!
      const key = vault.slice(2, 10)
      const coinRef = entry.agent.coinRef
      const spec: QueueSpec = {
        key: coinRef.replace(/^coin_/, ''),
        name: entry.summary.name,
        symbol: entry.summary.symbol,
        state: 'active',
        ageDays: Math.max(1, Math.round((now - entry.coin.identity.launchedAtUnix) / DAY)),
        narrativeSources: Array.from({ length: entry.coin.subject.narrativeSourceCount }, (_, i) => `https://${key}.example/source-${String(i + 1)}`),
        socials: entry.coin.operatedAccounts.find((a) => a.channel === 'x_operator') === undefined ? undefined : { x: entry.coin.operatedAccounts.find((a) => a.channel === 'x_operator')!.handle },
        screening: { ...entry.coin.screening, flags: [...entry.coin.screening.flags] },
        diligence: { admitted: true, blockers: [], retryable: false },
      }
      const record = buildRecord(spec, now, vault, entry.coin.identity.token, null)
      record.candidate = deriveCandidate(record)
      if (entry.coin.narrativeApproved) {
        record.approved = { ...record.candidate, approvedAtUnix: record.createdAtUnix + DAY, approvedBy: 'ops.demo' }
        record.narrativeApproved = true
      }
      this.#records.set(record.id, record)

      // A bound, labelled X account for each coin that operates one.
      for (const account of entry.coin.operatedAccounts) {
        if (account.channel !== 'x_operator') continue
        const accountId = `x_${account.handle}`
        this.#credentials.add(accountId)
        this.#bindings.set(accountId, { accountId, channel: 'x_operator', coinRef, vault, ticker: entry.summary.symbol })
        this.#labels.set(accountId, {
          accountId,
          attestedBy: 'ops.demo',
          attestedAtUnix: now - 20 * DAY,
          expiresAtUnix: now + 10 * DAY,
        })
      }

      // Purchases the runner committed and the operator has not yet evidenced.
      this.#awaiting.set(
        vault,
        entry.receipts
          .filter((item) => item.kind === 'procurement' && !item.executed && item.vendorId !== undefined && item.skuId !== undefined)
          .map((item) => ({
            vendorId: item.vendorId!,
            skuId: item.skuId!,
            quantity: 1,
            quoteCents: item.amountCents,
            proposedAtUnix: item.occurredAtUnix,
          })),
      )
    }

    for (const spec of QUEUE_SPECS) {
      const record = buildRecord(spec, now, fixtureAddressFor(`vault/${spec.key}`), fixtureAddressFor(`token/${spec.key}`), null)
      this.#records.set(record.id, record)
    }

    // One identity attestation on file, and one about to lapse.
    const hydrant = dataset.coins.get(dataset.order[0]!)!
    this.#kyb.set(hydrant.devSigner, {
      devSigner: hydrant.devSigner,
      attestedBy: 'ops.demo',
      providerRef: 'sumsub:apl_7f3c2',
      attestedAtUnix: now - 300 * DAY,
      expiresAtUnix: now + 65 * DAY,
    })
  }

  async #settle<T>(value: T): Promise<T> {
    if (this.#latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#latencyMs))
    return value
  }

  #authorize(auth: OperatorAuth, route: string): void {
    if (auth.token !== FIXTURE_OPERATOR_TOKEN) throw refuse(401, 'unauthorized', 'operator token required', route)
  }

  #require(id: string, route: string): FixtureRecord {
    const record = this.#records.get(id)
    if (record === undefined) throw refuse(404, 'no_such_onboarding', 'no such onboarding', route)
    return record
  }

  #requireByCoinRef(coinRef: string, route: string): FixtureRecord {
    const record = [...this.#records.values()].find((r) => r.coinRef === coinRef)
    if (record === undefined) throw refuse(404, 'no_such_coin', 'no onboarding for that coinRef', route)
    return record
  }

  #advance(record: FixtureRecord, to: OnboardingState, code: string, route: string, detail?: string): void {
    if (!TRANSITIONS[record.state].includes(to)) {
      throw refuse(400, 'illegal_transition', `cannot go from ${record.state} to ${to}`, route)
    }
    const atUnix = this.#now()
    record.history.push({ atUnix, from: record.state, to, code, detail: detail ?? null })
    record.state = to
    record.updatedAtUnix = atUnix
  }

  /** The public record, exactly the fields apps/api's publicRecord() emits: never the sources or socials. */
  #view(record: FixtureRecord): OnboardingRecordView {
    return structuredClone({
      id: record.id,
      state: record.state,
      vault: record.vault,
      token: record.token,
      coinRef: record.coinRef,
      createdAtUnix: record.createdAtUnix,
      updatedAtUnix: record.updatedAtUnix,
      subject: record.subject,
      consent: record.consent,
      screening: record.screening,
      diligence: record.diligence,
      deployedAtUnix: record.deployedAtUnix,
      pointedAtUnix: record.pointedAtUnix,
      activatedAtUnix: record.activatedAtUnix,
      declineReason: record.declineReason,
      narrativeApproved: record.narrativeApproved,
      history: record.history,
    })
  }

  #narrative(record: FixtureRecord): NarrativeView {
    return structuredClone({
      id: record.id,
      state: record.state,
      sources: record.narrativeSources,
      candidate: record.candidate,
      approved: record.approved,
    })
  }

  // --- the onboarding machine ----------------------------------------------

  async listOnboardings(auth: OperatorAuth, state?: OnboardingState): Promise<OnboardingRecordView[]> {
    this.#authorize(auth, 'onboardings')
    return this.#settle(
      [...this.#records.values()]
        .filter((record) => state === undefined || record.state === state)
        .sort((a, b) => b.updatedAtUnix - a.updatedAtUnix)
        .map((record) => this.#view(record)),
    )
  }

  async getOnboarding(auth: OperatorAuth, id: string): Promise<OnboardingRecordView> {
    this.#authorize(auth, 'onboarding')
    return this.#settle(this.#view(this.#require(id, 'onboarding')))
  }

  async runDiligence(auth: OperatorAuth, id: string): Promise<OnboardingRecordView> {
    this.#authorize(auth, 'diligence')
    const record = this.#require(id, 'diligence')
    if (record.state !== 'signed') {
      throw refuse(400, 'illegal_transition', `cannot go from ${record.state} to screened`, 'diligence')
    }
    const now = this.#now()
    record.screening = { verdict: 'CLEAR', paidMediaPermitted: true, flags: [], screenedAtUnix: now }
    record.diligence = { admitted: true, blockers: [], retryable: false }
    this.#advance(record, 'screened', 'diligence_passed', 'diligence')
    return this.#settle(this.#view(record))
  }

  async deploy(auth: OperatorAuth, id: string): Promise<OnboardingRecordView> {
    this.#authorize(auth, 'deploy')
    const record = this.#require(id, 'deploy')
    if (record.state === 'screened') {
      this.#advance(record, 'deployed', 'vault_deployed', 'deploy', fixtureBytes32For(`deploy/${record.id}/${String(this.#now())}`))
      record.deployedAtUnix = record.updatedAtUnix
    } else if (record.state !== 'deployed') {
      throw refuse(400, 'illegal_transition', `cannot deploy from ${record.state}`, 'deploy')
    }
    this.#advance(record, 'awaiting_pointing', 'bound', 'deploy')
    return this.#settle(this.#view(record))
  }

  async confirmPointing(auth: OperatorAuth, id: string): Promise<OnboardingRecordView> {
    this.#authorize(auth, 'pointing')
    const record = this.#require(id, 'pointing')
    if (record.state !== 'awaiting_pointing') {
      throw refuse(400, 'illegal_transition', `cannot go from ${record.state} to pointed`, 'pointing')
    }
    this.#advance(record, 'pointed', 'recipient_confirmed', 'pointing')
    record.pointedAtUnix = record.updatedAtUnix
    return this.#settle(this.#view(record))
  }

  async recordAcceptance(auth: OperatorAuth, id: string): Promise<OnboardingRecordView> {
    this.#authorize(auth, 'acceptance')
    const record = this.#require(id, 'acceptance')
    if (record.state !== 'pointed') {
      throw refuse(400, 'illegal_transition', `cannot go from ${record.state} to accepted`, 'acceptance')
    }
    // The real service reads the vault; the demo's chain agrees with its record.
    this.#advance(record, 'accepted', 'acceptance_confirmed', 'acceptance')
    return this.#settle(this.#view(record))
  }

  async activate(auth: OperatorAuth, id: string): Promise<OnboardingRecordView> {
    this.#authorize(auth, 'activate')
    const record = this.#require(id, 'activate')
    if (record.screening === null) {
      throw refuse(400, 'screening_missing', 'no screening on file; refusing to activate', 'activate')
    }
    if (record.screening.verdict === 'BLOCKED') {
      throw refuse(400, 'screening_blocked', 'the screening verdict is BLOCKED', 'activate')
    }
    if (record.state !== 'accepted') {
      throw refuse(400, 'illegal_transition', `cannot go from ${record.state} to active`, 'activate')
    }
    this.#advance(record, 'active', 'operator_activated', 'activate', fixtureBytes32For(`activate/${record.id}`))
    record.activatedAtUnix = record.updatedAtUnix
    return this.#settle(this.#view(record))
  }

  async decline(auth: OperatorAuth, id: string, code: string, detail?: string): Promise<OnboardingRecordView> {
    this.#authorize(auth, 'decline')
    if (!/^[a-z0-9_]{1,64}$/.test(code)) throw refuse(400, 'bad_code', 'code must be a machine code', 'decline')
    const record = this.#require(id, 'decline')
    this.#advance(record, 'declined', code, 'decline', detail)
    record.declineReason = code
    return this.#settle(this.#view(record))
  }

  // --- narrative -------------------------------------------------------------

  async getNarrative(auth: OperatorAuth, id: string): Promise<NarrativeView> {
    this.#authorize(auth, 'narrative')
    return this.#settle(this.#narrative(this.#require(id, 'narrative')))
  }

  async deriveNarrative(auth: OperatorAuth, id: string): Promise<NarrativeView> {
    this.#authorize(auth, 'narrative_derive')
    const record = this.#require(id, 'narrative_derive')
    if (!PROMOTION_ELIGIBLE_STATES.includes(record.state)) {
      throw refuse(409, 'narrative_not_eligible', 'a narrative is derived once the coin has pointed at the vault', 'narrative_derive')
    }
    if (record.narrativeSources.length === 0) {
      throw refuse(400, 'no_narrative_sources', 'the onboarding named no narrative sources', 'narrative_derive')
    }
    record.candidate = deriveCandidate(record)
    return this.#settle(this.#narrative(record))
  }

  async approveNarrative(auth: OperatorAuth, id: string, approvedBy: string): Promise<NarrativeApproval> {
    this.#authorize(auth, 'narrative_approve')
    if (!OPERATOR_ID.test(approvedBy)) throw refuse(400, 'bad_operator_id', 'approvedBy must be an operator id', 'narrative_approve')
    const record = this.#require(id, 'narrative_approve')
    if (record.candidate === null) {
      throw refuse(400, 'narrative_candidate_missing', 'no narrative candidate to approve', 'narrative_approve')
    }
    if (!PROMOTION_ELIGIBLE_STATES.includes(record.state)) {
      throw refuse(400, 'narrative_not_eligible', 'narrative may only be approved once pointed', 'narrative_approve')
    }
    record.approved = { ...record.candidate, approvedAtUnix: this.#now(), approvedBy }
    record.narrativeApproved = true
    const assets = this.#render(record)
    return this.#settle({ narrative: this.#narrative(record), creative: { rendered: true, narrative: true, assets } })
  }

  // --- creative --------------------------------------------------------------

  #render(record: FixtureRecord): CreativeAssetRef[] {
    record.assets.clear()
    const refs: CreativeAssetRef[] = []
    for (const kind of IMAGE_KINDS) {
      const bytes = renderSvg(kind, record)
      // keccak stands in for sha256 here: the shape (64 hex) is what the
      // console checks, and the web bundle carries no sha256.
      const digest = bytesToHex(keccak256(bytes)).slice(2)
      const ref: CreativeAssetRef = { id: `${record.coinRef}:${kind}:${digest.slice(0, 16)}`, kind, sha256: digest, bytes: bytes.byteLength }
      record.assets.set(kind, { ref, image: { kind, mime: 'image/svg+xml', bytes, sha256: digest } })
      refs.push(ref)
    }
    return refs
  }

  async renderCreative(auth: OperatorAuth, id: string): Promise<CreativeRender> {
    this.#authorize(auth, 'creative_render')
    const record = this.#require(id, 'creative_render')
    if (!PROMOTION_ELIGIBLE_STATES.includes(record.state)) {
      throw refuse(409, 'creative_not_eligible', 'creative is rendered once the coin has pointed at the vault', 'creative_render')
    }
    const assets = this.#render(record)
    return this.#settle({ id: record.id, narrative: record.approved !== null, assets })
  }

  async getCreative(auth: OperatorAuth, id: string, kind: ImageKind): Promise<CreativeImage> {
    this.#authorize(auth, 'creative')
    const record = this.#require(id, 'creative')
    const asset = record.assets.get(kind)
    if (asset === undefined) throw refuse(404, 'creative_not_rendered', 'no rendered asset of that kind for this coin', 'creative')
    return this.#settle({ ...asset.image, bytes: asset.image.bytes.slice() })
  }

  // --- X accounts ------------------------------------------------------------

  async authorizeX(auth: OperatorAuth, coinRef: string, accountId: string): Promise<XAuthorization> {
    this.#authorize(auth, 'x_authorize')
    if (!ACCOUNT_ID.test(accountId)) throw refuse(400, 'bad_accountId', 'accountId is required', 'x_authorize')
    this.#requireByCoinRef(coinRef, 'x_authorize')
    this.#counter += 1
    const state = `demo_state_${this.#counter.toString(36)}`
    const expiresAtUnix = this.#now() + 600
    this.#handshakes.set(state, { coinRef, accountId, expiresAtUnix })
    // The demo has no X to send the operator to. The handshake is treated as
    // redeemed the moment it is issued, so bind can succeed in the same session.
    this.#credentials.add(accountId)
    return this.#settle({
      url: `https://x.com/i/oauth2/authorize?state=${state}&client_id=demo&redirect_uri=${encodeURIComponent('https://receipts.invalid/accounts/x/callback')}`,
      state,
      expiresAtUnix,
    })
  }

  async bindX(auth: OperatorAuth, binding: { accountId: string; coinRef: string; ticker: string }): Promise<XBinding> {
    this.#authorize(auth, 'x_bind')
    if (!ACCOUNT_ID.test(binding.accountId)) throw refuse(400, 'bad_account_id', 'accountId must be a platform user id', 'x_bind')
    const record = this.#requireByCoinRef(binding.coinRef, 'x_bind')
    if (!PROMOTION_ELIGIBLE_STATES.includes(record.state)) {
      throw refuse(409, 'coin_not_eligible', 'an account is bound once the coin has pointed at the vault', 'x_bind')
    }
    if (binding.ticker.toUpperCase() !== record.subject.symbol.toUpperCase()) {
      throw refuse(400, 'ticker_mismatch', 'ticker does not match the onboarded symbol', 'x_bind')
    }
    if (!this.#credentials.has(binding.accountId)) {
      throw refuse(409, 'account_not_authorised', 'complete the OAuth handshake for this account first', 'x_bind')
    }
    const bound: XBinding = { accountId: binding.accountId, channel: 'x_operator', coinRef: binding.coinRef, vault: record.vault, ticker: binding.ticker }
    this.#bindings.set(binding.accountId, bound)
    return this.#settle({ ...bound })
  }

  async attestLabel(auth: OperatorAuth, input: { accountId: string; attestedBy: string; days: number }): Promise<LabelAttestation> {
    this.#authorize(auth, 'x_attest_label')
    if (!ACCOUNT_ID.test(input.accountId)) throw refuse(400, 'bad_account_id', 'accountId must be a platform user id', 'x_attest_label')
    if (!OPERATOR_ID.test(input.attestedBy)) throw refuse(400, 'bad_operator_id', 'attestedBy must be an operator id', 'x_attest_label')
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > 365) {
      throw refuse(400, 'bad_days', 'days must be an integer between 1 and 365', 'x_attest_label')
    }
    const now = this.#now()
    const attestation: LabelAttestation = { accountId: input.accountId, attestedBy: input.attestedBy, attestedAtUnix: now, expiresAtUnix: now + input.days * DAY }
    this.#labels.set(input.accountId, attestation)
    return this.#settle({ ...attestation })
  }

  /** Demo-only: what the console shows beside each coin. The real API has no read for this yet. */
  boundAccounts(): Array<{ binding: XBinding; label: LabelAttestation | null }> {
    return [...this.#bindings.values()].map((binding) => ({ binding, label: this.#labels.get(binding.accountId) ?? null }))
  }

  // --- purchases -------------------------------------------------------------

  async listPurchases(auth: OperatorAuth, vault: string): Promise<PurchaseQueue> {
    this.#authorize(auth, 'purchases')
    const key = vault.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(key)) throw refuse(400, 'bad_vault', 'vault must be a 0x address', 'purchases')
    return this.#settle(
      structuredClone({
        vault: key,
        atUnix: this.#now(),
        awaitingInvoice: this.#awaiting.get(key) ?? [],
        pendingInvoices: this.#invoices.get(key) ?? [],
      }),
    )
  }

  async recordInvoice(auth: OperatorAuth, invoice: InvoiceInput): Promise<{ vault: string; invoice: InvoiceView }> {
    this.#authorize(auth, 'invoices')
    const vault = invoice.vault.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(vault)) throw refuse(400, 'bad_vault', 'vault must be a 0x address', 'invoices')
    if (!Number.isInteger(invoice.quantity) || invoice.quantity < 1) throw refuse(400, 'bad_quantity', 'quantity must be a positive integer', 'invoices')
    const match = USD_DECIMAL.exec(invoice.amountUsd)
    if (match === null) throw refuse(400, 'bad_amount', 'amountUsd must be digits with at most two decimals', 'invoices')
    const amountCents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
    if (amountCents === 0n) throw refuse(400, 'bad_amount', 'amountUsd must be positive', 'invoices')
    if (!HEX_BYTES.test(invoice.vendorCountersig)) throw refuse(400, 'bad_countersig', 'vendorCountersig must be 0x-hex bytes', 'invoices')
    const now = this.#now()
    if (!Number.isInteger(invoice.issuedAtUnix) || invoice.issuedAtUnix < 1 || invoice.issuedAtUnix > now + 300) {
      throw refuse(400, 'bad_issuedAtUnix', 'issuedAtUnix must be unix seconds, not in the future', 'invoices')
    }

    const invoiceHash = bytesToHex(
      keccak256(
        new TextEncoder().encode(
          [invoice.vendorId, invoice.skuId, String(invoice.quantity), amountCents.toString(), String(invoice.issuedAtUnix)].join('|'),
        ),
      ),
    )
    if (invoice.invoiceHash !== undefined && invoice.invoiceHash.length > 0 && invoice.invoiceHash.toLowerCase() !== invoiceHash) {
      throw refuse(400, 'invoice_hash_mismatch', 'the supplied invoiceHash is not the hash of this invoice', 'invoices')
    }
    const pending = this.#invoices.get(vault) ?? []
    if (pending.some((i) => i.invoiceHash === invoiceHash)) {
      throw refuse(409, 'invoice_conflict', 'an invoice with this hash is already on file for the vault', 'invoices')
    }
    const view: InvoiceView = {
      vendorId: invoice.vendorId,
      skuId: invoice.skuId,
      quantity: invoice.quantity,
      amountCents,
      invoiceHash,
      issuedAtUnix: invoice.issuedAtUnix,
      baseline: invoice.baseline === undefined ? null : { boosts: invoice.baseline.boosts ?? null, rank: invoice.baseline.rank ?? null },
    }
    this.#invoices.set(vault, [...pending, view])
    // Evidenced: off the to-do list, as the real store clears it.
    this.#awaiting.set(
      vault,
      (this.#awaiting.get(vault) ?? []).filter((p) => !(p.skuId === invoice.skuId && p.quantity === invoice.quantity)),
    )
    return this.#settle({ vault, invoice: structuredClone(view) })
  }

  // --- identity --------------------------------------------------------------

  async attestKyb(auth: OperatorAuth, input: KybAttestationInput): Promise<KybAttestation> {
    this.#authorize(auth, 'kyb_attest')
    const devSigner = input.devSigner.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(devSigner)) throw refuse(400, 'bad_devSigner', 'devSigner must be a 0x address', 'kyb_attest')
    const now = this.#now()
    const attestedAtUnix = input.attestedAtUnix ?? now
    if (input.attestedBy.length === 0) throw refuse(400, 'bad_attested_by', 'attestedBy is required', 'kyb_attest')
    if (input.providerRef.length === 0) throw refuse(400, 'bad_provider_ref', 'providerRef is required', 'kyb_attest')
    if (!Number.isInteger(input.expiresAtUnix) || input.expiresAtUnix <= now) {
      throw refuse(400, 'attestation_expired', 'expiresAtUnix must be in the future', 'kyb_attest')
    }
    if (attestedAtUnix > now) throw refuse(400, 'attestation_in_future', 'attestedAtUnix must not be in the future', 'kyb_attest')
    const attestation: KybAttestation = { devSigner, attestedBy: input.attestedBy, providerRef: input.providerRef, attestedAtUnix, expiresAtUnix: input.expiresAtUnix }
    this.#kyb.set(devSigner, attestation)
    return this.#settle({ ...attestation })
  }

  async getKyb(auth: OperatorAuth, devSigner: string): Promise<KybLookup> {
    this.#authorize(auth, 'kyb')
    const key = devSigner.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(key)) throw refuse(400, 'bad_dev_signer', 'devSigner must be a 0x address', 'kyb')
    const attestation = this.#kyb.get(key)
    if (attestation === undefined) throw refuse(404, 'no_attestation', 'no identity attestation on file', 'kyb')
    return this.#settle({ attestation: { ...attestation }, current: attestation.expiresAtUnix > this.#now() })
  }
}

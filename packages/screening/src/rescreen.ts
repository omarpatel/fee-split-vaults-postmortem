/**
 * Continuous re-screening.
 *
 * THE HOLE THIS CLOSES. Launch metadata on this chain can be mutable after
 * launch. A coin can therefore be onboarded with a clean name and description,
 * pass every stage, receive service, and then be edited into something we would
 * never have admitted - with our disclosure, our accounts, and our media spend
 * already attached to it. A one-time admission check is not a control; it is a
 * snapshot of a value that the counterparty can change at will.
 *
 * So screening is a subscription, not an event. Every subject is re-screened
 * when its metadata hash changes, when its screening ages out (a shorter clock
 * for mutable metadata), and on a floor cadence regardless.
 *
 * A NEW METADATA VERSION IS A NEW SUBJECT, so its flags start empty - that is
 * not a stage clearing a prior stage's hit, it is a different document. What
 * does NOT reset is the block: `ScreeningHistory` re-attaches `previously_blocked`
 * so a rename cannot launder a coin that was already refused.
 */

import type { ScreeningVerdict } from '@fee-split-vaults/core'
import type { ScreeningEngine } from './pipeline.js'
import { declineRecordFor, type DeclineListSink } from './declineList.js'
import { metadataHashOf, type ScreeningReport, type SubjectMetadata } from './types.js'

export interface MetadataSource {
  /** Current on-chain / off-chain metadata for a token. Untrusted. */
  fetch(token: string): Promise<SubjectMetadata>
}

export interface RescreenState {
  token: string
  lastHash: string
  lastVerdict: ScreeningVerdict
  lastScreenedAtUnix: number
  nextDueAtUnix: number
}

export interface RescreenStore {
  get(token: string): RescreenState | undefined
  put(state: RescreenState): void
  due(nowUnix: number): RescreenState[]
  all(): RescreenState[]
}

export class InMemoryRescreenStore implements RescreenStore {
  private readonly states = new Map<string, RescreenState>()
  get(token: string): RescreenState | undefined {
    return this.states.get(token.toLowerCase())
  }
  put(state: RescreenState): void {
    this.states.set(state.token.toLowerCase(), state)
  }
  due(nowUnix: number): RescreenState[] {
    return [...this.states.values()].filter((s) => s.nextDueAtUnix <= nowUnix)
  }
  all(): RescreenState[] {
    return [...this.states.values()]
  }
}

/**
 * What the rest of the system must do about a re-screen. Screening never
 * performs these - it holds no keys and no publishing capability. It reports.
 */
export type RescreenAction =
  | 'none'
  | 'halt_paid_media'
  | 'halt_all_publishing'
  | 'publish_decline'
  | 'release_dev_fees'
  | 'requeue_human_review'
  | 'escalate_out_of_band'

export interface RescreenOutcome {
  token: string
  changed: boolean
  previousVerdict?: ScreeningVerdict
  currentVerdict: ScreeningVerdict
  worsened: boolean
  report: ScreeningReport
  actions: RescreenAction[]
}

export interface RescreenConfig {
  /** Floor cadence for immutable metadata. */
  intervalSeconds: number
  /** Tighter cadence while the metadata can still be edited. */
  mutableIntervalSeconds: number
}

export const DEFAULT_RESCREEN_CONFIG: RescreenConfig = {
  intervalSeconds: 24 * 60 * 60,
  mutableIntervalSeconds: 60 * 60,
}

const VERDICT_RANK: Record<ScreeningVerdict, number> = { CLEAR: 0, RESTRICTED: 1, BLOCKED: 2 }

export class RescreenWatcher {
  constructor(
    private readonly engine: ScreeningEngine,
    private readonly source: MetadataSource,
    private readonly store: RescreenStore = new InMemoryRescreenStore(),
    private readonly declineList?: DeclineListSink,
    private readonly config: RescreenConfig = DEFAULT_RESCREEN_CONFIG,
  ) {}

  /** Register a token for continuous re-screening from an initial report. */
  register(report: ScreeningReport): void {
    this.store.put(this.stateFor(report))
  }

  async check(token: string, nowUnix: number): Promise<RescreenOutcome> {
    const previous = this.store.get(token)
    const metadata = await this.source.fetch(token)
    const hash = metadataHashOf(metadata)
    const changed = previous !== undefined && previous.lastHash !== hash

    const report = await this.engine.screen(metadata)
    this.store.put(this.stateFor(report))

    const previousVerdict = previous?.lastVerdict
    const worsened =
      previousVerdict !== undefined &&
      VERDICT_RANK[report.verdict] > VERDICT_RANK[previousVerdict]

    const actions = this.actionsFor(report, worsened, changed)
    if (actions.includes('publish_decline') && this.declineList !== undefined) {
      await this.declineList.publish(declineRecordFor(report))
    }

    const outcome: RescreenOutcome = {
      token,
      changed,
      currentVerdict: report.verdict,
      worsened,
      report,
      actions,
    }
    if (previousVerdict !== undefined) outcome.previousVerdict = previousVerdict
    return outcome
  }

  /** Every token whose cadence has elapsed. Screening is a subscription. */
  async checkDue(nowUnix: number): Promise<RescreenOutcome[]> {
    const outcomes: RescreenOutcome[] = []
    for (const state of this.store.due(nowUnix)) {
      outcomes.push(await this.check(state.token, nowUnix))
    }
    return outcomes
  }

  private stateFor(report: ScreeningReport): RescreenState {
    const interval = report.subject.metadataMutable
      ? this.config.mutableIntervalSeconds
      : this.config.intervalSeconds
    return {
      token: report.subject.token,
      lastHash: report.subject.metadataHash,
      lastVerdict: report.verdict,
      lastScreenedAtUnix: report.screenedAtUnix,
      nextDueAtUnix: Math.min(report.screenedAtUnix + interval, report.expiresAtUnix),
    }
  }

  private actionsFor(
    report: ScreeningReport,
    worsened: boolean,
    changed: boolean,
  ): RescreenAction[] {
    const actions: RescreenAction[] = []
    if (report.verdict === 'BLOCKED') {
      actions.push('halt_all_publishing', 'publish_decline', 'release_dev_fees')
    } else if (report.verdict === 'RESTRICTED') {
      actions.push('halt_paid_media')
      if (changed || worsened) actions.push('requeue_human_review')
    } else if (changed) {
      // A clean rewrite still invalidates every approved creative: the human
      // approved a specific subject, not a token id.
      actions.push('requeue_human_review')
    }
    if (this.engine.needsOutOfBandEscalation(report)) actions.push('escalate_out_of_band')
    return actions.length === 0 ? ['none'] : actions
  }
}

/** In-memory metadata source for tests and local runs. */
export class FakeMetadataSource implements MetadataSource {
  private readonly byToken = new Map<string, SubjectMetadata>()

  set(metadata: SubjectMetadata): void {
    this.byToken.set(metadata.token.toLowerCase(), metadata)
  }

  async fetch(token: string): Promise<SubjectMetadata> {
    const metadata = this.byToken.get(token.toLowerCase())
    if (metadata === undefined) throw new Error(`no metadata for token ${token}`)
    return metadata
  }
}

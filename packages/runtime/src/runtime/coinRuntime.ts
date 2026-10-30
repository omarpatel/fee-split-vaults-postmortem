import type { Address, Digest, ImageRef, NarrativeProfile } from '@fee-split-vaults/core'
import { TIERS } from '../protocol.js'
import type { TierId } from '../protocol.js'
import { MODEL, supportsAdaptiveThinking, supportsEffort } from '../model/ids.js'
import type { ModelClient, ModelUsage } from '../model/client.js'
import { ZERO_USAGE, addUsage } from '../model/client.js'
import { batchRouted } from '../model/routing.js'
import { CostGovernor } from '../cost/governor.js'
import type { DegradeLevel, GovernorOptions } from '../cost/governor.js'
import { assembleCorpus } from '../corpus/assemble.js'
import type { AssembleOptions, AssembledCorpus, RawMessage } from '../corpus/assemble.js'
import { closedWindowAt } from '../corpus/window.js'
import type { CorpusWindow } from '../corpus/window.js'
import { Reader } from '../cognition/reader.js'
import { Planner } from '../cognition/planner.js'
import type { LinkRef, PlannerSkuView, Proposal, ProposalViolation } from '../cognition/plannerTools.js'
import { DivergenceDetector, toObservation } from '../divergence/detector.js'
import type { DivergenceVerdict } from '../divergence/detector.js'
import { hashUserId } from '../isolation/userId.js'

/**
 * One coin, one runtime, no shared mutable state.
 *
 * Isolation here is structural rather than conventional. Each instance owns its
 * own governor, its own divergence history, its own catalog view, and its own
 * hashed user_id. Nothing on this class is static. Two coins served by the same
 * process share exactly one thing - the stateless ModelClient - and every request
 * that goes through it carries a different user_id.
 *
 * Cross-coin bleed is blocked at the boundary rather than trusted to caller
 * discipline: every RawMessage carries a coin binding stamped by trusted ingest,
 * and the assembler throws on a mismatch.
 */

export interface CoinRuntimeConfig {
  /** Opaque, operator-assigned, [A-Za-z0-9_-]. Not the token address. */
  coinRef: string
  vault: Address
  tier: TierId
  /** Operator secret. Never logged, never sent. */
  userIdSalt: string
  catalog: readonly PlannerSkuView[]
  links: readonly LinkRef[]
  /** Generated images the planner may attach by id. Empty when the coin has none. */
  imageRefs: readonly ImageRef[]
  /** Operator-approved narrative, or null when the coin has none. Rendered by trusted code only. */
  narrative: NarrativeProfile | null
  /** False under a RESTRICTED screening verdict: organic operations only. */
  paidMediaPermitted: boolean
  assemble?: AssembleOptions
  governor?: Omit<GovernorOptions, 'tier'>
}

export interface WindowOutcome {
  coinRef: string
  window: CorpusWindow
  digest?: Digest
  verdict?: DivergenceVerdict
  proposals: Proposal[]
  /** Proposals the freeze removed. Kept so a human can see what was suppressed. */
  suppressed: Array<{ proposal: Proposal; reason: string }>
  violations: ProposalViolation[]
  usage: ModelUsage
  costUsd: number
  degradeLevel: DegradeLevel
  skipped?: 'tier_has_no_model' | 'budget_suspended' | 'budget_insufficient' | 'empty_window'
  notes: string[]
}

export class CoinRuntime {
  readonly coinRef: string
  readonly userIdHash: string
  private readonly reader: Reader
  private readonly governor: CostGovernor
  private readonly detector: DivergenceDetector

  constructor(
    private readonly config: CoinRuntimeConfig,
    private readonly model: ModelClient,
    overrides: { governor?: CostGovernor; detector?: DivergenceDetector } = {},
  ) {
    this.coinRef = config.coinRef
    this.userIdHash = hashUserId(config.userIdSalt, config.coinRef)
    this.reader = new Reader(model)
    this.governor =
      overrides.governor ?? new CostGovernor({ tier: config.tier, ...(config.governor ?? {}) })
    this.detector = overrides.detector ?? new DivergenceDetector()
  }

  get costGovernor(): CostGovernor {
    return this.governor
  }

  get divergence(): DivergenceDetector {
    return this.detector
  }

  /**
   * Run one scheduled window. Called by a clock, never by an inbound message.
   *
   * `messages` must already be scoped to this coin by trusted ingest; the
   * assembler enforces that and throws otherwise.
   */
  async runWindow(nowUnix: number, messages: readonly RawMessage[]): Promise<WindowOutcome> {
    const window = closedWindowAt(this.coinRef, nowUnix)
    const base: WindowOutcome = {
      coinRef: this.coinRef,
      window,
      proposals: [],
      suppressed: [],
      violations: [],
      usage: { ...ZERO_USAGE },
      costUsd: 0,
      degradeLevel: this.governor.level(nowUnix),
      notes: [],
    }

    if (!TIERS[this.config.tier].usesModel) {
      return { ...base, skipped: 'tier_has_no_model' }
    }

    const readerPlan = this.governor.plan('reader', nowUnix, { urgent: true })
    if (!readerPlan.allowed) {
      return { ...base, skipped: 'budget_suspended', notes: [readerPlan.reason] }
    }

    const corpus = assembleCorpus(window, messages, this.config.assemble)
    if (corpus.admittedMessageCount === 0) {
      // No model call at all. A silent window costs nothing, which is the whole
      // point of a fixed schedule with no wake-on-mention path.
      return { ...base, skipped: 'empty_window' }
    }

    const readerEstimate = this.estimateReaderCost(corpus)
    if (!this.governor.affords(nowUnix, readerEstimate)) {
      return {
        ...base,
        skipped: 'budget_insufficient',
        notes: [`reader call estimated at $${readerEstimate.toFixed(4)} would exceed the day`],
      }
    }

    const readerResult = readerPlan.viaBatch
      ? await new Reader(batchRouted(this.model, `${window.windowId}:reader`)).read(
          corpus,
          this.userIdHash,
        )
      : await this.reader.read(corpus, this.userIdHash)
    let usage = readerResult.usage
    let costUsd = this.governor.record(nowUnix, MODEL.haiku45, readerResult.usage, {
      batch: readerResult.batched,
    })
    const notes: string[] = []
    if (readerResult.rejectedGists > 0) {
      notes.push(`${String(readerResult.rejectedGists)} gist(s) dropped on the airlock boundary`)
    }

    const observation = toObservation(readerResult.digest)
    const verdict = this.detector.evaluate(observation)
    this.detector.observe(observation)

    if (verdict.freeze === 'all') {
      // Freeze before the planner call, not after it. The planner cannot be
      // trusted with a histogram we already believe is being steered, and not
      // calling it is also the cheaper answer.
      return {
        ...base,
        digest: readerResult.digest,
        verdict,
        usage,
        costUsd,
        degradeLevel: this.governor.level(nowUnix),
        proposals: [
          {
            kind: 'escalation',
            reason: 'anomalous_signal',
            note: `proposals frozen: ${verdict.reason}`,
          },
        ],
        notes: [...notes, verdict.reason],
      }
    }

    const plannerPlan = this.governor.plan('planner', nowUnix, { urgent: false })
    if (!plannerPlan.allowed) {
      return {
        ...base,
        digest: readerResult.digest,
        verdict,
        usage,
        costUsd,
        degradeLevel: plannerPlan.level,
        skipped: 'budget_suspended',
        notes: [...notes, plannerPlan.reason],
      }
    }

    const paidMediaPermitted = this.config.paidMediaPermitted && verdict.freeze === 'none'
    const planner = new Planner(
      plannerPlan.viaBatch ? batchRouted(this.model, `${window.windowId}:planner`) : this.model,
      {
        model: plannerPlan.model,
        catalog: this.config.catalog,
        links: this.config.links,
        imageRefs: this.config.imageRefs,
        narrative: this.config.narrative,
        paidMediaPermitted,
        ...(supportsEffort(plannerPlan.model) ? { effort: 'low' as const } : {}),
        ...(supportsAdaptiveThinking(plannerPlan.model)
          ? { thinking: 'adaptive' as const }
          : {}),
      },
    )

    const plan = await planner.plan(readerResult.digest, this.userIdHash)
    usage = addUsage(usage, plan.usage)
    costUsd += this.governor.record(nowUnix, plan.model, plan.usage, { batch: plan.batched })

    const suppressed: Array<{ proposal: Proposal; reason: string }> = []
    const kept: Proposal[] = []
    for (const proposal of plan.proposals) {
      if (proposal.kind === 'purchase' && verdict.freeze === 'purchases') {
        suppressed.push({ proposal, reason: verdict.reason })
        continue
      }
      kept.push(proposal)
    }

    return {
      coinRef: this.coinRef,
      window,
      digest: readerResult.digest,
      verdict,
      proposals: kept,
      suppressed,
      violations: plan.violations,
      usage,
      costUsd,
      degradeLevel: this.governor.level(nowUnix),
      notes: [...notes, ...(verdict.freeze === 'none' ? [] : [verdict.reason])],
    }
  }

  /**
   * Estimate before calling, so the last call of a day cannot overshoot by its
   * own full cost. Output is estimated at the cap because a truncated digest is
   * unusable and would be retried.
   */
  private estimateReaderCost(corpus: AssembledCorpus): number {
    const usage: ModelUsage = {
      ...ZERO_USAGE,
      inputTokens: corpus.estimatedTokens + 600,
      outputTokens: 512,
    }
    return this.governor.estimate(MODEL.haiku45, usage)
  }
}

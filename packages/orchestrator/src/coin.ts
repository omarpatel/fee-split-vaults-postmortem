/**
 * ONE COIN, ONE TICKER. This is where the packages actually meet.
 *
 * The pipeline, in order, and each stage runs only on inputs the previous one
 * actually produced:
 *
 *   indexer -> ledger -> tier -> runtime -> broker -> publisher -> receipts
 *
 * FOUR PROPERTIES THIS CLASS HOLDS STRUCTURALLY.
 *
 * ISOLATION. Nothing on this class is static. Each instance owns its own
 * CoinRuntime, cost governor, divergence detector and cursor. The only shared
 * object is a stateless ModelClient, and every request through it carries a
 * per-coin hashed user id. Every cross-boundary hand-off asserts the coin ref.
 *
 * THE AIRLOCK. This class never reads a field of a RawMessage. It fetches an
 * opaque array from trusted ingest and hands it to CoinRuntime.runWindow, which
 * assembles the corpus deterministically and throws on a cross-coin binding.
 * The only thing that comes back across is a validated Digest and a closed set
 * of proposals. isolation.spec.ts asserts, by reading this package's own source,
 * that no `.text` access exists anywhere in it.
 *
 * FIXED SCHEDULE. tick() is called by a clock. There is no method on this class
 * that an inbound message can call, and no branch in it that depends on message
 * volume other than through the Digest's counters.
 *
 * FAIL CLOSED. Every phase either produces its output or records a refusal with
 * a machine code. A phase that refused does not hand a default downstream: no
 * QF means no tier change, no screening means no paid media, no price means no
 * spend, a halt means no spend at all.
 */

import type {
  Address,
  Asset,
  Channel,
  Digest,
  ImageRef,
  NarrativeProfile,
  QfMeasurement,
  QualificationSignals,
  ScreeningResult,
  Vault,
} from '@fee-split-vaults/core'
import type { BudgetLedgerView, SpendCounters } from '@fee-split-vaults/broker'
import { SignalsUnavailableError, computeQf, type CoinBinding, type FeePosting } from '@fee-split-vaults/indexer'
import type { Ledger, LedgerStore } from '@fee-split-vaults/ledger'
import type { ModelClient, PlannerSkuView, Proposal, RawMessage, WindowOutcome } from '@fee-split-vaults/runtime'
import { CoinRuntime, CostGovernor, DivergenceDetector } from '@fee-split-vaults/runtime'
import type { LinkRef } from '@fee-split-vaults/runtime'
import { TIERS } from '../../../config/protocol.js'
import type { TierId } from '../../../config/protocol.js'

import { accruePostings, recordChainMovements, type AccrualResult, type MovementResult } from './accrual.js'
import { buildBudgetLedgerView, buildSpendCounters } from './budget.js'
import { runDeskPhase, type DeskPhaseResult } from './desk.js'
import { FailClosed, OrchestratorError, assertSameCoin, type TickPhase } from './errors.js'
import type {
  AssetRegistry,
  ChainReadModel,
  Clock,
  DeskPort,
  EscalationSink,
  FleetCounters,
  MessageSource,
  ScreeningStore,
  UsdPriceBook,
  VaultRepository,
} from './ports.js'
import { requirePrice, toIndexerOracle } from './prices.js'
import { publishProposals, type PublishAttempt, type PublishDeps } from './publish.js'
import { decideCadence } from './schedule.js'
import { attemptSpend, type SpendDeps, type SpendOutcome } from './spend.js'
import { evaluateTier, type TierDecision } from './tiers.js'

const QF_PRICE_MAX_AGE_SECONDS = 172_800
const SPEND_PRICE_MAX_AGE_SECONDS = 900
/**
 * How far back the measurement reads. computeQf's sustain lookback defaults to
 * 30 days, so a shorter read here would silently cap sustainedDays and make the
 * 14-day T2/T3 gates unreachable.
 */
const QF_LOOKBACK_SECONDS = 31 * 86_400

export interface SignalsProvider {
  /** Throws SignalsUnavailableError rather than reporting a confident zero. */
  compute(binding: CoinBinding, nowUnix: number): Promise<QualificationSignals>
}

export interface CoinTickerConfig {
  /** Operator-assigned, opaque, [A-Za-z0-9_-]. Never the token address. */
  coinRef: string
  vault: Address
  token: Address
  /** The quote asset this coin's fees and budget are denominated in. */
  quoteAsset: string
  /** Operator secret, at least 32 chars. Splits abuse history if rotated. */
  userIdSalt: string
  /** What the planner may propose. Ids and cost bands only; never a price. */
  catalog: readonly PlannerSkuView[]
  /** Allowlisted destinations by id. The URL never enters a prompt. */
  linkRefs: readonly LinkRef[]
  /** id -> URL. Resolved only after the model is out of the loop. */
  linkUrls: ReadonlyMap<string, string>
  /** Generated images the planner may attach, by id. Bytes are resolved by the publisher. */
  imageRefs: readonly ImageRef[]
  /** Operator-approved narrative rendered into the planner's per-coin block; null when none. */
  narrative: NarrativeProfile | null
  accounts: ReadonlyMap<Channel, string>
  /** Per-dev, signed, recorded off the model path. */
  relatedPartyOptIn: boolean
  /** Sweep interval floor for a spending vault, seconds. */
  sweepIntervalSeconds: number
}

export interface CoinTickerDeps {
  clock: Clock
  chain: ChainReadModel
  ledger: Ledger
  ledgerStore: LedgerStore
  assets: AssetRegistry
  prices: UsdPriceBook
  vaults: VaultRepository
  screening: ScreeningStore
  messages: MessageSource
  model: ModelClient
  /** Absent means no desk: questions are corpus only and the phase records `desk_unavailable`. */
  desk?: DeskPort
  signals?: SignalsProvider
  fleet: FleetCounters
  escalations: EscalationSink
  spend: Omit<SpendDeps, 'ledger' | 'fleet'>
  publish: Omit<PublishDeps, 'links' | 'accounts'>
}

export interface PhaseRefusal {
  phase: TickPhase
  code: string
  detail: string
}

export interface CoinTickResult {
  coinRef: string
  vault: Address
  atUnix: number
  ranChainPoll: boolean
  ranCognition: boolean
  accrual?: AccrualResult
  movements?: MovementResult
  qf?: QfMeasurement
  signals?: QualificationSignals
  tier?: TierDecision
  window?: WindowOutcome
  desk?: DeskPhaseResult
  spends: SpendOutcome[]
  publishes: PublishAttempt[]
  refusals: PhaseRefusal[]
  /** Earliest instant this coin has work again. A scheduler sleeps to it. */
  nextDueUnix: number
}

export class CoinTicker {
  readonly coinRef: string
  readonly vault: Address

  readonly #config: CoinTickerConfig
  readonly #deps: CoinTickerDeps
  /** Per-coin, never shared, and preserved across runtime rebuilds. */
  readonly #governor: CostGovernor
  readonly #detector: DivergenceDetector

  #runtime: CoinRuntime
  #runtimeTier: TierId
  #runtimePaidMedia: boolean
  #lastChainPollUnix: number | undefined
  #lastCognitionWindowId: string | undefined

  constructor(config: CoinTickerConfig, deps: CoinTickerDeps, initialTier: TierId = 'T0') {
    this.#config = config
    this.#deps = deps
    this.coinRef = config.coinRef
    this.vault = config.vault
    this.#governor = new CostGovernor({ tier: initialTier })
    this.#detector = new DivergenceDetector()
    this.#runtimeTier = initialTier
    this.#runtimePaidMedia = false
    this.#runtime = this.#buildRuntime(initialTier, false)
  }

  get costGovernor(): CostGovernor {
    return this.#governor
  }

  get divergence(): DivergenceDetector {
    return this.#detector
  }

  #buildRuntime(tier: TierId, paidMediaPermitted: boolean): CoinRuntime {
    return new CoinRuntime(
      {
        coinRef: this.#config.coinRef,
        vault: this.#config.vault,
        tier,
        userIdSalt: this.#config.userIdSalt,
        catalog: this.#config.catalog,
        links: this.#config.linkRefs,
        imageRefs: this.#config.imageRefs,
        narrative: this.#config.narrative,
        paidMediaPermitted,
      },
      this.#deps.model,
      // The governor and detector survive the rebuild ON PURPOSE. If a tier
      // change reset the divergence history, an attacker who could provoke a
      // tier change would get a free reset of the anomaly baseline.
      { governor: this.#governor, detector: this.#detector },
    )
  }

  #syncRuntime(tier: TierId, paidMediaPermitted: boolean): void {
    if (tier === this.#runtimeTier && paidMediaPermitted === this.#runtimePaidMedia) return
    this.#runtime = this.#buildRuntime(tier, paidMediaPermitted)
    this.#runtimeTier = tier
    this.#runtimePaidMedia = paidMediaPermitted
  }

  async tick(): Promise<CoinTickResult> {
    const nowUnix = this.#deps.clock.nowUnix()
    const refusals: PhaseRefusal[] = []
    const result: CoinTickResult = {
      coinRef: this.coinRef,
      vault: this.vault,
      atUnix: nowUnix,
      ranChainPoll: false,
      ranCognition: false,
      spends: [],
      publishes: [],
      refusals,
      nextDueUnix: nowUnix,
    }

    const refuse = (phase: TickPhase, code: string, detail: string): void => {
      refusals.push({ phase, code, detail })
    }

    // ---------------------------------------------------------------- guard --
    const vault = await this.#deps.vaults.get(this.vault)
    if (vault === undefined) {
      refuse('guard', 'vault_unknown', `no vault record for ${this.vault}`)
      return result
    }
    if (vault.token !== this.#config.token) {
      throw new OrchestratorError(
        `vault ${this.vault} is bound to ${vault.token}, ticker to ${this.#config.token}`,
        'vault_token_mismatch',
        'guard',
      )
    }

    const asset = this.#deps.assets.get(this.#config.quoteAsset)
    if (asset === undefined) {
      refuse('guard', 'asset_unregistered', `quote asset ${this.#config.quoteAsset} is not registered`)
      return result
    }

    const binding = await this.#deps.chain.binding(this.#config.token)
    const halts = await this.#deps.chain.halts(this.#config.token)
    for (const halt of halts) {
      await this.#deps.escalations.raise({
        coinRef: this.coinRef,
        vault: this.vault,
        kind: 'indexer_halt',
        code: halt.reason,
        detail: `${halt.reason} on ${this.#config.token}`,
        raisedAtUnix: nowUnix,
      })
    }
    const halted = halts.length > 0

    const screening = await this.#deps.screening.latest(this.#config.token)
    if (screening === undefined) {
      refuse('guard', 'screening_missing', 'no screening on file; paid media denied')
      await this.#deps.escalations.raise({
        coinRef: this.coinRef,
        vault: this.vault,
        kind: 'screening_missing',
        code: 'screening_missing',
        detail: `no screening result for ${this.#config.token}`,
        raisedAtUnix: nowUnix,
      })
    } else if (screening.verdict === 'BLOCKED') {
      await this.#deps.escalations.raise({
        coinRef: this.coinRef,
        vault: this.vault,
        kind: 'screening_blocked',
        code: 'screening_blocked',
        detail: screening.flags.join(','),
        raisedAtUnix: nowUnix,
      })
    }

    // Operations permission is a SCREENING fact, not a tier fact. A tick that
    // could not measure QF must not silence the desk - that would turn a
    // measurement outage into a service outage - so this is computed from the
    // screening directly and the tier decision only reports the same thing.
    const operationsPermitted = screening?.verdict !== 'BLOCKED'
    const spendAuthorityActive = vault.state === 'ACTIVE' && !halted && operationsPermitted

    const cadence = decideCadence(nowUnix, {
      coinRef: this.coinRef,
      ageSeconds: nowUnix - vault.deployedAtUnix,
      spendAuthorityActive,
      sweepIntervalSeconds: this.#config.sweepIntervalSeconds,
      ...(this.#lastChainPollUnix === undefined
        ? {}
        : { lastChainPollUnix: this.#lastChainPollUnix }),
      ...(this.#lastCognitionWindowId === undefined
        ? {}
        : { lastCognitionWindowId: this.#lastCognitionWindowId }),
    })
    result.nextDueUnix = cadence.nextDueUnix

    // --------------------------------------------------------- ingest+accrual --
    //
    // The measurement window is read on EVERY tick, not only on a chain-poll
    // tick. ChainReadModel is a read model over what the indexer has already
    // ingested, so this is a store read rather than a network call - and
    // measuring only on poll ticks would make QF read zero on every other tick
    // and oscillate the tier T1 -> T0 -> T1. A confident zero is exactly the
    // failure mode the fail-closed rule exists to prevent, and "the postings I
    // happened to fetch this tick" is how you manufacture one.
    let postings: readonly FeePosting[] = []
    let postingsRead = false
    try {
      postings = await this.#deps.chain.postings(
        this.vault,
        nowUnix - QF_LOOKBACK_SECONDS,
        nowUnix,
      )
      postingsRead = true
    } catch (error) {
      refuse('ingest', codeOf(error, 'postings_read_failed'), messageOf(error))
    }

    if (cadence.runChainPoll && postingsRead) {
      result.ranChainPoll = true
      const from = this.#lastChainPollUnix ?? nowUnix - QF_LOOKBACK_SECONDS
      this.#lastChainPollUnix = nowUnix
      try {
        result.accrual = await accruePostings(this.#deps.ledger, postings, this.#deps.assets)
      } catch (error) {
        refuse('accrual', codeOf(error, 'accrual_failed'), messageOf(error))
      }
      try {
        // Accrual first, movements second. An allocation is a split of income
        // already recognised, so recording it before the accrual it splits
        // would fail the sign rule and be refused - correctly, but noisily.
        const [claims, allocations] = await Promise.all([
          this.#deps.chain.claims(this.vault, from, nowUnix),
          this.#deps.chain.allocations(this.vault, from, nowUnix),
        ])
        result.movements = await recordChainMovements(this.#deps.ledger, claims, allocations)
        for (const refusal of result.movements.refusals) {
          refuse('accrual', refusal.code, `${refusal.ref}: ${refusal.detail}`)
        }
      } catch (error) {
        refuse('accrual', codeOf(error, 'movements_failed'), messageOf(error))
      }
    }

    // -------------------------------------------------------------- measure --
    if (binding === undefined) {
      refuse('measure', 'binding_unresolved', 'no CoinBinding; fees are unattributable')
    } else if (!postingsRead) {
      // No read means no measurement. It does NOT mean a measurement of zero.
      refuse('measure', 'postings_unavailable', 'the posting store could not be read this tick')
    } else {
      try {
        const qfResult = computeQf({
          binding,
          postings,
          assets: new Map(this.#deps.assets.all().map((a) => [a.address, a])),
          prices: toIndexerOracle(this.#deps.prices),
          options: {
            nowUnix,
            gateQfPerDay: TIERS[vault.tier].gateQfPerDay,
            maxPriceAgeSeconds: QF_PRICE_MAX_AGE_SECONDS,
          },
        })
        result.qf = qfResult.measurement
      } catch (error) {
        refuse('measure', codeOf(error, 'qf_failed'), messageOf(error))
      }

      if (this.#deps.signals !== undefined) {
        try {
          result.signals = await this.#deps.signals.compute(binding, nowUnix)
        } catch (error) {
          // Unavailable signals block an UPGRADE and nothing else. That is the
          // indexer's own posture: a refusal beats a confident wrong reading.
          refuse(
            'measure',
            error instanceof SignalsUnavailableError ? 'signals_unavailable' : 'signals_failed',
            messageOf(error),
          )
        }
      }
    }

    // ----------------------------------------------------------------- tier --
    let tier: TierDecision | undefined
    if (result.qf !== undefined && binding !== undefined) {
      tier = evaluateTier({
        currentTier: vault.tier,
        qf: result.qf,
        ...(result.signals === undefined ? {} : { signals: result.signals }),
        ...(screening === undefined ? {} : { screening }),
        budgetBps: vault.budgetBps,
        buybackEnabled: binding.buybackEnabled,
        creatorTaxBps: binding.creatorTaxBps,
        nowUnix,
      })
      result.tier = tier
      if (tier.tier !== vault.tier) {
        await this.#deps.vaults.put({ ...vault, tier: tier.tier })
        vault.tier = tier.tier
        if (tier.direction === 'downgrade') {
          await this.#deps.escalations.raise({
            coinRef: this.coinRef,
            vault: this.vault,
            kind: 'tier_downgrade',
            code: tier.reasons[0] ?? 'downgrade',
            detail: `${tier.previousTier} -> ${tier.tier}: ${tier.reasons.join(',')}`,
            raisedAtUnix: nowUnix,
          })
        }
      }
    } else {
      refuse('tier', 'no_measurement', 'tier held: QF could not be measured this tick')
    }

    const paidMediaPermitted =
      spendAuthorityActive && (tier?.paidMediaPermitted ?? false) && screening !== undefined
    this.#syncRuntime(vault.tier, paidMediaPermitted)

    // ------------------------------------------------------------ cognition --
    //
    // The window is read ONCE and shared with the desk phase below. It is read
    // whenever operations are permitted - at T0 too, where cognition is refused
    // but the desk still answers slash commands deterministically.
    const window = cadence.cognitionWindow
    let windowMessages: readonly RawMessage[] | undefined
    if (window !== undefined) {
      assertSameCoin(this.coinRef, window.coinRef, 'cognition window')
      this.#lastCognitionWindowId = window.windowId
      if (operationsPermitted) {
        try {
          windowMessages = await this.#deps.messages.since(
            this.coinRef,
            window.startUnix,
            window.endUnix,
          )
        } catch (error) {
          refuse('ingest', codeOf(error, 'messages_unavailable'), messageOf(error))
        }
      }

      if (!TIERS[vault.tier].usesModel) {
        refuse('cognition', 'tier_has_no_model', `${vault.tier} is deterministic by design`)
      } else if (!operationsPermitted) {
        refuse('cognition', 'operations_not_permitted', 'screening blocks all operations')
      } else if (windowMessages === undefined) {
        refuse('cognition', 'messages_unavailable', 'the window could not be read this tick')
      } else {
        try {
          const outcome = await this.#runtime.runWindow(nowUnix, windowMessages)
          assertSameCoin(this.coinRef, outcome.coinRef, 'window outcome')
          result.window = outcome
          result.ranCognition = true
          await this.#afterCognition(outcome, nowUnix)
        } catch (error) {
          refuse('cognition', codeOf(error, 'cognition_failed'), messageOf(error))
        }
      }

      // ----------------------------------------------------------------- desk --
      //
      // Every tier. T0 is a venue plus a janitor: the desk behind the port
      // answers slash commands from its cached FactSheet and moderates, and
      // never calls a model there; the port is told the tier and holds to it.
      const deskAccount = this.#config.accounts.get('telegram')
      if (!operationsPermitted) {
        refuse('desk', 'operations_not_permitted', 'screening blocks all operations')
      } else if (this.#deps.desk === undefined) {
        refuse('desk', 'desk_unavailable', 'no desk is wired; questions are corpus only')
      } else if (deskAccount === undefined) {
        refuse('desk', 'no_account_for_channel', 'no telegram account is bound; nothing can reply')
      } else if (windowMessages === undefined) {
        refuse('desk', 'messages_unavailable', 'the window could not be read this tick')
      } else {
        try {
          result.desk = await runDeskPhase(
            {
              desk: this.#deps.desk,
              publisher: this.#deps.publish.publisher,
              escalations: this.#deps.escalations,
            },
            {
              coinRef: this.coinRef,
              vault: this.vault,
              token: this.#config.token,
              tier: vault.tier,
              accountId: deskAccount,
              window: {
                windowId: window.windowId,
                startUnix: window.startUnix,
                endUnix: window.endUnix,
              },
              messages: windowMessages,
              nowUnix,
            },
          )
          for (const refusal of result.desk.refusals) refuse('desk', refusal.code, refusal.detail)
        } catch (error) {
          refuse('desk', codeOf(error, 'desk_failed'), messageOf(error))
        }
      }
    }

    const proposals = result.window?.proposals ?? []

    // ---------------------------------------------------------------- spend --
    const purchases = proposals.filter((p): p is Extract<Proposal, { kind: 'purchase' }> =>
      p.kind === 'purchase',
    )
    if (purchases.length > 0) {
      if (!spendAuthorityActive) {
        refuse('spend', 'spend_authority_inactive', `vault state ${vault.state}, halted=${halted}`)
      } else if (!paidMediaPermitted) {
        refuse('spend', 'paid_media_not_permitted', 'tier or screening denies paid media')
      } else if (result.qf === undefined || result.signals === undefined || screening === undefined) {
        refuse('spend', 'gate_inputs_missing', 'QF, signals or screening unavailable this tick')
      } else {
        try {
          result.spends = await this.#runSpends(
            purchases,
            vault,
            asset,
            result.qf,
            result.signals,
            screening,
            nowUnix,
          )
        } catch (error) {
          refuse('spend', codeOf(error, 'spend_failed'), messageOf(error))
        }
      }
    }

    // -------------------------------------------------------------- publish --
    const posts = proposals.filter((p): p is Extract<Proposal, { kind: 'post' }> => p.kind === 'post')
    if (posts.length > 0) {
      if (!operationsPermitted) {
        refuse('publish', 'operations_not_permitted', 'screening blocks all publishing')
      } else {
        try {
          result.publishes = await publishProposals(
            {
              publisher: this.#deps.publish.publisher,
              links: this.#config.linkUrls,
              accounts: this.#config.accounts,
            },
            this.vault,
            posts,
            window?.windowId ?? `${this.coinRef}:${nowUnix}`,
          )
        } catch (error) {
          refuse('publish', codeOf(error, 'publish_failed'), messageOf(error))
        }
      }
    }

    return result
  }

  /** Escalations the planner raised, plus a divergence freeze if one fired. */
  async #afterCognition(outcome: WindowOutcome, nowUnix: number): Promise<void> {
    for (const proposal of outcome.proposals) {
      if (proposal.kind !== 'escalation') continue
      await this.#deps.escalations.raise({
        coinRef: this.coinRef,
        vault: this.vault,
        kind: 'planner_escalation',
        code: proposal.reason,
        // The note came out of a model that read untrusted input. It goes to a
        // human queue verbatim and is never parsed for a value by anything.
        detail: proposal.note,
        raisedAtUnix: nowUnix,
      })
    }
    if (outcome.verdict !== undefined && outcome.verdict.freeze !== 'none') {
      await this.#deps.escalations.raise({
        coinRef: this.coinRef,
        vault: this.vault,
        kind: 'divergence_freeze',
        code: `divergence_${outcome.verdict.freeze}`,
        detail: outcome.verdict.reason,
        raisedAtUnix: nowUnix,
      })
    }
  }

  async #runSpends(
    purchases: ReadonlyArray<Extract<Proposal, { kind: 'purchase' }>>,
    vault: Vault,
    asset: Asset,
    qf: QfMeasurement,
    signals: QualificationSignals,
    screening: ScreeningResult,
    nowUnix: number,
  ): Promise<SpendOutcome[]> {
    const price = requirePrice(
      this.#deps.prices,
      asset.address,
      nowUnix,
      SPEND_PRICE_MAX_AGE_SECONDS,
      'spend',
    )

    const unfinalized = (await this.#deps.chain.postings(this.vault, 0, nowUnix)).filter(
      (p) => !p.finalized,
    )

    // REBUILT BEFORE EVERY PURCHASE, not once for the batch.
    //
    // `attemptSpend` writes a ledger row and a counter row for each purchase
    // that lands, so a view built once and reused across the loop shows the
    // second purchase a world in which the first never happened. Every
    // accumulating gate reads this object - the rolling cap, solvency, the
    // category sub-cap - so a stale one lets a tick approve N purchases that
    // are each individually affordable and collectively are not. The counters
    // beside it are already re-read per purchase for exactly this reason; this
    // is the same rule applied to the figure they are compared against.
    const freshLedgerView = async (): Promise<BudgetLedgerView> =>
      buildBudgetLedgerView({
        ledger: this.#deps.ledger,
        store: this.#deps.ledgerStore,
        vault: this.vault,
        asset,
        price,
        unfinalizedPostings: unfinalized,
        budgetBps: vault.budgetBps,
        // Inference is charged FIRST, always: the model spend a coin has
        // already incurred this period comes out of the budget before any
        // procurement.
        inferenceChargedMinor: this.#inferenceChargedMinor(
          asset,
          price.centsPerWholeUnit,
          nowUnix,
        ),
        // WHAT THIS COIN HAS ALREADY SPENT, PER CATEGORY, THIS PERIOD.
        //
        // This was `{}` - a literal, on the only path that ticks a real coin -
        // and an empty map made `categorySubcapGate` read every purchase as the
        // first one in its category. The sub-cap therefore only ever compared
        // ONE invoice against 30% of the period budget and never accumulated,
        // so a coin could buy the same category repeatedly, each purchase
        // comfortably under the cap, and pass through the ceiling in aggregate.
        // The adjacent total-procurement check reads the same map and was
        // equally inert.
        //
        // It comes from the counters rather than the ledger because the ledger
        // records amounts and accounts, not SKU categories: reconstructing a
        // category from a memo string would be a parser standing between a
        // coin's budget and the only gate that bounds it.
        categorySpendCents: await this.#deps.fleet.categorySpend30dCents(this.vault, nowUnix),
        outstandingObligationsMinor: 0n,
        nowUnix,
      })

    const outcomes: SpendOutcome[] = []
    for (const purchase of purchases) {
      const entry = this.#deps.spend.broker.catalog.entry(purchase.skuId)
      const counters: SpendCounters = await buildSpendCounters({
        fleet: this.#deps.fleet,
        vault: this.vault,
        vendorId: entry.sku.vendorId,
        nowUnix,
      })
      const ledgerView = await freshLedgerView()
      outcomes.push(
        await attemptSpend(
          { ...this.#deps.spend, ledger: this.#deps.ledger, fleet: this.#deps.fleet },
          {
            proposal: {
              vault: this.vault,
              skuId: purchase.skuId,
              quantity: purchase.quantity,
              rationale: purchase.rationale,
              proposedAtUnix: nowUnix,
            },
            vault,
            asset,
            price,
            ledgerView,
            qf,
            signals,
            screening,
            counters,
            relatedPartyOptIn: this.#config.relatedPartyOptIn,
            nowUnix,
          },
        ),
      )
    }
    return outcomes
  }

  /** Today's metered model spend, converted into minor units of the quote asset. */
  #inferenceChargedMinor(asset: Asset, centsPerWholeUnit: bigint, nowUnix: number): bigint {
    const usd = this.#governor.spentUsd(nowUnix)
    if (!(usd > 0) || centsPerWholeUnit <= 0n) return 0n
    const cents = BigInt(Math.ceil(usd * 100))
    let scale = 1n
    for (let i = 0; i < asset.decimals; i += 1) scale *= 10n
    // Ceil, because this is an amount OWED and rounding an obligation down
    // would quietly hand the client budget the operator has already spent.
    return (cents * scale + centsPerWholeUnit - 1n) / centsPerWholeUnit
  }
}

function codeOf(error: unknown, fallback: string): string {
  if (error instanceof OrchestratorError) return error.code
  if (error instanceof FailClosed) return error.code
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return fallback
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

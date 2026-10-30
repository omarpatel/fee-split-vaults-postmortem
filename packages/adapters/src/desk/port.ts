/**
 * The DeskPort: one process-wide instance, one desk per coin inside it.
 *
 * The tick hands over an opaque message; this is the plane that reads it.
 * Everything the desk package already decides - moderation before meaning,
 * slash commands from a cached FactSheet, the anti-snipe explainer, the
 * grounded model path under a budget, the refusal classifier on both sides -
 * runs unchanged through `DeskRouter`. What this class adds is the seam:
 *
 *   - NO SENDING. The router's `client.sendMessage` is a capture, not a wire.
 *     The captured body goes back to the tick, which publishes it as a reply
 *     through the publisher: disclosure, the outbound classifier, the link
 *     allowlist and the ticker policy all apply exactly as they do to a post.
 *     The desk's own disclosure footer is therefore never rendered onto the
 *     wire; the publisher's canonical one is.
 *   - MODERATION IS TYPED. Every chat-administration call goes through
 *     `DeskModerationActions`, whose live implementation checks the bot's own
 *     rights first and refuses with a machine code the tick records.
 *   - SCHEDULED READS ONLY. The FactSheet refreshes on its interval from the
 *     port, never because a message arrived; a flood of questions costs zero
 *     RPC calls.
 *   - EVERY REFUSAL IS FLUSHED. The refusal log's pending rows are written
 *     after each message and a failed write is the tick's refusal, not a lost
 *     promise.
 */

import type { Address } from '@fee-split-vaults/core'
import {
  DeskCorpusAssembler,
  DeskRouter,
  FactSheetCache,
  HaikuDesk,
  InMemoryEscalationQueue,
  LinkPolicy,
  ModerationEngine,
  renderCitations,
  stripModelDisclosure,
  type DeskBudget,
  type DeskChainReader,
  type DeskFeeLedger,
  type DeskHolderIndex,
  type DeskModel,
  type DeskOutcome as RouterOutcome,
  type ExplorerConfig,
  type HaikuDeskOptions,
  type InboundMessage,
  type LinkPolicyOptions,
  type RaidThresholds,
  type RefusalLog,
  type TelegramAdmin,
  type TelegramClient,
  type TelegramSendOptions,
} from '@fee-split-vaults/desk'
import type { DeskAnswerInput, DeskEscalation, DeskOutcome, DeskPort } from '@fee-split-vaults/orchestrator'
import type { TierId } from '../../../../config/protocol.js'
import { AdapterError } from '../errors.js'
import type { DeskModerationActions } from './moderation.js'

/** A refusal log that can also persist. `PgRefusalLog` is one; the in-memory log has no flush. */
export type FlushableRefusalLog = RefusalLog & { flush?(): Promise<number> }

export interface TelegramDeskPortOptions {
  moderation: DeskModerationActions
  chainReader: DeskChainReader
  explorer: ExplorerConfig
  refusalLog: FlushableRefusalLog
  /** Legal operator name. The desk renders with it; the publisher discloses with it. */
  operatorName: string
  /** The T1 model. Absent means every coin behaves as T0: commands and moderation only. */
  model?: DeskModel
  haiku?: Omit<HaikuDeskOptions, 'model'>
  /** The bot's @username, so a command addressed to another bot is not answered. */
  botUsername?: string
  holders?: DeskHolderIndex
  ledger?: DeskFeeLedger
  linkPolicy?: LinkPolicyOptions
  raid?: Partial<RaidThresholds>
  budget?: Partial<DeskBudget>
  /** Seconds between FactSheet refresh attempts per coin. */
  factsheetRefreshSeconds?: number
  documentedAntiSnipe?: { initialBps: number; windowSeconds: number }
  /** Append the desk's citation block to fact replies. Off by default: the explorer host must be on the publisher's link allowlist first. */
  includeCitations?: boolean
  clock?: () => number
}

interface CapturedSend {
  chatId: string
  text: string
  options: TelegramSendOptions | undefined
}

/**
 * The router's Telegram surface: sends are captured, administration is
 * delegated to the typed actions and every failure there is remembered so
 * the port can report it by code.
 */
class CapturingClient implements TelegramClient {
  readonly sends: CapturedSend[] = []
  readonly failures: Array<{ action: string; code: string }> = []

  constructor(private readonly actions: DeskModerationActions) {}

  reset(): void {
    this.sends.length = 0
    this.failures.length = 0
  }

  async sendMessage(chatId: string, text: string, options?: TelegramSendOptions): Promise<{ messageId: string }> {
    this.sends.push({ chatId, text, options })
    return { messageId: `captured:${String(this.sends.length)}` }
  }

  async #guarded<T>(action: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      this.failures.push({ action, code: error instanceof AdapterError ? error.code : 'moderation_failed' })
      throw error
    }
  }

  deleteMessage(chatId: string, messageId: string): Promise<void> {
    return this.#guarded('delete', () => this.actions.deleteMessage(chatId, messageId))
  }

  pinMessage(chatId: string, messageId: string, silent?: boolean): Promise<void> {
    return this.#guarded('pin', () => this.actions.pinMessage(chatId, messageId, silent))
  }

  unpinMessage(chatId: string, messageId: string): Promise<void> {
    return this.#guarded('unpin', () => this.actions.unpinMessage(chatId, messageId))
  }

  muteMember(chatId: string, userId: string, untilUnix: number): Promise<void> {
    return this.#guarded('mute', () => this.actions.muteMember(chatId, userId, untilUnix))
  }

  banMember(chatId: string, userId: string, deleteHistory?: boolean): Promise<void> {
    return this.#guarded('ban', () => this.actions.banMember(chatId, userId, deleteHistory))
  }

  setChatLocked(chatId: string, locked: boolean): Promise<void> {
    return this.#guarded('lock_chat', () => this.actions.setChatLocked(chatId, locked))
  }

  getChatAdministrators(chatId: string): Promise<TelegramAdmin[]> {
    return this.actions.getChatAdministrators(chatId)
  }
}

interface CoinDesk {
  vault: Address
  token: Address
  chatId: string
  tier: TierId
  router: DeskRouter
  client: CapturingClient
  sheet: FactSheetCache
  moderation: ModerationEngine
  escalations: InMemoryEscalationQueue
  corpus: DeskCorpusAssembler
  corpusWindowId: string
  /** Escalation ids already handed to the tick, so a merged repeat is not raised twice. */
  raised: Set<string>
}

export class TelegramDeskPort implements DeskPort {
  readonly #options: TelegramDeskPortOptions
  readonly #clock: () => number
  readonly #desk: HaikuDesk | undefined
  readonly #coins = new Map<string, CoinDesk>()

  constructor(options: TelegramDeskPortOptions) {
    this.#options = options
    this.#clock = options.clock ?? (() => Math.floor(Date.now() / 1000))
    this.#desk = options.model === undefined ? undefined : new HaikuDesk({ ...options.haiku, model: options.model })
  }

  /** Coins with a desk built so far. Diagnostics only. */
  get coinRefs(): string[] {
    return [...this.#coins.keys()]
  }

  #build(input: DeskAnswerInput): CoinDesk {
    const options = this.#options
    const client = new CapturingClient(options.moderation)
    const sheet = new FactSheetCache(
      {
        vault: input.vault,
        token: input.token,
        tier: input.tier,
        reader: options.chainReader,
        ...(options.holders === undefined ? {} : { holders: options.holders }),
        ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
        explorer: options.explorer,
        ...(options.documentedAntiSnipe === undefined ? {} : { documentedAntiSnipe: options.documentedAntiSnipe }),
      },
      { refreshIntervalSeconds: options.factsheetRefreshSeconds ?? 300, clock: this.#clock },
    )
    const moderation = new ModerationEngine({
      vault: input.vault,
      linkPolicy: new LinkPolicy(options.linkPolicy ?? {}),
      ...(options.raid === undefined ? {} : { raid: options.raid }),
    })
    const escalations = new InMemoryEscalationQueue()
    const corpus = new DeskCorpusAssembler(input.coinRef, input.window.startUnix)
    const router = new DeskRouter({
      vault: input.vault,
      tier: input.tier,
      client,
      sheetSource: () => sheet.get(),
      moderation,
      escalations,
      refusalLog: options.refusalLog,
      corpus,
      outbound: { operatorName: options.operatorName },
      ...(options.botUsername === undefined ? {} : { botUsername: options.botUsername }),
      ...(this.#desk === undefined ? {} : { desk: this.#desk }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      clock: this.#clock,
    })
    return {
      vault: input.vault,
      token: input.token,
      chatId: input.chatId,
      tier: input.tier,
      router,
      client,
      sheet,
      moderation,
      escalations,
      corpus,
      corpusWindowId: input.window.windowId,
      raised: new Set(),
    }
  }

  #coin(input: DeskAnswerInput): CoinDesk {
    const existing = this.#coins.get(input.coinRef)
    if (existing === undefined) {
      const built = this.#build(input)
      this.#coins.set(input.coinRef, built)
      return built
    }
    // A coin's vault, token and chat are configuration. A change under a
    // running desk is not something to adapt to quietly: the sheet, the
    // moderation history and the budget counters all belong to the old binding.
    if (existing.vault !== input.vault || existing.token !== input.token || existing.chatId !== input.chatId) {
      throw new AdapterError(
        `desk for ${input.coinRef} is bound to ${existing.vault}/${existing.token}/chat ${existing.chatId}; ` +
          `the tick now names ${input.vault}/${input.token}/chat ${input.chatId}`,
        'desk_binding_conflict',
      )
    }
    if (existing.tier !== input.tier) {
      existing.router.setTier(input.tier)
      existing.tier = input.tier
    }
    if (existing.corpusWindowId !== input.window.windowId) {
      existing.corpus = new DeskCorpusAssembler(input.coinRef, input.window.startUnix)
      existing.corpusWindowId = input.window.windowId
    }
    return existing
  }

  #toInbound(input: DeskAnswerInput): InboundMessage {
    const username = this.#options.botUsername
    const mentionsBot =
      username !== undefined && input.message.text.toLowerCase().includes(`@${username.toLowerCase()}`)
    return {
      channel: 'telegram',
      chatId: input.chatId,
      messageId: input.message.sourceId,
      authorId: input.message.authorId,
      text: input.message.text,
      sentAtUnix: input.message.postedAtUnix,
      mentionsBot,
    }
  }

  /** Escalations the router enqueued that the tick has not yet been handed. */
  #drainEscalations(coin: CoinDesk, nowUnix: number): DeskEscalation[] {
    const out: DeskEscalation[] = []
    for (const item of coin.escalations.open()) {
      if (coin.raised.has(item.id)) continue
      coin.raised.add(item.id)
      item.notifiedAtUnix = nowUnix
      out.push({ reason: item.reason, summary: item.summary, priority: item.priority })
    }
    return out
  }

  async answer(input: DeskAnswerInput): Promise<DeskOutcome> {
    if (input.message.boundCoinRef !== input.coinRef) {
      throw new AdapterError(
        `message ${input.message.sourceId} is bound to ${input.message.boundCoinRef}, not ${input.coinRef}`,
        'desk_binding_conflict',
      )
    }
    const coin = this.#coin(input)

    // Scheduled, never message-triggered: the interval bounds it whatever the
    // volume, and a failed refresh keeps the previous sheet (fields expire by TTL).
    await coin.sheet.refreshIfDue()

    coin.client.reset()
    const outcome = await coin.router.handle(this.#toInbound(input), { allowModel: input.modelPermitted })

    // A refusal the desk could not persist is a refusal the tick must see.
    await this.#options.refusalLog.flush?.()

    const escalations = this.#drainEscalations(coin, input.nowUnix)
    return this.#toOutcome(outcome, coin.client, escalations)
  }

  #toOutcome(outcome: RouterOutcome, client: CapturingClient, escalations: DeskEscalation[]): DeskOutcome {
    const modelCalled = outcome.modelCalled
    switch (outcome.action) {
      case 'ignored':
        return { kind: 'ignore', modelCalled, escalations }
      case 'moderated': {
        // The router already sent the warning through the captured client, if
        // the verdict carried one; it is the one send on this path.
        const warning = client.sends[0]?.text
        return {
          kind: 'moderated',
          actions: (outcome.moderation?.actions ?? []).map((action) => action.kind),
          failed: [...client.failures],
          ...(warning === undefined ? {} : { body: warning }),
          modelCalled,
          escalations,
        }
      }
      case 'refused':
      case 'budget_exhausted':
      case 'unavailable': {
        const body = outcome.answer === undefined ? undefined : this.#body(outcome)
        return {
          kind: 'refused',
          code:
            outcome.action === 'refused'
              ? (outcome.answer?.refusalCode ?? outcome.answer?.refusalClasses?.[0] ?? 'refused')
              : outcome.action,
          ...(body === undefined ? {} : { body }),
          modelCalled,
          escalations,
        }
      }
      case 'command':
      case 'antisnipe':
      case 'model': {
        if (outcome.answer === undefined) return { kind: 'ignore', modelCalled, escalations }
        return {
          kind: 'reply',
          body: this.#body(outcome),
          citedFields: outcome.answer.citations.map((citation) => citation.field),
          modelAuthored: outcome.answer.modelAuthored,
          modelCalled,
          escalations,
        }
      }
    }
  }

  /**
   * The body the publisher receives: the answer, its citation block when
   * enabled, and NO disclosure - the publisher strips any that slipped in and
   * appends the canonical one.
   */
  #body(outcome: RouterOutcome): string {
    const answer = outcome.answer
    if (answer === undefined) return ''
    const body = answer.modelAuthored ? stripModelDisclosure(answer.body) : answer.body.trim()
    if (this.#options.includeCitations !== true || answer.kind !== 'fact') return body
    const citations = renderCitations(answer.citations)
    return citations.length === 0 ? body : `${body}\n\n${citations}`
  }
}

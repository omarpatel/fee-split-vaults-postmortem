/**
 * @fee-split-vaults/desk - the client-facing support desk.
 *
 * Two products in one package:
 *
 *   T0, the deterministic bot. Slash commands answered from cached chain reads,
 *   a link policy, DM-solicitation warnings, impersonator detection, a pinned
 *   FactSheet, and moderation. No model participates at any point.
 *
 *   T1, the Haiku desk. Natural language, grounded in a FactSheet with per-field
 *   provenance, a citation on every answer, and an honest gap wherever a field
 *   is absent or stale.
 *
 * Note what this barrel does NOT export: anything that spends, signs, publishes
 * outside its own chat, or reaches a payee. The desk plane has no such
 * capability, and assertDeskHoldsNoAuthority() is here to keep it that way.
 */

export type { DeskAnswer, DeskAnswerKind, OutboundOptions } from './answer.js'
export {
  DeskConfigError,
  disclosureFooter,
  factAnswer,
  renderCitations,
  renderOutbound,
  stripModelDisclosure,
} from './answer.js'

export {
  ANTISNIPE_FIELDS,
  DOCUMENTED_ANTISNIPE,
  antiSnipeExemptWallets,
  antiSnipeLaunchNotice,
  antiSnipeParamsFrom,
  antiSnipeTaxBpsAt,
  explainAntiSnipe,
  explainWindfallCredit,
  isWithinAntiSnipeWindow,
  looksLikeAntiSnipeTicket,
  type AntiSnipeParams,
} from './antisnipe.js'

export {
  DESK_SPEND_TOOLS,
  DeskAuthorityViolation,
  DeskCorpusAssembler,
  assertDeskHoldsNoAuthority,
  classifyTopic,
  type AdmitResult,
  type CorpusLimits,
} from './airlock/inbound.js'

export {
  FactSheetError,
  buildFactSheet,
  citeFact,
  lookupFact,
  staleFields,
  txLink,
  usableFacts,
  type BuildFactSheetInput,
  type Citation,
  type FactLookup,
  type FactSheet,
} from './factsheet/builder.js'
export { FactSheetCache, type FactSheetCacheOptions } from './factsheet/cache.js'
export {
  FakeDeskChainReader,
  FakeFeeLedger,
  FakeHolderIndex,
  RpcDeskChainReader,
  decodeAddress,
  decodeAddressArray,
  decodeBool,
  decodeString,
  decodeUint,
  type AntiSnipeRead,
  type BlockRef,
  type CreditedFeesRead,
  type DeskChainReader,
  type DeskFeeLedger,
  type DeskHolderIndex,
  type FakeChainState,
  type FeeConfigRead,
  type HolderRead,
  type JsonRpcTransport,
  type LaunchRead,
  type LockRead,
  type VenueViewCalls,
  type PoolRead,
  type SupplyRead,
  type TokenIdentityRead,
  type ViewCallSpec,
} from './factsheet/chain-reader.js'
export {
  FACT_FIELDS,
  FACT_LABELS,
  FACT_SELF_CHECK,
  FACT_TTL_SECONDS,
  type Fact,
  type FactFieldId,
  type FactProvenance,
  type FactSource,
  type FactValue,
} from './factsheet/fields.js'
export {
  formatBpsAsPercent,
  formatDuration,
  formatTokenAmount,
  formatUnixTime,
  formatUsd,
  renderFactValue,
  urlExplorer,
  type ExplorerConfig,
} from './factsheet/render.js'

export {
  answerField,
  answerFields,
  renderFields,
  shortLabel,
  unknownFieldAnswer,
  type FieldAnswerContext,
  type FieldLines,
} from './field-answer.js'

export type { InboundMessage } from './message.js'

export {
  LinkPolicy,
  extractLinks,
  type LinkPolicyMode,
  type LinkPolicyOptions,
  type LinkRef,
  type LinkVerdict,
} from './moderation/blocklist.js'
export {
  DEFAULT_RAID_THRESHOLDS,
  DM_WARNING,
  ModerationEngine,
  executeModeration,
  type ModerationAction,
  type ModerationActionKind,
  type ModerationOptions,
  type ModerationOutcome,
  type ModerationReason,
  type ModerationVerdict,
  type RaidThresholds,
} from './moderation/engine.js'
export {
  DevNotifier,
  InMemoryEscalationQueue,
  defang,
  renderEscalation,
  safeSummaryFragment,
  type EscalationDraft,
  type EscalationItem,
  type EscalationPriority,
  type EscalationQueue,
  type EscalationReason,
} from './moderation/escalation.js'

export {
  classifyRefusal,
  screenExchange,
  type ClassifierSide,
  type ExchangeScreen,
  type RefusalDecision,
  type RefusalMatch,
} from './refusal/classifier.js'
export {
  InMemoryRefusalLog,
  fingerprint,
  makeRefusalRef,
  scrubExcerpt,
  type RefusalLog,
  type RefusalLogEntry,
} from './refusal/log.js'
export {
  NO_VERIFIED_ANSWER,
  REFUSAL_CLASS_LABEL,
  REFUSAL_CODES,
  REFUSAL_CODE_BODY,
  REFUSAL_TEMPLATES,
  STALE_REASON,
  UNKNOWN_FIELD_TEMPLATES,
  noVerifiedAnswerBody,
  refusalBody,
  refusalCodeBody,
  unknownFieldBody,
  type RefusalCode,
} from './refusal/templates.js'

export {
  classifyLanguage,
  type LanguageDecision,
  type LanguageReason,
  type LanguageVerdict,
  type ScriptBucket,
} from './language.js'

export {
  DEFAULT_DESK_BUDGET,
  DeskRouter,
  type DeskAction,
  type DeskBudget,
  type DeskHandleOptions,
  type DeskOutcome,
  type DeskRouterOptions,
} from './router.js'

export {
  T0_COMMANDS,
  factsAnswer,
  handleT0Command,
  helpAnswer,
  parseCommand,
  type ParsedCommand,
  type T0Command,
} from './t0/commands.js'
export {
  PinnedFactSheetManager,
  renderPinnedFactSheet,
  type PinState,
} from './t0/pinned.js'

export {
  HaikuDesk,
  buildGroundingFacts,
  sanitizeQuestion,
  type DeskAttempt,
  type DeskFailure,
  type HaikuDeskOptions,
} from './t1/desk.js'
export {
  groundAnswer,
  type GroundingOptions,
  type GroundingResult,
  type GroundingViolation,
  type GroundingViolationKind,
} from './t1/grounding.js'
export {
  AnthropicDeskModel,
  DESK_MODEL_ID,
  DESK_SYSTEM_PROMPT,
  FakeDeskModel,
  buildUserMessage,
  parseDeskModelReply,
  renderFactBlock,
  type AnthropicMessagesApi,
  type DeskModel,
  type DeskModelReply,
  type DeskModelRequest,
  type GroundingFact,
} from './t1/model.js'

export {
  BotApiTelegramClient,
  FakeTelegramClient,
  TelegramApiError,
  type HttpJsonPost,
  type TelegramAdmin,
  type TelegramClient,
  type TelegramSendOptions,
} from './telegram/client.js'

export {
  FEE_RECIPIENT_TIMELOCK_SECONDS,
  raiseSheetAlerts,
  type SheetWatchOptions,
} from './watchers.js'

export {
  detectLanguage,
  editDistance,
  normalize,
  similarity,
  type LanguageCode,
  type NormalizedText,
} from './text/normalize.js'

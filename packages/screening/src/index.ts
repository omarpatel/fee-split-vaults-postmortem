/**
 * @fee-split-vaults/screening
 *
 * Four-stage content screening plus the client fraud diligence gate.
 *
 * Stage 1 deterministic lexicon, trademark and sanctions - free, pure, always.
 * Stage 2 perceptual matching and the mandatory child-safety hash check.
 * Stage 3 model adjudication over a closed rubric with enum-only output.
 * Stage 4 human review, at the paid-media gate only.
 *
 * Union of flags: every stage may add, no stage may clear.
 * Verdicts: CLEAR, RESTRICTED (organic only, no paid media), BLOCKED.
 *
 * This package holds no keys and has no spending, posting, or signing surface.
 */

export {
  DECLINE_CODES,
  FLAG_CODES,
  FLAG_SPECS,
  ScreeningFailClosed,
  assertMonotonic,
  declineCodeFor,
  isFlagCode,
  isStickyBlock,
  makeFlag,
  mergeFlags,
  paidMediaPermitted,
  requiresOutOfBandEscalation,
  severityOf,
  specFor,
  verdictFor,
  worstSeverity,
  type DeclineCode,
  type Flag,
  type FlagCode,
  type FlagSeverity,
  type FlagSpec,
  type StageName,
} from './flags.js'

export {
  DENSE_FOLD,
  NUMERIC_FOLD,
  WORD_FOLD,
  excerpt,
  fold,
  foldDense,
  foldTerm,
  hasWordBoundary,
  spanWasSplit,
  wordTokens,
  type FoldOptions,
  type FoldedText,
} from './normalize.js'

export { TermMatcher, type TermMatch, type TermSpec } from './matcher.js'

export {
  DEFAULT_LEXICON,
  DEFAULT_LEXICON_SOURCE,
  LEXICON_CATEGORIES,
  Lexicon,
  NUMERIC_HATE_CODES,
  StaticLexiconSource,
  parseLexiconJson,
  type CategoryHit,
  type LexiconCategory,
  type LexiconEntry,
  type LexiconSource,
} from './lexicon.js'

export {
  DEFAULT_SDN_POLICY,
  LoadedSdnSource,
  SAMPLE_SDN_ENTRIES,
  SampleSdnSource,
  SdnScreener,
  withinOneEdit,
  type SdnEntry,
  type SdnEntryType,
  type SdnListStatus,
  type SdnMatch,
  type SdnPolicy,
  type SdnSource,
} from './ofac.js'

export {
  DEFAULT_OFAC_SDN_URL,
  FileLexiconSource,
  LexiconFileError,
  OfacSdnSource,
  SdnLoadError,
  loadScreeningSources,
  parseSdnCsv,
  parseSdnXml,
  type LexiconFileErrorCode,
  type OfacSdnLoadOptions,
  type ScreeningSourceOptions,
  type ScreeningSources,
  type SdnLoadErrorCode,
} from './sources.js'

export {
  AnthropicTransportError,
  createAnthropicMessagesPort,
  type AnthropicMessagesPortOptions,
} from './anthropic-port.js'

export {
  EMPTY_STAGE_OUTPUT,
  finalizeReport,
  makeSubject,
  metadataHashOf,
  redactEvidence,
  reportId,
  scrubLongText,
  sha256Hex,
  subjectText,
  toScreeningResult,
  type HumanDecision,
  type HumanReviewRecord,
  type ImageRef,
  type ScreeningReport,
  type ScreeningSubject,
  type StageOutput,
  type SubjectMetadata,
} from './types.js'

export { runStage1, type Stage1Deps, type Stage1Options } from './stage1.js'

export {
  DEFAULT_PERCEPTUAL_THRESHOLDS,
  FakeCsamHashProvider,
  FakeMatcher,
  ImageNotServable,
  ImageServeGate,
  InMemoryCsamEscalationSink,
  runStage2,
  type CsamEscalation,
  type CsamEscalationSink,
  type CsamHashProvider,
  type FaceMatcher,
  type HashCheckResult,
  type HashCheckVerdict,
  type LogoMatcher,
  type PerceptualMatch,
  type PerceptualThresholds,
  type Stage2Deps,
} from './stage2.js'

export {
  ADJUDICATION_MODEL,
  ADJUDICATION_TOOL,
  ADJUDICATION_TOOL_NAME,
  AdjudicationMalformed,
  FakeAdjudicator,
  RUBRIC_CONFIDENCE,
  RUBRIC_LABELS,
  RUBRIC_SYSTEM_PROMPT,
  RUBRIC_VERSION,
  createAnthropicAdjudicator,
  runStage3,
  validateAdjudication,
  type AdjudicationInput,
  type AdjudicationOutput,
  type Adjudicator,
  type AnthropicAdjudicatorOptions,
  type AnthropicContentBlock,
  type AnthropicMessageRequest,
  type AnthropicMessageResponse,
  type AnthropicMessagesPort,
  type AnthropicToolDefinition,
  type RubricConfidence,
  type RubricLabel,
  type Stage3Deps,
} from './stage3.js'

export {
  DEFAULT_THROUGHPUT_MODEL,
  PaidMediaReviewQueue,
  assertPaidMediaApproved,
  estimateDailyReviewHours,
  type PaidMediaReviewItem,
  type ReviewThroughputModel,
} from './stage4.js'

export {
  DEFAULT_SCREENING_CONFIG,
  InMemoryScreeningHistory,
  ScreeningEngine,
  assertFreshScreening,
  assertOperationsPermitted,
  assertPaidMediaPermitted,
  isFresh,
  verdictOf,
  type PerceptualDeps,
  type ScreeningConfig,
  type ScreeningEngineDeps,
  type ScreeningHistory,
} from './pipeline.js'

export {
  DECLINE_LIST_SCHEMA_VERSION,
  InMemoryDeclineList,
  declineRecordFor,
  serializeDeclineList,
  type DeclineListSink,
  type DeclineRecord,
} from './declineList.js'

export {
  DEFAULT_RESCREEN_CONFIG,
  FakeMetadataSource,
  InMemoryRescreenStore,
  RescreenWatcher,
  type MetadataSource,
  type RescreenAction,
  type RescreenConfig,
  type RescreenOutcome,
  type RescreenState,
  type RescreenStore,
} from './rescreen.js'

export {
  DEFAULT_DILIGENCE_POLICY,
  DILIGENCE_CHECKS,
  FakeChainDiligenceProbe,
  FakeIdentityProvider,
  assertOnboardingAdmitted,
  runFraudDiligence,
  type AuthorityStatus,
  type ChainDiligenceProbe,
  type CheckOutcome,
  type DiligenceCheck,
  type DiligenceCheckResult,
  type DiligenceDeps,
  type DiligencePolicy,
  type DiligenceReport,
  type FakeChainState,
  type IdentityProvider,
  type IdentityRecord,
  type LpLockStatus,
  type SellSimulation,
} from './diligence.js'

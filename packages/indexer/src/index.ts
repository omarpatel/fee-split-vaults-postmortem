/**
 * @fee-split-vaults/indexer
 *
 * Chain ingestion and QF measurement for chain 4663.
 *
 * The four properties this package exists to hold:
 *
 *   BOUNDED   - only vaults we issued a consent for are ever indexed. Every log
 *               query is refused unless it is filtered to that set.
 *   PINNED    - every read is addressed by block hash. There is no type in this
 *               package capable of expressing a read against a block number.
 *   QUORUM    - two independent providers must agree, or the read refuses. There
 *               is no single-provider fallback.
 *   FINALIZED - budget authority is drawn only from finalized postings, and a
 *               reorg that reaches a finalized block halts rather than rewrites.
 *
 * It holds no keys, signs nothing, and spends nothing. It reads attacker-
 * influenced chain state - which is precisely why it has no such powers - and it
 * decodes only numbers, addresses and hashes, never a string of on-chain
 * metadata.
 */

export {
  assertPinnedTopics,
  CREATOR_FEE_RECIPIENT_CHANGE_CANCELLED,
  CREATOR_FEE_RECIPIENT_CHANGE_PROPOSED,
  CREATOR_FEE_RECIPIENT_UPDATED,
  CURVE_BUY,
  CURVE_SELL,
  CURVE_TRADE_FIELDS,
  curveTradeShapePinned,
  decodeEventLog,
  decodeLaunchedToken,
  defineEvent,
  derivePoolId,
  encodeAddressArgCall,
  GET_LAUNCHED_TOKEN_SELECTOR,
  POOL_FEES_SWEPT,
  POOL_REGISTERED,
  VENUE_EVENTS,
  requireAddress,
  requireBigInt,
  requireHash32,
  selector,
  TOKEN_LAUNCHED,
} from './abi.js'
export type {
  AbiStaticType,
  DecodedLog,
  DecodedValue,
  EventParam,
  EventShape,
  LaunchedToken,
  VenueEventName,
  PoolKeyInput,
} from './abi.js'

export {
  ANTI_SNIPE_WINDOW_SECONDS,
  attributeCurveLog,
  attributeFeeLogs,
  attributeSweptLog,
  bindingFromLaunch,
  classifyFee,
  confirmPoolRegistration,
  creatorShareOfFee,
  decodeLaunch,
  decodePoolRegistration,
  postingId,
} from './attribution.js'
export type {
  AttributionOptions,
  ClassifyInput,
  FeeAttributionContext,
  FeeAttributionResult,
  LaunchBindingFields,
  PoolRegistration,
} from './attribution.js'

export { ChainTracker } from './chain.js'
export type { ChainTrackerOptions, ReorgOutcome } from './chain.js'

export {
  ChainMismatchError,
  CurveShapeUnpinnedError,
  DecodeError,
  EventShapeMismatchError,
  FinalityViolationError,
  HolderLedgerError,
  IndexerError,
  MissingPriceError,
  QuorumDisagreementError,
  ReorgTooDeepError,
  RpcError,
  ScanRetryError,
  SignalsUnavailableError,
  StaleWatchError,
  UnboundedQueryError,
  WatchSetError,
} from './errors.js'
export type { IndexerErrorCode } from './errors.js'

export { FakeChain, FakeRpcClient } from './fake-rpc.js'
export type { FakeChainOptions, FakeLogInput, FakeRpcOptions } from './fake-rpc.js'

export {
  addressEquals,
  addressToTopic,
  bytesToHex,
  hexToBytes,
  isHex,
  normalizeAddress,
  normalizeHash32,
  topicToAddress,
} from './hex.js'
export type { Hex } from './hex.js'

export {
  assertBoundedWatchSet,
  InMemoryVaultRegistry,
  MAX_WATCHED_VAULTS,
  VaultIndexer,
} from './indexer.js'
export type {
  IndexerConfig,
  IndexerDeps,
  ScannedRange,
  TickResult,
  VaultRegistry,
} from './indexer.js'

export { keccak256, keccak256Hex } from './keccak.js'

export {
  ERC20_TRANSFER,
  HolderIndexer,
  InMemoryHolderBalanceStore,
  POOL_MANAGER_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
} from './holders.js'
export type {
  HolderBalanceStore,
  HolderCursor,
  HolderIndexerConfig,
  HolderIndexerDeps,
  HolderRpc,
  HolderTickResult,
  HolderTokenScan,
  IndexedToken,
} from './holders.js'

export { toAccrualLedgerEntry, tradesFromPostings } from './model.js'
export type {
  CoinBinding,
  FeeClassification,
  FeePhase,
  FeePosting,
  FeeSource,
  IssuedVault,
  LaunchFacts,
  PendingOverride,
  RecipientObservation,
  TradeObservation,
  WatchTarget,
} from './model.js'

export {
  DEFAULT_MAX_PRICE_AGE_SECONDS,
  requirePrice,
  StaticPriceOracle,
  toUsdValue,
  usdOf,
} from './prices.js'
export type { PinnedPrice, PriceOracle } from './prices.js'

export { QuorumRpc } from './quorum.js'
export type { QuorumOptions } from './quorum.js'

export {
  computeQf,
  finalizedCreditByAsset,
  mean,
  median,
  utcDayIndex,
} from './qf.js'
export type { QfExclusions, QfInput, QfOptions, QfResult } from './qf.js'

export {
  assertBoundedLogQuery,
  canonicalBlock,
  canonicalLog,
  DEFAULT_QUERY_LIMITS,
  FIREHOSE_CONTRACTS,
  logKey,
  sortLogs,
} from './rpc.js'
export type {
  BlockRef,
  BlockTag,
  ChainWriteClient,
  LogQuery,
  NonceTag,
  PinnedCall,
  QueryLimits,
  RpcClient,
  RpcLog,
  TopicFilter,
  TransactionCall,
  TransactionReceipt,
} from './rpc.js'

export { JsonRpcClient } from './json-rpc.js'
export type { JsonRpcOptions } from './json-rpc.js'

export {
  DAY_SECONDS,
  effectiveIntervalSeconds,
  isPollDue,
  nextPollAtUnix,
  PENDING_OVERRIDE_INTERVAL_SECONDS,
  POLL_SCHEDULE,
  scheduledIntervalSeconds,
} from './schedule.js'
export type { PollBand, PollPolicyInput } from './schedule.js'

export {
  computeQualificationSignals,
  DEFAULT_HOLDER_SNAPSHOT_MAX_AGE_SECONDS,
  DEFAULT_VOLUME_SAMPLE_MAX_AGE_SECONDS,
  InMemoryHolderSource,
  InMemoryTradeSource,
  InMemoryVolumeSource,
  PostingsTradeSource,
  PostingsVolumeSource,
  VOLUME_SAMPLE_WINDOW_SECONDS,
} from './signals.js'
export type {
  ExternalVolumeObserver,
  HolderBalance,
  HolderSnapshot,
  HolderSource,
  PostingsVolumeSourceDeps,
  SignalsInput,
  SignalsOptions,
  TradeSource,
  TradeWindow,
  VolumeSample,
  VolumeSource,
} from './signals.js'

export { InMemoryIndexerStore } from './store.js'
export type { CursorKey, IndexerStore, PostingQuery } from './store.js'

export {
  InMemoryHaltSink,
  OVERRIDE_TIMELOCK_SECONDS,
  OwnerOverrideWatcher,
  RecipientWatcher,
} from './watchers.js'
export type {
  HaltNotice,
  HaltReason,
  HaltSink,
  OwnerOverrideWatcherOptions,
  RecipientCheck,
  RecipientWatcherOptions,
} from './watchers.js'

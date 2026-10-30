/**
 * @fee-split-vaults/adapters - the real implementations of the orchestrator's ports.
 *
 * Until this package existed, every port in `packages/orchestrator/src/ports.ts`
 * had exactly one implementation and it was an in-memory fake. The tick loop was
 * complete, tested and unable to touch reality. This is the other half: a chain
 * read model over the indexer's quorum RPC, a message source over the Telegram
 * Bot API, and Postgres behind the two pieces of state that must outlive a
 * process - the spend counters and the escalations.
 *
 * WHY IT IS A SEPARATE PACKAGE. `packages/orchestrator` imports the other
 * packages and nothing imports it back; that one-way property is what keeps the
 * seam readable. Putting adapters inside it would have made it import a
 * database driver, an HTTP transport and a JSON-RPC client, and putting them in
 * the packages they adapt would have made those packages import the
 * orchestrator. Here, the arrows all point one way: adapters -> orchestrator ->
 * everything else.
 *
 * THE ONE PROPERTY EVERY FILE HERE SHARES. A fake can be honest about not
 * knowing something because nothing is behind it. A real adapter has a network,
 * a database and a rate limit behind it, and every one of those can fail in a
 * way that looks exactly like "nothing happened". So each implementation
 * distinguishes the two, and says so by throwing: `CoverageGapError` when a
 * scan has not reached the window it was asked about, `CounterUnavailableError`
 * rather than a zero that would open every spend cap, `VaultNotTrackedError`
 * rather than an empty list that reads as a vault that never settled, and
 * `CredentialMissingError` at construction rather than a source that silently
 * ingests nothing.
 *
 * WHAT IS NOT HERE. No keys, no signer, no settlement submitter. The
 * `SettlementPort` is the one port this package deliberately does not
 * implement: it is the only thing in the system that can move money, and it
 * needs an operator key, an approval path and a review that is not this.
 */

export {
  AdapterError,
  ChatUnboundError,
  CounterUnavailableError,
  CoverageGapError,
  CredentialMissingError,
  CursorUnavailableError,
  EscalationSinkUnavailableError,
  InvoiceConflictError,
  InvoiceUnknownError,
  SecretUnopenableError,
  SourceUnavailableError,
  UnservableRangeError,
  VaultNotTrackedError,
} from './errors.js'
export type { AdapterErrorCode } from './errors.js'

export {
  CursorRegressionError,
  InMemoryChainCursorStore,
  PgChainCursorStore,
} from './chain/cursors.js'
export type { ChainCursorStore, ScanCursor, ScanStream } from './chain/cursors.js'

export { InMemoryHaltStore, PgHaltStore } from './chain/halts.js'
export type { HaltReadModel, HaltStore } from './chain/halts.js'

export { InMemoryVaultMovementStore, PgVaultMovementStore } from './chain/movements.js'
export type { VaultMovementStore } from './chain/movements.js'

export {
  DEFAULT_MAX_LOGS_PER_RANGE,
  FLEET_SCOPE,
  RpcChainReadModel,
} from './chain/read-model.js'
export type {
  FeeIndexerLike,
  RpcChainReadModelConfig,
  RpcChainReadModelDeps,
  SyncResult,
  TrackedVault,
  VaultSyncResult,
} from './chain/read-model.js'

export {
  VAULT_CLAIMED,
  VAULT_CREDITED,
  VAULT_MOVEMENT_TOPICS,
  decodeAllocation,
  decodeClaim,
  movementId,
} from './chain/vault-events.js'

export {
  BotApiTelegramInbound,
  FakeTelegramInbound,
  MAX_STORED_TEXT_CHARS,
} from './telegram/inbound.js'
export type { TelegramInbound, TelegramInboundMessage } from './telegram/inbound.js'

export {
  InMemoryInboundMessageStore,
  PgInboundMessageStore,
  TelegramMessageSource,
} from './telegram/message-source.js'
export type {
  InboundMessageStore,
  PollResult,
  StoredInboundMessage,
  TelegramMessageSourceConfig,
} from './telegram/message-source.js'

export { PgFleetCounters, dayKey } from './pg/counters.js'
export { MAX_DETAIL_CHARS, PgEscalationSink } from './pg/escalations.js'
export type { OpenEscalation } from './pg/escalations.js'

export { bigIntFromSql, countFromSql } from './pg/sql.js'
export type { SqlDriver, SqlRow, SqlValue } from './pg/sql.js'

export { PgIndexerStore } from './pg/indexer-store.js'
export { PgVaultRepository } from './pg/vaults.js'
export { PgScreeningStore } from './pg/screening.js'
export { PgReceiptStore } from './pg/receipts.js'
export { PgApprovalStore } from './pg/approvals.js'
export { PgInvoiceRegistry } from './pg/invoices.js'
export {
  PgAccountCredentialStore,
  PgAccountRegistry,
  PgLabelAttestationStore,
  PgPostRegistry,
} from './pg/publisher.js'
export { PgChannelHealthStore } from './pg/publisher-health.js'
export { PgImageAssetStore } from './pg/images.js'
export { pgLedgerDriver, toPositionalParams } from './pg/ledger-driver.js'
export { openSecret, sealSecret, sealedKeyId, sealingKeyFromHex } from './pg/crypto.js'
export type { SealingKey } from './pg/crypto.js'

export { PrivateKeySigner, SignerKeyError, addressOfPublicKey } from './chain/signer.js'
export type { RecoverableSignature, TransactionSigner } from './chain/signer.js'
export {
  TransactionEncodingError,
  bigIntToMinimalBytes,
  rlpEncode,
  serializeSigned,
  signTransaction,
  signingDigest,
} from './chain/tx.js'
export type { Eip1559Transaction, SignedTransaction } from './chain/tx.js'
export {
  AbiEncodeError,
  PULL_BUDGET_SELECTOR,
  USED_INVOICE_SELECTOR,
  decodeBool,
  encodePullBudget,
  encodeUsedInvoice,
} from './chain/abi-encode.js'
export type { PullBudgetArgs } from './chain/abi-encode.js'
export { ChainSettlementPort, SettlementError, chunkInvoiceHash } from './chain/settlement.js'
export type { ChainSettlementOptions, ChainSettlementReceipt, SettlementErrorCode } from './chain/settlement.js'

export { DexscreenerEvidenceSource } from './vendors/dexscreener.js'
export type { DexscreenerEvidenceSourceOptions } from './vendors/dexscreener.js'
export { CoinGeckoPriceBook } from './prices/coingecko.js'
export type { CoinGeckoIdMap, CoinGeckoPriceBookOptions } from './prices/coingecko.js'

export { NarrativeFetchError, fetchNarrativeSource, narrativeSourceUrlProblem } from './narrative/fetch.js'
export type { FetchNarrativeOptions, NarrativeFetchErrorCode, NarrativeSource } from './narrative/fetch.js'

export { PgPendingPurchaseStore } from './pg/purchases.js'

export { ChainRecipientReader, RecipientReadError } from './chain/recipients.js'
export type { ChainRecipientReaderOptions, PinnedChainReads, RecipientReadErrorCode } from './chain/recipients.js'
export { ChainVaultDeployer, VaultDeployError, predictVaultAddress } from './chain/deployer.js'
export type {
  ChainDeploymentReceipt,
  ChainVaultDeployerOptions,
  FactoryAddresses,
  VaultDeployErrorCode,
} from './chain/deployer.js'
export {
  CONSENT_TUPLE,
  DEPLOY_SELECTOR,
  IS_VAULT_SELECTOR,
  VAULT_DEPLOYED_TOPIC,
  consentSalt,
  encodeConsentWords,
  encodeDeploy,
  encodeIsVault,
} from './chain/abi-encode.js'
export {
  ESCROW_BALANCE_OF_SELECTOR,
  ESCROW_BALANCE_OF_TOKEN_SELECTOR,
  ESCROW_ERROR_SIGNATURES,
  MAX_SWEEP_ASSETS,
  NATIVE_ASSET,
  VAULT_ERROR_SIGNATURES,
  VAULT_STATE_BY_ORDINAL,
  VAULT_VIEW_SELECTORS,
  VAULT_VIEW_SIGNATURES,
  VAULT_WRITE_SELECTORS,
  VAULT_WRITE_SIGNATURES,
  customErrorSelector,
  decodeCheckSolvency,
  decodeCustomError,
  decodeLegs,
  decodeUint256,
  decodeVaultState,
  isNativeAsset,
  vaultStateFromOrdinal,
} from './chain/abi-encode.js'
export type {
  DecodedCustomError,
  EscrowErrorName,
  VaultErrorName,
  VaultLegs,
  VaultSolvency,
  VaultViewName,
  VaultWriteName,
} from './chain/abi-encode.js'
export { BroadcastError, TransactionBroadcaster, revertDataOf } from './chain/broadcast.js'
export type { BroadcastErrorCode, BroadcasterOptions, ConfirmedTransaction, TransactionRequest } from './chain/broadcast.js'
export {
  ESCROW_ERROR_CODES,
  VAULT_ERROR_CODES,
  VaultOpError,
  VaultOperatorClient,
  VaultReadClient,
  assertHeadReader,
  headOf,
} from './chain/vault-ops.js'
export type {
  EscrowContractErrorCode,
  VaultContractErrorCode,
  VaultOpErrorCode,
  VaultOperatorOptions,
  VaultReadOptions,
  VaultReadRpc,
  VaultTxReceipt,
} from './chain/vault-ops.js'
export { EscrowReadClient } from './chain/escrow.js'
export type { EscrowReadOptions } from './chain/escrow.js'

export {
  AssetReadError,
  ChainAssetReader,
  ChainAssetRegistry,
  PgAssetPolicy,
  loadAssetRegistry,
} from './chain/assets.js'
export type {
  AssetPolicy,
  AssetPolicySource,
  AssetReadErrorCode,
  ChainAssetFacts,
  LoadAssetRegistryOptions,
} from './chain/assets.js'
export { PgHolderBalanceStore } from './pg/holders.js'

// Desk: the support desk as a DeskPort, plus its typed moderation surface and
// the quorum-backed FactSheet reader.
export { ModerationRightsError, TelegramModerationActions } from './desk/moderation.js'
export type { DeskModerationActions, ModerationRight, TelegramModerationActionsOptions } from './desk/moderation.js'
export { VenueDeskChainReader, QuorumDeskTransport } from './desk/chain-reader.js'
export type { DeskChainReads, VenueDeskChainReaderOptions } from './desk/chain-reader.js'
export { TelegramDeskPort } from './desk/port.js'
export type { FlushableRefusalLog, TelegramDeskPortOptions } from './desk/port.js'
export { PgRefusalLog } from './pg/refusals.js'
export type { PgRefusalLogOptions } from './pg/refusals.js'

// X mentions ingest and the per-coin union of message sources.
export {
  InMemoryXMentionStore,
  PgXMentionStore,
  XMentionsMessageSource,
  compareTweetIds,
  mentionChatId,
} from './x/mentions.js'
export type {
  StoredXMention,
  XMentionStore,
  XMentionsMessageSourceOptions,
  XMentionsPollResult,
} from './x/mentions.js'
export { MergedMessageSource } from './telegram/merged.js'

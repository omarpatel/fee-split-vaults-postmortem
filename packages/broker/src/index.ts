/**
 * @fee-split-vaults/broker - the deterministic spend gate.
 *
 * No model runs in this package. Every money decision is an ordered chain of
 * pure functions over integer cents, so a disputed spend can be replayed from
 * the audit log by someone who does not trust the operator.
 */

export { SpendBroker, type SpendBrokerOptions } from './broker.js'

export {
  GATE_CHAIN,
  GATE_NAMES,
  assertCommitmentRuleIntact,
  categoryCapCents,
  evaluateGates,
  lifetimeCapCents,
  relatedPartyCapCents,
  rollingCapCents,
  traceGates,
  type Gate,
} from './gates.js'

export {
  buildGateContext,
  type BudgetLedgerView,
  type GateContext,
  type ObligationTerms,
  type ResolvedBudget,
  type ResolvedCounters,
  type ResolvedObligation,
  type SpendCounters,
  type SpendRequest,
} from './context.js'

export { validateSpendProposal } from './proposal.js'

export {
  HttpPolicyService,
  InMemoryPolicyService,
  PolicyKeyring,
  PolicyTokenSigner,
  compiledPolicyLimits,
  verifyPolicyToken,
  type EffectiveLimits,
  type HttpPolicyServiceOptions,
  type PolicyClaims,
  type PolicyLimits,
  type PolicyService,
  type VerifiedPolicy,
} from './policy.js'

export {
  HttpRateCardFetcher,
  InMemoryRateCardArchive,
  OPERATOR_VENDOR_ID,
  VendorCatalog,
  applyReconciliation,
  assertNoSpreadOnRecommendedPurchase,
  reconcileCatalog,
  sha256Hex,
  spreadCents,
  type CatalogEntry,
  type CatalogVariance,
  type CatalogVarianceKind,
  type HttpRateCardFetcherOptions,
  type PricingModel,
  type RateCard,
  type RateCardArchive,
} from './catalog.js'

export {
  FakeEvidenceSource,
  HttpEvidenceSource,
  PREDICATE_KINDS,
  PREDICATE_PARAMS,
  PredicateRegistry,
  isPredicateKind,
  type DeliveryRecord,
  type EtiListingObservation,
  type EvidenceRef,
  type EvidenceSource,
  type FakeEvidenceSeed,
  type HttpEvidenceEndpoints,
  type PredicateCheck,
  type PredicateKind,
  type PredicateParamVocabulary,
  type Verifier,
} from './predicates.js'

export {
  evaluateEscrow,
  milestoneSlices,
  planEscrow,
  toDeliveryOutcome,
  type EscrowOutcome,
  type EscrowPlan,
  type MilestoneSpec,
  type WithheldLine,
} from './escrow.js'

export {
  applyDeliveryOutcome,
  initialReliabilityScore,
  updateReliabilityScore,
  type DeliveryOutcome,
} from './reliability.js'

export {
  HUMAN_APPROVAL_MAX_AGE_SECONDS,
  assertNoThirdPartyPayee,
  buildDisbursement,
  decisionDigest,
  invoiceHashFor,
  minorFromUsdCents,
  splitBoundedTransfers,
  type AssetUsdPrice,
  type BuildDisbursementArgs,
  type BuiltDisbursement,
  type HumanApprovalRecord,
  type OperatorTreasury,
  type ReimbursementPull,
  type VendorInvoice,
} from './disbursement.js'

export {
  CATEGORY_SUBCAP_BPS,
  KOL_CHECK_OFFSETS_SECONDS,
  KYB_MAX_AGE_SECONDS,
  MANUAL_ATTESTATION_MAX_USD,
  MAX_RATIONALE_CHARS,
  MAX_SKU_QUANTITY,
  OFAC_MAX_AGE_SECONDS,
  QUALIFICATION_CONJUNCTS,
  RATE_CARD_MAX_AGE_SECONDS,
  RATE_LIMITS,
  ROLLING_WINDOW_DAYS,
  SCREENING_MAX_AGE_SECONDS,
  VENDOR_RELIABILITY,
  type SkuCategory,
} from './limits.js'

export {
  CENTS_PER_USD,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  PRICE_MAX_AGE_SECONDS,
  applyBps,
  ceilCentsFromUsd,
  exactCentsFromUsd,
  floorCentsFromUsd,
  fractionToBps,
  medianCents,
  pinnedCents,
  sumCents,
  usdFromCents,
} from './money.js'

export { createFakeHttpClient, createFetchHttpClient, type HttpClient, type HttpRequest, type HttpResponse } from './http.js'

export { BrokerError, PolicyError, SelfDealingError } from './errors.js'

export { sha256Hex as contentHash } from './hash.js'

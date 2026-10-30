/**
 * JSON wire shapes.
 *
 * `MinorString` and `CentsString` are decimal integer strings. They are strings
 * because JSON numbers are IEEE doubles: 2^53 wei is about 0.009 ETH, and a
 * receipts page whose whole claim is exactness cannot round an amount on the
 * way in. decode.ts is the only place these become bigint.
 */

import type { TierId } from '../protocol.js'

/** Decimal integer string, minor units of a named asset. */
export type MinorString = string
/** Decimal integer string, USD cents. */
export type CentsString = string

export interface UsdValueWire {
  cents: CentsString
  priceSource: string
  pricedAtUnix: number
  blockHash?: string
}

export interface AssetWire {
  address: string
  symbol: string
  decimals: number
}

export interface ProtocolInfoWire {
  chainId: number
  operatorLegalName: string
  operatorAddresses: Array<{ label: string; address: string; role: string }>
  factory: string
  vaultDeployer: string
  vaultInitCodeHash: string
  adapter: string
  termsUrl: string
  termsHash: string
  operatorBps: number
  budgetBpsMaxOffered: number
  receiptsBaseUrl: string
}

export interface CoinIdentityWire {
  vault: string
  token: string
  name: string
  symbol: string
  graduated: boolean
  launchedAtUnix: number
  buybackEnabled: boolean
  creatorTaxBps: number
}

export interface FeeFlowPeriodWire {
  periodStartUnix: number
  periodEndUnix: number
  perAsset: Array<{ asset: AssetWire; creditedMinor: MinorString; usd: UsdValueWire }>
  qfGrossCents: CentsString
  devLegCents: CentsString
  budgetCents: CentsString
  operatorFeeCents: CentsString
  referrerCents: CentsString
}

export interface DeliveryCheckWire {
  checkedAtUnix: number
  offsetSeconds: number
  passed: boolean
  evidenceUri?: string
  evidenceHash?: string
  note?: string
}

export interface ReceiptItemWire {
  id: string
  kind: 'procurement' | 'operations' | 'refund' | 'fee'
  description: string
  amountCents: CentsString
  occurredAtUnix: number
  publishAfterUnix: number
  executed: boolean
  vendorId?: string
  vendorName?: string
  vendorIsRelatedParty?: boolean
  skuId?: string
  skuDescription?: string
  invoiceHash?: string
  permalink?: string
  predicateKind?: string
  predicateResults: DeliveryCheckWire[]
  withheldReason?: string
}

export interface ReceiptPageWire {
  items: ReceiptItemWire[]
  nextCursor: string | null
}

export interface VendorScorecardWire {
  vendorId: string
  displayName: string
  isRelatedParty: boolean
  enabled: boolean
  reliabilityScore: number
  purchases: number
  spendCents: CentsString
  attributedNewBuyers: number
  costPerAttributedBuyerCents: CentsString | null
  predicatesPassed: number
  predicatesFailed: number
  withheldCents: CentsString
  lastPurchaseAtUnix: number | null
}

export interface PublicCoinWire {
  identity: CoinIdentityWire
  state: string
  tier: TierId
  operatorBps: number
  budgetBps: number
  budgetBpsMax: number
  referrerBps: number
  /** A measurement, not an amount: the trailing 7-day MEDIAN of daily credits. */
  qfPerDayUsd: number
  observedDays: number
  sustainedDays: number
  screening: { verdict: string; paidMediaPermitted: boolean; flags: string[] }
  period: FeeFlowPeriodWire
  lifetime: FeeFlowPeriodWire
  budgetBalanceCents: CentsString
  unprovenEscrowCents: CentsString
  balancesObservedAtUnix: number
  operatedAccounts: Array<{ channel: string; handle: string; url: string }>
  paidPromotionInUse: boolean
  lastReconciledAtUnix: number
  reconciliationVariance: 'none' | 'info' | 'warn' | 'critical'
  /** Scrubbed name/symbol plus counts. Links, sources and socials never appear. */
  subject: { name: string; symbol: string; linkCount: number; narrativeSourceCount: number }
  narrativeApproved: boolean
}

export interface CoinSummaryWire {
  vault: string
  token: string
  name: string
  symbol: string
  tier: TierId
  state: string
  qfPerDayUsd: number
  buybackEnabled: boolean
}

export interface AuthChallengeWire {
  address: string
  nonce: string
  message: string
  issuedAtUnix: number
  expiresAtUnix: number
}

export interface SessionWire {
  token: string
  address: string
  expiresAtUnix: number
  vaults: string[]
}

export interface WeeklyReportWire {
  vault: string
  periodStartUnix: number
  periodEndUnix: number
  qfReceivedCents: CentsString
  devLegCents: CentsString
  budgetSpentCents: CentsString
  operatorFeeCents: CentsString
  lineItems: ReceiptItemWire[]
  verifiedReachSummary: string
  attributedNewBuyers: number | null
  costPerAttributedBuyerCents: CentsString | null
  withheldPayments: Array<{
    vendorId: string
    vendorName: string
    amountCents: CentsString
    reason: string
  }>
  whatWeDidNotDo: string[]
}

export interface EscalationWire {
  id: string
  vault: string
  reason: string
  priority: 'low' | 'normal' | 'high' | 'critical'
  summary: string
  evidence: string[]
  openedAtUnix: number
  slaDueAtUnix: number
  acknowledgedAtUnix: number | null
  resolution: string | null
}

export interface UnsignedTxWire {
  to: string
  data: string
  value: string
  chainId: number
  summary: string
}

export interface DevVaultDetailWire {
  coin: PublicCoinWire
  devPayout: string
  claimable: Array<{ asset: AssetWire; devMinor: MinorString; usd: UsdValueWire }>
  pendingDial: { pendingBudgetBps: number; effectiveAtUnix: number } | null
  operatorNoticeUnix: number | null
  deadManUnix: number | null
  lastHeartbeatUnix: number | null
}

export interface ConsentWire {
  devSigner: string
  devPayout: string
  token: string
  termsHash: string
  operatorBps: number
  budgetBpsMax: number
  adapter: string
  referrer: string
  referrerBps: number
  expiryUnix: number
  nonce: string
}

export interface ConsentQuoteWire {
  consent: ConsentWire
  predictedVault: string
  salt: string
  digest: string
  termsUrl: string
}

export interface DeploymentTicketWire {
  vault: string
  tx: UnsignedTxWire
  submittedAtUnix: number
}

export interface RetrofitPlanWire {
  token: string
  vault: string
  transferTx: UnsignedTxWire
  registry: string
  currentRecipient: string
  strandableCredits: Array<{ asset: AssetWire; amountMinor: MinorString; usd: UsdValueWire }>
  claimTxs: UnsignedTxWire[]
  sweepTx: UnsignedTxWire | null
}

// ---------------------------------------------------------------------------
// The agent team
//
// `MicroUsdString` is a decimal integer string of MILLIONTHS of a dollar, not
// cents. See domain/money.ts: metered model spend is measured in fractions of a
// cent, and a per-call figure rounded to cents renders as "$0.00".
// ---------------------------------------------------------------------------

/** Decimal integer string, millionths of one USD. */
export type MicroUsdString = string

export interface AgentRoleWire {
  id: string
  title: string
  mission: string
  phases: string[]
  readsUntrustedInput: boolean
  may: string[]
  mayNot: string[]
  activity: string
  dormantCode?: string
  dormantReason?: string
}

export interface AgentModelWire {
  readerModel: string
  plannerModel: string
  /** 'live' | 'fake' | 'unknown'. Never omitted, never inferred from absence. */
  provenance: string
  detail: string
  viaBatch: boolean
}

export interface AgentSpendWire {
  todayMicroUsd: MicroUsdString
  dailyCapMicroUsd: MicroUsdString
  tierCogsPerDayMicroUsd: MicroUsdString
  callsToday: number
  degradeLevel: string
  dayKey: string
}

export interface CoinAgentWire {
  coinRef: string
  vault: string
  tier: TierId
  vaultState: string
  halted: boolean
  /** null means NO SCREENING ON FILE, which is not the same as a pass. */
  screeningVerdict: string | null
  paidMediaPermitted: boolean
  /** null means this coin has never ticked. Never 0, never "now". */
  lastTickAtUnix: number | null
  nextDueUnix: number | null
  freeze: string
  model: AgentModelWire
  spend: AgentSpendWire
  roles: AgentRoleWire[]
  fakedDependencies: string[]
  atUnix: number
}

export interface AgentRunDigestWire {
  windowId: string
  windowStartUnix: number
  windowEndUnix: number
  admittedMessageCount: number
  droppedMessageCount: number
  distinctAuthorCount: number
  topicCounts: Array<{ code: string; count: number }>
  signals: string[]
  gists: string[]
  rejectedGistCount: number
  readerRefusals: number
}

export interface AgentRunProposalWire {
  kind: string
  channel?: string
  intent?: string
  topic?: string
  linkRefCount?: number
  bodyChars?: number
  skuId?: string
  quantity?: number
  rationale?: string
  reason?: string
  note?: string
}

export interface AgentRunWire {
  id: string
  coinRef: string
  vault: string
  atUnix: number
  tier: TierId
  ranChainPoll: boolean
  ranCognition: boolean
  nextDueUnix: number
  skipped?: string
  freeze?: { level: string; reason: string }
  digest: AgentRunDigestWire | null
  proposals: AgentRunProposalWire[]
  suppressed: Array<{ proposal: AgentRunProposalWire; reason: string }>
  violations: Array<{ toolName: string; field: string; message: string }>
  refusals: Array<{ phase: string; code: string; detail: string }>
  spends: Array<{
    skuId?: string
    status: string
    approved: boolean
    failedGate?: string
    requiresHumanApproval: boolean
    code: string
    detail: string
  }>
  publishes: Array<{
    channel: string
    intent: string
    published: boolean
    rejectedReason?: string
  }>
  cost: {
    microUsd: MicroUsdString
    degradeLevel: string
    usage: {
      inputTokens: number
      outputTokens: number
      cacheCreationInputTokens: number
      cacheReadInputTokens: number
    }
  }
  modelProvenance: string
}

export interface AgentRunPageWire {
  vault: string
  atUnix: number
  runs: AgentRunWire[]
  nextCursor: string | null
  fakedDependencies: string[]
}

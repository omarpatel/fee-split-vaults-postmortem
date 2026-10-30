/**
 * What components consume.
 *
 * These are the DECODED shapes: every amount is bigint (minor units for assets,
 * cents for USD), every USD figure that came from a conversion carries its
 * price provenance, and nothing here is a JSON primitive that could silently be
 * a float. The wire shapes live in wire.ts and are converted exactly once, in
 * decode.ts, at the boundary.
 */

import type { TierId } from '../protocol.js'
import type { Cents, MicroUsd, Minor, PricedUsd } from '../domain/money.js'

export type Address = string
export type TxHash = string

export type VaultState =
  | 'UNBOUND'
  | 'PASSTHROUGH'
  | 'BOUND'
  | 'PENDING'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'POISONED'
  | 'TERMINATED'

export type ScreeningVerdict = 'CLEAR' | 'RESTRICTED' | 'BLOCKED'

// ---------------------------------------------------------------------------
// Protocol / deployment
// ---------------------------------------------------------------------------

export interface ProtocolInfo {
  chainId: number
  /** The operator's LEGAL name, for the disclosure block. Not a brand. */
  operatorLegalName: string
  /** Every operator-controlled address that touches member money. */
  operatorAddresses: Array<{ label: string; address: Address; role: string }>
  factory: Address
  /** CREATE2 deployer. Vault addresses derive from this, not from the factory. */
  vaultDeployer: Address
  vaultInitCodeHash: string
  adapter: Address
  /** Versioned MSA + content policy. The hash goes into the salt preimage. */
  termsUrl: string
  termsHash: string
  /** Read from config/protocol.ts server-side; mirrored so drift is visible. */
  operatorBps: number
  budgetBpsMaxOffered: number
  /** Where the desk publishes receipts, so links can be checked against it. */
  receiptsBaseUrl: string
}

// ---------------------------------------------------------------------------
// Public coin page
// ---------------------------------------------------------------------------

export interface Asset {
  address: Address
  symbol: string
  decimals: number
}

export interface CoinIdentity {
  vault: Address
  token: Address
  name: string
  symbol: string
  /** Whether the coin has graduated off the bonding curve. */
  graduated: boolean
  launchedAtUnix: number
  /** Determines the creator rate: 0.70% off, 0.35% on. Never assume. */
  buybackEnabled: boolean
  /** Immutable per token, 0..1000. Paid 100% to creator, never split. */
  creatorTaxBps: number
}

export interface FeeFlowPeriod {
  periodStartUnix: number
  periodEndUnix: number
  /** Gross creator fees credited to this coin's vault, per asset. */
  perAsset: Array<{ asset: Asset; creditedMinor: Minor; usd: PricedUsd }>
  /** USD totals, cents. Each leg separate; never summed into one figure. */
  qfGrossCents: Cents
  devLegCents: Cents
  budgetCents: Cents
  operatorFeeCents: Cents
  referrerCents: Cents
}

export interface DeliveryCheck {
  checkedAtUnix: number
  offsetSeconds: number
  passed: boolean
  evidenceUri?: string
  evidenceHash?: string
  note?: string
}

export interface ReceiptItem {
  id: string
  kind: 'procurement' | 'operations' | 'refund' | 'fee'
  description: string
  amountCents: Cents
  occurredAtUnix: number
  /** Server-declared reveal time. The client re-derives the 72h floor anyway. */
  publishAfterUnix: number
  /** False means it is still a commitment, and the lag applies to it. */
  executed: boolean

  vendorId?: string
  vendorName?: string
  vendorIsRelatedParty?: boolean
  skuId?: string
  skuDescription?: string
  invoiceHash?: string
  permalink?: string
  predicateKind?: string
  predicateResults: DeliveryCheck[]
  /** Set when a predicate failed and the vendor was not paid. */
  withheldReason?: string
}

export interface ReceiptPage {
  items: ReceiptItem[]
  nextCursor: string | null
}

export interface VendorScorecard {
  vendorId: string
  displayName: string
  isRelatedParty: boolean
  enabled: boolean
  reliabilityScore: number
  purchases: number
  spendCents: Cents
  /** Attributed by the indexer, not self-reported by the vendor. */
  attributedNewBuyers: number
  /**
   * null when the attribution window has not closed or no buyers were
   * attributed. A divide-by-zero rendered as "$0.00" would read as a triumph.
   */
  costPerAttributedBuyerCents: Cents | null
  predicatesPassed: number
  predicatesFailed: number
  withheldCents: Cents
  lastPurchaseAtUnix: number | null
}

/**
 * The coin as the dev described it at onboarding, scrubbed server-side. The
 * links and narrative sources are counted, never listed: they are destinations
 * the dev named, and the public page does not send readers to them.
 */
export interface CoinSubject {
  name: string
  symbol: string
  linkCount: number
  narrativeSourceCount: number
}

export interface PublicCoin {
  identity: CoinIdentity
  state: VaultState
  tier: TierId
  /** Immutable, frozen in the salt. */
  operatorBps: number
  budgetBps: number
  budgetBpsMax: number
  referrerBps: number

  qfPerDayUsd: number
  observedDays: number
  sustainedDays: number

  screening: { verdict: ScreeningVerdict; paidMediaPermitted: boolean; flags: string[] }

  period: FeeFlowPeriod
  lifetime: FeeFlowPeriod

  /**
   * Balances the page must BAND. Handed over as exact cents because banding is
   * the presentation layer's job and doing it server-side would leave the
   * client unable to state the ladder it used.
   */
  budgetBalanceCents: Cents
  unprovenEscrowCents: Cents
  balancesObservedAtUnix: number

  /** Accounts that post about this coin. Exactly one ticker each. */
  operatedAccounts: Array<{ channel: string; handle: string; url: string }>
  paidPromotionInUse: boolean
  lastReconciledAtUnix: number
  reconciliationVariance: 'none' | 'info' | 'warn' | 'critical'

  subject: CoinSubject
  /**
   * Whether an operator has approved the narrative derived from the dev's
   * sources. Nothing is posted about a coin before this is true.
   */
  narrativeApproved: boolean
}

export interface CoinSummary {
  vault: Address
  token: Address
  name: string
  symbol: string
  tier: TierId
  state: VaultState
  qfPerDayUsd: number
  buybackEnabled: boolean
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthChallenge {
  address: Address
  nonce: string
  /** The exact string the wallet must sign. Built server-side, shown to the dev. */
  message: string
  issuedAtUnix: number
  expiresAtUnix: number
}

export interface Session {
  token: string
  address: Address
  expiresAtUnix: number
  vaults: Address[]
}

// ---------------------------------------------------------------------------
// Dev dashboard
// ---------------------------------------------------------------------------

export interface WeeklyReportView {
  vault: Address
  periodStartUnix: number
  periodEndUnix: number
  qfReceivedCents: Cents
  devLegCents: Cents
  budgetSpentCents: Cents
  operatorFeeCents: Cents
  lineItems: ReceiptItem[]
  verifiedReachSummary: string
  attributedNewBuyers: number | null
  costPerAttributedBuyerCents: Cents | null
  withheldPayments: Array<{ vendorId: string; vendorName: string; amountCents: Cents; reason: string }>
  whatWeDidNotDo: string[]
}

export type EscalationPriority = 'low' | 'normal' | 'high' | 'critical'

export interface Escalation {
  id: string
  vault: Address
  reason: string
  priority: EscalationPriority
  /** Defanged before it left the desk. Links are inert by construction. */
  summary: string
  evidence: string[]
  openedAtUnix: number
  slaDueAtUnix: number
  acknowledgedAtUnix: number | null
  resolution: string | null
}

export interface PendingDialChange {
  pendingBudgetBps: number
  effectiveAtUnix: number
}

export interface DevVaultDetail {
  coin: PublicCoin
  devPayout: Address
  /** Legs are per asset and pull-only for the dev. */
  claimable: Array<{ asset: Asset; devMinor: Minor; usd: PricedUsd }>
  pendingDial: PendingDialChange | null
  operatorNoticeUnix: number | null
  deadManUnix: number | null
  lastHeartbeatUnix: number | null
}

/**
 * An unsigned transaction. The API never signs and never holds a key that
 * could; it hands back calldata and the dev's own wallet sends it. Every
 * state-changing dev control on the dashboard is one of these.
 */
export interface UnsignedTx {
  to: Address
  data: string
  value: string
  chainId: number
  /** Plain-language statement of what sending this does. Shown before signing. */
  summary: string
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export interface ConsentQuote {
  consent: {
    devSigner: Address
    devPayout: Address
    token: Address
    termsHash: string
    operatorBps: number
    budgetBpsMax: number
    adapter: Address
    referrer: Address
    referrerBps: number
    expiryUnix: number
    nonce: string
  }
  /** The server's prediction. The client recomputes and compares before signing. */
  predictedVault: Address
  salt: string
  digest: string
  termsUrl: string
}

export interface DeploymentTicket {
  vault: Address
  /** The deploy transaction, for the dev to send or for the operator to relay. */
  tx: UnsignedTx
  submittedAtUnix: number
}

export interface RetrofitPlan {
  token: Address
  vault: Address
  /** transferCreatorFeeRecipient(token, vault) against the Venue registry. */
  transferTx: UnsignedTx
  /** The registry that owns creator-fee recipiency for this token. */
  registry: Address
  currentRecipient: Address
  /**
   * Credited-but-unclaimed balances under the CURRENT recipient. These do not
   * follow recipiency and are the reason the sweep-and-claim step exists.
   */
  strandableCredits: Array<{ asset: Asset; amountMinor: Minor; usd: PricedUsd }>
  /** The claim transactions to send FIRST. msg.sender-only; nobody can help. */
  claimTxs: UnsignedTx[]
  sweepTx: UnsignedTx | null
}

// ---------------------------------------------------------------------------
// The agent team
//
// What a coin's page needs in order to show WHO is working for it and, just as
// importantly, WHO IS NOT AND WHY. A dormant role with its reason stated is
// more informative than a role that quietly disappears from the grid.
// ---------------------------------------------------------------------------

/**
 * The closed role vocabulary, and the only runtime value in this module.
 *
 * It is a value rather than a bare union because decode.ts checks an inbound
 * role id against it: a seventh role arriving from a server this client does
 * not understand is a decode failure, not a role rendered blank.
 */
export const AGENT_ROLE_IDS = [
  'indexer',
  'reader',
  'planner',
  'desk',
  'broker',
  'publisher',
] as const

export type AgentRoleId = (typeof AGENT_ROLE_IDS)[number]

/**
 * Whose output this is.
 *
 * 'unknown' is a real third state and not a polite 'fake': a process that has
 * not yet made a call cannot honestly claim a credential resolved.
 */
export type ModelProvenance = 'live' | 'fake' | 'unknown'

export type DegradeLevel = 'full' | 'batch' | 'downgrade' | 'suspend'

export type FreezeLevel = 'none' | 'purchases' | 'all'

export interface AgentRoleView {
  id: AgentRoleId
  title: string
  mission: string
  /** The tick phases this role owns. Ties a name to the code that runs. */
  phases: string[]
  readsUntrustedInput: boolean
  may: string[]
  /** The structural refusals. Product surface, not a disclaimer. */
  mayNot: string[]
  activity: 'active' | 'dormant'
  dormantCode?: string
  dormantReason?: string
}

export interface AgentModelView {
  readerModel: string
  plannerModel: string
  provenance: ModelProvenance
  detail: string
  viaBatch: boolean
}

export interface AgentSpendView {
  todayMicroUsd: MicroUsd
  dailyCapMicroUsd: MicroUsd
  tierCogsPerDayMicroUsd: MicroUsd
  callsToday: number
  degradeLevel: DegradeLevel
  dayKey: string
}

export interface CoinAgent {
  coinRef: string
  vault: Address
  tier: TierId
  vaultState: VaultState
  halted: boolean
  /** null means no screening on file. Absence is never rendered as a pass. */
  screeningVerdict: ScreeningVerdict | null
  paidMediaPermitted: boolean
  /** null means never ticked. The page must not render this as 0 or as now. */
  lastTickAtUnix: number | null
  nextDueUnix: number | null
  freeze: FreezeLevel
  model: AgentModelView
  spend: AgentSpendView
  roles: AgentRoleView[]
  /** Empty means everything is real. Nothing is omitted to tidy the page. */
  fakedDependencies: string[]
  atUnix: number
}

export interface AgentRunDigest {
  windowId: string
  windowStartUnix: number
  windowEndUnix: number
  /** Messages the READER saw, at full fidelity. */
  admittedMessageCount: number
  droppedMessageCount: number
  distinctAuthorCount: number
  topicCounts: Array<{ code: string; count: number }>
  signals: string[]
  /** The only text that crossed the airlock, and it is scrubbed. */
  gists: string[]
  rejectedGistCount: number
  readerRefusals: number
}

export type AgentRunProposal =
  | {
      kind: 'post'
      channel: string
      intent: string
      topic: string
      linkRefCount: number
      /** The body is never on the wire. Its length is an audit fact. */
      bodyChars: number
    }
  | { kind: 'purchase'; skuId: string; quantity: number; rationale: string }
  | { kind: 'escalation'; reason: string; note: string }
  | { kind: 'no_action'; reason: string }

export interface AgentRunRefusal {
  phase: string
  code: string
  detail: string
}

export interface AgentRun {
  id: string
  coinRef: string
  vault: Address
  atUnix: number
  tier: TierId
  ranChainPoll: boolean
  ranCognition: boolean
  nextDueUnix: number
  skipped?: string
  freeze?: { level: Exclude<FreezeLevel, 'none'>; reason: string }
  digest: AgentRunDigest | null
  proposals: AgentRunProposal[]
  suppressed: Array<{ proposal: AgentRunProposal; reason: string }>
  violations: Array<{ toolName: string; field: string; message: string }>
  refusals: AgentRunRefusal[]
  spends: Array<{
    skuId?: string
    status: string
    approved: boolean
    failedGate?: string
    requiresHumanApproval: boolean
    code: string
    detail: string
  }>
  publishes: Array<{ channel: string; intent: string; published: boolean; rejectedReason?: string }>
  cost: {
    microUsd: MicroUsd
    degradeLevel: DegradeLevel
    usage: {
      inputTokens: number
      outputTokens: number
      cacheCreationInputTokens: number
      cacheReadInputTokens: number
    }
  }
  /** Recorded per run, so a later credential cannot relabel scripted history. */
  modelProvenance: ModelProvenance
}

export interface AgentRunPage {
  vault: Address
  atUnix: number
  runs: AgentRun[]
  nextCursor: string | null
  fakedDependencies: string[]
}

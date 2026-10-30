/**
 * What the /v1 routes read that the rest of the service does not.
 *
 * Every port here is a READ except EscalationQueue.acknowledge, which writes
 * four columns the dev owns. None of them can move money, deploy anything or
 * make a coin tick; the web contract says no route signs or sends, and these
 * ports are shaped so that stays true by construction.
 *
 * Each port has an in-memory form in this file. They are not fakes in the
 * "canned answer" sense: the routes are tested against them with the same
 * projection code production runs, and a control plane booted without a
 * database gets exactly these, empty, so it serves an empty directory rather
 * than a 500.
 */

import type { Address } from '@fee-split-vaults/core'

// ---------------------------------------------------------------------------
// Chain views
// ---------------------------------------------------------------------------

/** CoinVault's public getters the dev dashboard renders. Read at one pinned block. */
export interface VaultDialView {
  budgetBps: number
  pendingBudgetBps: number
  /** 0 when no lowering is pending. */
  pendingDialUnix: number
  /** 0 when the operator has given no withdrawal notice. */
  operatorNoticeUnix: number
  lastOperatorActionUnix: number
  deadManUnix: number
  devPayout: Address
}

export interface VaultLegsView {
  dev: bigint
  budget: bigint
  operator: bigint
  referrer: bigint
}

export interface VaultViews {
  dial(vault: Address): Promise<VaultDialView>
  legOf(vault: Address, asset: string): Promise<VaultLegsView>
}

/** The Venue V2 escrow's credited-but-unclaimed balance for a recipient. */
export interface EscrowCredits {
  credits(recipient: Address, asset: string): Promise<bigint>
}

/** ERC-20 name()/symbol(), for a retrofit whose subject the dev never typed. */
export interface TokenMetadata {
  describe(token: Address): Promise<{ name: string; symbol: string }>
}

export class InMemoryVaultViews implements VaultViews {
  readonly dials = new Map<string, VaultDialView>()
  readonly legs = new Map<string, VaultLegsView>()

  async dial(vault: Address): Promise<VaultDialView> {
    const view = this.dials.get(vault.toLowerCase())
    if (view === undefined) throw new Error(`no vault view for ${vault}`)
    return { ...view }
  }

  async legOf(vault: Address, asset: string): Promise<VaultLegsView> {
    return { ...(this.legs.get(`${vault.toLowerCase()}|${asset.toLowerCase()}`) ?? { dev: 0n, budget: 0n, operator: 0n, referrer: 0n }) }
  }
}

export class InMemoryEscrowCredits implements EscrowCredits {
  readonly credited = new Map<string, bigint>()

  async credits(recipient: Address, asset: string): Promise<bigint> {
    return this.credited.get(`${recipient.toLowerCase()}|${asset.toLowerCase()}`) ?? 0n
  }
}

export class InMemoryTokenMetadata implements TokenMetadata {
  readonly tokens = new Map<string, { name: string; symbol: string }>()

  async describe(token: Address): Promise<{ name: string; symbol: string }> {
    const held = this.tokens.get(token.toLowerCase())
    if (held === undefined) throw new Error(`no such token ${token}`)
    return { ...held }
  }
}

// ---------------------------------------------------------------------------
// Escalations: the desk's queue, and the dev's acknowledgement of it
// ---------------------------------------------------------------------------

export type AckDecision = 'acknowledged' | 'action_taken' | 'dismissed'
export const ACK_DECISIONS: readonly AckDecision[] = ['acknowledged', 'action_taken', 'dismissed']

export interface EscalationRecord {
  id: string
  vault: Address
  kind: string
  code: string
  /** Machine-written by the orchestrator; still scrubbed on the way out. */
  detail: string
  raisedAtUnix: number
  resolvedAtUnix?: number
  acknowledgedAtUnix?: number
  ackDecision?: AckDecision
}

export interface EscalationQueue {
  /** Every escalation ever raised for the vault, newest first. */
  forVault(vault: Address): Promise<EscalationRecord[]>
  /** Records the dev's decision. Undefined when no such escalation exists for that vault. */
  acknowledge(input: {
    id: string
    vault: Address
    decision: AckDecision
    note: string
    by: Address
    atUnix: number
  }): Promise<EscalationRecord | undefined>
}

export class InMemoryEscalationQueue implements EscalationQueue {
  readonly rows: EscalationRecord[] = []

  async forVault(vault: Address): Promise<EscalationRecord[]> {
    return this.rows
      .filter((row) => row.vault.toLowerCase() === vault.toLowerCase())
      .sort((a, b) => b.raisedAtUnix - a.raisedAtUnix)
      .map((row) => ({ ...row }))
  }

  async acknowledge(input: Parameters<EscalationQueue['acknowledge']>[0]): Promise<EscalationRecord | undefined> {
    const row = this.rows.find((r) => r.id === input.id && r.vault.toLowerCase() === input.vault.toLowerCase())
    if (row === undefined) return undefined
    row.acknowledgedAtUnix = input.atUnix
    row.ackDecision = input.decision
    return { ...row }
  }
}

// ---------------------------------------------------------------------------
// Procurement outcomes: what was bought, and whether it was delivered
// ---------------------------------------------------------------------------

export interface PredicateCheck {
  offsetSeconds: number
  checkedAtUnix: number
  passed: boolean
  evidenceUri?: string
  evidenceHash?: string
  note?: string
}

export interface ProcurementOutcome {
  disbursementId: string
  vault: Address
  vendorId: string
  skuId: string
  predicateKind: string
  /** The catalog price the fleet quoted. Reporting only; the money moved as minor units. */
  costUsd: number
  fundedAtUnix: number
  /** Checks that have RUN. A scheduled-but-unchecked offset is not a result. */
  checks: PredicateCheck[]
  withheldReason?: string
}

export interface ProcurementOutcomes {
  forVault(vault: Address): Promise<ProcurementOutcome[]>
  forDisbursement(disbursementId: string): Promise<ProcurementOutcome | undefined>
}

export class InMemoryProcurementOutcomes implements ProcurementOutcomes {
  readonly outcomes: ProcurementOutcome[] = []

  async forVault(vault: Address): Promise<ProcurementOutcome[]> {
    return this.outcomes.filter((o) => o.vault.toLowerCase() === vault.toLowerCase()).map(cloneOutcome)
  }

  async forDisbursement(disbursementId: string): Promise<ProcurementOutcome | undefined> {
    const found = this.outcomes.find((o) => o.disbursementId === disbursementId)
    return found === undefined ? undefined : cloneOutcome(found)
  }
}

function cloneOutcome(outcome: ProcurementOutcome): ProcurementOutcome {
  return { ...outcome, checks: outcome.checks.map((check) => ({ ...check })) }
}

// ---------------------------------------------------------------------------
// The measurement the tier gate already made
// ---------------------------------------------------------------------------

export interface QfMeasurement {
  /** Trailing 7-day MEDIAN of daily credits in USD. A measurement, not an amount. */
  qfPerDayUsd: number
  observedDays: number
  sustainedDays: number
  measuredAtUnix: number
}

export interface QfReader {
  latest(vault: Address): Promise<QfMeasurement | undefined>
}

export class InMemoryQfReader implements QfReader {
  readonly measurements = new Map<string, QfMeasurement>()

  async latest(vault: Address): Promise<QfMeasurement | undefined> {
    const held = this.measurements.get(vault.toLowerCase())
    return held === undefined ? undefined : { ...held }
  }
}

// ---------------------------------------------------------------------------
// Vendors and operated accounts
// ---------------------------------------------------------------------------

export interface VendorSummary {
  id: string
  displayName: string
  isRelatedParty: boolean
  reliabilityScore: number
  enabled: boolean
}

export interface VendorDirectory {
  all(): readonly VendorSummary[]
}

export interface OperatedAccount {
  channel: string
  handle: string
  url: string
}

export interface OperatedAccounts {
  forVault(vault: Address): Promise<OperatedAccount[]>
}

export class InMemoryOperatedAccounts implements OperatedAccounts {
  readonly accounts = new Map<string, OperatedAccount[]>()

  async forVault(vault: Address): Promise<OperatedAccount[]> {
    return (this.accounts.get(vault.toLowerCase()) ?? []).map((account) => ({ ...account }))
  }
}

// ---------------------------------------------------------------------------
// The quote's side-channel: what the dev told us that is not in the consent
// ---------------------------------------------------------------------------

export interface QuoteExtras {
  nonce: string
  devSigner: Address
  narrativeSources: string[]
  socials?: { x?: string }
  issuedAtUnix: number
  expiresAtUnix: number
}

export interface QuoteStore {
  put(extras: QuoteExtras): Promise<void>
  get(nonce: string): Promise<QuoteExtras | undefined>
}

export class InMemoryQuoteStore implements QuoteStore {
  readonly #quotes = new Map<string, QuoteExtras>()

  async put(extras: QuoteExtras): Promise<void> {
    this.#quotes.set(extras.nonce, structuredClone(extras))
  }

  async get(nonce: string): Promise<QuoteExtras | undefined> {
    const held = this.#quotes.get(nonce)
    return held === undefined ? undefined : structuredClone(held)
  }
}

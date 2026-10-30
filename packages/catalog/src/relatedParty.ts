/**
 * RELATED-PARTY SPEND.
 *
 * A related party is any vendor the operator is affiliated with, and the
 * operator itself is the largest one: every operator-service line - moderation,
 * creative, build - is the operator selling to a budget the operator directs.
 * That is not forbidden, because someone has to do the work and doing it in
 * house is often cheapest. It is CAPPED and it is OPTED INTO, because the
 * alternative is an agency that quietly routes a client's whole procurement
 * budget to itself and calls the result a campaign.
 *
 * Two controls, both fail-closed:
 *
 *   CAP. SPEND_LIMITS.relatedPartyCapOf30dBudget of the coin's OWN trailing
 *   30-day procurement budget. The coin's own: no cross-coin arithmetic exists
 *   in this file, and COMMITMENT_RULE.allowCrossCoinSubsidy is why.
 *
 *   OPT-IN. Per (vault, vendor), explicit, revocable, and hashed against the
 *   exact disclosure text the dev accepted. Never inferred from a tier, never
 *   inherited from another coin, never granted by a model, and never implied by
 *   the dev having signed the master agreement - the master agreement is where
 *   the dev learns related parties exist, not where they consent to one.
 *
 * Absent data is a refusal. No opt-in, no spend. No 30-day budget figure, no
 * spend. A revoked opt-in is not a lapsed opt-in; it is a no.
 */
import { RelatedPartyViolation } from './errors.js'
import { applyBps, fractionToBps, formatCents } from './money.js'
import { SPEND_LIMITS } from './protocol.js'
import type { RelatedPartyDecision, RelatedPartyOptIn, RelatedPartySpendContext } from './types.js'

/** 0.25 -> 2500 bps, checked once at module load so no cap is a float. */
export const RELATED_PARTY_CAP_BPS = fractionToBps(
  SPEND_LIMITS.relatedPartyCapOf30dBudget,
  'SPEND_LIMITS.relatedPartyCapOf30dBudget',
)

/** Where per-dev opt-ins live. Never a model output; never a message field. */
export interface RelatedPartyOptInStore {
  /** The live opt-in for this pair, or null. Revoked records return null. */
  find(vault: string, vendorId: string, nowUnix: number): Promise<RelatedPartyOptIn | null>
}

export class InMemoryRelatedPartyOptIns implements RelatedPartyOptInStore {
  readonly #records = new Map<string, RelatedPartyOptIn>()

  constructor(seed: readonly RelatedPartyOptIn[] = []) {
    for (const record of seed) this.record(record)
  }

  static #key(vault: string, vendorId: string): string {
    return `${vault.toLowerCase()}|${vendorId}`
  }

  record(optIn: RelatedPartyOptIn): void {
    if (typeof optIn.vault !== 'string' || optIn.vault.length === 0) {
      throw new RelatedPartyViolation('bad_vault', 'opt-in has no vault')
    }
    if (typeof optIn.vendorId !== 'string' || optIn.vendorId.length === 0) {
      throw new RelatedPartyViolation('bad_vendor', 'opt-in has no vendor')
    }
    if (typeof optIn.disclosureHash !== 'string' || optIn.disclosureHash.length < 32) {
      throw new RelatedPartyViolation(
        'no_disclosure_hash',
        `opt-in for ${optIn.vendorId} does not commit to the disclosure the dev accepted`,
      )
    }
    this.#records.set(InMemoryRelatedPartyOptIns.#key(optIn.vault, optIn.vendorId), optIn)
  }

  revoke(vault: string, vendorId: string, atUnix: number): void {
    const key = InMemoryRelatedPartyOptIns.#key(vault, vendorId)
    const existing = this.#records.get(key)
    if (existing === undefined) return
    this.#records.set(key, { ...existing, revokedAtUnix: atUnix })
  }

  async find(vault: string, vendorId: string, nowUnix: number): Promise<RelatedPartyOptIn | null> {
    const record = this.#records.get(InMemoryRelatedPartyOptIns.#key(vault, vendorId))
    if (record === undefined) return null
    if (record.optedInAtUnix > nowUnix) return null
    if (record.revokedAtUnix !== undefined && record.revokedAtUnix <= nowUnix) return null
    return record
  }
}

/** The cap in cents for a given trailing-30-day procurement budget. */
export function relatedPartyCapCents(trailing30dBudgetCents: bigint): bigint {
  if (trailing30dBudgetCents < 0n) {
    throw new RelatedPartyViolation(
      'negative_budget',
      'trailing 30-day budget cannot be negative',
    )
  }
  return applyBps(trailing30dBudgetCents, RELATED_PARTY_CAP_BPS)
}

/**
 * The decision. Returns a value rather than throwing because the broker's gate
 * layer wants a reason string it can put in a SpendDecision; the throwing
 * variant below exists for callers that treat this as an invariant.
 */
export async function evaluateRelatedPartySpend(
  store: RelatedPartyOptInStore,
  context: RelatedPartySpendContext,
): Promise<RelatedPartyDecision> {
  const { vault, vendorId, trailing30dBudgetCents, relatedPartySpentCents, proposedCents } = context

  if (proposedCents <= 0n) {
    return {
      permitted: false,
      capCents: 0n,
      remainingCents: 0n,
      reason: 'proposed amount is not positive',
    }
  }
  if (trailing30dBudgetCents <= 0n) {
    // Fail closed: no measured budget means no measured cap, which means no cap.
    return {
      permitted: false,
      capCents: 0n,
      remainingCents: 0n,
      reason: 'no trailing 30-day procurement budget on record for this vault',
    }
  }

  const optIn = await store.find(vault, vendorId, context.nowUnix)
  if (optIn === null) {
    return {
      permitted: false,
      capCents: relatedPartyCapCents(trailing30dBudgetCents),
      remainingCents: 0n,
      reason: `no live per-dev opt-in for related party "${vendorId}" on this vault`,
    }
  }

  const cap = relatedPartyCapCents(trailing30dBudgetCents)
  const spent = relatedPartySpentCents < 0n ? 0n : relatedPartySpentCents
  const remaining = cap > spent ? cap - spent : 0n

  if (proposedCents > remaining) {
    return {
      permitted: false,
      capCents: cap,
      remainingCents: remaining,
      reason:
        `related-party spend with "${vendorId}" would reach ${formatCents(spent + proposedCents)} against a ` +
        `30-day cap of ${formatCents(cap)} (${RELATED_PARTY_CAP_BPS} bps of ${formatCents(trailing30dBudgetCents)})`,
    }
  }

  return {
    permitted: true,
    capCents: cap,
    remainingCents: remaining - proposedCents,
    reason: `within the ${RELATED_PARTY_CAP_BPS} bps related-party cap, opted in at ${optIn.optedInAtUnix}`,
  }
}

/** Throwing form, for callers that treat a related-party breach as a defect. */
export async function assertRelatedPartySpend(
  store: RelatedPartyOptInStore,
  context: RelatedPartySpendContext,
): Promise<RelatedPartyDecision> {
  const decision = await evaluateRelatedPartySpend(store, context)
  if (!decision.permitted) {
    throw new RelatedPartyViolation('refused', decision.reason)
  }
  return decision
}

/**
 * The wire -> domain boundary. The ONLY place a JSON value becomes a bigint.
 *
 * Fails closed. A malformed amount throws rather than defaulting to zero: a
 * receipts page that renders "$0.00" because a string did not parse is worse
 * than one that renders an error, because the reader cannot tell the difference
 * between "nothing was spent" and "we could not read what was spent".
 */

import type { Cents, MicroUsd, Minor, PricedUsd } from '../domain/money.js'
import { TIER_ORDER, type TierId } from '../protocol.js'
// The one VALUE this module needs from model.ts: the closed role vocabulary,
// which is checked at the boundary rather than trusted from the server.
import { AGENT_ROLE_IDS } from './model.js'
import type * as M from './model.js'
import type * as W from './wire.js'

export class DecodeError extends Error {
  constructor(message: string, readonly field: string) {
    super(`decode: ${message} (${field})`)
    this.name = 'DecodeError'
  }
}

const INTEGER_STRING = /^-?\d+$/

export function decodeInteger(value: string, field: string): bigint {
  if (typeof value !== 'string' || !INTEGER_STRING.test(value)) {
    throw new DecodeError(`expected a decimal integer string, got ${JSON.stringify(value)}`, field)
  }
  return BigInt(value)
}

export function decodeMinor(value: string, field: string): Minor {
  return decodeInteger(value, field)
}

export function decodeCents(value: string, field: string): Cents {
  return decodeInteger(value, field)
}

export function decodeCentsOrNull(value: string | null, field: string): Cents | null {
  return value === null ? null : decodeCents(value, field)
}

export function decodeUsd(wire: W.UsdValueWire, field: string): PricedUsd {
  if (typeof wire?.priceSource !== 'string' || wire.priceSource.length === 0) {
    throw new DecodeError('a USD figure arrived without a price source', field)
  }
  return {
    cents: decodeCents(wire.cents, `${field}.cents`),
    priceSource: wire.priceSource,
    pricedAtUnix: wire.pricedAtUnix,
    ...(wire.blockHash === undefined ? {} : { blockHash: wire.blockHash }),
  }
}

const VAULT_STATES: readonly M.VaultState[] = [
  'UNBOUND',
  'PASSTHROUGH',
  'BOUND',
  'PENDING',
  'ACTIVE',
  'SUSPENDED',
  'POISONED',
  'TERMINATED',
]

export function decodeVaultState(value: string, field: string): M.VaultState {
  const found = VAULT_STATES.find((state) => state === value)
  if (found === undefined) throw new DecodeError(`unknown vault state "${value}"`, field)
  return found
}

export function decodeTier(value: string, field: string): TierId {
  const found = TIER_ORDER.find((tier) => tier === value)
  if (found === undefined) throw new DecodeError(`unknown tier "${value}"`, field)
  return found
}

export function decodeAsset(wire: W.AssetWire): M.Asset {
  return { address: wire.address, symbol: wire.symbol, decimals: wire.decimals }
}

export function decodeProtocol(wire: W.ProtocolInfoWire): M.ProtocolInfo {
  return { ...wire }
}

export function decodeFeeFlowPeriod(wire: W.FeeFlowPeriodWire, field: string): M.FeeFlowPeriod {
  return {
    periodStartUnix: wire.periodStartUnix,
    periodEndUnix: wire.periodEndUnix,
    perAsset: wire.perAsset.map((entry, i) => ({
      asset: decodeAsset(entry.asset),
      creditedMinor: decodeMinor(entry.creditedMinor, `${field}.perAsset[${i}]`),
      usd: decodeUsd(entry.usd, `${field}.perAsset[${i}].usd`),
    })),
    qfGrossCents: decodeCents(wire.qfGrossCents, `${field}.qfGrossCents`),
    devLegCents: decodeCents(wire.devLegCents, `${field}.devLegCents`),
    budgetCents: decodeCents(wire.budgetCents, `${field}.budgetCents`),
    operatorFeeCents: decodeCents(wire.operatorFeeCents, `${field}.operatorFeeCents`),
    referrerCents: decodeCents(wire.referrerCents, `${field}.referrerCents`),
  }
}

export function decodeReceipt(wire: W.ReceiptItemWire, field: string): M.ReceiptItem {
  return {
    id: wire.id,
    kind: wire.kind,
    description: wire.description,
    amountCents: decodeCents(wire.amountCents, `${field}.amountCents`),
    occurredAtUnix: wire.occurredAtUnix,
    publishAfterUnix: wire.publishAfterUnix,
    executed: wire.executed === true,
    predicateResults: wire.predicateResults.map((check) => ({ ...check })),
    ...(wire.vendorId === undefined ? {} : { vendorId: wire.vendorId }),
    ...(wire.vendorName === undefined ? {} : { vendorName: wire.vendorName }),
    ...(wire.vendorIsRelatedParty === undefined
      ? {}
      : { vendorIsRelatedParty: wire.vendorIsRelatedParty }),
    ...(wire.skuId === undefined ? {} : { skuId: wire.skuId }),
    ...(wire.skuDescription === undefined ? {} : { skuDescription: wire.skuDescription }),
    ...(wire.invoiceHash === undefined ? {} : { invoiceHash: wire.invoiceHash }),
    ...(wire.permalink === undefined ? {} : { permalink: wire.permalink }),
    ...(wire.predicateKind === undefined ? {} : { predicateKind: wire.predicateKind }),
    ...(wire.withheldReason === undefined ? {} : { withheldReason: wire.withheldReason }),
  }
}

export function decodeReceiptPage(wire: W.ReceiptPageWire): M.ReceiptPage {
  return {
    items: wire.items.map((item, i) => decodeReceipt(item, `receipts[${i}]`)),
    nextCursor: wire.nextCursor,
  }
}

export function decodeVendor(wire: W.VendorScorecardWire): M.VendorScorecard {
  const field = `vendor.${wire.vendorId}`
  return {
    vendorId: wire.vendorId,
    displayName: wire.displayName,
    isRelatedParty: wire.isRelatedParty,
    enabled: wire.enabled,
    reliabilityScore: wire.reliabilityScore,
    purchases: wire.purchases,
    spendCents: decodeCents(wire.spendCents, `${field}.spendCents`),
    attributedNewBuyers: wire.attributedNewBuyers,
    costPerAttributedBuyerCents: decodeCentsOrNull(
      wire.costPerAttributedBuyerCents,
      `${field}.costPerAttributedBuyerCents`,
    ),
    predicatesPassed: wire.predicatesPassed,
    predicatesFailed: wire.predicatesFailed,
    withheldCents: decodeCents(wire.withheldCents, `${field}.withheldCents`),
    lastPurchaseAtUnix: wire.lastPurchaseAtUnix,
  }
}

export function decodeCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new DecodeError('expected a non-negative integer', field)
  }
  return value
}

export function decodeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new DecodeError('expected a boolean', field)
  return value
}

/**
 * Typed as unknown on purpose: the wire type SAYS this is an object, but the
 * subject is the one part of the record a dev authored, and a server that
 * forgot to scrub or reshape it must not render as a coin with no name.
 */
export function decodeSubject(value: unknown, field: string): M.CoinSubject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DecodeError('expected an object', field)
  }
  const subject = value as Record<string, unknown>
  if (typeof subject.name !== 'string') throw new DecodeError('expected a string', `${field}.name`)
  if (typeof subject.symbol !== 'string') {
    throw new DecodeError('expected a string', `${field}.symbol`)
  }
  return {
    name: subject.name,
    symbol: subject.symbol,
    linkCount: decodeCount(subject.linkCount, `${field}.linkCount`),
    narrativeSourceCount: decodeCount(
      subject.narrativeSourceCount,
      `${field}.narrativeSourceCount`,
    ),
  }
}

export function decodePublicCoin(wire: W.PublicCoinWire): M.PublicCoin {
  const field = `coin.${wire.identity.vault}`
  return {
    identity: { ...wire.identity },
    state: decodeVaultState(wire.state, `${field}.state`),
    tier: decodeTier(wire.tier, `${field}.tier`),
    operatorBps: wire.operatorBps,
    budgetBps: wire.budgetBps,
    budgetBpsMax: wire.budgetBpsMax,
    referrerBps: wire.referrerBps,
    qfPerDayUsd: wire.qfPerDayUsd,
    observedDays: wire.observedDays,
    sustainedDays: wire.sustainedDays,
    screening: {
      verdict: decodeScreeningVerdict(wire.screening.verdict, `${field}.screening`),
      paidMediaPermitted: wire.screening.paidMediaPermitted,
      flags: [...wire.screening.flags],
    },
    period: decodeFeeFlowPeriod(wire.period, `${field}.period`),
    lifetime: decodeFeeFlowPeriod(wire.lifetime, `${field}.lifetime`),
    budgetBalanceCents: decodeCents(wire.budgetBalanceCents, `${field}.budgetBalanceCents`),
    unprovenEscrowCents: decodeCents(wire.unprovenEscrowCents, `${field}.unprovenEscrowCents`),
    balancesObservedAtUnix: wire.balancesObservedAtUnix,
    operatedAccounts: wire.operatedAccounts.map((account) => ({ ...account })),
    paidPromotionInUse: wire.paidPromotionInUse,
    lastReconciledAtUnix: wire.lastReconciledAtUnix,
    reconciliationVariance: wire.reconciliationVariance,
    subject: decodeSubject(wire.subject, `${field}.subject`),
    narrativeApproved: decodeBoolean(wire.narrativeApproved, `${field}.narrativeApproved`),
  }
}

export function decodeCoinSummary(wire: W.CoinSummaryWire): M.CoinSummary {
  return {
    vault: wire.vault,
    token: wire.token,
    name: wire.name,
    symbol: wire.symbol,
    tier: decodeTier(wire.tier, 'summary.tier'),
    state: decodeVaultState(wire.state, 'summary.state'),
    qfPerDayUsd: wire.qfPerDayUsd,
    buybackEnabled: wire.buybackEnabled,
  }
}

export function decodeWeeklyReport(wire: W.WeeklyReportWire): M.WeeklyReportView {
  const field = `report.${wire.vault}.${wire.periodStartUnix}`
  return {
    vault: wire.vault,
    periodStartUnix: wire.periodStartUnix,
    periodEndUnix: wire.periodEndUnix,
    qfReceivedCents: decodeCents(wire.qfReceivedCents, `${field}.qfReceivedCents`),
    devLegCents: decodeCents(wire.devLegCents, `${field}.devLegCents`),
    budgetSpentCents: decodeCents(wire.budgetSpentCents, `${field}.budgetSpentCents`),
    operatorFeeCents: decodeCents(wire.operatorFeeCents, `${field}.operatorFeeCents`),
    lineItems: wire.lineItems.map((item, i) => decodeReceipt(item, `${field}.lineItems[${i}]`)),
    verifiedReachSummary: wire.verifiedReachSummary,
    attributedNewBuyers: wire.attributedNewBuyers,
    costPerAttributedBuyerCents: decodeCentsOrNull(
      wire.costPerAttributedBuyerCents,
      `${field}.costPerAttributedBuyerCents`,
    ),
    withheldPayments: wire.withheldPayments.map((payment, i) => ({
      vendorId: payment.vendorId,
      vendorName: payment.vendorName,
      amountCents: decodeCents(payment.amountCents, `${field}.withheldPayments[${i}]`),
      reason: payment.reason,
    })),
    whatWeDidNotDo: [...wire.whatWeDidNotDo],
  }
}

export function decodeEscalation(wire: W.EscalationWire): M.Escalation {
  return { ...wire, evidence: [...wire.evidence] }
}

export function decodeUnsignedTx(wire: W.UnsignedTxWire): M.UnsignedTx {
  return { ...wire }
}

export function decodeDevVaultDetail(wire: W.DevVaultDetailWire): M.DevVaultDetail {
  const field = `devVault.${wire.coin.identity.vault}`
  return {
    coin: decodePublicCoin(wire.coin),
    devPayout: wire.devPayout,
    claimable: wire.claimable.map((leg, i) => ({
      asset: decodeAsset(leg.asset),
      devMinor: decodeMinor(leg.devMinor, `${field}.claimable[${i}].devMinor`),
      usd: decodeUsd(leg.usd, `${field}.claimable[${i}].usd`),
    })),
    pendingDial: wire.pendingDial === null ? null : { ...wire.pendingDial },
    operatorNoticeUnix: wire.operatorNoticeUnix,
    deadManUnix: wire.deadManUnix,
    lastHeartbeatUnix: wire.lastHeartbeatUnix,
  }
}

export function decodeConsentQuote(wire: W.ConsentQuoteWire): M.ConsentQuote {
  return {
    consent: { ...wire.consent },
    predictedVault: wire.predictedVault,
    salt: wire.salt,
    digest: wire.digest,
    termsUrl: wire.termsUrl,
  }
}

export function decodeRetrofitPlan(wire: W.RetrofitPlanWire): M.RetrofitPlan {
  return {
    token: wire.token,
    vault: wire.vault,
    transferTx: decodeUnsignedTx(wire.transferTx),
    registry: wire.registry,
    currentRecipient: wire.currentRecipient,
    strandableCredits: wire.strandableCredits.map((credit, i) => ({
      asset: decodeAsset(credit.asset),
      amountMinor: decodeMinor(credit.amountMinor, `retrofit.strandable[${i}]`),
      usd: decodeUsd(credit.usd, `retrofit.strandable[${i}].usd`),
    })),
    claimTxs: wire.claimTxs.map(decodeUnsignedTx),
    sweepTx: wire.sweepTx === null ? null : decodeUnsignedTx(wire.sweepTx),
  }
}

// ---------------------------------------------------------------------------
// The agent team
// ---------------------------------------------------------------------------

export function decodeMicroUsd(value: string, field: string): MicroUsd {
  return decodeInteger(value, field)
}

/**
 * A closed enum, decoded closed.
 *
 * An unknown member throws rather than falling back. A page that quietly read
 * an unrecognised degrade level as 'full' would render a suspended team as a
 * working one, which is the exact class of failure this app refuses elsewhere.
 */
export function decodeEnum<T extends string>(value: string, allowed: readonly T[], field: string): T {
  const found = allowed.find((candidate) => candidate === value)
  if (found === undefined) throw new DecodeError(`unknown value "${value}"`, field)
  return found
}

const DEGRADE_LEVELS: readonly M.DegradeLevel[] = ['full', 'batch', 'downgrade', 'suspend']
const FREEZE_LEVELS: readonly M.FreezeLevel[] = ['none', 'purchases', 'all']
const PROVENANCES: readonly M.ModelProvenance[] = ['live', 'fake', 'unknown']
const ACTIVITIES = ['active', 'dormant'] as const
const FREEZE_LEVELS_SET = ['purchases', 'all'] as const

export function decodeAgentRole(wire: W.AgentRoleWire, field: string): M.AgentRoleView {
  return {
    id: decodeEnum(wire.id, AGENT_ROLE_IDS, `${field}.id`),
    title: wire.title,
    mission: wire.mission,
    phases: [...wire.phases],
    readsUntrustedInput: wire.readsUntrustedInput === true,
    may: [...wire.may],
    mayNot: [...wire.mayNot],
    activity: decodeEnum(wire.activity, ACTIVITIES, `${field}.activity`),
    ...(wire.dormantCode === undefined ? {} : { dormantCode: wire.dormantCode }),
    ...(wire.dormantReason === undefined ? {} : { dormantReason: wire.dormantReason }),
  }
}

export function decodeCoinAgent(wire: W.CoinAgentWire): M.CoinAgent {
  const field = `agent.${wire.vault}`
  const roles = wire.roles.map((role, i) => decodeAgentRole(role, `${field}.roles[${i}]`))
  // A team that arrived short a member is a decode failure, not a smaller team:
  // a missing role would render as a role that does not exist rather than as a
  // role nobody told us about.
  if (roles.length !== AGENT_ROLE_IDS.length) {
    throw new DecodeError(
      `expected ${AGENT_ROLE_IDS.length} roles, got ${roles.length}`,
      `${field}.roles`,
    )
  }
  return {
    coinRef: wire.coinRef,
    vault: wire.vault,
    tier: decodeTier(wire.tier, `${field}.tier`),
    vaultState: decodeVaultState(wire.vaultState, `${field}.vaultState`),
    halted: wire.halted === true,
    screeningVerdict:
      wire.screeningVerdict === null
        ? null
        : decodeScreeningVerdict(wire.screeningVerdict, `${field}.screeningVerdict`),
    paidMediaPermitted: wire.paidMediaPermitted === true,
    lastTickAtUnix: wire.lastTickAtUnix,
    nextDueUnix: wire.nextDueUnix,
    freeze: decodeEnum(wire.freeze, FREEZE_LEVELS, `${field}.freeze`),
    model: {
      readerModel: wire.model.readerModel,
      plannerModel: wire.model.plannerModel,
      provenance: decodeEnum(wire.model.provenance, PROVENANCES, `${field}.model.provenance`),
      detail: wire.model.detail,
      viaBatch: wire.model.viaBatch === true,
    },
    spend: {
      todayMicroUsd: decodeMicroUsd(wire.spend.todayMicroUsd, `${field}.spend.today`),
      dailyCapMicroUsd: decodeMicroUsd(wire.spend.dailyCapMicroUsd, `${field}.spend.dailyCap`),
      tierCogsPerDayMicroUsd: decodeMicroUsd(
        wire.spend.tierCogsPerDayMicroUsd,
        `${field}.spend.tierCogs`,
      ),
      callsToday: wire.spend.callsToday,
      degradeLevel: decodeEnum(wire.spend.degradeLevel, DEGRADE_LEVELS, `${field}.spend.degrade`),
      dayKey: wire.spend.dayKey,
    },
    roles,
    fakedDependencies: [...wire.fakedDependencies],
    atUnix: wire.atUnix,
  }
}

export function decodeScreeningVerdict(value: string, field: string): M.ScreeningVerdict {
  if (value === 'CLEAR' || value === 'RESTRICTED' || value === 'BLOCKED') return value
  throw new DecodeError(`unknown screening verdict "${value}"`, field)
}

export function decodeAgentProposal(
  wire: W.AgentRunProposalWire,
  field: string,
): M.AgentRunProposal {
  switch (wire.kind) {
    case 'post':
      return {
        kind: 'post',
        channel: requirePresent(wire.channel, `${field}.channel`),
        intent: requirePresent(wire.intent, `${field}.intent`),
        topic: requirePresent(wire.topic, `${field}.topic`),
        linkRefCount: requirePresent(wire.linkRefCount, `${field}.linkRefCount`),
        bodyChars: requirePresent(wire.bodyChars, `${field}.bodyChars`),
      }
    case 'purchase':
      return {
        kind: 'purchase',
        skuId: requirePresent(wire.skuId, `${field}.skuId`),
        quantity: requirePresent(wire.quantity, `${field}.quantity`),
        rationale: wire.rationale ?? '',
      }
    case 'escalation':
      return {
        kind: 'escalation',
        reason: requirePresent(wire.reason, `${field}.reason`),
        note: wire.note ?? '',
      }
    case 'no_action':
      return { kind: 'no_action', reason: wire.reason ?? '' }
    default:
      throw new DecodeError(`unknown proposal kind "${wire.kind}"`, field)
  }
}

/** A field the schema says is always present for this kind, or a decode error. */
function requirePresent<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new DecodeError('required field is missing', field)
  return value
}

export function decodeAgentRun(wire: W.AgentRunWire): M.AgentRun {
  const field = `run.${wire.id}`
  return {
    id: wire.id,
    coinRef: wire.coinRef,
    vault: wire.vault,
    atUnix: wire.atUnix,
    tier: decodeTier(wire.tier, `${field}.tier`),
    ranChainPoll: wire.ranChainPoll === true,
    ranCognition: wire.ranCognition === true,
    nextDueUnix: wire.nextDueUnix,
    ...(wire.skipped === undefined ? {} : { skipped: wire.skipped }),
    ...(wire.freeze === undefined
      ? {}
      : {
          freeze: {
            level: decodeEnum(wire.freeze.level, FREEZE_LEVELS_SET, `${field}.freeze.level`),
            reason: wire.freeze.reason,
          },
        }),
    digest:
      wire.digest === null
        ? null
        : {
            windowId: wire.digest.windowId,
            windowStartUnix: wire.digest.windowStartUnix,
            windowEndUnix: wire.digest.windowEndUnix,
            admittedMessageCount: wire.digest.admittedMessageCount,
            droppedMessageCount: wire.digest.droppedMessageCount,
            distinctAuthorCount: wire.digest.distinctAuthorCount,
            topicCounts: wire.digest.topicCounts.map((entry) => ({ ...entry })),
            signals: [...wire.digest.signals],
            gists: [...wire.digest.gists],
            rejectedGistCount: wire.digest.rejectedGistCount,
            readerRefusals: wire.digest.readerRefusals,
          },
    proposals: wire.proposals.map((proposal, i) =>
      decodeAgentProposal(proposal, `${field}.proposals[${i}]`),
    ),
    suppressed: wire.suppressed.map((entry, i) => ({
      proposal: decodeAgentProposal(entry.proposal, `${field}.suppressed[${i}]`),
      reason: entry.reason,
    })),
    violations: wire.violations.map((violation) => ({ ...violation })),
    refusals: wire.refusals.map((refusal) => ({ ...refusal })),
    spends: wire.spends.map((spend) => ({ ...spend })),
    publishes: wire.publishes.map((attempt) => ({ ...attempt })),
    cost: {
      microUsd: decodeMicroUsd(wire.cost.microUsd, `${field}.cost.microUsd`),
      degradeLevel: decodeEnum(wire.cost.degradeLevel, DEGRADE_LEVELS, `${field}.cost.degrade`),
      usage: { ...wire.cost.usage },
    },
    modelProvenance: decodeEnum(wire.modelProvenance, PROVENANCES, `${field}.modelProvenance`),
  }
}

export function decodeAgentRunPage(wire: W.AgentRunPageWire): M.AgentRunPage {
  return {
    vault: wire.vault,
    atUnix: wire.atUnix,
    runs: wire.runs.map(decodeAgentRun),
    nextCursor: wire.nextCursor,
    fakedDependencies: [...wire.fakedDependencies],
  }
}

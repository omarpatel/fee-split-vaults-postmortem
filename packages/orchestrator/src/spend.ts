/**
 * The money path, end to end, for one purchase proposal.
 *
 * THE THREE RULES THIS FILE EXISTS TO HOLD.
 *
 *   RULE 3, no third-party payee. The only value this function produces that
 *   can move money is a ReimbursementPull, whose destination is written by the
 *   broker's buildDisbursement() and is always the operator treasury. It is
 *   re-asserted here against every allowlisted vendor payout address before it
 *   is handed to settlement. There is no branch in this file that constructs a
 *   destination.
 *
 *   RULE 6, the commitment rule. It is enforced inside the broker's gate chain,
 *   which refuses to load at all if anyone flips a COMMITMENT_RULE flag. This
 *   function does not re-implement it - it would be a second copy that could
 *   drift - but it does refuse to disburse against a decision that did not come
 *   back approved, and it records fullyBankedAtSigning: true only because
 *   approval is what proves it.
 *
 *   RULE 8, fail closed. Missing invoice, missing approval, missing price,
 *   frozen scope, disabled asset: every one of them is a refusal with a machine
 *   code, and none of them falls through to a default.
 *
 * ORDERING. Settlement happens BEFORE the ledger write. If the ledger write
 * then fails, the ledger is temporarily short against the chain and a critical
 * escalation is raised - which reconciliation detects and a human resolves. The
 * other order would let the ledger claim money moved that did not, which is the
 * failure that cannot be detected by comparing the ledger to the chain.
 */

import type {
  Address,
  Asset,
  Disbursement,
  QfMeasurement,
  QualificationSignals,
  ScreeningResult,
  SpendDecision,
  SpendProposal,
  Vault,
} from '@fee-split-vaults/core'
import {
  assertNoThirdPartyPayee,
  buildDisbursement,
  decisionDigest,
  validateSpendProposal,
  type BudgetLedgerView,
  type OperatorTreasury,
  type ReimbursementPull,
  type SpendBroker,
  type SpendCounters,
} from '@fee-split-vaults/broker'
import type { Ledger } from '@fee-split-vaults/ledger'
import { chainBatchKey } from '@fee-split-vaults/ledger'
import { createHash } from 'node:crypto'
import { FailClosed } from './errors.js'
import type {
  ApprovalStore,
  FleetCounters,
  InvoiceRegistry,
  PendingPurchaseStore,
  PinnedUsdPrice,
  PredicateQueue,
  ReceiptStore,
  SettlementPort,
} from './ports.js'
import { toBrokerPrice } from './prices.js'
import { procurementReceipt } from './receipts.js'

export interface SpendAttemptInput {
  proposal: SpendProposal
  vault: Vault
  asset: Asset
  price: PinnedUsdPrice
  ledgerView: BudgetLedgerView
  qf: QfMeasurement
  signals: QualificationSignals
  screening: ScreeningResult
  counters: SpendCounters
  relatedPartyOptIn: boolean
  nowUnix: number
}

export interface SpendDeps {
  broker: SpendBroker
  ledger: Ledger
  treasury: OperatorTreasury
  invoices: InvoiceRegistry
  approvals: ApprovalStore
  settlement: SettlementPort
  receipts: ReceiptStore
  fleet: FleetCounters
  /** Delivery checks are scheduled the moment the reimbursement lands. */
  predicates: PredicateQueue
  /**
   * Approved purchases the operator still has to evidence. Written on
   * `awaiting_invoice`, cleared once the reimbursement settles; the API
   * reads it to show a human what to buy and invoice.
   */
  pending: PendingPurchaseStore
}

export type SpendOutcomeStatus =
  | 'disbursed'
  | 'refused'
  | 'awaiting_human_approval'
  | 'awaiting_invoice'
  | 'settlement_failed'
  | 'ledger_write_failed'

export interface SpendOutcome {
  status: SpendOutcomeStatus
  decision: SpendDecision
  /** Machine code. Stable across releases; safe to alert on. */
  code: string
  detail: string
  disbursement?: Disbursement
  pull?: ReimbursementPull
  txHash?: string
}

function disbursementIdFor(proposal: SpendProposal, quoteCents: bigint): string {
  return (
    'db_' +
    createHash('sha256')
      .update(
        JSON.stringify({
          vault: proposal.vault,
          skuId: proposal.skuId,
          quantity: proposal.quantity,
          proposedAtUnix: proposal.proposedAtUnix,
          quoteCents: quoteCents.toString(),
        }),
        'utf8',
      )
      .digest('hex')
      .slice(0, 32)
  )
}

function refused(code: string, detail: string): SpendOutcome {
  return {
    status: 'refused',
    decision: { approved: false, failedGate: code, reason: detail, requiresHumanApproval: false },
    code,
    detail,
  }
}

export async function attemptSpend(
  deps: SpendDeps,
  input: SpendAttemptInput,
): Promise<SpendOutcome> {
  const { proposal, vault, asset, nowUnix } = input

  // The proposal came out of a model. Re-validate the closed key set here even
  // though the runtime already did: a second validation costs nothing and the
  // first one is on the other side of a package boundary.
  const validated = validateSpendProposal(proposal)
  if (validated.vault !== vault.address) {
    throw new FailClosed('spend', 'proposal_vault_mismatch', 'proposal names a different vault')
  }
  if (!asset.enabled) {
    return refused('asset_kill_switch', `quote asset ${asset.address} is disabled`)
  }

  // A critical reconciliation variance freezes NEW authorization for its scope.
  // An already-signed, already-banked commitment still settles; this is the
  // authorization path, so the freeze bites here.
  try {
    await deps.ledger.assertSpendAuthorizationAllowed({ vault: vault.address, asset: asset.address })
  } catch (error) {
    return refused('ledger_freeze', error instanceof Error ? error.message : String(error))
  }

  await deps.fleet.recordProposal(vault.address, nowUnix)

  const decision = await deps.broker.decide(
    {
      proposal: validated,
      vault,
      asset,
      ledger: input.ledgerView,
      qf: input.qf,
      signals: input.signals,
      screening: input.screening,
      counters: input.counters,
      relatedPartyOptIn: input.relatedPartyOptIn,
    },
    nowUnix,
  )

  if (!decision.approved) {
    return {
      status: 'refused',
      decision,
      code: decision.failedGate ?? 'unknown_gate',
      detail: decision.reason,
    }
  }

  const entry = deps.broker.catalog.entry(validated.skuId)
  const quoteCents = deps.broker.catalog.priceCents(validated.skuId, validated.quantity)

  let approval
  if (decision.requiresHumanApproval) {
    approval = await deps.approvals.find(vault.address, decisionDigest(validated, quoteCents))
    if (approval === undefined) {
      return {
        status: 'awaiting_human_approval',
        decision,
        code: 'human_approval_pending',
        detail: `spend of ${Number(quoteCents) / 100} USD needs a human; none recorded`,
      }
    }
  }

  // The operator has already bought this as principal, in its own name. No
  // invoice means no evidence of that purchase, and reimbursing an unevidenced
  // purchase is how a reimbursement becomes a payment.
  const invoice = await deps.invoices.find(
    vault.address,
    validated.skuId,
    validated.quantity,
    nowUnix,
  )
  if (invoice === undefined) {
    // The to-do a human sees. Keyed on (vault, sku, quantity), so the same
    // decision re-made every window is one line, not one per tick.
    await deps.pending.record({
      vault: vault.address,
      vendorId: entry.sku.vendorId,
      skuId: validated.skuId,
      quantity: validated.quantity,
      quoteCents,
      proposedAtUnix: validated.proposedAtUnix,
    })
    return {
      status: 'awaiting_invoice',
      decision,
      code: 'invoice_missing',
      detail: `no countersigned invoice for ${validated.skuId} x${validated.quantity}`,
    }
  }

  const built = buildDisbursement({
    proposal: validated,
    decision,
    entry,
    catalog: deps.broker.catalog,
    invoice,
    treasury: deps.treasury,
    asset,
    price: toBrokerPrice(input.price, asset.decimals),
    quoteCents,
    disbursementId: disbursementIdFor(validated, quoteCents),
    nowUnix,
    ...(approval === undefined ? {} : { approval }),
  })

  // Belt to the broker's braces. If this ever throws, something upstream is
  // constructing a destination and that is a security incident, not a bug.
  assertNoThirdPartyPayee(built.pull.destination, deps.treasury, deps.broker.catalog)

  let settlement
  try {
    settlement = await deps.settlement.submit(built.pull)
  } catch (error) {
    return {
      status: 'settlement_failed',
      decision,
      code: 'settlement_failed',
      detail: error instanceof Error ? error.message : String(error),
      disbursement: built.disbursement,
      pull: built.pull,
    }
  }

  try {
    await deps.ledger.recordBudgetDisbursement({
      vault: vault.address,
      asset: asset.address,
      amountMinor: settlement.settledMinor,
      occurredAtUnix: settlement.settledAtUnix,
      batchKey: chainBatchKey('budget_disbursement', settlement.txHash, 0),
      source: 'manual',
      txHash: settlement.txHash,
      ...(settlement.blockHash === undefined ? {} : { blockHash: settlement.blockHash }),
      memo: `${validated.skuId} x${validated.quantity} -> operator treasury reimbursement`,
      commitment: {
        id: built.disbursement.id,
        authorizedAtUnix: nowUnix,
        // The commitment_rule gate approved this, and that gate is exactly the
        // check that the coin's own banked budget covered the whole obligation
        // at signing. Approval is the proof; this flag records it.
        fullyBankedAtSigning: true,
      },
      invoiceHash: invoice.invoiceHash,
    })
  } catch (error) {
    return {
      status: 'ledger_write_failed',
      decision,
      code: 'ledger_write_failed',
      detail:
        `settlement ${settlement.txHash} landed but the ledger write failed: ` +
        (error instanceof Error ? error.message : String(error)),
      disbursement: built.disbursement,
      pull: built.pull,
      txHash: settlement.txHash,
    }
  }

  // STAMPED WITH THE AUTHORIZATION CLOCK, not the settlement receipt's.
  //
  // Every counter this feeds is read back against the TICK clock: the gates ask
  // vendorSpendTodayCents(vendorId, nowUnix) and disbursementsToday(nowUnix),
  // and "today" is a UTC day key. settledAtUnix comes from outside - a block
  // timestamp, or whatever a settlement implementation reports - so writing
  // under it and reading under nowUnix puts the write in one bucket and the
  // read in another whenever the two land on opposite sides of a midnight, or
  // whenever an implementation's clock simply differs. The counter then reads
  // low and every daily cap it bounds silently opens; measured against this
  // package's own settlement fake, the $25,000 fleet-wide per-vendor cap did
  // not bind at all. recordProposal above already uses nowUnix, so this also
  // makes the two writes in this function agree with each other.
  await deps.fleet.recordDisbursement({
    vault: vault.address,
    vendorId: entry.sku.vendorId,
    amountCents: quoteCents,
    isRelatedParty: deps.broker.catalog.vendor(entry.sku.vendorId).isRelatedParty,
    // The category the sub-cap accumulates over. Taken from the catalog entry
    // this spend was priced from, so the row that counts against the cap and
    // the row the gate priced can never describe different SKUs.
    category: entry.sku.category,
    atUnix: nowUnix,
  })

  await deps.receipts.put(
    procurementReceipt({
      vault: vault.address,
      disbursement: built.disbursement,
      // Nothing is delivered at disbursement time. The 72h publication lag
      // applies until a predicate passes and the receipt is re-issued.
      delivered: false,
      description: `${entry.sku.description} x${validated.quantity}`,
    }),
  )

  // The invoice is spent. find() will not return it again, so a second tick
  // that decides the same line waits for a new invoice instead of replaying
  // this one into the vault's used-hash check.
  await deps.invoices.markSettled(vault.address, invoice.invoiceHash, settlement.txHash)
  // Evidenced and reimbursed: nothing left for a human to do about this line.
  await deps.pending.clear(vault.address, validated.skuId, validated.quantity)

  // No predicate, no purchase - and no purchase without its checks scheduled.
  // The verifier job re-issues the receipt as delivered on the first pass.
  await deps.predicates.enqueue({
    disbursementId: built.disbursement.id,
    vault: vault.address,
    token: vault.token,
    skuId: validated.skuId,
    vendorId: entry.sku.vendorId,
    spec: entry.sku.predicate,
    fundedAtUnix: nowUnix,
    costUsd: built.disbursement.costUsd,
    ...(invoice.baseline === undefined ? {} : { baseline: invoice.baseline }),
  })

  return {
    status: 'disbursed',
    decision,
    code: 'disbursed',
    detail: `reimbursed ${Number(quoteCents) / 100} USD to the operator treasury`,
    disbursement: built.disbursement,
    pull: built.pull,
    txHash: settlement.txHash,
  }
}

/**
 * Receipts.
 *
 * The publication lag is the whole subtlety here. A receipts feed that showed
 * every commitment the moment it was signed would be a front-runnable purchase
 * calendar: "this coin just bought trending at 14:02" is tradeable information
 * before the listing goes live. So a receipt for work that has NOT yet been
 * delivered is withheld for RECEIPT_PUBLISH_LAG_SECONDS, and a receipt for work
 * already delivered publishes at once.
 *
 * The lag delays PUBLICATION, never RECORDING. The row is written immediately
 * and its occurredAtUnix is the real instant, so the audit trail is complete
 * even while the public view is behind.
 */

import type { Address, Disbursement, Receipt } from '@fee-split-vaults/core'
import { createHash } from 'node:crypto'
import type { ReceiptStore } from './ports.js'

/** 72 hours. Long enough that a purchase calendar is stale, short enough to be a receipt. */
export const RECEIPT_PUBLISH_LAG_SECONDS = 72 * 60 * 60

function receiptId(parts: readonly string[]): string {
  return 'rc_' + createHash('sha256').update(parts.join(''), 'utf8').digest('hex').slice(0, 32)
}

/** One disbursement, one receipt row: the delivered re-issue lands on the same id. */
export function procurementReceiptId(disbursementId: string): string {
  return receiptId(['procurement', disbursementId])
}

export interface ProcurementReceiptInput {
  vault: Address
  disbursement: Disbursement
  /** True once at least one delivery predicate has passed. */
  delivered: boolean
  description: string
  evidenceUri?: string
}

export function procurementReceipt(input: ProcurementReceiptInput): Receipt {
  const { disbursement } = input
  const receipt: Receipt = {
    id: procurementReceiptId(disbursement.id),
    vault: input.vault,
    disbursementId: disbursement.id,
    kind: 'procurement',
    amountUsd: disbursement.costUsd,
    description: input.description,
    occurredAtUnix: disbursement.disbursedAtUnix,
    publishAfterUnix: input.delivered
      ? disbursement.disbursedAtUnix
      : disbursement.disbursedAtUnix + RECEIPT_PUBLISH_LAG_SECONDS,
  }
  if (input.evidenceUri !== undefined) receipt.evidenceUri = input.evidenceUri
  return receipt
}

/**
 * The re-issue. A delivery predicate passed, so the receipt written at
 * disbursement time stops being a purchase calendar and publishes now, citing
 * the evidence. Same id, same amount, same instant; only the lag and the
 * evidence change. Returns undefined when no receipt was written for the
 * disbursement, which the caller treats as a fault, never as "nothing to do".
 */
export async function publishDeliveredReceipt(
  store: ReceiptStore,
  disbursementId: string,
  evidenceUri?: string,
): Promise<Receipt | undefined> {
  const existing = await store.get(procurementReceiptId(disbursementId))
  if (existing === undefined) return undefined
  const delivered: Receipt = { ...existing, publishAfterUnix: existing.occurredAtUnix }
  if (evidenceUri !== undefined) delivered.evidenceUri = evidenceUri
  await store.put(delivered)
  return delivered
}

export interface SimpleReceiptInput {
  vault: Address
  kind: 'operations' | 'refund' | 'fee'
  amountUsd: number
  description: string
  occurredAtUnix: number
  /** Distinguishes two same-kind receipts in the same second. */
  discriminator: string
  evidenceUri?: string
}

/**
 * Operations, refunds and fees describe money that has ALREADY moved, so there
 * is nothing to front-run and no lag.
 */
export function ledgerReceipt(input: SimpleReceiptInput): Receipt {
  const receipt: Receipt = {
    id: receiptId([input.kind, input.vault, String(input.occurredAtUnix), input.discriminator]),
    vault: input.vault,
    kind: input.kind,
    amountUsd: input.amountUsd,
    description: input.description,
    occurredAtUnix: input.occurredAtUnix,
    publishAfterUnix: input.occurredAtUnix,
  }
  if (input.evidenceUri !== undefined) receipt.evidenceUri = input.evidenceUri
  return receipt
}

export function isPublishable(receipt: Receipt, nowUnix: number): boolean {
  return nowUnix >= receipt.publishAfterUnix
}

export class InMemoryReceiptStore implements ReceiptStore {
  readonly #byVault = new Map<string, Receipt[]>()
  readonly #byId = new Map<string, Receipt>()

  /** Upsert by id. A receipt id is content-derived, so the same row is the same purchase. */
  async put(receipt: Receipt): Promise<void> {
    const previous = this.#byId.get(receipt.id)
    this.#byId.set(receipt.id, receipt)
    const list = (this.#byVault.get(receipt.vault) ?? []).filter((r) => r !== previous)
    list.push(receipt)
    list.sort((a, b) => a.occurredAtUnix - b.occurredAtUnix || a.id.localeCompare(b.id))
    this.#byVault.set(receipt.vault, list)
  }

  async list(
    vault: Address,
    options: {
      fromUnix?: number
      toUnix?: number
      publishedOnly?: boolean
      nowUnix?: number
    } = {},
  ): Promise<Receipt[]> {
    const now = options.nowUnix ?? Math.floor(Date.now() / 1000)
    const publishedOnly = options.publishedOnly ?? true
    return (this.#byVault.get(vault) ?? []).filter((r) => {
      if (options.fromUnix !== undefined && r.occurredAtUnix < options.fromUnix) return false
      if (options.toUnix !== undefined && r.occurredAtUnix > options.toUnix) return false
      if (publishedOnly && !isPublishable(r, now)) return false
      return true
    })
  }

  async get(id: string): Promise<Receipt | undefined> {
    return this.#byId.get(id)
  }
}

/**
 * Closed-schema validation of a spend proposal.
 *
 * The planner's propose_purchase tool emits a SKU id and a quantity. It cannot
 * name a payee, an address, or an amount - and this function is where that
 * claim is enforced rather than assumed. The key set is CLOSED: a proposal
 * carrying a `payee`, `payoutAddress`, `amountUsd`, or any other field is
 * rejected outright, not sanitised and not ignored. Ignoring an extra field is
 * almost as bad as honouring it, because it leaves the caller believing the
 * field had no effect when in fact it was never seen.
 *
 * The rationale is advisory prose that reaches a human reading a receipt. It is
 * never parsed for values, is length-capped, and is run through the airlock's
 * own destination assertion so a smuggled address cannot ride into a report.
 */
import { assertNoDestination, type SpendProposal } from '@fee-split-vaults/core'
import { BrokerError } from './errors.js'
import { MAX_RATIONALE_CHARS } from './limits.js'

const PROPOSAL_KEYS: ReadonlySet<string> = new Set([
  'vault',
  'skuId',
  'quantity',
  'rationale',
  'proposedAtUnix',
])

const SKU_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/

export function validateSpendProposal(candidate: unknown): SpendProposal {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new BrokerError('proposal', 'not_an_object', 'proposal is not an object')
  }
  const p = candidate as Record<string, unknown>

  for (const key of Object.keys(p)) {
    if (!PROPOSAL_KEYS.has(key)) {
      throw new BrokerError(
        'proposal',
        'unexpected_field',
        `unexpected field "${key}" - the proposal schema is closed and cannot carry a payee`,
      )
    }
  }

  if (typeof p.vault !== 'string' || !ADDRESS_PATTERN.test(p.vault)) {
    throw new BrokerError('proposal', 'bad_vault', 'vault must be a 20-byte hex address')
  }
  if (typeof p.skuId !== 'string' || !SKU_ID_PATTERN.test(p.skuId)) {
    throw new BrokerError('proposal', 'bad_sku_id', 'skuId is not a well-formed catalog id')
  }
  if (typeof p.quantity !== 'number' || !Number.isSafeInteger(p.quantity) || p.quantity < 1) {
    throw new BrokerError('proposal', 'bad_quantity', 'quantity must be a positive integer')
  }
  if (
    typeof p.proposedAtUnix !== 'number' ||
    !Number.isFinite(p.proposedAtUnix) ||
    p.proposedAtUnix <= 0
  ) {
    throw new BrokerError('proposal', 'bad_timestamp', 'proposedAtUnix must be a unix timestamp')
  }
  if (typeof p.rationale !== 'string') {
    throw new BrokerError('proposal', 'bad_rationale', 'rationale must be a string')
  }
  if (p.rationale.length > MAX_RATIONALE_CHARS) {
    throw new BrokerError(
      'proposal',
      'rationale_too_long',
      `rationale exceeds ${MAX_RATIONALE_CHARS} characters`,
    )
  }
  assertNoDestination(p.rationale, 'rationale')

  return {
    vault: p.vault,
    skuId: p.skuId,
    quantity: p.quantity,
    rationale: p.rationale,
    proposedAtUnix: p.proposedAtUnix,
  }
}

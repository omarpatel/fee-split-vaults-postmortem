/**
 * Purchases the broker approved that the operator has not yet evidenced.
 *
 * The port lives in the orchestrator, because the fact is produced there (an
 * `awaiting_invoice` SpendOutcome records it) and consumed here, in a process
 * that holds no fleet. The same store instance - Postgres in a deployment -
 * is what both processes see, so `POST /invoices` clearing an entry is what
 * takes it off the runner's list too.
 */

export {
  InMemoryPendingPurchaseStore,
  type PendingPurchase,
  type PendingPurchaseSource,
  type PendingPurchaseStore,
} from '@fee-split-vaults/orchestrator'

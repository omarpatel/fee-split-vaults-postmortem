/**
 * The two CoinVault events the tick loop's money movements are drawn from.
 *
 * NO SECOND DECODER. The shapes are built with the indexer's own
 * `defineEvent`, so topic0 is keccak of the signature string at module load and
 * the decode goes through the indexer's `decodeEventLog`, with its topic-count
 * and data-length checks. This file contributes signature strings and the
 * mapping to the orchestrator's observation types; it contains no ABI logic.
 *
 * NAME COLLISION, STATED SO NOBODY TRIPS ON IT. `Credited` is also the name of
 * a Venue FEE ESCROW event - `Credited(address,address,uint256)`, topic0
 * 0x4e45da44... - and the two are unrelated. The escrow's version says money
 * arrived for a recipient; the vault's version says money already in the vault
 * was SPLIT into its legs. They have different signatures and therefore
 * different topic0 values, so a query for one can never match the other, but
 * the constants here are named VAULT_* to keep the two apart in prose too.
 *
 * INTEGRATION SURFACE. The signature strings are this package's assumption
 * about the deployed CoinVault ABI (contracts/src/CoinVault.sol). If one is
 * wrong its topic0 matches no log, the query returns nothing, and the vault
 * reports no claims and no allocations. That direction is safe on its own -
 * unallocated budget cannot be spent - but it is indistinguishable from a quiet
 * vault, which is why `RpcChainReadModel` refuses on coverage rather than
 * leaning on this to fail loudly.
 */


import {
  DecodeError,
  decodeEventLog,
  defineEvent,
  normalizeAddress,
  normalizeHash32,
  requireAddress,
  requireBigInt,
  type BlockRef,
  type RpcLog,
} from '@fee-split-vaults/indexer'
import type { AllocationObservation, ClaimObservation } from '@fee-split-vaults/orchestrator'

/** `claim()` / `claimToken()` pulled `received` out of escrow into the vault. */
export const VAULT_CLAIMED = defineEvent('Claimed', [
  { name: 'asset', type: 'address', indexed: true },
  { name: 'received', type: 'uint256', indexed: false },
  { name: 'maxAmount', type: 'uint256', indexed: false },
])

/**
 * `_settle()` split an unaccounted balance into the four legs.
 *
 * This is the ONLY event that puts money in the budget leg. A vault whose
 * Credited stream is empty accrues income forever and can never spend a cent,
 * and that is the correct behaviour rather than something to route around.
 */
export const VAULT_CREDITED = defineEvent('Credited', [
  { name: 'asset', type: 'address', indexed: true },
  { name: 'amount', type: 'uint256', indexed: false },
  { name: 'toDev', type: 'uint256', indexed: false },
  { name: 'toBudget', type: 'uint256', indexed: false },
  { name: 'toOperator', type: 'uint256', indexed: false },
  { name: 'toReferrer', type: 'uint256', indexed: false },
])

export const VAULT_MOVEMENT_TOPICS = [VAULT_CLAIMED.topic0, VAULT_CREDITED.topic0] as const

export function decodeClaim(log: RpcLog, block: BlockRef): ClaimObservation {
  const decoded = decodeEventLog(VAULT_CLAIMED, log)
  const received = requireBigInt(decoded, 'received')
  if (received < 0n) throw new DecodeError(`Claimed.received is negative: ${received}`)

  return {
    vault: normalizeAddress(log.address),
    asset: requireAddress(decoded, 'asset'),
    amountMinor: received,
    occurredAtUnix: block.timestampUnix,
    txHash: normalizeHash32(log.transactionHash),
    logIndex: log.logIndex,
    blockHash: normalizeHash32(log.blockHash),
  }
}

/**
 * One settle().
 *
 * The legs are checked to sum to the credited amount before the observation is
 * built. On chain the rounding remainder goes to the DEV leg, so integer
 * division can only ever favour the client; a sum that does NOT reconcile means
 * the deployed ABI is not the one compiled against here, and posting the legs
 * anyway would write a ledger entry whose parts do not add up to its whole.
 *
 * The referrer is carried as its own leg, exactly as the event reports it: on
 * chain the referrer's cut is carved out of the OPERATOR's slice (never the
 * client's) and has its own pull, CoinVault.withdrawReferrer, so `toOperator`
 * is already the operator's take net of the referrer.
 */
export function decodeAllocation(log: RpcLog, block: BlockRef): AllocationObservation {
  const decoded = decodeEventLog(VAULT_CREDITED, log)
  const amount = requireBigInt(decoded, 'amount')
  const toDev = requireBigInt(decoded, 'toDev')
  const toBudget = requireBigInt(decoded, 'toBudget')
  const toOperator = requireBigInt(decoded, 'toOperator')
  const toReferrer = requireBigInt(decoded, 'toReferrer')

  for (const [name, value] of [
    ['amount', amount],
    ['toDev', toDev],
    ['toBudget', toBudget],
    ['toOperator', toOperator],
    ['toReferrer', toReferrer],
  ] as const) {
    if (value < 0n) throw new DecodeError(`Credited.${name} is negative: ${value}`)
  }

  const legs = toDev + toBudget + toOperator + toReferrer
  if (legs !== amount) {
    throw new DecodeError(
      `Credited legs sum to ${legs} but the credited amount is ${amount} ` +
        `(tx ${log.transactionHash}:${log.logIndex}); refusing to post a split that does not reconcile`,
    )
  }

  return {
    vault: normalizeAddress(log.address),
    asset: requireAddress(decoded, 'asset'),
    devMinor: toDev,
    budgetMinor: toBudget,
    operatorMinor: toOperator,
    referrerMinor: toReferrer,
    occurredAtUnix: block.timestampUnix,
    txHash: normalizeHash32(log.transactionHash),
    logIndex: log.logIndex,
    blockHash: normalizeHash32(log.blockHash),
  }
}

/** `${txHash}:${logIndex}`. A pure function of chain position, hence replay-safe. */
export function movementId(log: RpcLog): string {
  return `${normalizeHash32(log.transactionHash)}:${log.logIndex}`
}

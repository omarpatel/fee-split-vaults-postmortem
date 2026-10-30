/**
 * Typed failures for the ingestion plane.
 *
 * Every one of these is a REFUSAL, not a warning. The indexer feeds budget
 * authority; an indexer that guesses when it cannot read is an indexer that
 * authorises spending against money that may not exist. Callers must treat any
 * IndexerError as "do not advance the cursor, do not grant authority".
 */

export type IndexerErrorCode =
  | 'rpc'
  | 'quorum_disagreement'
  | 'unbounded_query'
  | 'chain_mismatch'
  | 'finality_violation'
  | 'reorg_too_deep'
  | 'scan_retry'
  | 'decode'
  | 'event_shape_mismatch'
  | 'curve_shape_unpinned'
  | 'missing_price'
  | 'signals_unavailable'
  | 'stale_watch'
  | 'watch_set'
  | 'holder_ledger'

export class IndexerError extends Error {
  constructor(
    message: string,
    readonly code: IndexerErrorCode,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class RpcError extends IndexerError {
  constructor(
    message: string,
    readonly endpointId: string,
  ) {
    super(`rpc(${endpointId}): ${message}`, 'rpc')
  }
}

/**
 * Two providers returned different answers for the same pinned read. There is no
 * tie-break and no "pick the higher one": we do not know which is lying.
 */
export class QuorumDisagreementError extends IndexerError {
  constructor(
    readonly method: string,
    readonly left: string,
    readonly right: string,
  ) {
    super(`quorum disagreement on ${method}: ${left} != ${right}`, 'quorum_disagreement')
  }
}

/** A log query that would have scanned the launch firehose rather than our set. */
export class UnboundedQueryError extends IndexerError {
  constructor(message: string) {
    super(`unbounded query: ${message}`, 'unbounded_query')
  }
}

export class ChainMismatchError extends IndexerError {
  constructor(expected: number, actual: number, endpointId: string) {
    super(`endpoint ${endpointId} is on chain ${actual}, expected ${expected}`, 'chain_mismatch')
  }
}

/**
 * A reorg reached a block we had already treated as final. Budget authority was
 * possibly granted against money that no longer exists. This halts; it never
 * silently rewrites history.
 */
export class FinalityViolationError extends IndexerError {
  constructor(
    readonly blockNumber: bigint,
    readonly finalizedNumber: bigint,
    detail: string,
  ) {
    super(
      `reorg touched block ${blockNumber} at or below finalized head ${finalizedNumber}: ${detail}`,
      'finality_violation',
    )
  }
}

/**
 * We could not find a common ancestor within the tracked window. Either the
 * reorg is deeper than anything this chain should produce, or the two endpoints
 * are serving a different chain than the one we indexed. Neither is recoverable
 * automatically.
 */
export class ReorgTooDeepError extends IndexerError {
  constructor(
    readonly searchedFrom: bigint,
    readonly maxDepth: number,
  ) {
    super(
      `no common ancestor within ${maxDepth} blocks below ${searchedFrom}; halting rather than guessing`,
      'reorg_too_deep',
    )
  }
}

/**
 * The chain moved under a scan that was already in flight. Harmless and
 * expected: the cursor is not advanced and the next tick redoes the range.
 */
export class ScanRetryError extends IndexerError {
  constructor(detail: string) {
    super(`scan must be retried: ${detail}`, 'scan_retry')
  }
}

export class DecodeError extends IndexerError {
  constructor(message: string) {
    super(`decode: ${message}`, 'decode')
  }
}

/** A computed topic0 did not match the operator-pinned, ABI-verified value. */
export class EventShapeMismatchError extends IndexerError {
  constructor(eventName: string, expected: string, computed: string) {
    super(
      `event ${eventName} topic0 ${computed} does not match pinned ${expected}; ` +
        `the deployed ABI and this package disagree`,
      'event_shape_mismatch',
    )
  }
}

/**
 * A curve trade shape is missing one of the names attribution reads. The names
 * are pinned from live chain evidence (tools/artifacts/CURVE-SHAPE.md); a shape
 * without them would make an amount read a guess that changes a money figure
 * without breaking a decode, so attribution refuses instead.
 */
export class CurveShapeUnpinnedError extends IndexerError {
  constructor(eventName: string) {
    super(
      `${eventName} shape lacks a named trader/amountIn/amountOut/fee/creatorTax field; ` +
        `refusing to read an amount out of a positional word. ` +
        `See abi.ts CURVE_BUY/CURVE_SELL and tools/artifacts/CURVE-SHAPE.md.`,
      'curve_shape_unpinned',
    )
  }
}

export class MissingPriceError extends IndexerError {
  constructor(asset: string, atUnix: number, detail: string) {
    super(`no usable price for ${asset} at ${atUnix}: ${detail}`, 'missing_price')
  }
}

export class SignalsUnavailableError extends IndexerError {
  constructor(signal: string, detail: string) {
    super(`qualification signal ${signal} unavailable: ${detail}`, 'signals_unavailable')
  }
}

/**
 * A watcher has not completed a successful check within its deadline. Spend must
 * halt: an unobserved fee recipient is indistinguishable from a stolen one.
 */
export class StaleWatchError extends IndexerError {
  constructor(watcher: string, lastOkAtUnix: number, deadlineSeconds: number) {
    super(
      `${watcher} last succeeded at ${lastOkAtUnix}, exceeding its ${deadlineSeconds}s deadline`,
      'stale_watch',
    )
  }
}

export class WatchSetError extends IndexerError {
  constructor(message: string) {
    super(`watch set: ${message}`, 'watch_set')
  }
}

/**
 * The holder ledger stopped conserving supply: a Transfer debited an address
 * below zero, or the cursor's block is no longer canonical. Either means the
 * balances cannot be vouched for, so the signal built on them refuses.
 */
export class HolderLedgerError extends IndexerError {
  constructor(
    readonly token: string,
    detail: string,
  ) {
    super(`holder ledger for ${token}: ${detail}`, 'holder_ledger')
  }
}

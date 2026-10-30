/**
 * Every error in this package is a REFUSAL. Nothing here degrades to a warning,
 * returns a default, or writes a partial batch. A ledger that guesses is a
 * ledger that loses money quietly.
 */

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(`ledger: ${message}`)
    this.name = new.target.name
  }
}

/** A debit/credit pair that is not on the whitelist in accounts.ts. */
export class IllegalPostingError extends LedgerError {
  constructor(
    message: string,
    readonly debit: string,
    readonly credit: string,
  ) {
    super(message, 'ILLEGAL_POSTING')
  }
}

/** A write that would leave an account on the wrong side of its normal balance. */
export class LedgerBalanceError extends LedgerError {
  constructor(
    message: string,
    readonly vault: string,
    readonly asset: string,
    readonly account: string,
    readonly resultingBalanceMinor: bigint,
  ) {
    super(message, 'UNBALANCED')
  }
}

/** Debits did not equal credits for some asset in the proposed write. */
export class UnbalancedWriteError extends LedgerError {
  constructor(
    message: string,
    readonly residualByAsset: ReadonlyMap<string, bigint>,
  ) {
    super(message, 'RESIDUAL_NONZERO')
  }
}

/** Two different entry bodies hashed to the same deterministic id. */
export class EntryIdCollisionError extends LedgerError {
  constructor(readonly id: string) {
    super(`entry id ${id} already exists with different content`, 'ID_COLLISION')
  }
}

/** A malformed entry, observation, or request. */
export class InvalidInputError extends LedgerError {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message, 'INVALID_INPUT')
  }
}

/** Income recognition was attempted from a source outside the precedence order. */
export class PrecedenceError extends LedgerError {
  constructor(message: string) {
    super(message, 'PRECEDENCE')
  }
}

/** New spend authorization refused because a critical variance froze the scope. */
export class SpendFrozenError extends LedgerError {
  constructor(
    message: string,
    readonly freezeIds: readonly string[],
  ) {
    super(message, 'SPEND_FROZEN')
  }
}

/** No usable price. USD figures fail closed rather than defaulting to zero. */
export class PriceUnavailableError extends LedgerError {
  constructor(
    message: string,
    readonly asset: string,
  ) {
    super(message, 'PRICE_UNAVAILABLE')
  }
}

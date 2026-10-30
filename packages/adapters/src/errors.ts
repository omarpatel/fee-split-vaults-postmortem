/**
 * Typed refusals for the adapter plane.
 *
 * Every error here exists to keep one distinction from collapsing: "nothing
 * happened" and "I could not look" are different answers, and only the first
 * one is safely representable as an empty array or a zero.
 *
 * The orchestrator's ports return `readonly T[]` and `Promise<number>`. There
 * is no room in those types for "unknown", so the ONLY way an adapter can say
 * it does not know is to throw. A real implementation that swallows a database
 * outage and returns `[]` tells the tick loop that a coin earned no fees; one
 * that swallows it and returns `0` from a spend counter opens every cap in the
 * broker at once. Both are silent, both move money, and both are prevented by
 * throwing one of these.
 */

export type AdapterErrorCode =
  | 'coverage_gap'
  | 'vault_not_tracked'
  | 'source_unavailable'
  | 'counter_unavailable'
  | 'escalation_sink_unavailable'
  | 'cursor_unavailable'
  | 'credential_missing'
  | 'unservable_range'
  | 'chat_unbound'
  | 'invoice_conflict'
  | 'invoice_unknown'
  | 'secret_unopenable'
  | 'moderation_rights_missing'
  | 'desk_binding_conflict'

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly code: AdapterErrorCode,
  ) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * The read model is further behind the chain than its tolerance allows.
 *
 * A window query answered from a cursor that stopped advancing an hour ago is
 * not a measurement of that window; it is a measurement of whatever we happened
 * to have ingested. Returning it would render as "no fees in the last hour",
 * which is exactly the confident zero the fail-closed rule exists to prevent.
 */
export class CoverageGapError extends AdapterError {
  constructor(
    readonly stream: string,
    readonly scope: string,
    readonly coveredThroughUnix: number | undefined,
    readonly requestedToUnix: number,
  ) {
    super(
      `${stream} coverage for ${scope} reaches ` +
        `${coveredThroughUnix === undefined ? 'NOTHING (no cursor)' : String(coveredThroughUnix)}` +
        `, which does not cover the window ending ${requestedToUnix}; refusing to report an unmeasured range as empty`,
      'coverage_gap',
    )
  }
}

/**
 * A vault nobody registered for scanning.
 *
 * Silently returning no claims and no allocations for an unknown vault would be
 * indistinguishable from a vault that has genuinely never settled - and the
 * second of those is a state the tick loop is designed to sit in for weeks.
 */
export class VaultNotTrackedError extends AdapterError {
  constructor(readonly vault: string) {
    super(
      `vault ${vault} is not registered with this read model, so its claims and allocations ` +
        `were never scanned; that is not the same as "it never settled"`,
      'vault_not_tracked',
    )
  }
}

/** A backing store threw. The caller must treat this as unknown, never as none. */
export class SourceUnavailableError extends AdapterError {
  constructor(
    readonly source: string,
    detail: string,
    override readonly cause?: unknown,
  ) {
    super(`${source} could not be read: ${detail}`, 'source_unavailable')
  }
}

/**
 * A spend counter could not be read.
 *
 * Separated from SourceUnavailableError because the consequence is specific:
 * the broker's caps are enforced against these numbers, so a zero returned here
 * does not merely lose information, it authorises spending.
 */
export class CounterUnavailableError extends AdapterError {
  constructor(
    readonly counter: string,
    detail: string,
    override readonly cause?: unknown,
  ) {
    super(
      `fleet counter ${counter} could not be read (${detail}); refusing to answer 0, ` +
        `which would open every cap that reads it`,
      'counter_unavailable',
    )
  }
}

/** An escalation could not be persisted. A dropped escalation is a silent page. */
export class EscalationSinkUnavailableError extends AdapterError {
  constructor(
    detail: string,
    override readonly cause?: unknown,
  ) {
    super(`escalation could not be persisted: ${detail}`, 'escalation_sink_unavailable')
  }
}

export class CursorUnavailableError extends AdapterError {
  constructor(
    readonly key: string,
    detail: string,
    override readonly cause?: unknown,
  ) {
    super(`cursor ${key} could not be read or written: ${detail}`, 'cursor_unavailable')
  }
}

/**
 * A credential the adapter needs is absent.
 *
 * Thrown at CONSTRUCTION, not at first use. An adapter that builds without its
 * token and then fails on the first send is a half-configured process that
 * looks healthy; the caller has to learn at wiring time so it can fall back to
 * a labelled fake instead.
 */
export class CredentialMissingError extends AdapterError {
  constructor(
    readonly credential: string,
    detail: string,
  ) {
    super(`${credential} is not configured: ${detail}`, 'credential_missing')
  }
}

/** A single block still failed after halving. The range really is unservable. */
export class UnservableRangeError extends AdapterError {
  constructor(
    readonly blockNumber: bigint,
    detail: string,
  ) {
    super(
      `block ${blockNumber} could not be scanned even alone: ${detail}; ` +
        `refusing to return a short result set that would look like a real answer`,
      'unservable_range',
    )
  }
}

/** Inbound traffic arrived from a chat no coin claims. It is not anyone's. */
export class ChatUnboundError extends AdapterError {
  constructor(readonly chatId: string) {
    super(
      `chat ${chatId} is not bound to a coin; a message with no binding must not be ` +
        `stamped with a guess`,
      'chat_unbound',
    )
  }
}

/**
 * An invoice hash already recorded for this vault was put() again. Not an
 * upsert: two reimbursements against one invoice is the failure the registry
 * exists to prevent, so the second write is refused rather than merged.
 */
export class InvoiceConflictError extends AdapterError {
  constructor(
    readonly vault: string,
    readonly invoiceHash: string,
  ) {
    super(`invoice ${invoiceHash} is already recorded for vault ${vault}`, 'invoice_conflict')
  }
}

/** A settlement was reported for an invoice the registry never saw. */
export class InvoiceUnknownError extends AdapterError {
  constructor(
    readonly vault: string,
    readonly invoiceHash: string,
  ) {
    super(`invoice ${invoiceHash} is not recorded for vault ${vault}`, 'invoice_unknown')
  }
}

/**
 * A sealed secret could not be opened: wrong key, wrong key id, or a tampered
 * blob. Nothing is returned in any of those cases - a token decrypted under the
 * wrong key is not a token, it is 32 bytes of noise sent to a live API.
 */
export class SecretUnopenableError extends AdapterError {
  constructor(
    readonly reason: 'malformed' | 'key_mismatch' | 'auth_failed',
    detail: string,
  ) {
    super(`sealed secret cannot be opened (${reason}): ${detail}`, 'secret_unopenable')
  }
}

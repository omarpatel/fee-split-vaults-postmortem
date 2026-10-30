/**
 * Broker failures are values, not exceptions, at the gate boundary: every gate
 * returns a SpendDecision. BrokerError exists for the layer BELOW the gates -
 * context assembly, catalog resolution, policy verification - where there is no
 * meaningful "partial" answer. decide() converts every BrokerError into a
 * refusal carrying the originating gate name, so an unexpected throw can never
 * become an approval.
 */
export class BrokerError extends Error {
  constructor(
    /** Gate name attributed to this failure when it is converted to a refusal. */
    readonly gate: string,
    readonly code: string,
    message: string,
  ) {
    super(`${gate}/${code}: ${message}`)
    this.name = 'BrokerError'
  }
}

/** Signed-policy-object failures. Fetch failure or expiry means NO SPEND. */
export class PolicyError extends BrokerError {
  constructor(code: string, message: string) {
    super('policy_token', code, message)
    this.name = 'PolicyError'
  }
}

/** Raised when a catalog entry would let the operator earn a spread. */
export class SelfDealingError extends BrokerError {
  constructor(code: string, message: string) {
    super('catalog', code, message)
    this.name = 'SelfDealingError'
  }
}

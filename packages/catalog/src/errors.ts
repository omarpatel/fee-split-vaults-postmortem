/**
 * Catalog failures are ALWAYS exceptions, never values.
 *
 * The broker's gates return a SpendDecision because a refusal there is a normal
 * business outcome. Nothing in this package has a normal failure mode: a SKU
 * that does not validate, a price that does not reconcile, or a rate card whose
 * hash does not match is a defect in the operator's own data, and the correct
 * response is to refuse to start rather than to serve a catalog that might be
 * marking a client up. Fail closed means the process does not come up.
 */

export type CatalogFailureStage =
  | 'load'
  | 'schema'
  | 'price_book'
  | 'tier_availability'
  | 'related_party'
  | 'reconciliation'
  | 'archive'
  | 'screening_data'
  | 'factsheet_schema'

export class CatalogError extends Error {
  constructor(
    readonly stage: CatalogFailureStage,
    readonly code: string,
    message: string,
  ) {
    super(`catalog/${stage}/${code}: ${message}`)
    this.name = 'CatalogError'
  }
}

/**
 * Raised whenever the operator would earn anything other than its published
 * unit rate on a line it recommended. Distinct from CatalogError because this
 * one is the business-model invariant, not a data defect: an alert on this
 * class is an integrity incident, not a bad deploy.
 */
export class PriceBookViolation extends CatalogError {
  constructor(code: string, message: string) {
    super('price_book', code, message)
    this.name = 'PriceBookViolation'
  }
}

/**
 * Raised when a SKU is offered at a tier whose procurement budget cannot fund
 * it. Advertising what the budget cannot buy is the specific failure this
 * package exists to prevent.
 */
export class TierAvailabilityViolation extends CatalogError {
  constructor(code: string, message: string) {
    super('tier_availability', code, message)
    this.name = 'TierAvailabilityViolation'
  }
}

/** Raised on a related-party purchase without opt-in or over the cap. */
export class RelatedPartyViolation extends CatalogError {
  constructor(code: string, message: string) {
    super('related_party', code, message)
    this.name = 'RelatedPartyViolation'
  }
}

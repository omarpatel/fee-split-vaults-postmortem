/**
 * The /v1 dependency set over in-memory ports, for every suite that builds a
 * router. Same projection code as production; only the stores are memory.
 */
import type { RecipientReader } from '../onboarding.js'
import type { RouteDeps } from '../routes.js'
import {
  InMemoryEscalationQueue,
  InMemoryOperatedAccounts,
  InMemoryProcurementOutcomes,
  InMemoryQfReader,
  InMemoryQuoteStore,
} from '../v1/ports.js'
import type { V1Deps } from '../v1/routes.js'
import { DevAuth, InMemoryDevSessionStore } from '../v1/sessions.js'

const REFUSING_RECIPIENTS: RecipientReader = {
  creatorFeeRecipient: () => Promise.reject(new Error('recipients not wired in this test')),
  launchedAtUnix: () => Promise.reject(new Error('recipients not wired in this test')),
  launchTerms: () => Promise.reject(new Error('recipients not wired in this test')),
}

export function v1Deps(
  base: Pick<RouteDeps, 'onboarding' | 'screening' | 'factory' | 'domain' | 'ledger' | 'ledgerStore' | 'receipts' | 'reporting' | 'now'>,
  extras: Partial<Omit<V1Deps, keyof typeof base>> = {},
): V1Deps {
  return {
    onboarding: base.onboarding,
    screening: base.screening,
    factory: base.factory,
    domain: base.domain,
    ledger: base.ledger,
    ledgerStore: base.ledgerStore,
    receipts: base.receipts,
    reporting: base.reporting,
    now: base.now,
    auth: new DevAuth({ store: new InMemoryDevSessionStore(), issuer: 'Test Operator LLC', now: base.now }),
    quotes: new InMemoryQuoteStore(),
    protocol: { operatorLegalName: 'Test Operator LLC', operatorAddresses: [], receiptsBaseUrl: 'https://receipts.example' },
    recipients: REFUSING_RECIPIENTS,
    escalations: new InMemoryEscalationQueue(),
    outcomes: new InMemoryProcurementOutcomes(),
    qf: new InMemoryQfReader(),
    vendors: { all: () => [] },
    accounts: new InMemoryOperatedAccounts(),
    ...extras,
  }
}

/** A full RouteDeps from one without `v1`. */
export function withV1(deps: Omit<RouteDeps, 'v1'>, extras: Partial<Omit<V1Deps, 'onboarding' | 'screening' | 'factory' | 'domain' | 'ledger' | 'ledgerStore' | 'receipts' | 'reporting' | 'now'>> = {}): RouteDeps {
  return { ...deps, v1: v1Deps(deps, extras) }
}

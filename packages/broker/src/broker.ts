/**
 * The spend broker: the only component in the system that decides whether money
 * moves, and the only one with no model in it.
 *
 * Its whole contract is that decide() is a pure function of (request, policy,
 * catalog, clock). The two impure steps - fetching the signed policy object and
 * verifying it - happen before the chain runs and produce a refusal on any
 * failure. Nothing that happens after that point can reach the network, the
 * clock, or a random number.
 *
 * A NOTE ON WHAT MUST NEVER BE ADDED HERE: no method on this class may accept a
 * payee, an address, an amount, or free text that is later parsed for one. The
 * planner selects a catalog id and a quantity; the broker prices it. That
 * asymmetry is what makes a fully compromised cognition plane survivable.
 */
import { AirlockViolation, type SpendDecision } from '@fee-split-vaults/core'
import type { VendorCatalog } from './catalog.js'
import { buildGateContext, type GateContext, type SpendRequest } from './context.js'
import { BrokerError } from './errors.js'
import { evaluateGates, traceGates } from './gates.js'
import {
  verifyPolicyToken,
  type PolicyKeyring,
  type PolicyService,
  type VerifiedPolicy,
} from './policy.js'
import type { PredicateRegistry } from './predicates.js'

export interface SpendBrokerOptions {
  catalog: VendorCatalog
  policyService: PolicyService
  keyring: PolicyKeyring
  predicates: PredicateRegistry
}

function refusal(gate: string, reason: string): SpendDecision {
  return { approved: false, failedGate: gate, reason, requiresHumanApproval: false }
}

function toRefusal(error: unknown, fallbackGate: string): SpendDecision {
  if (error instanceof BrokerError) {
    return refusal(error.gate, error.message)
  }
  if (error instanceof AirlockViolation) {
    return refusal('proposal', error.message)
  }
  // An unexpected throw is a refusal, never an approval.
  return refusal(fallbackGate, `unexpected broker failure: ${String(error)}`)
}

export class SpendBroker {
  readonly #catalog: VendorCatalog
  readonly #policyService: PolicyService
  readonly #keyring: PolicyKeyring
  readonly #predicates: PredicateRegistry

  constructor(options: SpendBrokerOptions) {
    this.#catalog = options.catalog
    this.#policyService = options.policyService
    this.#keyring = options.keyring
    this.#predicates = options.predicates
  }

  get catalog(): VendorCatalog {
    return this.#catalog
  }

  async #policyFor(vault: string, nowUnix: number): Promise<VerifiedPolicy> {
    // Fetch failure and expiry are the same event: NO SPEND.
    const token = await this.#policyService.fetch(vault, nowUnix)
    return verifyPolicyToken(token, this.#keyring, vault, nowUnix)
  }

  async decide(request: SpendRequest, nowUnix: number): Promise<SpendDecision> {
    let context: GateContext
    try {
      const policy = await this.#policyFor(request.vault.address, nowUnix)
      context = buildGateContext(
        request,
        policy,
        this.#catalog,
        this.#predicates.kinds,
        nowUnix,
      )
    } catch (error) {
      return toRefusal(error, 'policy_token')
    }
    try {
      return evaluateGates(context)
    } catch (error) {
      // The chain is pure and should not throw. If it ever does, that is a
      // refusal, not an approval.
      return toRefusal(error, 'gate_chain')
    }
  }

  /**
   * Every gate's verdict for one request, for a receipt or a dispute. Runs the
   * same chain decide() runs; it does not re-implement it.
   */
  async trace(
    request: SpendRequest,
    nowUnix: number,
  ): Promise<{ decision: SpendDecision; trace: Array<{ gate: string; decision: SpendDecision }> }> {
    let context: GateContext
    try {
      const policy = await this.#policyFor(request.vault.address, nowUnix)
      context = buildGateContext(request, policy, this.#catalog, this.#predicates.kinds, nowUnix)
    } catch (error) {
      const decision = toRefusal(error, 'policy_token')
      return { decision, trace: [{ gate: decision.failedGate ?? 'policy_token', decision }] }
    }
    return { decision: evaluateGates(context), trace: traceGates(context) }
  }
}

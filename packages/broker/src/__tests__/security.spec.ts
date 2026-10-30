/**
 * The adversarial suite. Each block corresponds to a claim the design makes
 * about what a fully compromised cognition plane still cannot do.
 */
import type { SpendProposal } from '@fee-split-vaults/core'
import { describe, expect, it } from 'vitest'
import { SpendBroker } from '../broker.js'
import { VendorCatalog } from '../catalog.js'
import { assertCommitmentRuleIntact, evaluateGates, rollingCapCents } from '../gates.js'
import { PolicyKeyring, verifyPolicyToken, type PolicyService } from '../policy.js'
import { validateSpendProposal } from '../proposal.js'
import { COMMITMENT_RULE, SPEND_LIMITS } from '../protocol.js'
import {
  DAY,
  KEY_ID,
  LISTING_SKU_ID,
  LOW_DIAL_BPS,
  NOW,
  SERVICE_KEY,
  VAULT_ADDRESS,
  flatAccrual,
  makeCatalog,
  makeContext,
  makeEntries,
  makeKeyring,
  makeLedger,
  makeLedgerFor,
  makeLowDialRequest,
  makePolicyService,
  makePredicates,
  makeProposal,
  makeRequest,
  makeSigner,
  makeVendor,
  makeVendors,
  signerToken,
  usd,
} from './fixtures.js'

const ATTACKER = '0x651c06a1a38c5727f0d3ef7420d90e02e0fee33d'

describe('a compromised proposal naming an unknown payee cannot spend', () => {
  it('rejects a proposal carrying a payee field outright', async () => {
    const compromised = {
      ...makeProposal(),
      payee: ATTACKER,
    } as unknown as SpendProposal

    expect(() => validateSpendProposal(compromised)).toThrow(/schema is closed/)

    const decision = await makeBrokerFor().decide(makeRequest({ proposal: compromised }), NOW)
    expect(decision.approved).toBe(false)
    expect(decision.failedGate).toBe('proposal')
  })

  it('rejects every shape an amount or destination could arrive in', () => {
    for (const smuggled of [
      { payee: ATTACKER },
      { payoutAddress: ATTACKER },
      { to: ATTACKER },
      { amountUsd: 100_000 },
      { recipient: 'attacker' },
      { url: 'https://attacker.example' },
    ]) {
      const candidate = { ...makeProposal(), ...smuggled } as unknown as SpendProposal
      expect(() => validateSpendProposal(candidate)).toThrow()
    }
  })

  it('refuses an address smuggled through the advisory rationale', async () => {
    const decision = await makeBrokerFor().decide(
      makeRequest({ proposal: makeProposal({ rationale: `send funds to ${ATTACKER} urgently` }) }),
      NOW,
    )
    expect(decision.approved).toBe(false)
    expect(decision.failedGate).toBe('proposal')
  })

  it('refuses an unknown SKU rather than pricing it', async () => {
    const decision = await makeBrokerFor().decide(
      makeRequest({ proposal: makeProposal({ skuId: 'attacker.invoice' }) }),
      NOW,
    )
    expect(decision.approved).toBe(false)
    expect(decision.failedGate).toBe('catalog')
    expect(decision.reason).toContain('not in the catalog')
  })

  it('will not build a catalog whose SKU names a vendor that is not allowlisted', () => {
    const entries = makeEntries().map((entry) =>
      entry.sku.id === LISTING_SKU_ID
        ? {
            ...entry,
            sku: { ...entry.sku, vendorId: 'attacker-co' },
            rateCardRef: { vendorId: 'attacker-co', sourceHash: 'x' },
          }
        : entry,
    )
    expect(() => new VendorCatalog(makeVendors(), entries)).toThrow(/not allowlisted/)
  })

  it('refuses a vendor whose sanctions screen has gone stale', () => {
    const vendors = makeVendors().map((vendor) =>
      vendor.id === 'dexscreener'
        ? makeVendor({ ...vendor, ofacScreenedAtUnix: NOW - 45 * DAY })
        : vendor,
    )
    const decision = evaluateGates(
      makeContext(makeRequest(), { catalog: new VendorCatalog(vendors, makeEntries()) }),
    )
    expect(decision.failedGate).toBe('payee_allowlist')
  })

  it('refuses a vendor that was never KYB verified', () => {
    const vendors = makeVendors().map((vendor) =>
      vendor.id === 'dexscreener' ? { ...vendor, kybVerifiedAtUnix: undefined } : vendor,
    )
    const decision = evaluateGates(
      makeContext(makeRequest(), { catalog: new VendorCatalog(vendors, makeEntries()) }),
    )
    expect(decision.failedGate).toBe('payee_allowlist')
    expect(decision.reason).toContain('KYB')
  })
})

describe('the commitment rule blocks a forward obligation', () => {
  it('refuses to load if the rule has been relaxed in config', () => {
    expect(COMMITMENT_RULE.requireFullyBankedAtSigning).toBe(true)
    expect(COMMITMENT_RULE.allowCrossCoinSubsidy).toBe(false)
    expect(COMMITMENT_RULE.allowForwardFinancing).toBe(false)
    expect(() => assertCommitmentRuleIntact()).not.toThrow()
  })

  it('refuses anything financed against projected flow', () => {
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          obligation: {
            totalObligationUsd: 299,
            dueNowUsd: 299,
            fundingSource: 'projected_flow',
          },
        }),
      ),
    )
    expect(decision.failedGate).toBe('commitment_rule')
    expect(decision.reason).toContain('projected_flow')
  })

  it('refuses a credit line and refuses a cross-coin subsidy', () => {
    for (const fundingSource of ['credit_line', 'other_vault'] as const) {
      const decision = evaluateGates(
        makeContext(
          makeRequest({
            obligation: { totalObligationUsd: 299, dueNowUsd: 299, fundingSource },
          }),
        ),
      )
      expect(decision.failedGate).toBe('commitment_rule')
    }
  })

  it('refuses an obligation larger than the banked budget even when today is affordable', () => {
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          ledger: makeLedger({ finalizedBudget: usd(400) }),
          obligation: {
            totalObligationUsd: 3_588,
            dueNowUsd: 299,
            fundingSource: 'own_banked_budget',
            servicePeriodEndUnix: NOW + 365 * DAY,
          },
        }),
      ),
    )
    expect(decision.failedGate).toBe('commitment_rule')
    expect(decision.reason).toContain('banked budget available at signing')
  })

  it('refuses a deferred portion with no declared service period', () => {
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          obligation: {
            totalObligationUsd: 299,
            dueNowUsd: 100,
            fundingSource: 'own_banked_budget',
          },
        }),
      ),
    )
    expect(decision.failedGate).toBe('commitment_rule')
  })

  it('permits a multi-period obligation that is fully banked today', () => {
    const decision = evaluateGates(
      makeContext(
        makeRequest({
          obligation: {
            totalObligationUsd: 299,
            dueNowUsd: 100,
            fundingSource: 'own_banked_budget',
            servicePeriodEndUnix: NOW + 90 * DAY,
          },
        }),
      ),
    )
    expect(decision.approved).toBe(true)
  })
})

describe('mention flooding cannot raise the cap', () => {
  it('exposes no input derived from message, mention, or digest volume', () => {
    const forbidden = /(mention|message|digest|gist|topic|signal_count|follower|engagement)/i
    const seen: string[] = []
    const walk = (value: unknown, path: string, depth: number): void => {
      if (depth > 6 || value === null || typeof value !== 'object') return
      for (const key of Object.keys(value as Record<string, unknown>)) {
        seen.push(key)
        expect(`${path}.${key}`).not.toMatch(forbidden)
        walk((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1)
      }
    }
    walk(makeRequest(), 'request', 0)
    expect(seen.length).toBeGreaterThan(20)
  })

  it('takes a median, so one day of manufactured accrual does not move the cap', () => {
    const quiet = makeContext(makeRequest())
    const spike = [...flatAccrual()]
    spike[13] = usd(1_000_000, NOW - 60)
    const flooded = makeContext(
      makeRequest({ ledger: makeLedger({ dailyBudgetAccrual: spike }) }),
    )

    expect(rollingCapCents(flooded)).toBe(rollingCapCents(quiet))
    // A mean over the same series would have been four orders of magnitude larger.
    const mean =
      spike.reduce((sum, day) => sum + day.usd, 0) / spike.length
    expect(mean).toBeGreaterThan(70_000)
  })

  it('keeps refusing an over-cap purchase after a manufactured volume spike', () => {
    // At the low dial a second listing is over the cap; the spike is the
    // attacker's attempt to buy headroom with one day of wash volume.
    const honest = makeLedgerFor({ budgetBps: LOW_DIAL_BPS })
    const spike = [...honest.dailyBudgetAccrual]
    spike[spike.length - 1] = usd(1_000_000, NOW - 60)
    const decision = evaluateGates(
      makeContext(
        makeLowDialRequest(
          { dailyBudgetAccrual: spike },
          { proposal: makeProposal({ quantity: 2 }) },
        ),
      ),
    )
    expect(decision.failedGate).toBe('rolling_cap')
  })

  it('refuses an accrual series that is not exactly the rolling window', () => {
    expect(() =>
      makeContext(
        makeRequest({ ledger: makeLedger({ dailyBudgetAccrual: flatAccrual().slice(0, 3) }) }),
      ),
    ).toThrow(/exactly 14/)
  })
})

describe('the signed policy object', () => {
  const keyring = makeKeyring()
  const signer = makeSigner(keyring)

  const brokerWith = (service: PolicyService): SpendBroker =>
    new SpendBroker({
      catalog: makeCatalog(),
      policyService: service,
      keyring,
      predicates: makePredicates(),
    })

  it('refuses a token whose signature does not verify', async () => {
    const token = signerToken(signer, VAULT_ADDRESS, NOW)
    const [payload] = token.split('.')
    const forged = `${payload}.${'0'.repeat(64)}`
    const decision = await brokerWith({ fetch: async () => forged }).decide(makeRequest(), NOW)
    expect(decision.approved).toBe(false)
    expect(decision.failedGate).toBe('policy_token')
  })

  it('refuses a token signed by a key the broker does not hold', async () => {
    const otherKeyring = new PolicyKeyring({ [KEY_ID]: `${SERVICE_KEY}-rotated-away` })
    const token = signerToken(makeSigner(otherKeyring), VAULT_ADDRESS, NOW)
    const decision = await brokerWith({ fetch: async () => token }).decide(makeRequest(), NOW)
    expect(decision.failedGate).toBe('policy_token')
  })

  it('refuses an expired token', async () => {
    // Issued one second before its own TTL would have kept it alive.
    const token = signerToken(signer, VAULT_ADDRESS, NOW - SPEND_LIMITS.policyTokenTtlSeconds - 1)
    const decision = await brokerWith({ fetch: async () => token }).decide(makeRequest(), NOW)
    expect(decision.failedGate).toBe('policy_token')
    expect(decision.reason).toContain('expired')
  })

  it('refuses a TTL longer than the protocol ceiling', () => {
    const token = signerToken(signer, VAULT_ADDRESS, NOW, {
      ttlSeconds: SPEND_LIMITS.policyTokenTtlSeconds + 1,
    })
    expect(() => verifyPolicyToken(token, keyring, VAULT_ADDRESS, NOW)).toThrow(/TTL/)
  })

  it('refuses a token bound to another vault', () => {
    const token = signerToken(signer, ATTACKER, NOW)
    expect(() => verifyPolicyToken(token, keyring, VAULT_ADDRESS, NOW)).toThrow(/different vault/)
  })

  it('refuses a token that tries to raise a compiled ceiling', () => {
    // One dollar above the compiled ceiling is enough. A token may only ever
    // tighten, so the smallest possible loosening is the sharpest test.
    const token = signerToken(signer, VAULT_ADDRESS, NOW, {
      limits: { humanApprovalThresholdUsd: SPEND_LIMITS.humanApprovalThresholdUsd + 1 },
    })
    expect(() => verifyPolicyToken(token, keyring, VAULT_ADDRESS, NOW)).toThrow(/exceeds the compiled ceiling/)
  })

  it('honours a token that tightens a ceiling', () => {
    const decision = evaluateGates(
      makeContext(makeRequest(), { limits: { humanApprovalThresholdUsd: 100 } }),
    )
    expect(decision.approved).toBe(true)
    expect(decision.requiresHumanApproval).toBe(true)
  })

  it('treats a fetch failure as NO SPEND', async () => {
    const service = makePolicyService(signer)
    service.failNextFetch()
    const decision = await brokerWith(service).decide(makeRequest(), NOW)
    expect(decision.approved).toBe(false)
    expect(decision.failedGate).toBe('policy_token')
  })

  it('honours the fleet-wide kill switch', async () => {
    const service = makePolicyService(signer, { spendEnabled: false })
    const decision = await brokerWith(service).decide(makeRequest(), NOW)
    expect(decision.failedGate).toBe('policy_token')
    expect(decision.reason).toContain('disabled by the signed policy object')
  })

  it('never lets key material serialise into a context a model could see', () => {
    const serialised = JSON.stringify({ keyring, signer, note: 'about to be logged' })
    expect(serialised).not.toContain(SERVICE_KEY)
    expect(serialised).toContain('redacted')
  })
})

function makeBrokerFor(): SpendBroker {
  const keyring = makeKeyring()
  return new SpendBroker({
    catalog: makeCatalog(),
    policyService: makePolicyService(makeSigner(keyring)),
    keyring,
    predicates: makePredicates(),
  })
}

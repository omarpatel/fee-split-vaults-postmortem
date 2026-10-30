/**
 * Delivery predicates, milestone escrow, payment withholding, reliability
 * feedback, and the reimbursement pull that never reaches a third party.
 */
import { describe, expect, it } from 'vitest'
import { VendorCatalog } from '../catalog.js'
import {
  assertNoThirdPartyPayee,
  buildDisbursement,
  decisionDigest,
  invoiceHashFor,
  minorFromUsdCents,
  splitBoundedTransfers,
  type AssetUsdPrice,
  type BuildDisbursementArgs,
  type VendorInvoice,
} from '../disbursement.js'
import { evaluateEscrow, milestoneSlices, planEscrow, toDeliveryOutcome } from '../escrow.js'
import { evaluateGates } from '../gates.js'
import { PRICE_MAX_AGE_SECONDS } from '../money.js'
import { FakeEvidenceSource, PredicateRegistry, type DeliveryRecord } from '../predicates.js'
import { applyDeliveryOutcome, updateReliabilityScore } from '../reliability.js'
import {
  DAY,
  KOL_SKU_ID,
  LISTING_SKU_ID,
  NOW,
  RELATED_SKU_ID,
  TOKEN_ADDRESS,
  TREASURY_ADDRESS,
  USDG_ADDRESS,
  VAULT_ADDRESS,
  VENDOR_PAYOUT,
  makeAsset,
  makeCatalog,
  makeContext,
  makeEntries,
  makeProposal,
  makeRequest,
  makeVendors,
} from './fixtures.js'

const KOL_SPEC = makeCatalog().entry(KOL_SKU_ID).sku.predicate
const BOOST_SPEC = makeCatalog().entry(RELATED_SKU_ID).sku.predicate

function delivery(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    disbursementId: 'disb-1',
    vault: VAULT_ADDRESS,
    token: TOKEN_ADDRESS,
    fundedAtUnix: NOW,
    postRef: 'post-1',
    ...overrides,
  }
}

describe('KOL posts are verified at T+24h and again at T+7d', () => {
  it('pays the first milestone and withholds the second when the post is deleted', async () => {
    const evidence = new FakeEvidenceSource({
      posts: { 'post-1': { exists: true, impressions: 1_500, containsDisclosure: true } },
    })
    const registry = new PredicateRegistry(evidence)
    const record = delivery()

    const at24h = await registry.verify({
      spec: KOL_SPEC,
      delivery: record,
      offsetSeconds: DAY,
      nowUnix: NOW + DAY,
    })
    expect(at24h.passed).toBe(true)

    evidence.seed = {
      posts: { 'post-1': { exists: false, impressions: 0, containsDisclosure: false } },
    }
    const at7d = await registry.verify({
      spec: KOL_SPEC,
      delivery: record,
      offsetSeconds: 7 * DAY,
      nowUnix: NOW + 7 * DAY,
    })
    expect(at7d.passed).toBe(false)
    expect(at7d.note).toContain('deleted')

    const plan = planEscrow({
      disbursementId: record.disbursementId,
      vault: VAULT_ADDRESS,
      vendorId: 'kolnet',
      totalCents: 40_000n,
      spec: KOL_SPEC,
      fundedAtUnix: NOW,
    })
    const outcome = evaluateEscrow(plan, [at24h, at7d], NOW + 7 * DAY)
    expect(outcome.releasedCents).toBe(20_000n)
    expect(outcome.withheldCents).toBe(20_000n)
    expect(outcome.pendingCents).toBe(0n)
    expect(outcome.settled).toBe(true)
    expect(outcome.withheldLines).toHaveLength(1)
    expect(outcome.withheldLines[0]?.amountUsd).toBe(200)
  })

  it('fails a post that no longer carries the disclosure', async () => {
    const registry = new PredicateRegistry(
      new FakeEvidenceSource({
        posts: { 'post-1': { exists: true, impressions: 9_999, containsDisclosure: false } },
      }),
    )
    const result = await registry.verify({
      spec: KOL_SPEC,
      delivery: delivery(),
      offsetSeconds: 7 * DAY,
      nowUnix: NOW + 7 * DAY,
    })
    expect(result.passed).toBe(false)
    expect(result.note).toContain('disclosure')
  })

  it('fails closed when the evidence provider is unreachable', async () => {
    const registry = new PredicateRegistry(new FakeEvidenceSource({ offline: true }))
    const result = await registry.verify({
      spec: KOL_SPEC,
      delivery: delivery(),
      offsetSeconds: DAY,
      nowUnix: NOW + DAY,
    })
    expect(result.passed).toBe(false)
    expect(result.note).toContain('unavailable')
  })

  it('runs only the checks that are due, and is idempotent on replay', async () => {
    const registry = new PredicateRegistry(
      new FakeEvidenceSource({
        posts: { 'post-1': { exists: true, impressions: 5_000, containsDisclosure: true } },
      }),
    )
    const record = delivery()
    const first = await registry.verifyDue(KOL_SPEC, record, [], NOW + 2 * DAY)
    expect(first.map((r) => r.offsetSeconds)).toEqual([DAY])

    const replay = await registry.verifyDue(KOL_SPEC, record, first, NOW + 2 * DAY)
    expect(replay).toEqual([])

    const later = await registry.verifyDue(KOL_SPEC, record, first, NOW + 8 * DAY)
    expect(later.map((r) => r.offsetSeconds)).toEqual([7 * DAY])
  })
})

describe('boost deltas need a pre-purchase baseline', () => {
  it('fails when no baseline was captured', async () => {
    const registry = new PredicateRegistry(new FakeEvidenceSource({ boosts: 90 }))
    const result = await registry.verify({
      spec: BOOST_SPEC,
      delivery: delivery(),
      offsetSeconds: DAY,
      nowUnix: NOW + DAY,
    })
    expect(result.passed).toBe(false)
    expect(result.note).toContain('baseline')
  })

  it('passes on a real delta against the captured baseline', async () => {
    const registry = new PredicateRegistry(new FakeEvidenceSource({ boosts: 90 }))
    const result = await registry.verify({
      spec: BOOST_SPEC,
      delivery: delivery({ baseline: { boosts: 50 } }),
      offsetSeconds: DAY,
      nowUnix: NOW + DAY,
    })
    expect(result.passed).toBe(true)
  })
})

describe('milestone escrow', () => {
  it('splits into slices that sum exactly to the total', () => {
    const plan = planEscrow({
      disbursementId: 'd',
      vault: VAULT_ADDRESS,
      vendorId: 'kolnet',
      totalCents: 10_001n,
      spec: { kind: 'kol_post', verifyAtOffsetsSeconds: [DAY, 3 * DAY, 7 * DAY], params: {} },
      fundedAtUnix: NOW,
    })
    const slices = milestoneSlices(plan)
    expect(slices.reduce((a, b) => a + b, 0n)).toBe(10_001n)
  })

  it('holds slices pending until their check time arrives', () => {
    const plan = planEscrow({
      disbursementId: 'd',
      vault: VAULT_ADDRESS,
      vendorId: 'kolnet',
      totalCents: 40_000n,
      spec: KOL_SPEC,
      fundedAtUnix: NOW,
    })
    const outcome = evaluateEscrow(plan, [], NOW + 2 * DAY)
    expect(outcome.pendingCents).toBe(40_000n)
    expect(outcome.settled).toBe(false)
  })

  it('returns unproven procurement to the dev leg once the proof window closes', () => {
    const plan = planEscrow({
      disbursementId: 'd',
      vault: VAULT_ADDRESS,
      vendorId: 'kolnet',
      totalCents: 40_000n,
      spec: KOL_SPEC,
      fundedAtUnix: NOW,
    })
    const outcome = evaluateEscrow(plan, [], NOW + 8 * DAY)
    expect(outcome.returnedToDevLegCents).toBe(40_000n)
    expect(outcome.releasedCents).toBe(0n)
    expect(outcome.withheldLines.every((l) => l.reason.includes('dev leg'))).toBe(true)
  })
})

describe('reliability feeds back into the gate', () => {
  it('moves the score by value released, not by delivery count', () => {
    const next = updateReliabilityScore(0.85, {
      vendorId: 'kolnet',
      releasedCents: 20_000n,
      withheldCents: 20_000n,
      observedAtUnix: NOW,
    })
    expect(next).toBe(0.7625)
  })

  it('learns nothing from an escrow that adjudicated nothing', () => {
    expect(
      updateReliabilityScore(0.85, {
        vendorId: 'kolnet',
        releasedCents: 0n,
        withheldCents: 0n,
        observedAtUnix: NOW,
      }),
    ).toBe(0.85)
  })

  it('disables a vendor that falls through the floor, and the gate then refuses', () => {
    const kolnet = makeVendors().find((v) => v.id === 'kolnet')!
    const plan = planEscrow({
      disbursementId: 'd',
      vault: VAULT_ADDRESS,
      vendorId: 'kolnet',
      totalCents: 40_000n,
      spec: KOL_SPEC,
      fundedAtUnix: NOW,
    })
    const failed = evaluateEscrow(plan, [], NOW + 8 * DAY)

    let vendor = applyDeliveryOutcome(kolnet, toDeliveryOutcome(plan, failed))
    expect(vendor.reliabilityScore).toBeLessThan(kolnet.reliabilityScore)
    vendor = applyDeliveryOutcome(vendor, toDeliveryOutcome(plan, failed))
    expect(vendor.enabled).toBe(false)

    const catalog = new VendorCatalog(
      makeVendors().map((v) => (v.id === 'kolnet' ? vendor : v)),
      makeEntries(),
    )
    const decision = evaluateGates(
      makeContext(makeRequest({ proposal: makeProposal({ skuId: KOL_SKU_ID }) }), { catalog }),
    )
    expect(decision.approved).toBe(false)
    expect(['payee_allowlist', 'vendor_reliability']).toContain(decision.failedGate)
  })
})

describe('disbursement is a reimbursement pull to the operator treasury', () => {
  const treasury = { address: TREASURY_ADDRESS, label: 'Operator treasury' }
  const price: AssetUsdPrice = {
    asset: USDG_ADDRESS,
    decimals: 6,
    centsPerWholeUnit: 100n,
    source: 'test:pinned',
    pricedAtUnix: NOW - 60,
  }

  const invoice = (overrides: Partial<VendorInvoice> = {}): VendorInvoice => {
    const body = {
      vendorId: 'dexscreener',
      skuId: LISTING_SKU_ID,
      quantity: 1,
      amountUsd: 299,
      issuedAtUnix: NOW - 600,
      ...overrides,
    }
    return {
      invoiceHash: invoiceHashFor(body),
      vendorCountersig: `0x${'ab'.repeat(65)}`,
      ...body,
    }
  }

  function build(overrides: Partial<BuildDisbursementArgs> = {}) {
    const catalog = makeCatalog()
    const decision = evaluateGates(makeContext(makeRequest()))
    return buildDisbursement({
      proposal: makeProposal(),
      decision,
      entry: catalog.entry(LISTING_SKU_ID),
      catalog,
      invoice: invoice(),
      treasury,
      asset: makeAsset(),
      price,
      quoteCents: 29_900n,
      disbursementId: 'disb-1',
      nowUnix: NOW,
      ...overrides,
    })
  }

  it('sends money only to the operator treasury', () => {
    const built = build()
    expect(built.pull.destination).toBe(TREASURY_ADDRESS)
    expect(makeCatalog().payoutAddresses).not.toContain(built.pull.destination.toLowerCase())
    expect(built.pull.amountMinor).toBe(299_000_000n)
    expect(built.disbursement.costUsd).toBe(299)
  })

  it('refuses any destination that is not the treasury', () => {
    expect(() => assertNoThirdPartyPayee(VENDOR_PAYOUT, treasury, makeCatalog())).toThrow(
      /only permitted destination/,
    )
  })

  it('aborts if the treasury address ever collides with a vendor payout address', () => {
    expect(() =>
      assertNoThirdPartyPayee(
        VENDOR_PAYOUT,
        { address: VENDOR_PAYOUT, label: 'compromised' },
        makeCatalog(),
      ),
    ).toThrow(/vendor payout address/)
  })

  it('refuses to settle at any amount other than the quoted one', () => {
    expect(() => build({ invoice: invoice({ amountUsd: 349 }) })).toThrow(/earns no spread/)
    expect(() => build({ invoice: invoice({ amountUsd: 249 }) })).toThrow(/earns no spread/)
  })

  it('refuses an invoice that no vendor countersigned', () => {
    expect(() => build({ invoice: invoice({ vendorCountersig: '' }) })).toThrow(/countersign/)
    expect(() => build({ invoice: invoice({ vendorCountersig: 'signed by vendor' }) })).toThrow(
      /countersign/,
    )
  })

  it('refuses an invoice whose hash is not bytes32 or does not cover its body', () => {
    expect(() => build({ invoice: invoice({ invoiceHash: '0xinvoice' }) })).toThrow(
      /invoice_hash_malformed/,
    )
    const other = invoiceHashFor({ ...invoice(), issuedAtUnix: NOW - 601 })
    expect(() => build({ invoice: invoice({ invoiceHash: other }) })).toThrow(/invoice_hash_mismatch/)
  })

  it('hands the invoice identity and countersignature to the pull unchanged', () => {
    const inv = invoice({ baseline: { boosts: 12 } })
    expect(inv.invoiceHash).not.toBe(invoiceHashFor({ ...inv, baseline: undefined }))
    const built = build({ invoice: inv })
    expect(built.pull.invoiceHash).toBe(inv.invoiceHash)
    expect(built.pull.vendorCountersig).toBe(inv.vendorCountersig)
  })

  it('refuses to disburse an escalated decision without a matching human approval', () => {
    const decision = { ...evaluateGates(makeContext(makeRequest())), requiresHumanApproval: true }
    expect(() => build({ decision })).toThrow(/requires human approval/)

    expect(() =>
      build({
        decision,
        approval: {
          approver: 'ops@example',
          approvedAtUnix: NOW - 60,
          decisionDigest: decisionDigest(makeProposal({ quantity: 4 }), 119_600n),
        },
      }),
    ).toThrow(/different decision/)

    const built = build({
      decision,
      approval: {
        approver: 'ops@example',
        approvedAtUnix: NOW - 60,
        decisionDigest: decisionDigest(makeProposal(), 29_900n),
      },
    })
    expect(built.pull.destination).toBe(TREASURY_ADDRESS)
  })

  it('splits a pull that would breach a per-transfer cap', () => {
    const built = build({ asset: makeAsset({ maxTransferMinor: 100_000_000n }) })
    expect(built.pull.transfers).toEqual([100_000_000n, 100_000_000n, 99_000_000n])
    expect(built.pull.transfers.reduce((a, b) => a + b, 0n)).toBe(built.pull.amountMinor)
  })

  it('rounds the settlement amount down, so rounding favours the client', () => {
    expect(
      minorFromUsdCents(1n, { ...price, centsPerWholeUnit: 300n }, NOW, PRICE_MAX_AGE_SECONDS),
    ).toBe(3_333n)
  })

  it('refuses to settle on a stale asset price', () => {
    expect(() =>
      minorFromUsdCents(
        29_900n,
        { ...price, pricedAtUnix: NOW - PRICE_MAX_AGE_SECONDS - 1 },
        NOW,
        PRICE_MAX_AGE_SECONDS,
      ),
    ).toThrow(/stale/)
  })

  it('settles at the broker-wide price-staleness window when the caller names none', () => {
    // The window is money.ts's to set. buildDisbursement used to restate it as
    // a literal, which would have kept settlement accepting prices the rest of
    // the broker had already declared too old.
    expect(() =>
      build({ price: { ...price, pricedAtUnix: NOW - PRICE_MAX_AGE_SECONDS - 1 } }),
    ).toThrow(/stale/)
    expect(
      build({ price: { ...price, pricedAtUnix: NOW - PRICE_MAX_AGE_SECONDS + 1 } }).pull
        .amountMinor,
    ).toBe(299_000_000n)
  })

  it('splits nothing when there is no cap', () => {
    expect(splitBoundedTransfers(5n)).toEqual([5n])
  })
})

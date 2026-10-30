/**
 * SHARED TOLERANCES ARE READ, NEVER RESTATED.
 *
 * money.ts owns the two numbers several modules need: how stale a price may be
 * before it stops counting as a price, and how far ahead of our clock another
 * clock may run before a timestamp from it is refused. Both had been restated as
 * bare literals at individual call sites, and that is the defect this file
 * exists to prevent: tightening the shared number leaves every restatement
 * loose, and the loosest check is the one an attacker with a fast clock uses.
 *
 * Two kinds of test here, and each catches what the other cannot.
 *
 *   The BOUNDARY tests pin every site that accepts a future-dated input to the
 *   SAME distance, computed from the constant. Restate the tolerance anywhere
 *   and these go red the next time the shared value moves in either direction.
 *
 *   The SOURCE GUARD catches the restatement at the moment it is written, which
 *   is a great deal cheaper than catching it a year later.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Vendor } from '@fee-split-vaults/core'
import { describe, expect, it } from 'vitest'
import { VendorCatalog } from '../catalog.js'
import {
  buildDisbursement,
  decisionDigest,
  invoiceHashFor,
  minorFromUsdCents,
  type AssetUsdPrice,
  type BuiltDisbursement,
} from '../disbursement.js'
import { evaluateGates } from '../gates.js'
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  PRICE_MAX_AGE_SECONDS,
  pinnedCents,
  usdFromCents,
} from '../money.js'
import { verifyPolicyToken } from '../policy.js'
import {
  LISTING_SKU_ID,
  NOW,
  TREASURY_ADDRESS,
  USDG_ADDRESS,
  VAULT_ADDRESS,
  makeAsset,
  makeContext,
  makeCounters,
  makeEntries,
  makeKeyring,
  makeProposal,
  makeRequest,
  makeSigner,
  makeVendors,
  signerToken,
  usd,
} from './fixtures.js'

const TOLERANCE = CLOCK_SKEW_TOLERANCE_SECONDS

/** The same catalog, with one vendor's compliance dates moved. */
function catalogWithVendorDates(overrides: Partial<Vendor>): VendorCatalog {
  return new VendorCatalog(
    makeVendors().map((vendor) =>
      vendor.id === 'dexscreener' ? { ...vendor, ...overrides } : vendor,
    ),
    makeEntries(),
  )
}

const ASSET_PRICE: AssetUsdPrice = {
  asset: USDG_ADDRESS,
  decimals: 6,
  centsPerWholeUnit: 100n,
  source: 'test:pinned',
  pricedAtUnix: NOW - 60,
}

/** An escalated decision settled against a human approval of the given date. */
function settleWithApprovalAt(approvedAtUnix: number): BuiltDisbursement {
  const context = makeContext(makeRequest())
  const quoteCents = context.quoteCents
  const invoiceBody = {
    vendorId: 'dexscreener',
    skuId: LISTING_SKU_ID,
    quantity: 1,
    amountUsd: usdFromCents(quoteCents),
    issuedAtUnix: NOW - 600,
  }
  return buildDisbursement({
    proposal: makeProposal(),
    decision: { ...evaluateGates(context), requiresHumanApproval: true },
    entry: context.entry,
    catalog: new VendorCatalog(makeVendors(), makeEntries()),
    invoice: {
      ...invoiceBody,
      invoiceHash: invoiceHashFor(invoiceBody),
      vendorCountersig: `0x${'ab'.repeat(65)}`,
    },
    treasury: { address: TREASURY_ADDRESS, label: 'Operator treasury' },
    asset: makeAsset(),
    price: ASSET_PRICE,
    quoteCents,
    disbursementId: 'disb-1',
    nowUnix: NOW,
    approval: {
      approver: 'ops@example',
      approvedAtUnix,
      decisionDigest: decisionDigest(makeProposal(), quoteCents),
    },
  })
}

describe('every future-dated input is refused at the same distance', () => {
  it('takes a pinned price exactly at the tolerance and refuses one second beyond', () => {
    expect(pinnedCents(usd(10, NOW + TOLERANCE), NOW, 'price', { mode: 'floor' })).toBe(1_000n)
    expect(() => pinnedCents(usd(10, NOW + TOLERANCE + 1), NOW, 'price', { mode: 'floor' })).toThrow(
      /future/,
    )
  })

  it('takes a policy token issued exactly at the tolerance and refuses one second beyond', () => {
    const keyring = makeKeyring()
    const signer = makeSigner(keyring)
    expect(() =>
      verifyPolicyToken(
        signerToken(signer, VAULT_ADDRESS, NOW + TOLERANCE),
        keyring,
        VAULT_ADDRESS,
        NOW,
      ),
    ).not.toThrow()
    expect(() =>
      verifyPolicyToken(
        signerToken(signer, VAULT_ADDRESS, NOW + TOLERANCE + 1),
        keyring,
        VAULT_ADDRESS,
        NOW,
      ),
    ).toThrow(/future/)
  })

  it('takes spend counters stamped exactly at the tolerance and refuses one second beyond', () => {
    expect(() =>
      makeContext(makeRequest({ counters: makeCounters({ countedAtUnix: NOW + TOLERANCE }) })),
    ).not.toThrow()
    expect(() =>
      makeContext(makeRequest({ counters: makeCounters({ countedAtUnix: NOW + TOLERANCE + 1 }) })),
    ).toThrow(/future/)
  })

  it('takes a KYB record dated exactly at the tolerance and refuses one second beyond', () => {
    const ok = evaluateGates(
      makeContext(makeRequest(), {
        catalog: catalogWithVendorDates({ kybVerifiedAtUnix: NOW + TOLERANCE }),
      }),
    )
    expect(ok.approved).toBe(true)

    const beyond = evaluateGates(
      makeContext(makeRequest(), {
        catalog: catalogWithVendorDates({ kybVerifiedAtUnix: NOW + TOLERANCE + 1 }),
      }),
    )
    expect(beyond.failedGate).toBe('payee_allowlist')
    expect(beyond.reason).toContain('future')
  })

  it('takes a sanctions screen dated exactly at the tolerance and refuses one second beyond', () => {
    const ok = evaluateGates(
      makeContext(makeRequest(), {
        catalog: catalogWithVendorDates({ ofacScreenedAtUnix: NOW + TOLERANCE }),
      }),
    )
    expect(ok.approved).toBe(true)

    const beyond = evaluateGates(
      makeContext(makeRequest(), {
        catalog: catalogWithVendorDates({ ofacScreenedAtUnix: NOW + TOLERANCE + 1 }),
      }),
    )
    expect(beyond.failedGate).toBe('payee_allowlist')
    expect(beyond.reason).toContain('future')
  })

  it('settles at an asset price dated exactly at the tolerance and refuses one second beyond', () => {
    expect(
      minorFromUsdCents(
        29_900n,
        { ...ASSET_PRICE, pricedAtUnix: NOW + TOLERANCE },
        NOW,
        PRICE_MAX_AGE_SECONDS,
      ),
    ).toBe(299_000_000n)
    expect(() =>
      minorFromUsdCents(
        29_900n,
        { ...ASSET_PRICE, pricedAtUnix: NOW + TOLERANCE + 1 },
        NOW,
        PRICE_MAX_AGE_SECONDS,
      ),
    ).toThrow(/stale/)
  })

  it('takes a human approval dated exactly at the tolerance and refuses one second beyond', () => {
    expect(settleWithApprovalAt(NOW + TOLERANCE).pull.destination).toBe(TREASURY_ADDRESS)
    expect(() => settleWithApprovalAt(NOW + TOLERANCE + 1)).toThrow(/expired/)
  })
})

describe('the tolerance is never restated as a literal', () => {
  /**
   * Every timestamp comparison in this package bounds a clock against a NAMED
   * window - CLOCK_SKEW_TOLERANCE_SECONDS, PRICE_MAX_AGE_SECONDS, one of the
   * windows in limits.ts, or a field on TERMS. A bare number added to or
   * subtracted from a timestamp is a second copy of one of those windows, and a
   * second copy is a window that will not be tightened when the first one is.
   *
   * Test files are exempt: a fixture legitimately says "priced a minute ago".
   */
  it('has no timestamp compared against a bare number anywhere in the package', () => {
    const src = fileURLToPath(new URL('..', import.meta.url))
    const restatements: string[] = []
    for (const file of readdirSync(src).filter((name) => name.endsWith('.ts'))) {
      readFileSync(join(src, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/Unix\s*[+-]\s*\d/.test(line)) {
            restatements.push(`${file}:${index + 1}: ${line.trim()}`)
          }
        })
    }
    expect(restatements).toEqual([])
  })
})

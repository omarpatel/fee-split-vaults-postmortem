/**
 * The money path after the pull lands: the invoice it cited is spent, and the
 * delivery checks the SKU promised are scheduled with what they need.
 */
import { describe, expect, it } from 'vitest'
import { RECEIPT_PUBLISH_LAG_SECONDS, publishDeliveredReceipt } from '../receipts.js'
import {
  LISTING_SKU,
  NOW,
  TOKEN,
  VAULT,
  makeHarness,
  makeInvoice,
  seedWindow,
  usdgPrice,
  warmUp,
  type Harness,
} from './harness.js'

function purchase(): Array<{ name: string; input: unknown }> {
  return [
    {
      name: 'propose_purchase',
      input: { skuId: LISTING_SKU, quantity: 1, rationale: 'a listing answers the how-to-buy backlog' },
    },
  ]
}

async function nextTick(h: Harness, stepSeconds: number) {
  const now = h.clock.nowUnix() + stepSeconds
  h.clock.set(now)
  h.prices.pin(usdgPrice(now - 30))
  seedWindow(h.messages, h.config.coinRef, Math.floor(now / 1_800) * 1_800 - 1_800)
  return h.ticker.tick()
}

describe('an invoice reimburses exactly one purchase', () => {
  it('is settled by the pull that cites it and never found again', async () => {
    const h = makeHarness({ withInvoice: false })
    const invoice = makeInvoice({ baseline: { boosts: 3 } })
    await h.invoices.put(VAULT, invoice)
    await warmUp(h)
    h.script.calls = purchase()

    const first = await h.ticker.tick()
    expect(first.spends[0]?.status).toBe('disbursed')
    expect(first.spends[0]?.pull?.invoiceHash).toBe(invoice.invoiceHash)
    expect(await h.invoices.listPending(VAULT)).toEqual([])

    // Same decision on the next tick: no invoice, so no reimbursement. Without
    // markSettled this would replay the same hash into the vault a second time.
    const second = await nextTick(h, 43_200)
    expect(second.spends[0]?.status).toBe('awaiting_invoice')
    expect(second.spends[0]?.code).toBe('invoice_missing')
    expect(h.settlement.submitted).toHaveLength(1)
  })

  it('schedules the SKU predicate with the invoice baseline once the pull landed', async () => {
    const h = makeHarness({ withInvoice: false })
    await h.invoices.put(VAULT, makeInvoice({ baseline: { boosts: 3 } }))
    await warmUp(h)
    h.script.calls = purchase()

    const result = await h.ticker.tick()
    expect(result.spends[0]?.status).toBe('disbursed')
    const disbursement = result.spends[0]?.disbursement
    expect(h.predicates.scheduled).toHaveLength(1)
    expect(h.predicates.scheduled[0]).toMatchObject({
      disbursementId: disbursement?.id,
      vault: VAULT,
      token: TOKEN,
      skuId: LISTING_SKU,
      vendorId: 'dexscreener',
      spec: h.broker.catalog.entry(LISTING_SKU).sku.predicate,
      fundedAtUnix: h.clock.nowUnix(),
      costUsd: 299,
      baseline: { boosts: 3 },
    })
  })

  it('schedules nothing and settles nothing when settlement fails', async () => {
    const h = makeHarness()
    await warmUp(h)
    h.settlement.failNext()
    h.script.calls = purchase()

    const result = await h.ticker.tick()
    expect(result.spends[0]?.status).toBe('settlement_failed')
    expect(h.predicates.scheduled).toHaveLength(0)
    expect((await h.invoices.listPending(VAULT)).length).toBeGreaterThan(0)
  })
})

describe('the pending-purchase list', () => {
  it('holds one line per approved, uninvoiced purchase however many ticks re-decide it', async () => {
    const h = makeHarness({ withInvoice: false })
    await warmUp(h)
    h.script.calls = purchase()

    const first = await h.ticker.tick()
    expect(first.spends[0]?.status).toBe('awaiting_invoice')
    const firstProposedAt = h.clock.nowUnix()

    const second = await nextTick(h, 43_200)
    expect(second.spends[0]?.status).toBe('awaiting_invoice')

    const pending = await h.pending.awaitingInvoice(VAULT)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toEqual({
      vault: VAULT.toLowerCase(),
      vendorId: 'dexscreener',
      skuId: LISTING_SKU,
      quantity: 1,
      quoteCents: h.broker.catalog.priceCents(LISTING_SKU, 1),
      proposedAtUnix: firstProposedAt,
    })
  })

  it('drops the line once the invoice arrives and the reimbursement settles', async () => {
    const h = makeHarness({ withInvoice: false })
    await warmUp(h)
    h.script.calls = purchase()

    expect((await h.ticker.tick()).spends[0]?.status).toBe('awaiting_invoice')
    expect(await h.pending.awaitingInvoice(VAULT)).toHaveLength(1)

    await h.invoices.put(VAULT, makeInvoice())
    const settled = await nextTick(h, 43_200)
    expect(settled.spends[0]?.status).toBe('disbursed')
    expect(await h.pending.awaitingInvoice(VAULT)).toEqual([])
  })
})

describe('the delivered re-issue', () => {
  it('publishes the withheld receipt at once, on the same row, citing the evidence', async () => {
    const h = makeHarness()
    await warmUp(h)
    h.script.calls = purchase()
    const result = await h.ticker.tick()
    const disbursementId = result.spends[0]?.disbursement?.id as string
    const now = h.clock.nowUnix()
    expect(await h.receipts.list(VAULT, { publishedOnly: true, nowUnix: now })).toHaveLength(0)

    const reissued = await publishDeliveredReceipt(h.receipts, disbursementId, 'https://api.test/pairs')
    expect(reissued?.publishAfterUnix).toBe(reissued?.occurredAtUnix)

    const published = await h.receipts.list(VAULT, { publishedOnly: true, nowUnix: now })
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ disbursementId, evidenceUri: 'https://api.test/pairs', amountUsd: 299 })
    // Not a second row beside the withheld one.
    expect(await h.receipts.list(VAULT, { publishedOnly: false, nowUnix: now + RECEIPT_PUBLISH_LAG_SECONDS })).toHaveLength(1)
    expect(await publishDeliveredReceipt(h.receipts, 'db_never_written')).toBeUndefined()
  })
})

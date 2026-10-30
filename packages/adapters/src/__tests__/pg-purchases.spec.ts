/**
 * The pending-purchase list against a real Postgres (pglite) with the real
 * 0014 DDL applied: the one-row-per-line upsert, earliest-proposal-wins, and
 * the delete that an invoice on file triggers.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PendingPurchase } from '@fee-split-vaults/orchestrator'
import { PgPendingPurchaseStore } from '../pg/purchases.js'
import { migratedPglite, type MigratedPglite } from './pglite.js'

const VAULT = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa'
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

let pg: MigratedPglite

beforeAll(async () => {
  pg = await migratedPglite()
}, 120_000)

afterAll(async () => {
  await pg.close()
})

function line(overrides: Partial<PendingPurchase> = {}): PendingPurchase {
  return {
    vault: VAULT,
    vendorId: 'dexscreener',
    skuId: 'dexscreener.eti',
    quantity: 1,
    quoteCents: 29_900n,
    proposedAtUnix: 1_700_000_000,
    ...overrides,
  }
}

describe('PgPendingPurchaseStore', () => {
  it('round-trips a line, lowercases the vault and scopes reads to it', async () => {
    const store = new PgPendingPurchaseStore(pg.driver)
    await store.record(line())
    await store.record(line({ vault: OTHER, skuId: 'other.sku' }))

    expect(await store.awaitingInvoice(VAULT)).toEqual([line({ vault: VAULT.toLowerCase() })])
    expect(await store.awaitingInvoice(VAULT.toLowerCase())).toHaveLength(1)
    expect(await store.awaitingInvoice(OTHER)).toEqual([line({ vault: OTHER, skuId: 'other.sku' })])
  })

  it('keeps one row per (vault, sku, quantity) with the earliest proposal time', async () => {
    const store = new PgPendingPurchaseStore(pg.driver)
    await store.record(line({ skuId: 'sku.earliest', proposedAtUnix: 1_700_000_500 }))
    await store.record(line({ skuId: 'sku.earliest', proposedAtUnix: 1_700_000_100, quoteCents: 30_000n }))
    await store.record(line({ skuId: 'sku.earliest', proposedAtUnix: 1_700_000_900 }))
    // A different quantity is a different line.
    await store.record(line({ skuId: 'sku.earliest', quantity: 2, proposedAtUnix: 1_700_000_050 }))

    const rows = (await store.awaitingInvoice(VAULT)).filter((p) => p.skuId === 'sku.earliest')
    expect(rows.map((p) => [p.quantity, p.proposedAtUnix, p.quoteCents])).toEqual([
      [2, 1_700_000_050, 29_900n],
      [1, 1_700_000_100, 29_900n],
    ])
  })

  it('clears exactly the line named, and clearing twice is harmless', async () => {
    const store = new PgPendingPurchaseStore(pg.driver)
    await store.record(line({ skuId: 'sku.clear', quantity: 1 }))
    await store.record(line({ skuId: 'sku.clear', quantity: 3 }))

    await store.clear(VAULT, 'sku.clear', 1)
    await store.clear(VAULT, 'sku.clear', 1)

    const rows = (await store.awaitingInvoice(VAULT)).filter((p) => p.skuId === 'sku.clear')
    expect(rows.map((p) => p.quantity)).toEqual([3])
  })

  it('refuses a non-positive quantity at the table', async () => {
    const store = new PgPendingPurchaseStore(pg.driver)
    await expect(store.record(line({ skuId: 'sku.zero', quantity: 0 }))).rejects.toThrow()
  })
})

/**
 * The Postgres stores against a real Postgres (pglite) with the real
 * migrations applied. What is tested is BEHAVIOUR the in-memory doubles also
 * promise and a plain round-trip cannot prove: idempotent counts, rollback
 * boundaries, finalisation only against a matching block hash, constraint
 * refusals, the embargo filter, invoice uniqueness, and the credential seal.
 */

import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { imageAssetId, type ImageAsset, type Receipt, type ScreeningResult, type Vault } from '@fee-split-vaults/core'
import type { CoinBinding, FeePosting } from '@fee-split-vaults/indexer'
import { SqlLedgerStore } from '@fee-split-vaults/ledger'
import type { AccountBinding, PostRecord } from '@fee-split-vaults/publisher'
import type { VendorInvoice } from '@fee-split-vaults/broker'
import { InvoiceConflictError, InvoiceUnknownError, SecretUnopenableError, SourceUnavailableError } from '../errors.js'
import { PgVaultMovementStore } from '../chain/movements.js'
import { PgApprovalStore } from '../pg/approvals.js'
import { PgImageAssetStore } from '../pg/images.js'
import { PgIndexerStore } from '../pg/indexer-store.js'
import { PgInvoiceRegistry } from '../pg/invoices.js'
import { pgLedgerDriver, toPositionalParams } from '../pg/ledger-driver.js'
import { PgAccountCredentialStore, PgAccountRegistry, PgLabelAttestationStore, PgPostRegistry } from '../pg/publisher.js'
import { PgReceiptStore } from '../pg/receipts.js'
import { PgScreeningStore } from '../pg/screening.js'
import { PgVaultRepository } from '../pg/vaults.js'
import { migratedPglite, type MigratedPglite } from './pglite.js'

const VAULT = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa'
const TOKEN = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb'
const CURVE = '0xcccccccccccccccccccccccccccccccccccccccc'
const USDG = '0xdddddddddddddddddddddddddddddddddddddddd'
const POOL = '0x' + '11'.repeat(32)
const HASH_A = ('0x' + 'a1'.repeat(32)) as `0x${string}`
const HASH_B = ('0x' + 'b2'.repeat(32)) as `0x${string}`
const KEY = 'ab'.repeat(32)
const OTHER_KEY = 'cd'.repeat(32)

let pg: MigratedPglite

beforeAll(async () => {
  pg = await migratedPglite()
}, 120_000)

afterAll(async () => {
  await pg.close()
})

function posting(overrides: Partial<FeePosting> & { id: string; blockNumber: bigint }): FeePosting {
  return {
    vault: VAULT,
    token: TOKEN,
    asset: USDG,
    creditedMinor: 7n,
    grossFeeMinor: 10n,
    derivation: 'creator_share_of_fee',
    volumeMinor: 1_000n,
    source: 'curve_event',
    phase: 'pre_graduation',
    classification: 'trade',
    side: 'buy',
    blockHash: HASH_A,
    txHash: `0x${overrides.id.padEnd(64, '0')}`,
    logIndex: 0,
    occurredAtUnix: 1_700_000_000 + Number(overrides.blockNumber),
    finalized: false,
    ...overrides,
  }
}

describe('PgIndexerStore', () => {
  it('counts only new postings and orders reads by chain position', async () => {
    const store = new PgIndexerStore(pg.driver)
    const first = await store.putPostings([
      posting({ id: 'p2', blockNumber: 101n, logIndex: 3 }),
      posting({ id: 'p1', blockNumber: 100n }),
    ])
    const second = await store.putPostings([posting({ id: 'p1', blockNumber: 100n }), posting({ id: 'p3', blockNumber: 102n })])
    expect(first).toBe(2)
    expect(second).toBe(1)

    const rows = await store.postings({ vault: VAULT })
    expect(rows.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
    expect(rows[0]?.creditedMinor).toBe(7n)
    expect(rows[0]?.counterparty).toBeUndefined()
    expect(rows[1]?.logIndex).toBe(3)
  })

  it('finalises only postings whose block hash matches the tracked block', async () => {
    const store = new PgIndexerStore(pg.driver)
    await store.putBlock({ number: 100n, hash: HASH_A, parentHash: HASH_B, timestampUnix: 1 })
    await store.putBlock({ number: 101n, hash: HASH_B, parentHash: HASH_A, timestampUnix: 2 })
    // p1 @100 matches HASH_A; p2 @101 was recorded under HASH_A but the chain says HASH_B.
    const marked = await store.markFinalizedThrough(105n)
    expect(marked).toBe(1)
    const finalized = await store.postings({ vault: VAULT, finalizedOnly: true })
    expect(finalized.map((p) => p.id)).toEqual(['p1'])
    expect(await store.markFinalizedThrough(105n)).toBe(0)
  })

  it('rolls back above a block and returns exactly what it removed', async () => {
    const store = new PgIndexerStore(pg.driver)
    const removed = await store.rollbackAboveBlock(100n)
    expect(removed.map((p) => p.id)).toEqual(['p2', 'p3'])
    expect((await store.postings({})).map((p) => p.id)).toEqual(['p1'])
    await store.deleteBlocksAbove(100n)
    expect(await store.highestTrackedBlock()).toMatchObject({ number: 100n, hash: HASH_A })
  })

  it('round-trips a binding and finds it by curve and by pool id', async () => {
    const store = new PgIndexerStore(pg.driver)
    const binding: CoinBinding = {
      token: TOKEN,
      vault: VAULT,
      curve: CURVE,
      poolId: POOL,
      quoteAsset: USDG,
      launchedAtUnix: 1_700_000_000,
      launchBlockNumber: 99n,
      buybackEnabled: true,
      creatorTaxBps: 100,
      coverageStartUnix: 1_700_000_000,
    }
    await store.putBindings([binding])
    const byCurve = await store.bindingByCurve(CURVE.toUpperCase().replace('0X', '0x'))
    expect(byCurve?.token).toBe(TOKEN.toLowerCase())
    expect(byCurve?.launchBlockNumber).toBe(99n)
    expect(byCurve?.graduatedAtUnix).toBeUndefined()
    expect((await store.bindingByPoolId(POOL))?.vault).toBe(VAULT.toLowerCase())
    expect(await store.bindingByToken('0x' + '00'.repeat(20))).toBeUndefined()
  })

  it('keeps cursors and a single recipient observation per token', async () => {
    const store = new PgIndexerStore(pg.driver)
    expect(await store.getCursor('curve_trades')).toBeUndefined()
    await store.setCursor('curve_trades', 5n)
    await store.setCursor('curve_trades', 9n)
    expect(await store.getCursor('curve_trades')).toBe(9n)

    await store.putRecipientObservation({
      token: TOKEN,
      recipient: VAULT,
      expected: VAULT,
      matches: true,
      blockHash: HASH_A,
      blockNumber: 100n,
      observedAtUnix: 1,
    })
    await store.putRecipientObservation({
      token: TOKEN,
      recipient: CURVE,
      expected: VAULT,
      matches: false,
      blockHash: HASH_B,
      blockNumber: 101n,
      observedAtUnix: 2,
    })
    const observed = await store.recipientObservation(TOKEN)
    expect(observed?.matches).toBe(false)
    expect(observed?.blockNumber).toBe(101n)
  })
})

function vault(overrides: Partial<Vault> = {}): Vault {
  return {
    address: VAULT,
    token: TOKEN,
    consent: {
      devSigner: '0x' + '01'.repeat(20),
      devPayout: '0x' + '02'.repeat(20),
      token: TOKEN,
      termsHash: '0x' + '03'.repeat(32),
      operatorBps: 1_500,
      budgetBpsMax: 5_000,
      adapter: '0x' + '04'.repeat(20),
      referrer: '0x' + '00'.repeat(20),
      referrerBps: 0,
      expiryUnix: 1_800_000_000,
      nonce: '1',
    },
    state: 'ACTIVE',
    tier: 'T0',
    budgetBps: 2_000,
    buybackEnabled: false,
    creatorTaxBps: 0,
    deployedAtUnix: 1_700_000_000,
    ...overrides,
  }
}

describe('PgVaultRepository', () => {
  it('persists a tier change and refuses a state this build does not know', async () => {
    const repo = new PgVaultRepository(pg.driver)
    await repo.put(vault())
    await repo.put({ ...vault(), tier: 'T1', activatedAtUnix: 1_700_000_100 })
    const stored = await repo.get(VAULT)
    expect(stored?.tier).toBe('T1')
    expect(stored?.activatedAtUnix).toBe(1_700_000_100)
    expect(stored?.consent.operatorBps).toBe(1_500)
    expect((await repo.list()).map((v) => v.address)).toEqual([VAULT.toLowerCase()])

    await expect(repo.put(vault({ state: 'FROZEN' as Vault['state'] }))).rejects.toBeInstanceOf(SourceUnavailableError)
    expect((await repo.get(VAULT))?.state).toBe('ACTIVE')
  })
})

describe('PgScreeningStore', () => {
  it('serves the latest verdict and refuses paid media on a non-CLEAR verdict', async () => {
    const store = new PgScreeningStore(pg.driver)
    const clear: ScreeningResult = {
      token: TOKEN,
      verdict: 'CLEAR',
      flags: [],
      stagesRun: ['lexicon', 'trademark'],
      screenedAtUnix: 1,
      paidMediaPermitted: true,
    }
    await store.put(clear)
    await store.put({ ...clear, verdict: 'RESTRICTED', flags: ['lexicon:slur'], paidMediaPermitted: false, screenedAtUnix: 2, note: 'x' })
    const latest = await store.latest(TOKEN)
    expect(latest?.verdict).toBe('RESTRICTED')
    expect(latest?.flags).toEqual(['lexicon:slur'])
    expect(latest?.stagesRun).toEqual(['lexicon', 'trademark'])
    expect(latest?.note).toBe('x')

    await expect(store.put({ ...clear, verdict: 'BLOCKED', screenedAtUnix: 3 })).rejects.toBeInstanceOf(SourceUnavailableError)
    // The refused write rolled back whole: the previous current row still governs.
    expect((await store.latest(TOKEN))?.screenedAtUnix).toBe(2)
  })
})

describe('PgReceiptStore', () => {
  it('hides embargoed receipts by default and is idempotent on id', async () => {
    const store = new PgReceiptStore(pg.driver, () => 1_000)
    const receipt: Receipt = {
      id: 'r1',
      vault: VAULT,
      kind: 'procurement',
      amountUsd: 12.5,
      description: 'trending placement',
      publishAfterUnix: 2_000,
      occurredAtUnix: 500,
      evidenceUri: 'https://example.invalid/e',
    }
    await store.put(receipt)
    await store.put({ ...receipt, description: 'retry with a different body' })
    expect((await store.get('r1'))?.description).toBe('trending placement')
    expect(await store.list(VAULT)).toEqual([])
    expect((await store.list(VAULT, { nowUnix: 2_000 })).map((r) => r.id)).toEqual(['r1'])
    expect((await store.list(VAULT, { publishedOnly: false, toUnix: 499 })).length).toBe(0)
    const all = await store.list(VAULT, { publishedOnly: false })
    expect(all[0]?.disbursementId).toBeUndefined()
    expect(all[0]?.amountUsd).toBe(12.5)
  })
})

describe('PgApprovalStore', () => {
  it('finds an approval only under its own vault and digest', async () => {
    const store = new PgApprovalStore(pg.driver)
    await store.put(VAULT, { approver: 'ops@example', approvedAtUnix: 10, decisionDigest: 'd1' })
    expect((await store.find(VAULT.toLowerCase(), 'd1'))?.approver).toBe('ops@example')
    expect(await store.find(VAULT, 'd2')).toBeUndefined()
    expect(await store.find(CURVE, 'd1')).toBeUndefined()
  })
})

function invoice(hash: string, overrides: Partial<VendorInvoice> = {}): VendorInvoice {
  return {
    vendorId: 'dexscreener',
    skuId: 'boost-10',
    quantity: 1,
    amountUsd: 99,
    invoiceHash: hash,
    vendorCountersig: 'sig',
    issuedAtUnix: 100,
    ...overrides,
  }
}

describe('PgInvoiceRegistry', () => {
  const H1 = '0x' + '11'.repeat(32)
  const H2 = '0x' + '22'.repeat(32)

  it('refuses a duplicate hash, a malformed hash, and an unknown settlement', async () => {
    const registry = new PgInvoiceRegistry(pg.driver, () => 500)
    await registry.put(VAULT, invoice(H1))
    await expect(registry.put(VAULT, invoice(H1, { amountUsd: 1 }))).rejects.toBeInstanceOf(InvoiceConflictError)
    await expect(registry.put(VAULT, invoice('0x' + 'ZZ'.repeat(32)))).rejects.toThrow(TypeError)
    await expect(registry.markSettled(VAULT, H2, '0xtx')).rejects.toBeInstanceOf(InvoiceUnknownError)
  })

  it('finds only unsettled invoices, oldest first, and settles exactly once', async () => {
    const registry = new PgInvoiceRegistry(pg.driver, () => 500)
    await registry.put(VAULT, invoice(H2, { issuedAtUnix: 50 }))
    expect((await registry.find(VAULT, 'boost-10', 1, 500))?.invoiceHash).toBe(H2)
    expect(await registry.find(VAULT, 'boost-10', 2, 500)).toBeUndefined()

    await registry.markSettled(VAULT, H2, '0xtx1')
    await registry.markSettled(VAULT, H2, '0xtx1')
    await expect(registry.markSettled(VAULT, H2, '0xtx2')).rejects.toBeInstanceOf(InvoiceConflictError)
    expect((await registry.listPending(VAULT)).map((i) => i.invoiceHash)).toEqual([H1])
    expect((await registry.find(VAULT, 'boost-10', 1, 500))?.invoiceHash).toBe(H1)
  })
})

describe('PgAccountRegistry', () => {
  it('binds an account, keys case-insensitively and puts the coin on the roster', async () => {
    const registry = new PgAccountRegistry(pg.driver)
    const binding: AccountBinding = {
      accountId: 'AcctOne',
      channel: 'x_operator',
      coinRef: 'coin-a',
      vault: VAULT,
      token: TOKEN,
      ticker: 'abc',
      delegated: false,
    }
    await registry.bind(binding)
    expect((await registry.get('x_operator', 'acctone'))?.coinRef).toBe('coin-a')
    expect(await registry.get('telegram', 'acctone')).toBeNull()
    expect((await registry.roster()).map((r) => r.ticker)).toEqual(['abc'])
    await registry.addRosterEntry({ ticker: 'ABC', vault: VAULT, token: TOKEN })
    expect((await registry.roster()).length).toBe(1)
    await registry.unbind('x_operator', 'ACCTONE')
    expect(await registry.get('x_operator', 'AcctOne')).toBeNull()
  })
})

describe('PgPostRegistry', () => {
  it('lists posts awaiting read-back and stops listing them once one is recorded', async () => {
    const registry = new PgPostRegistry(pg.driver)
    const record: PostRecord = {
      externalId: 'post-1',
      vault: VAULT,
      channel: 'x_operator',
      accountId: 'acctone',
      correlationId: 'c1',
      publishedAtUnix: 1_000,
      isPromotional: true,
      classificationRules: ['promo:ticker'],
      disclosure: { operatorName: 'Op', receiptUrl: 'https://example.invalid/r', paidPromotion: true },
      requiredTokens: ['#ad', 'Op'],
      publishedTextHash: 'h',
      bodyTruncated: false,
      approvedBy: 'ops',
    }
    await registry.put(record)
    await registry.put({ ...record, externalId: 'post-2', publishedAtUnix: 5_000 })
    expect((await registry.awaitingReadBack(2_000)).map((p) => p.externalId)).toEqual(['post-1'])
    expect(await registry.get('post-1')).toEqual(record)

    await registry.setReadBack('post-1', { externalId: 'post-1', verifiedAtUnix: 1_500, ok: false, missing: ['#ad'], deleted: true })
    expect(await registry.awaitingReadBack(10_000)).toHaveLength(1)
    const verified = await registry.get('post-1')
    expect(verified?.readBack).toEqual({ externalId: 'post-1', verifiedAtUnix: 1_500, ok: false, missing: ['#ad'], deleted: true })
    const [row] = await pg.driver.query<{ read_back_verified: boolean; deleted_at_unix: unknown }>(
      'SELECT read_back_verified, deleted_at_unix FROM publication WHERE id = $1',
      ['post-1'],
    )
    expect(row).toMatchObject({ read_back_verified: false, deleted_at_unix: 1_500 })
  })
})

describe('PgAccountCredentialStore', () => {
  it('refuses to construct without a proper key', () => {
    expect(() => new PgAccountCredentialStore(pg.driver, '')).toThrow(TypeError)
    expect(() => new PgAccountCredentialStore(pg.driver, 'abcd')).toThrow(TypeError)
  })

  it('seals at rest and refuses to open under a different key', async () => {
    const store = new PgAccountCredentialStore(pg.driver, KEY)
    const creds = { accessToken: 'tok-secret', refreshToken: 'ref-secret', expiresAtUnix: 9_000, scopes: ['tweet.write'] }
    await store.put('acct-1', creds)
    expect(await store.get('acct-1')).toEqual(creds)
    expect(await store.get('acct-none')).toBeNull()

    const [row] = await pg.driver.query<{ sealed: string }>('SELECT sealed FROM publisher_account_credential WHERE account_id = $1', [
      'acct-1',
    ])
    expect(row?.sealed).not.toContain('tok-secret')
    expect(row?.sealed).not.toContain(Buffer.from('tok-secret').toString('base64url'))

    const wrong = new PgAccountCredentialStore(pg.driver, OTHER_KEY)
    await expect(wrong.get('acct-1')).rejects.toBeInstanceOf(SecretUnopenableError)
  })

  it('refuses a blob whose ciphertext was altered', async () => {
    const store = new PgAccountCredentialStore(pg.driver, KEY)
    const [row] = await pg.driver.query<{ sealed: string }>('SELECT sealed FROM publisher_account_credential WHERE account_id = $1', [
      'acct-1',
    ])
    const parts = row!.sealed.split('.')
    const body = Buffer.from(parts[3]!, 'base64url')
    body[0] = body[0]! ^ 0xff
    parts[3] = body.toString('base64url')
    await pg.driver.execute('UPDATE publisher_account_credential SET sealed = $2 WHERE account_id = $1', ['acct-1', parts.join('.')])
    await expect(store.get('acct-1')).rejects.toMatchObject({ reason: 'auth_failed' })
  })
})

describe('PgLabelAttestationStore', () => {
  it('round-trips and refuses an attestation that expires before it was made', async () => {
    const store = new PgLabelAttestationStore(pg.driver)
    await store.put({ accountId: 'acct-1', attestedBy: 'ops', attestedAtUnix: 10, expiresAtUnix: 20 })
    expect((await store.get('acct-1'))?.expiresAtUnix).toBe(20)
    await expect(
      store.put({ accountId: 'acct-2', attestedBy: 'ops', attestedAtUnix: 20, expiresAtUnix: 10 }),
    ).rejects.toBeInstanceOf(SourceUnavailableError)
    expect(await store.get('acct-2')).toBeNull()
  })
})

describe('PgImageAssetStore', () => {
  function asset(coinRef: string, bytes: Uint8Array): ImageAsset {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    return { id: imageAssetId(coinRef, 'card', sha256), coinRef, kind: 'card', mime: 'image/png', width: 1200, height: 675, sha256, bytes }
  }

  it('stores bytes intact, dedupes on content, and refuses a mislabelled hash', async () => {
    const store = new PgImageAssetStore(pg.driver)
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10])
    const a = asset('coin-a', bytes)
    await store.put(a)
    await store.put(a)
    const stored = await store.get(a.id)
    expect(stored?.bytes).toEqual(bytes)
    expect(stored?.width).toBe(1200)
    expect(await store.list('coin-a')).toEqual([{ id: a.id, kind: 'card' }])
    expect(await store.list('coin-b')).toEqual([])

    await expect(store.put({ ...a, sha256: 'ff'.repeat(32) })).rejects.toThrow(TypeError)
  })
})

describe('pgLedgerDriver', () => {
  it('rewrites ? placeholders positionally', () => {
    expect(toPositionalParams('SELECT * FROM t WHERE a = ? AND b = ?')).toBe('SELECT * FROM t WHERE a = $1 AND b = $2')
  })

  it('runs SqlLedgerStore on Postgres: append, dedupe, balances, freeze', async () => {
    const store = new SqlLedgerStore(pgLedgerDriver(pg.driver))
    const entry = {
      id: 'e1',
      vault: VAULT.toLowerCase(),
      asset: USDG,
      debit: 'asset:escrow' as const,
      credit: 'income:fees' as const,
      amountMinor: 12_345_678_901_234_567_890n,
      occurredAtUnix: 1_700_000_000,
      source: 'curve_event' as const,
    }
    const first = await store.appendWrite({ entries: [entry] })
    const again = await store.appendWrite({ entries: [entry] })
    expect(first.inserted).toBe(1)
    expect(again.duplicates).toBe(1)
    expect((await store.getEntry('e1'))?.amountMinor).toBe(12_345_678_901_234_567_890n)
    const balances = await store.listAccountBalances({ vault: VAULT.toLowerCase() })
    expect(balances.find((b) => b.account === 'income:fees')?.balanceMinor).toBe(-12_345_678_901_234_567_890n)

    await store.putFreeze({ id: 'f1', scope: { kind: 'vault', vault: VAULT.toLowerCase() }, reason: 'variance', frozenAtUnix: 1 })
    expect((await store.listFreezes(true)).map((f) => f.id)).toEqual(['f1'])
    await store.clearFreeze('f1', 2, 'ops')
    expect(await store.listFreezes(true)).toEqual([])
  })
})

describe('PgVaultMovementStore', () => {
  it('round-trips the four Credited legs and refuses a negative referrer leg', async () => {
    const store = new PgVaultMovementStore(pg.driver)
    const allocation = {
      id: `${HASH_B}:0`,
      blockNumber: 500n,
      vault: VAULT.toLowerCase(),
      asset: USDG,
      devMinor: 700_000n,
      budgetMinor: 200_000n,
      operatorMinor: 80_000n,
      referrerMinor: 20_000n,
      occurredAtUnix: 1_700_000_500,
      txHash: HASH_B,
      logIndex: 0,
    }
    expect(await store.putAllocations([allocation])).toBe(1)
    expect(await store.putAllocations([allocation])).toBe(0)
    const rows = await store.allocations(VAULT, 1_700_000_500, 1_700_000_500)
    expect(rows).toEqual([
      {
        vault: VAULT.toLowerCase(),
        asset: USDG,
        devMinor: 700_000n,
        budgetMinor: 200_000n,
        operatorMinor: 80_000n,
        referrerMinor: 20_000n,
        occurredAtUnix: 1_700_000_500,
        txHash: HASH_B,
        logIndex: 0,
      },
    ])
    await expect(
      store.putAllocations([{ ...allocation, id: `${HASH_B}:1`, logIndex: 1, referrerMinor: -1n }]),
    ).rejects.toThrow(SourceUnavailableError)
  })
})

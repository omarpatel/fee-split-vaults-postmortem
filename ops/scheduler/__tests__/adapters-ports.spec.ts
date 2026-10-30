/**
 * The real ops ports, against a real Postgres (pglite) and the in-memory
 * chain/price fakes. Each test is a refusal or a state change a job depends
 * on: a fake that returned a default here would let a job report success over
 * nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Asset, Vault } from '@fee-split-vaults/core'
import { Ledger, SqlLedgerStore } from '@fee-split-vaults/ledger'
import { pgLedgerDriver, PgVaultRepository } from '@fee-split-vaults/adapters'
import { InMemoryAssetRegistry, InMemoryChainReadModel, InMemoryPriceBook } from '@fee-split-vaults/orchestrator'
import type { CoinBinding, FeePosting } from '@fee-split-vaults/indexer'
import { PgAlertLog, LoggedAlertSink, WebhookAlertSink } from '../adapters/alerts.js'
import { PgVaultDirectory } from '../adapters/directory.js'
import { OpsAdapterError } from '../adapters/errors.js'
import { SqlLedgerOps } from '../adapters/ledger-ops.js'
import { IndexerQfSource } from '../adapters/qf.js'
import { TelegramReportDelivery } from '../adapters/report-delivery.js'
import { openMigratedDb, type MigratedDb } from '../adapters/__tests__/pglite.js'
import type { OpsAlert, SweepReceipt } from '../ports.js'

const NOW = 1_757_000_000
const VAULT = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const TX = `0x${'ab'.repeat(32)}` as const
const BLOCK = `0x${'cd'.repeat(32)}` as const
const clock = { nowUnix: () => NOW }

const vault: Vault = {
  address: VAULT,
  token: TOKEN,
  consent: {
    devSigner: '0x3333333333333333333333333333333333333333',
    devPayout: '0x4444444444444444444444444444444444444444',
    token: TOKEN,
    termsHash: `0x${'00'.repeat(32)}`,
    operatorBps: 500,
    budgetBpsMax: 5000,
    adapter: '0x5555555555555555555555555555555555555555',
    referrer: '0x0000000000000000000000000000000000000000',
    referrerBps: 0,
    expiryUnix: NOW + 86_400,
    nonce: '1',
  },
  state: 'ACTIVE',
  tier: 'T1',
  budgetBps: 2000,
  buybackEnabled: false,
  creatorTaxBps: 0,
  deployedAtUnix: NOW - 30 * 86_400,
}

const usdg: Asset = { address: USDG, symbol: 'USDG', decimals: 6, isPausableProxy: true, enabled: true }

const binding: CoinBinding = {
  token: TOKEN,
  vault: VAULT,
  curve: '0x6666666666666666666666666666666666666666',
  quoteAsset: USDG,
  launchedAtUnix: NOW - 30 * 86_400,
  launchBlockNumber: 1n,
  buybackEnabled: false,
  creatorTaxBps: 0,
  coverageStartUnix: NOW - 30 * 86_400,
}

function posting(dayAgo: number, credited: bigint): FeePosting {
  return {
    id: `${TX}:${dayAgo}`,
    vault: VAULT,
    token: TOKEN,
    asset: USDG,
    creditedMinor: credited,
    grossFeeMinor: credited,
    derivation: 'explicit',
    volumeMinor: credited * 100n,
    source: 'pool_fees_swept',
    phase: 'post_graduation',
    classification: 'trade',
    side: 'sweep',
    blockNumber: BigInt(100 - dayAgo),
    blockHash: BLOCK,
    txHash: TX,
    logIndex: dayAgo,
    occurredAtUnix: NOW - dayAgo * 86_400 - 3600,
    finalized: true,
  }
}

let db: MigratedDb

beforeEach(async () => {
  db = await openMigratedDb(NOW)
})

afterEach(async () => {
  await db.db.close()
})

describe('PgVaultDirectory', () => {
  it('refuses a vault with no record and projects the consent terms of one that has', async () => {
    const repo = new PgVaultRepository(db.driver)
    const directory = new PgVaultDirectory(repo)
    expect(await directory.get(VAULT)).toBeUndefined()
    expect(await directory.listByState(['ACTIVE'])).toEqual([])

    await repo.put(vault)
    const ref = await directory.get(VAULT)
    expect(ref?.operatorBps).toBe(500)
    expect(ref?.devPayout).toBe(vault.consent.devPayout)
    expect(ref).not.toHaveProperty('consent')
    expect((await directory.listByState(['ACTIVE'])).map((v) => v.address)).toEqual([VAULT])
  })
})

describe('SqlLedgerOps', () => {
  function ops(chain: InMemoryChainReadModel, usd?: (minor: bigint) => number | undefined): { ops: SqlLedgerOps; store: SqlLedgerStore } {
    const store = new SqlLedgerStore(pgLedgerDriver(db.driver))
    const ledger = new Ledger(store, { now: () => NOW })
    return {
      ops: new SqlLedgerOps({ driver: db.driver, store, ledger, chain, usdOf: (_a, minor) => (usd ?? (() => 1))(minor), clock, matchGraceSeconds: 0 }),
      store,
    }
  }

  const receipt: SweepReceipt = {
    sweepId: 'sw_1',
    runKey: 'escrow.sweep|0x1111|p1',
    vault: VAULT,
    asset: USDG,
    claimedMinor: 1_000_000n,
    chunks: 1,
    txHashes: [TX],
    blockHash: BLOCK,
    completedAtUnix: NOW - 600,
  }

  it('freezes the vault when the chain received less than the executor claimed', async () => {
    const chain = new InMemoryChainReadModel()
    chain.putPostings(posting(0, 1_000_000n))
    // The chain scan saw a claim short by 20%: critical, and a critical
    // variance freezes the scope through the ledger facade.
    chain.putClaim({ vault: VAULT, asset: USDG, amountMinor: 800_000n, occurredAtUnix: NOW - 500, txHash: TX, logIndex: 0, blockHash: BLOCK })
    const { ops: ledgerOps, store } = ops(chain)
    await ledgerOps.recordSweep(receipt)
    await ledgerOps.recordSweep(receipt)
    expect(await ledgerOps.unmatchedSweeps(10)).toEqual([{ sweepId: 'sw_1', vault: VAULT, sweptAtUnix: NOW - 600 }])

    const report = await ledgerOps.threeWayMatch({ sweepId: 'sw_1' })
    expect(report.matched).toBe(false)
    expect(report.missingLegs).toEqual(['ledger_recognized'])
    expect(report.worstSeverity).toBe('critical')
    expect(report.varianceIds.length).toBeGreaterThan(0)
    const freezes = await store.listFreezes(true)
    expect(freezes.some((f) => f.scope.kind === 'vault_asset' && f.scope.vault === VAULT)).toBe(true)
    expect(await ledgerOps.unmatchedSweeps(10)).toEqual([])
  })

  it('freezeAuthorizations records one live freeze per cause and refreezes after clearance', async () => {
    const { ops: ledgerOps, store } = ops(new InMemoryChainReadModel())
    await ledgerOps.freezeAuthorizations({ scope: VAULT, reason: 'structural invariant balanced' })
    await ledgerOps.freezeAuthorizations({ scope: VAULT, reason: 'structural invariant balanced' })
    const active = await store.listFreezes(true)
    expect(active).toHaveLength(1)
    await store.clearFreeze(active[0]!.id, NOW + 1, 'operator')
    await ledgerOps.freezeAuthorizations({ scope: VAULT, reason: 'structural invariant balanced' })
    expect(await store.listFreezes(true)).toHaveLength(1)
    expect(await store.listFreezes(false)).toHaveLength(2)
  })
})

describe('IndexerQfSource', () => {
  it('refuses a vault without a record, a token without a binding, and a posting without a price', async () => {
    const repo = new PgVaultRepository(db.driver)
    const chain = new InMemoryChainReadModel()
    const prices = new InMemoryPriceBook()
    const source = new IndexerQfSource({ chain, vaults: repo, assets: new InMemoryAssetRegistry([usdg]), prices })

    await expect(source.measure(VAULT, NOW)).rejects.toMatchObject({ code: 'vault_unknown' })
    await repo.put(vault)
    await expect(source.measure(VAULT, NOW)).rejects.toMatchObject({ code: 'binding_unknown' })
    chain.putBinding(binding)
    chain.putPostings(posting(1, 5_000_000n))
    await expect(source.measure(VAULT, NOW)).rejects.toMatchObject({ code: 'price_missing' })
    await expect(source.signals(VAULT, NOW)).rejects.toMatchObject({ code: 'signals_unavailable' })

    prices.pin({ asset: USDG, centsPerWholeUnit: 100n, source: 'test', pricedAtUnix: NOW - 2 * 86_400 })
    const qf = await source.measure(VAULT, NOW)
    expect(qf.vault).toBe(VAULT)
    expect(qf.perAsset[0]?.creditedMinor).toBe(5_000_000n)
  })
})

describe('alerts', () => {
  const alert: OpsAlert = {
    alertId: 'dead_letter_backlog',
    severity: 'ticket',
    scope: 'fleet',
    summary: '7 unresolved dead letters',
    runbook: 'ops/runbooks/ledger-variance-critical.md',
    facts: { open: 7 },
    raisedAtUnix: NOW,
  }

  it('records the firing before posting, refreshes an open firing, and fails closed on a bad webhook', async () => {
    const posted: Array<{ url: string; body: string }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      posted.push({ url: String(url), body: String(init?.body) })
      return new Response('ok', { status: 200 })
    }) as typeof fetch
    const log = new PgAlertLog(db.driver)
    const sink = new LoggedAlertSink(log, new WebhookAlertSink({ url: 'https://alerts.example/hook', fetchImpl }), 'job')

    await sink.raise(alert)
    await sink.raise({ ...alert, raisedAtUnix: NOW + 60, summary: '9 unresolved dead letters' })
    expect(posted).toHaveLength(2)
    expect(JSON.parse(posted[0]!.body)).toMatchObject({ alert_id: 'dead_letter_backlog', scope: 'fleet' })
    const rows = await db.driver.query<{ summary: string; raised_by: string; fired_at_unix: string | number }>(
      'SELECT summary, raised_by, fired_at_unix FROM ops_alert_firing WHERE cleared_at_unix IS NULL',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ summary: '9 unresolved dead letters', raised_by: 'job' })
    expect(Number(rows[0]!.fired_at_unix)).toBe(NOW + 60)

    expect(await log.clearResolved('job', new Set(), NOW + 120)).toBe(1)
    expect(await log.openCount()).toBe(0)

    const failing = new WebhookAlertSink({
      url: 'https://alerts.example/hook',
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    })
    await expect(failing.raise(alert)).rejects.toMatchObject({ code: 'webhook_failed' })
    expect(() => new WebhookAlertSink({ url: 'http://alerts.example/hook' })).toThrow(OpsAdapterError)
  })
})

describe('TelegramReportDelivery', () => {
  const report = {
    vault: VAULT,
    periodStartUnix: NOW - 7 * 86_400,
    periodEndUnix: NOW,
    qfReceivedUsd: 12.5,
    devLegUsd: 10,
    budgetSpentUsd: 0,
    operatorFeeUsd: 0.62,
    referrerFeeUsd: 0,
    lineItems: [],
    verifiedReachSummary: 'none',
    withheldPayments: [],
    whatWeDidNotDo: ['No paid promotion was purchased this period.'],
  }

  it('refuses an unbound chat and a placeholder operator, and sends once per period with disclosure', async () => {
    const sent: Array<{ chatId: string; text: string }> = []
    const transport = {
      sendMessage: async (req: { chatId: string; text: string }) => {
        sent.push(req)
        return { messageId: sent.length }
      },
    }
    const base = { driver: db.driver, transport, receiptsBaseUrl: 'https://receipts.example', clock }

    const unbound = new TelegramReportDelivery({ ...base, chatFor: () => undefined, operatorName: 'Acme Ops' })
    await expect(unbound.deliver(report)).rejects.toMatchObject({ code: 'chat_unbound' })

    const unnamed = new TelegramReportDelivery({ ...base, chatFor: () => '-100', operatorName: 'SET_ME_BEFORE_LAUNCH' })
    await expect(unnamed.deliver(report)).rejects.toMatchObject({ code: 'operator_unnamed' })
    expect(sent).toHaveLength(0)

    const delivery = new TelegramReportDelivery({ ...base, chatFor: () => '-100', operatorName: 'Acme Ops' })
    const first = await delivery.deliver(report)
    expect(first).toEqual({ delivered: true, channel: 'telegram', externalId: '-100:1' })
    expect(sent[0]?.text).toContain('AI-operated by Acme Ops')
    expect(sent[0]?.text).toContain(`receipts: https://receipts.example/${VAULT}`)
    expect(sent[0]?.text).toContain('What we did not do')

    const again = await delivery.deliver(report)
    expect(again.externalId).toBe('-100:1')
    expect(sent).toHaveLength(1)
  })
})

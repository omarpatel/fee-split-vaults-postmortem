/**
 * The publishing account health log against the real 0021 DDL: append-only,
 * newest row wins, keys the way the binding registry keys, and the CHECKs
 * refuse what the type does not admit.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SourceUnavailableError } from '../errors.js'
import { PgChannelHealthStore } from '../pg/publisher-health.js'
import { migratedPglite, type MigratedPglite } from './pglite.js'

const NOW = 1_757_000_000
let pg: MigratedPglite

beforeAll(async () => {
  pg = await migratedPglite()
}, 120_000)

afterAll(async () => {
  await pg.close()
})

describe('PgChannelHealthStore', () => {
  it('returns null for an account nothing has probed, then the newest row once probed', async () => {
    const store = new PgChannelHealthStore(pg.driver)
    expect(await store.get('x_operator', '100200300')).toBeNull()

    await store.put({ channel: 'x_operator', accountId: '100200300', status: 'ok', observedAtUnix: NOW - 7200, detail: '200 users/me' })
    await store.put({ channel: 'x_operator', accountId: '100200300', status: 'suspended', observedAtUnix: NOW, detail: '403 about:blank | suspended' })
    expect(await store.get('x_operator', '100200300')).toEqual({
      channel: 'x_operator',
      accountId: '100200300',
      status: 'suspended',
      observedAtUnix: NOW,
      detail: '403 about:blank | suspended',
    })
    // History is kept: both rows are there, and the ok is still the older one.
    const rows = await pg.driver.query<{ status: string }>(
      `SELECT status FROM publisher_account_health WHERE account_id = '100200300' ORDER BY observed_at_unix`,
    )
    expect(rows.map((r) => r.status)).toEqual(['ok', 'suspended'])
  })

  it('keys by channel and lowercased account id, like the binding registry', async () => {
    const store = new PgChannelHealthStore(pg.driver)
    await store.put({ channel: 'x_client_delegated', accountId: 'DevAcct', status: 'ok', observedAtUnix: NOW, detail: '200' })
    expect(await store.get('x_client_delegated', 'devacct')).toMatchObject({ accountId: 'devacct', status: 'ok' })
    expect(await store.get('x_operator', 'devacct')).toBeNull()
  })

  it('bounds the detail rather than failing the row', async () => {
    const store = new PgChannelHealthStore(pg.driver)
    await store.put({ channel: 'x_operator', accountId: 'long', status: 'locked', observedAtUnix: NOW, detail: 'y'.repeat(2000) })
    expect((await store.get('x_operator', 'long'))?.detail.length).toBe(240)
  })

  it('refuses a status the schema does not know as a typed source failure', async () => {
    const store = new PgChannelHealthStore(pg.driver)
    await expect(
      store.put({ channel: 'x_operator', accountId: 'bad', status: 'banned' as never, observedAtUnix: NOW, detail: '' }),
    ).rejects.toBeInstanceOf(SourceUnavailableError)
  })
})

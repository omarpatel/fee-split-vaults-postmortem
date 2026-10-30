/**
 * The one test that matters here is `an unreachable database never reads as 0`.
 *
 * Everything else in this file is scaffolding around it. These counters are
 * spend caps: `disbursementsToday` reads low and the fleet-wide daily cap opens,
 * `vendorSpendTodayCents` reads low and one vendor's cap across the entire
 * client book opens, `relatedPartySpend30dCents` reads low and the related-party
 * limit opens. A metric that fails to zero is a bad graph; a cap that fails to
 * zero authorises spending on every coin at once.
 */

import { describe, expect, it } from 'vitest'
import { CounterUnavailableError } from '../errors.js'
import { PgFleetCounters, dayKey } from '../pg/counters.js'
import { RecordingSqlDriver } from './harness.js'

const VAULT = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01'
const NOW = 1_757_000_000

describe('PgFleetCounters fails closed', () => {
  const reads: Array<[string, (counters: PgFleetCounters) => Promise<number | bigint>]> = [
    ['disbursementsToday', (c) => c.disbursementsToday(NOW)],
    ['disbursementsTodayForVault', (c) => c.disbursementsTodayForVault(VAULT, NOW)],
    ['vendorSpendTodayCents', (c) => c.vendorSpendTodayCents('vendor-1', NOW)],
    ['vendorDisbursementsTodayForVault', (c) => c.vendorDisbursementsTodayForVault(VAULT, 'vendor-1', NOW)],
    ['proposalsLastHour', (c) => c.proposalsLastHour(VAULT, NOW)],
    ['relatedPartySpend30dCents', (c) => c.relatedPartySpend30dCents(VAULT, NOW)],
  ]

  it('categorySpend30dCents throws rather than returning an empty breakdown', async () => {
    const driver = new RecordingSqlDriver()
    driver.unavailable = true
    const counters = new PgFleetCounters(driver)

    // An empty map is this read's version of a zero: every sub-cap would then
    // measure the next purchase as the first one in its category, which is
    // exactly the inert gate the category column was added to end.
    await expect(counters.categorySpend30dCents(VAULT, NOW)).rejects.toBeInstanceOf(
      CounterUnavailableError,
    )
  })

  for (const [name, read] of reads) {
    it(`${name} throws rather than returning 0 when the database is unreachable`, async () => {
      const driver = new RecordingSqlDriver()
      driver.unavailable = true
      const counters = new PgFleetCounters(driver)

      // Not `resolves.toBe(0)`. Not a swallowed error. A throw.
      await expect(read(counters)).rejects.toBeInstanceOf(CounterUnavailableError)
      await expect(read(counters)).rejects.toThrow(/would open every cap/)
    })
  }

  it('a write that fails is as loud as a read that fails', async () => {
    const driver = new RecordingSqlDriver()
    driver.unavailable = true
    const counters = new PgFleetCounters(driver)

    // A disbursement that landed on chain but was never counted is spend no cap
    // ever sees again.
    await expect(
      counters.recordDisbursement({
        vault: VAULT,
        vendorId: 'vendor-1',
        amountCents: 1_000n,
        isRelatedParty: false,
        category: 'listing',
        atUnix: NOW,
      }),
    ).rejects.toBeInstanceOf(CounterUnavailableError)
    await expect(counters.recordProposal(VAULT, NOW)).rejects.toBeInstanceOf(CounterUnavailableError)
  })

  it('distinguishes "I asked and nothing happened" from "I could not ask"', async () => {
    const driver = new RecordingSqlDriver()
    // A successful query that matched no rows. This IS zero, and saying so is
    // correct - it is the unreachable case above that must not say it.
    driver.defaultRows = [{ n: '0' }]
    const counters = new PgFleetCounters(driver)
    await expect(counters.disbursementsToday(NOW)).resolves.toBe(0)

    driver.defaultRows = [{ cents: '0' }]
    await expect(counters.vendorSpendTodayCents('vendor-1', NOW)).resolves.toBe(0n)
  })
})

describe('PgFleetCounters binds the parameters the caps depend on', () => {
  it('buckets days as floor(unix / 86400), matching the in-memory counters', async () => {
    const driver = new RecordingSqlDriver()
    driver.defaultRows = [{ n: '3' }]
    const counters = new PgFleetCounters(driver)

    await counters.disbursementsToday(NOW)
    expect(driver.last().params).toEqual([dayKey(NOW)])
    expect(dayKey(NOW)).toBe(Math.floor(NOW / 86_400))

    // The boundary is UTC midnight, not the database server's midnight.
    const midnight = dayKey(NOW) * 86_400
    expect(dayKey(midnight)).toBe(dayKey(NOW))
    expect(dayKey(midnight - 1)).toBe(dayKey(NOW) - 1)
  })

  it('lowercases the vault, so checksum casing cannot split a cap in two', async () => {
    const driver = new RecordingSqlDriver()
    driver.defaultRows = [{ n: '1' }]
    const counters = new PgFleetCounters(driver)

    await counters.disbursementsTodayForVault(VAULT, NOW)
    expect(driver.last().params[0]).toBe(VAULT.toLowerCase())
  })

  it('reads the hourly proposal window as strictly greater than now - 3600', async () => {
    const driver = new RecordingSqlDriver()
    driver.defaultRows = [{ n: '0' }]
    const counters = new PgFleetCounters(driver)

    await counters.proposalsLastHour(VAULT, NOW)
    expect(driver.lastSql()).toContain('at_unix > $2')
    expect(driver.last().params[1]).toBe(NOW - 3_600)
  })

  it('reads related-party spend over a rolling 30 days, related-party rows only', async () => {
    const driver = new RecordingSqlDriver()
    driver.defaultRows = [{ cents: '250' }]
    const counters = new PgFleetCounters(driver)

    await counters.relatedPartySpend30dCents(VAULT, NOW)
    expect(driver.lastSql()).toContain('is_related_party')
    expect(driver.last().params[1]).toBe(NOW - 30 * 86_400)
  })

  it('groups the category breakdown in ONE query over a rolling 30 days', async () => {
    const driver = new RecordingSqlDriver()
    driver.defaultRows = [
      { category: 'listing', cents: '40000' },
      { category: 'kol', cents: '5000' },
    ]
    const counters = new PgFleetCounters(driver)

    const totals = await counters.categorySpend30dCents(VAULT, NOW)
    expect(totals).toEqual({ listing: 40_000n, kol: 5_000n })

    // GROUPED, not seven separate reads. The same gate sums these against the
    // procurement budget, so a category a caller forgot to ask for would be an
    // under-count of that total - and an under-counted spend figure opens a cap.
    expect(driver.lastSql()).toContain('GROUP BY category')
    expect(driver.last().params).toEqual([VAULT.toLowerCase(), NOW - 30 * 86_400])
  })

  it('refuses a category it does not recognise rather than dropping the row', async () => {
    const driver = new RecordingSqlDriver()
    driver.defaultRows = [
      { category: 'listing', cents: '1000' },
      { category: 'a_category_this_build_has_never_heard_of', cents: '999999' },
    ]
    const counters = new PgFleetCounters(driver)

    // Dropping it would silently remove real spend from the total the
    // procurement-budget check reads. There is no way to attribute it to a cap,
    // so the counter refuses instead of reporting a number it knows is short.
    await expect(counters.categorySpend30dCents(VAULT, NOW)).rejects.toThrow(
      /unrecognised category/,
    )
  })

  it('writes cents as an exact integer string and stores the day key beside it', async () => {
    const driver = new RecordingSqlDriver()
    const counters = new PgFleetCounters(driver)

    await counters.recordDisbursement({
      vault: VAULT,
      vendorId: 'vendor-1',
      amountCents: 9_007_199_254_740_993n, // 2^53 + 1: unrepresentable as a double
      isRelatedParty: true,
      category: 'listing',
      atUnix: NOW,
    })

    const params = driver.last().params
    expect(params[2]).toBe('vendor-1')
    // The category rides along on the same row the caps are counted from, so a
    // disbursement can never be counted for a cap under one category and
    // priced under another.
    expect(driver.lastSql()).toContain('category')
    expect(params[5]).toBe('listing')
    expect(params[3]).toBe('9007199254740993')
    expect(params[4]).toBe(true)
    expect(params[6]).toBe(NOW)
    expect(params[7]).toBe(dayKey(NOW))
  })
})

describe('cent totals survive the driver boundary', () => {
  it('reads a sum above 2^53 without rounding it', async () => {
    const driver = new RecordingSqlDriver()
    // `pg` hands BIGINT and NUMERIC back as strings precisely because they do
    // not fit in a double. Number() here would silently round.
    driver.defaultRows = [{ cents: '9007199254740993' }]
    const counters = new PgFleetCounters(driver)

    await expect(counters.vendorSpendTodayCents('vendor-1', NOW)).resolves.toBe(9_007_199_254_740_993n)
  })

  it('refuses a column that is not an integer literal rather than coercing it', async () => {
    const driver = new RecordingSqlDriver()
    driver.defaultRows = [{ cents: '12.5' }]
    const counters = new PgFleetCounters(driver)

    await expect(counters.vendorSpendTodayCents('vendor-1', NOW)).rejects.toThrow(/not an integer literal/)
  })
})

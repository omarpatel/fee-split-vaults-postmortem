/**
 * Fleet spend counters over Postgres.
 *
 * THESE ARE SPEND GATES, NOT METRICS. Every read here is an input to a cap the
 * broker enforces: the fleet-wide daily disbursement count, one vendor's spend
 * across the whole client book, a vault's proposal rate, thirty days of
 * related-party spend. A metric that reads low when the database is down is an
 * annoyance. A CAP that reads low when the database is down is an open cap, on
 * every coin at once, for as long as the outage lasts.
 *
 * So there is exactly one rule in this file and it is enforced in every method:
 * a query that throws becomes a `CounterUnavailableError`. It never becomes 0
 * and never becomes an empty result. `InMemoryFleetCounters` says the same
 * thing in its own doc block - "a counter store that is unreachable must throw
 * rather than return zero: the broker treats a stale counter as unknown and
 * unknown means no spend, but a confident zero would open every cap" - and this
 * is the implementation that has to actually hold it, because this is the one
 * with a network between it and its data.
 *
 * A SUCCESSFUL QUERY THAT MATCHES NO ROWS IS GENUINELY ZERO. That is the
 * distinction: "I asked and nothing has happened today" is a real answer, and
 * it is the answer this returns. "I could not ask" is not, and it throws.
 *
 * DAY BOUNDARIES MATCH THE IN-MEMORY IMPLEMENTATION EXACTLY: floor(unix/86400),
 * a UTC day index, computed in TypeScript and stored on the row. Letting
 * Postgres derive the day from a timestamp would put the boundary in the
 * server's timezone, and a fleet whose caps reset at a different instant than
 * its tests assume is a fleet whose caps are not the ones anyone reviewed.
 */

import { randomUUID } from 'node:crypto'
import type { Address } from '@fee-split-vaults/core'
import { CATEGORY_SUBCAP_BPS, type SkuCategory } from '@fee-split-vaults/broker'
import type { FleetCounters, FleetDisbursementRecord } from '@fee-split-vaults/orchestrator'
import { CounterUnavailableError } from '../errors.js'
import { bigIntFromSql, countFromSql, type SqlDriver } from './sql.js'

const DAY_SECONDS = 86_400
const HOUR_SECONDS = 3_600
const THIRTY_DAYS_SECONDS = 30 * DAY_SECONDS

/**
 * The sub-cap table is the definition of the category set - the same table the
 * gate reads - so this cannot drift from what the broker will actually enforce.
 */
function isSkuCategory(value: string): value is SkuCategory {
  return Object.prototype.hasOwnProperty.call(CATEGORY_SUBCAP_BPS, value)
}

/** Identical to the in-memory implementation's dayKey. Deliberately duplicated
 *  nowhere else: both call floor(unix / 86400) and both mean a UTC day. */
export function dayKey(unix: number): number {
  return Math.floor(unix / DAY_SECONDS)
}

export class PgFleetCounters implements FleetCounters {
  constructor(private readonly driver: SqlDriver) {}

  async #count(counter: string, sql: string, params: readonly (string | number | boolean)[]): Promise<number> {
    try {
      const rows = await this.driver.query<{ n: unknown }>(sql, params)
      return countFromSql(rows[0]?.n ?? 0, counter)
    } catch (error) {
      throw new CounterUnavailableError(counter, String(error), error)
    }
  }

  async #cents(counter: string, sql: string, params: readonly (string | number | boolean)[]): Promise<bigint> {
    try {
      const rows = await this.driver.query<{ cents: unknown }>(sql, params)
      return bigIntFromSql(rows[0]?.cents ?? 0, counter)
    } catch (error) {
      throw new CounterUnavailableError(counter, String(error), error)
    }
  }

  async disbursementsToday(nowUnix: number): Promise<number> {
    return this.#count(
      'disbursementsToday',
      'SELECT count(*) AS n FROM fleet_disbursement WHERE day_key = $1',
      [dayKey(nowUnix)],
    )
  }

  async disbursementsTodayForVault(vault: Address, nowUnix: number): Promise<number> {
    return this.#count(
      'disbursementsTodayForVault',
      'SELECT count(*) AS n FROM fleet_disbursement WHERE vault = $1 AND day_key = $2',
      [vault.toLowerCase(), dayKey(nowUnix)],
    )
  }

  async vendorSpendTodayCents(vendorId: string, nowUnix: number): Promise<bigint> {
    return this.#cents(
      'vendorSpendTodayCents',
      // ::numeric on the way in, ::text on the way out. A cent total can exceed
      // 2^53 and `pg` would hand a bare bigint back as a string anyway; being
      // explicit means no driver configuration can turn it into a rounded double.
      `SELECT COALESCE(sum(amount_cents), 0)::text AS cents
         FROM fleet_disbursement WHERE vendor_id = $1 AND day_key = $2`,
      [vendorId, dayKey(nowUnix)],
    )
  }

  async vendorDisbursementsTodayForVault(
    vault: Address,
    vendorId: string,
    nowUnix: number,
  ): Promise<number> {
    return this.#count(
      'vendorDisbursementsTodayForVault',
      `SELECT count(*) AS n FROM fleet_disbursement
        WHERE vault = $1 AND vendor_id = $2 AND day_key = $3`,
      [vault.toLowerCase(), vendorId, dayKey(nowUnix)],
    )
  }

  async proposalsLastHour(vault: Address, nowUnix: number): Promise<number> {
    // Strictly greater than, matching InMemoryFleetCounters: a proposal exactly
    // one hour old has aged out.
    return this.#count(
      'proposalsLastHour',
      'SELECT count(*) AS n FROM fleet_proposal WHERE vault = $1 AND at_unix > $2',
      [vault.toLowerCase(), nowUnix - HOUR_SECONDS],
    )
  }

  async relatedPartySpend30dCents(vault: Address, nowUnix: number): Promise<bigint> {
    return this.#cents(
      'relatedPartySpend30dCents',
      `SELECT COALESCE(sum(amount_cents), 0)::text AS cents
         FROM fleet_disbursement
        WHERE vault = $1 AND is_related_party AND at_unix >= $2`,
      [vault.toLowerCase(), nowUnix - THIRTY_DAYS_SECONDS],
    )
  }

  /**
   * A landed disbursement.
   *
   * THE ID IS RANDOM, NOT DERIVED, and that is the fail-closed choice. The port
   * hands over no identity - `FleetDisbursementRecord` is (vault, vendor,
   * cents, related-party, when) - so a deterministic id would have to be a hash
   * of those fields, and two identical purchases in the same second would
   * collide and be recorded once. That under-counts a cap, which OPENS it. A
   * random id can only ever over-count on a retry, which CLOSES a cap early.
   * Between a gate that fails open and one that fails shut, this takes shut.
   */
  /**
   * The whole per-category breakdown for one vault over the sub-cap period.
   *
   * ONE QUERY, GROUPED, rather than one query per category. The gate sums these
   * against the procurement budget as well as checking each against its own
   * sub-cap, so a category missing from the result is an under-count of the
   * total, and an under-counted spend figure opens a cap. A GROUP BY cannot
   * omit a category that has rows; seven separate reads can.
   *
   * A category with no rows is simply absent, which the port defines as a
   * measured zero. The failure case is the query throwing, and that becomes a
   * `CounterUnavailableError` like every other read here - never an empty map
   * standing in for "the database was unreachable".
   */
  async categorySpend30dCents(
    vault: Address,
    nowUnix: number,
  ): Promise<Partial<Record<SkuCategory, bigint>>> {
    let rows: Array<{ category: unknown; cents: unknown }>
    try {
      rows = await this.driver.query<{ category: unknown; cents: unknown }>(
        `SELECT category, COALESCE(sum(amount_cents), 0)::text AS cents
           FROM fleet_disbursement
          WHERE vault = $1 AND at_unix >= $2 AND category IS NOT NULL
          GROUP BY category`,
        [vault.toLowerCase(), nowUnix - THIRTY_DAYS_SECONDS],
      )
    } catch (error) {
      throw new CounterUnavailableError('categorySpend30dCents', String(error), error)
    }
    const totals: Partial<Record<SkuCategory, bigint>> = {}
    for (const row of rows) {
      // A category this build does not recognise is NOT dropped. Dropping it
      // would remove real spend from the total the procurement-budget check
      // reads, which is the same under-count in a quieter form. There is no
      // safe way to attribute it, so the counter refuses instead.
      if (typeof row.category !== 'string' || !isSkuCategory(row.category)) {
        throw new CounterUnavailableError(
          'categorySpend30dCents',
          `fleet_disbursement holds spend in an unrecognised category ${JSON.stringify(row.category)}; ` +
            'refusing to report a total that silently omits it',
        )
      }
      totals[row.category] = bigIntFromSql(row.cents ?? 0, 'categorySpend30dCents')
    }
    return totals
  }

  async recordDisbursement(entry: FleetDisbursementRecord): Promise<void> {
    try {
      await this.driver.execute(
        `INSERT INTO fleet_disbursement
             (id, vault, vendor_id, amount_cents, is_related_party, category, at_unix, day_key)
         VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8)`,
        [
          randomUUID(),
          entry.vault.toLowerCase(),
          entry.vendorId,
          entry.amountCents.toString(),
          entry.isRelatedParty,
          entry.category,
          entry.atUnix,
          dayKey(entry.atUnix),
        ],
      )
    } catch (error) {
      // A write that fails must be as loud as a read that fails. A disbursement
      // that landed on chain but was never counted is spend that no cap sees.
      throw new CounterUnavailableError('recordDisbursement', String(error), error)
    }
  }

  async recordProposal(vault: Address, atUnix: number): Promise<void> {
    try {
      await this.driver.execute(
        'INSERT INTO fleet_proposal (id, vault, at_unix) VALUES ($1, $2, $3)',
        [randomUUID(), vault.toLowerCase(), atUnix],
      )
    } catch (error) {
      throw new CounterUnavailableError('recordProposal', String(error), error)
    }
  }
}

import { describe, expect, it } from 'vitest'
import { EscalationSinkUnavailableError } from '../errors.js'
import { MAX_DETAIL_CHARS, PgEscalationSink } from '../pg/escalations.js'
import { RecordingSqlDriver } from './harness.js'

const VAULT = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01'
const NOW = 1_757_000_000

const HALT = {
  coinRef: 'coin-1',
  vault: VAULT,
  kind: 'indexer_halt',
  code: 'recipient_transferred',
  detail: 'creator fee recipient moved away from the vault',
  raisedAtUnix: NOW,
} as const

describe('PgEscalationSink', () => {
  it('persists, so the restart the failure caused does not erase the failure', async () => {
    const driver = new RecordingSqlDriver()
    await new PgEscalationSink(driver).raise(HALT)

    const sql = driver.lastSql()
    expect(sql).toContain('INSERT INTO ops_escalation')
    expect(driver.last().params).toEqual([
      'coin-1',
      VAULT.toLowerCase(),
      'indexer_halt',
      'recipient_transferred',
      HALT.detail,
      NOW,
    ])
  })

  it('dedupes an open escalation by (vault, kind, code) and keeps the FIRST raise time', async () => {
    const driver = new RecordingSqlDriver()
    await new PgEscalationSink(driver).raise(HALT)

    const sql = driver.lastSql()
    // A halt re-raises on every tick for as long as it holds. One row per tick
    // would bury the first occurrence under thousands of copies of itself.
    expect(sql).toContain('ON CONFLICT (vault, kind, code) WHERE resolved_at_unix IS NULL')
    expect(sql).toContain('occurrences = ops_escalation.occurrences + 1')
    // raised_at_unix is written once and never updated: "since when" is the
    // question an operator actually asks.
    expect(sql).not.toContain('raised_at_unix = EXCLUDED')
  })

  it('caps the detail, because a human reads it in a terminal', async () => {
    const driver = new RecordingSqlDriver()
    await new PgEscalationSink(driver).raise({ ...HALT, detail: 'x'.repeat(MAX_DETAIL_CHARS * 3) })
    expect(String(driver.last().params[4])).toHaveLength(MAX_DETAIL_CHARS)
  })

  it('throws when it cannot persist, rather than dropping the page', async () => {
    const driver = new RecordingSqlDriver()
    driver.unavailable = true
    const sink = new PgEscalationSink(driver)

    await expect(sink.raise(HALT)).rejects.toBeInstanceOf(EscalationSinkUnavailableError)
    await expect(sink.open()).rejects.toBeInstanceOf(EscalationSinkUnavailableError)
  })

  it('reads back only what is still open', async () => {
    const driver = new RecordingSqlDriver()
    driver.defaultRows = [
      {
        coin_ref: 'coin-1',
        vault: VAULT.toLowerCase(),
        kind: 'ledger_freeze',
        code: 'divergence',
        detail: 'ledger and chain disagree',
        raised_at_unix: '1757000000',
        last_raised_at_unix: '1757000600',
        occurrences: '7',
      },
    ]

    const open = await new PgEscalationSink(driver).open(VAULT)
    expect(driver.lastSql()).toContain('resolved_at_unix IS NULL')
    expect(open).toEqual([
      {
        coinRef: 'coin-1',
        vault: VAULT.toLowerCase(),
        kind: 'ledger_freeze',
        code: 'divergence',
        detail: 'ledger and chain disagree',
        raisedAtUnix: 1_757_000_000,
        lastRaisedAtUnix: 1_757_000_600,
        occurrences: 7,
      },
    ])
  })
})

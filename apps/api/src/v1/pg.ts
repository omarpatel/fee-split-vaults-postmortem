/**
 * The /v1 ports over Postgres. Schema: ops/migrations/0022_dev_sessions.sql
 * for what this file owns; 0008/0013/0015/0011 for what it only reads.
 *
 * Written against the structural SqlDriver every persistent port uses, so it
 * typechecks with no `pg` present, tests on pglite, and takes ops's PgDriver
 * in production.
 */

import type { Address } from '@fee-split-vaults/core'
import { countFromSql, type SqlDriver, type SqlRow } from '@fee-split-vaults/adapters'

import { normalizeAddress } from '../crypto/address.js'
import type {
  AckDecision,
  EscalationQueue,
  EscalationRecord,
  OperatedAccount,
  OperatedAccounts,
  PredicateCheck,
  ProcurementOutcome,
  ProcurementOutcomes,
  QfMeasurement,
  QfReader,
  QuoteExtras,
  QuoteStore,
} from './ports.js'
import type { DevChallenge, DevSession, DevSessionStore } from './sessions.js'

function text(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new TypeError(`${column} is ${typeof value}, not text`)
  return value
}

function optionalText(row: SqlRow, column: string): string | undefined {
  const value = row[column]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${column} is ${typeof value}, not text`)
  return value
}

function optionalCount(row: SqlRow, column: string): number | undefined {
  const value = row[column]
  return value === null || value === undefined ? undefined : countFromSql(value, column)
}

function float(row: SqlRow, column: string): number {
  const value = row[column]
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : Number.NaN
  if (!Number.isFinite(parsed)) throw new TypeError(`${column} is not a finite number`)
  return parsed
}

/** JSONB arrives parsed from `pg` and pglite alike; a TEXT fallback is parsed here. */
function json<T>(row: SqlRow, column: string): T | undefined {
  const value = row[column]
  if (value === null || value === undefined) return undefined
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export class PgDevSessionStore implements DevSessionStore {
  constructor(private readonly sql: SqlDriver) {}

  async putChallenge(challenge: DevChallenge): Promise<void> {
    await this.sql.execute(
      `INSERT INTO dev_auth_challenge (nonce, address, message, issued_at_unix, expires_at_unix)
       VALUES ($1, $2, $3, $4, $5)`,
      [challenge.nonce, normalizeAddress(challenge.address), challenge.message, challenge.issuedAtUnix, challenge.expiresAtUnix],
    )
  }

  /** One UPDATE with the unconsumed predicate: two concurrent presentations get one row. */
  async consumeChallenge(nonce: string, atUnix: number): Promise<DevChallenge | undefined> {
    const rows = await this.sql.query(
      `UPDATE dev_auth_challenge SET consumed_at_unix = $2
        WHERE nonce = $1 AND consumed_at_unix IS NULL
        RETURNING nonce, address, message, issued_at_unix, expires_at_unix`,
      [nonce, atUnix],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    return {
      nonce: text(row, 'nonce'),
      address: normalizeAddress(text(row, 'address')),
      message: text(row, 'message'),
      issuedAtUnix: countFromSql(row.issued_at_unix, 'dev_auth_challenge.issued_at_unix'),
      expiresAtUnix: countFromSql(row.expires_at_unix, 'dev_auth_challenge.expires_at_unix'),
    }
  }

  async putSession(session: DevSession): Promise<void> {
    await this.sql.execute(
      `INSERT INTO dev_session (id, token_hash, address, issued_at_unix, expires_at_unix)
       VALUES ($1, $2, $3, $4, $5)`,
      [session.id, session.tokenHash, normalizeAddress(session.address), session.issuedAtUnix, session.expiresAtUnix],
    )
  }

  async sessionByTokenHash(tokenHash: string): Promise<DevSession | undefined> {
    const rows = await this.sql.query(
      'SELECT id, token_hash, address, issued_at_unix, expires_at_unix FROM dev_session WHERE token_hash = $1',
      [tokenHash],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    return {
      id: text(row, 'id'),
      tokenHash: text(row, 'token_hash'),
      address: normalizeAddress(text(row, 'address')),
      issuedAtUnix: countFromSql(row.issued_at_unix, 'dev_session.issued_at_unix'),
      expiresAtUnix: countFromSql(row.expires_at_unix, 'dev_session.expires_at_unix'),
    }
  }
}

export class PgQuoteStore implements QuoteStore {
  constructor(private readonly sql: SqlDriver) {}

  async put(extras: QuoteExtras): Promise<void> {
    await this.sql.execute(
      `INSERT INTO onboarding_quote (nonce, dev_signer, narrative_sources, socials, issued_at_unix, expires_at_unix)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
       ON CONFLICT (nonce) DO NOTHING`,
      [
        extras.nonce,
        normalizeAddress(extras.devSigner),
        JSON.stringify(extras.narrativeSources),
        extras.socials === undefined ? null : JSON.stringify(extras.socials),
        extras.issuedAtUnix,
        extras.expiresAtUnix,
      ],
    )
  }

  async get(nonce: string): Promise<QuoteExtras | undefined> {
    const rows = await this.sql.query(
      'SELECT nonce, dev_signer, narrative_sources, socials, issued_at_unix, expires_at_unix FROM onboarding_quote WHERE nonce = $1',
      [nonce],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    const socials = json<{ x?: string }>(row, 'socials')
    return {
      nonce: text(row, 'nonce'),
      devSigner: normalizeAddress(text(row, 'dev_signer')),
      narrativeSources: json<string[]>(row, 'narrative_sources') ?? [],
      ...(socials === undefined ? {} : { socials }),
      issuedAtUnix: countFromSql(row.issued_at_unix, 'onboarding_quote.issued_at_unix'),
      expiresAtUnix: countFromSql(row.expires_at_unix, 'onboarding_quote.expires_at_unix'),
    }
  }
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

const ESCALATION_COLUMNS =
  'id, vault, kind, code, detail, raised_at_unix, resolved_at_unix, acknowledged_at_unix, ack_decision'

function toEscalation(row: SqlRow): EscalationRecord {
  const resolvedAtUnix = optionalCount(row, 'resolved_at_unix')
  const acknowledgedAtUnix = optionalCount(row, 'acknowledged_at_unix')
  const ackDecision = optionalText(row, 'ack_decision')
  return {
    id: String(countFromSql(row.id, 'ops_escalation.id')),
    vault: normalizeAddress(text(row, 'vault')),
    kind: text(row, 'kind'),
    code: text(row, 'code'),
    detail: text(row, 'detail'),
    raisedAtUnix: countFromSql(row.raised_at_unix, 'ops_escalation.raised_at_unix'),
    ...(resolvedAtUnix === undefined ? {} : { resolvedAtUnix }),
    ...(acknowledgedAtUnix === undefined ? {} : { acknowledgedAtUnix }),
    ...(ackDecision === undefined ? {} : { ackDecision: ackDecision as AckDecision }),
  }
}

export class PgEscalationQueue implements EscalationQueue {
  constructor(private readonly sql: SqlDriver) {}

  async forVault(vault: Address): Promise<EscalationRecord[]> {
    const rows = await this.sql.query(
      `SELECT ${ESCALATION_COLUMNS} FROM ops_escalation WHERE vault = $1 ORDER BY raised_at_unix DESC, id DESC`,
      [normalizeAddress(vault)],
    )
    return rows.map(toEscalation)
  }

  async acknowledge(input: Parameters<EscalationQueue['acknowledge']>[0]): Promise<EscalationRecord | undefined> {
    if (!/^\d{1,18}$/.test(input.id)) return undefined
    const rows = await this.sql.query(
      `UPDATE ops_escalation
          SET acknowledged_at_unix = $3, acknowledged_by = $4, ack_decision = $5, ack_note = $6
        WHERE id = $1 AND vault = $2
        RETURNING ${ESCALATION_COLUMNS}`,
      [Number(input.id), normalizeAddress(input.vault), input.atUnix, normalizeAddress(input.by), input.decision, input.note],
    )
    const row = rows[0]
    return row === undefined ? undefined : toEscalation(row)
  }
}

// ---------------------------------------------------------------------------
// Procurement outcomes: ops_predicate_check + ops_predicate_withhold
// ---------------------------------------------------------------------------

interface CheckRow extends SqlRow {
  disbursement_id: string
  vault: string
  sku_id: string
  vendor_id: string
  spec: unknown
  withheld_reason: unknown
}

const CHECK_SELECT = `SELECT c.disbursement_id, c.offset_seconds, c.vault, c.sku_id, c.vendor_id, c.cost_usd, c.funded_at_unix, c.spec,
         c.checked_at_unix, c.passed, c.evidence_uri, c.evidence_hash, c.note, w.reason AS withheld_reason
    FROM ops_predicate_check c
    LEFT JOIN ops_predicate_withhold w ON w.disbursement_id = c.disbursement_id`

function groupOutcomes(rows: CheckRow[]): ProcurementOutcome[] {
  const byId = new Map<string, ProcurementOutcome>()
  for (const row of rows) {
    const id = text(row, 'disbursement_id')
    let outcome = byId.get(id)
    if (outcome === undefined) {
      const spec = json<{ kind?: unknown }>(row, 'spec')
      const withheldReason = optionalText(row, 'withheld_reason')
      outcome = {
        disbursementId: id,
        vault: normalizeAddress(text(row, 'vault')),
        vendorId: text(row, 'vendor_id'),
        skuId: text(row, 'sku_id'),
        predicateKind: typeof spec?.kind === 'string' ? spec.kind : 'unknown',
        costUsd: float(row, 'cost_usd'),
        fundedAtUnix: countFromSql(row.funded_at_unix, 'ops_predicate_check.funded_at_unix'),
        checks: [],
        ...(withheldReason === undefined ? {} : { withheldReason }),
      }
      byId.set(id, outcome)
    }
    const checkedAtUnix = optionalCount(row, 'checked_at_unix')
    if (checkedAtUnix === undefined) continue
    const evidenceUri = optionalText(row, 'evidence_uri')
    const evidenceHash = optionalText(row, 'evidence_hash')
    const note = optionalText(row, 'note')
    const check: PredicateCheck = {
      offsetSeconds: countFromSql(row.offset_seconds, 'ops_predicate_check.offset_seconds'),
      checkedAtUnix,
      passed: row.passed === true,
      ...(evidenceUri === undefined ? {} : { evidenceUri }),
      ...(evidenceHash === undefined ? {} : { evidenceHash }),
      ...(note === undefined ? {} : { note }),
    }
    outcome.checks.push(check)
  }
  return [...byId.values()]
}

export class PgProcurementOutcomes implements ProcurementOutcomes {
  constructor(private readonly sql: SqlDriver) {}

  async forVault(vault: Address): Promise<ProcurementOutcome[]> {
    const rows = await this.sql.query<CheckRow>(
      `${CHECK_SELECT} WHERE c.vault = $1 ORDER BY c.funded_at_unix DESC, c.disbursement_id, c.offset_seconds`,
      [normalizeAddress(vault)],
    )
    return groupOutcomes(rows)
  }

  async forDisbursement(disbursementId: string): Promise<ProcurementOutcome | undefined> {
    const rows = await this.sql.query<CheckRow>(`${CHECK_SELECT} WHERE c.disbursement_id = $1 ORDER BY c.offset_seconds`, [
      disbursementId,
    ])
    return groupOutcomes(rows)[0]
  }
}

// ---------------------------------------------------------------------------
// The tier gate's measurement
// ---------------------------------------------------------------------------

export class PgQfReader implements QfReader {
  constructor(private readonly sql: SqlDriver) {}

  /** The latest applied decision carries the full measurement; a day with no decision yet has only the observation. */
  async latest(vault: Address): Promise<QfMeasurement | undefined> {
    const key = normalizeAddress(vault)
    const [decision] = await this.sql.query(
      `SELECT qf_per_day_usd, observed_days, sustained_days, decided_at_unix FROM ops_tier_history
        WHERE vault = $1 ORDER BY decided_at_unix DESC LIMIT 1`,
      [key],
    )
    const [observation] = await this.sql.query(
      `SELECT qf_per_day_usd, observed_at_unix, (SELECT count(*) FROM ops_qf_observation WHERE vault = $1) AS observed_days
         FROM ops_qf_observation WHERE vault = $1 ORDER BY observed_at_unix DESC LIMIT 1`,
      [key],
    )
    if (observation === undefined && decision === undefined) return undefined
    if (
      decision !== undefined &&
      (observation === undefined ||
        countFromSql(decision.decided_at_unix, 'decided_at_unix') >= countFromSql(observation.observed_at_unix, 'observed_at_unix'))
    ) {
      return {
        qfPerDayUsd: float(decision, 'qf_per_day_usd'),
        observedDays: countFromSql(decision.observed_days, 'observed_days'),
        sustainedDays: countFromSql(decision.sustained_days, 'sustained_days'),
        measuredAtUnix: countFromSql(decision.decided_at_unix, 'decided_at_unix'),
      }
    }
    if (observation === undefined) return undefined
    return {
      qfPerDayUsd: float(observation, 'qf_per_day_usd'),
      observedDays: countFromSql(observation.observed_days, 'observed_days'),
      sustainedDays: decision === undefined ? 0 : countFromSql(decision.sustained_days, 'sustained_days'),
      measuredAtUnix: countFromSql(observation.observed_at_unix, 'observed_at_unix'),
    }
  }
}

// ---------------------------------------------------------------------------
// Operated accounts: publisher_account_binding
// ---------------------------------------------------------------------------

export class PgOperatedAccounts implements OperatedAccounts {
  constructor(private readonly sql: SqlDriver) {}

  async forVault(vault: Address): Promise<OperatedAccount[]> {
    const rows = await this.sql.query(
      'SELECT channel, account_id FROM publisher_account_binding WHERE vault = $1 ORDER BY channel, account_id',
      [normalizeAddress(vault)],
    )
    const accounts: OperatedAccount[] = []
    for (const row of rows) {
      const channel = text(row, 'channel')
      const accountId = text(row, 'account_id')
      // The binding holds X's numeric user id, not the handle; X resolves the id publicly.
      if (channel === 'x_operator' || channel === 'x_client_delegated') {
        accounts.push({ channel: 'x', handle: accountId, url: `https://x.com/i/user/${encodeURIComponent(accountId)}` })
      }
    }
    return accounts
  }
}

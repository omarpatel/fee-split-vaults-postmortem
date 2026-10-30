/**
 * Where an alert goes.
 *
 * Two halves, composed: the LOG (ops_alert_firing, 0007) is what makes "was
 * this paging all weekend" answerable and what the status CLI reads; the
 * WEBHOOK is what wakes a person. The log is written FIRST. A webhook that is
 * down must not lose the record that the alert existed, and a responder who
 * arrives late must find the row.
 *
 * The webhook is a plain POST of the alert as JSON to OPS_ALERT_WEBHOOK_URL -
 * the shape PagerDuty Events, Slack incoming webhooks and Opsgenie all accept
 * behind a thin relay, and deliberately not any one vendor's schema. A non-2xx
 * or unreachable endpoint throws `webhook_failed`, so the raising job retries
 * and, failing that, dead-letters: an alert the pager never got is itself
 * something the dead-letter backlog alert will page about.
 *
 * REPEATS. A firing for an (alertId, scope) that already has an OPEN row is
 * the same incident: the row's fired_at and facts are refreshed and the
 * webhook is posted again (the evaluator's own suppression window decides how
 * often that happens). It becomes a new incident only once the old one has
 * been cleared.
 */

import { canonicalDigest } from '../../lib/ids.js'
import type { SqlDriver } from '../../migrations/driver.js'
import type { AlertSink, OpsAlert } from '../ports.js'
import { OpsAdapterError, intOf, strOf } from './errors.js'

export interface RecordedFiring {
  id: string
  /** False when an open row for the same (alertId, scope) was refreshed. */
  opened: boolean
}

export class PgAlertLog {
  constructor(private readonly driver: SqlDriver) {}

  async record(alert: OpsAlert, raisedBy: string): Promise<RecordedFiring> {
    const facts = JSON.stringify(alert.facts)
    const open = await this.driver.query<{ id: string }>(
      `SELECT id FROM ops_alert_firing WHERE alert_id = $1 AND scope = $2 AND cleared_at_unix IS NULL`,
      [alert.alertId, alert.scope],
    )
    const existing = open[0]
    if (existing !== undefined) {
      const id = strOf(existing.id, 'ops_alert_firing.id')
      await this.driver.execute(
        `UPDATE ops_alert_firing SET fired_at_unix = $2, summary = $3, facts_json = $4, severity = $5 WHERE id = $1`,
        [id, alert.raisedAtUnix, alert.summary, facts, alert.severity],
      )
      return { id, opened: false }
    }
    const id = `af_${canonicalDigest({ alert: alert.alertId, scope: alert.scope, at: alert.raisedAtUnix }).slice(0, 32)}`
    await this.driver.execute(
      `INSERT INTO ops_alert_firing
           (id, alert_id, scope, severity, summary, runbook, auto_action, facts_json,
            first_seen_at_unix, fired_at_unix, raised_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [id, alert.alertId, alert.scope, alert.severity, alert.summary, alert.runbook, 'none', facts, alert.raisedAtUnix, raisedBy],
    )
    return { id, opened: true }
  }

  /**
   * Close the open firings `raisedBy` raised whose (alertId, scope) is not in
   * `active`. Only the raiser's own rows: a page a reconciliation job raised is
   * cleared by the human who resolved it, not by a monitor that stopped seeing
   * the condition.
   */
  async clearResolved(raisedBy: string, active: ReadonlySet<string>, nowUnix: number): Promise<number> {
    const rows = await this.driver.query<{ id: string; alert_id: string; scope: string }>(
      `SELECT id, alert_id, scope FROM ops_alert_firing WHERE raised_by = $1 AND cleared_at_unix IS NULL`,
      [raisedBy],
    )
    let cleared = 0
    for (const row of rows) {
      const key = `${strOf(row.alert_id, 'ops_alert_firing.alert_id')}#${strOf(row.scope, 'ops_alert_firing.scope')}`
      if (active.has(key)) continue
      await this.driver.execute(`UPDATE ops_alert_firing SET cleared_at_unix = $2 WHERE id = $1 AND cleared_at_unix IS NULL`, [
        strOf(row.id, 'ops_alert_firing.id'),
        nowUnix,
      ])
      cleared += 1
    }
    return cleared
  }

  async openCount(): Promise<number> {
    const rows = await this.driver.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM ops_alert_firing WHERE cleared_at_unix IS NULL`,
    )
    return intOf(rows[0]?.n ?? 0, 'ops_alert_firing.count')
  }
}

export interface WebhookAlertSinkOptions {
  url: string
  fetchImpl?: typeof fetch
  /** Sent as a bearer token when present. */
  authToken?: string
  timeoutMs?: number
}

export class WebhookAlertSink implements AlertSink {
  readonly #url: string
  readonly #fetch: typeof fetch
  readonly #authToken: string | undefined
  readonly #timeoutMs: number

  constructor(options: WebhookAlertSinkOptions) {
    let parsed: URL
    try {
      parsed = new URL(options.url)
    } catch {
      throw new OpsAdapterError('webhook_failed', `OPS_ALERT_WEBHOOK_URL is not a URL`)
    }
    if (parsed.protocol !== 'https:') throw new OpsAdapterError('webhook_failed', 'OPS_ALERT_WEBHOOK_URL must be https')
    this.#url = options.url
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#authToken = options.authToken
    this.#timeoutMs = options.timeoutMs ?? 10_000
  }

  async raise(alert: OpsAlert): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    let response: Response
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.#authToken === undefined ? {} : { authorization: `Bearer ${this.#authToken}` }),
        },
        body: JSON.stringify({
          alert_id: alert.alertId,
          severity: alert.severity,
          scope: alert.scope,
          summary: alert.summary,
          runbook: alert.runbook,
          facts: alert.facts,
          raised_at_unix: alert.raisedAtUnix,
        }),
        signal: controller.signal,
      })
    } catch (error) {
      throw new OpsAdapterError('webhook_failed', `${alert.alertId}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) throw new OpsAdapterError('webhook_failed', `${alert.alertId}: webhook answered ${String(response.status)}`)
  }
}

/** Log first, then page. Both halves are real or the composition root did not build this. */
export class LoggedAlertSink implements AlertSink {
  constructor(
    private readonly log: PgAlertLog,
    private readonly webhook: AlertSink,
    private readonly raisedBy: string,
  ) {}

  async raise(alert: OpsAlert): Promise<void> {
    await this.log.record(alert, this.raisedBy)
    await this.webhook.raise(alert)
  }
}

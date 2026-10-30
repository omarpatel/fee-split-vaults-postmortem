/**
 * The onboarding record in Postgres. Schema: ops/migrations/0012_onboarding.sql.
 *
 * Written against the same structural SqlDriver every other persistent port in
 * the repository uses, so the store typechecks and tests with no `pg` present
 * (the tests run it on pglite) and production passes ops's PgDriver.
 *
 * The sub-documents - consent, screening, diligence, narrative, history - go
 * in and out as JSONB whole. This module does not interpret them: the code that
 * owns each shape validates it, and a narrative in particular is re-validated
 * by validateNarrativeProfile at the moment it is approved, so a hand-edited
 * row cannot smuggle a destination into the planner.
 */

import type { Address, Consent, NarrativeProfile, ScreeningResult } from '@fee-split-vaults/core'
import type { DiligenceReport } from '@fee-split-vaults/screening'
import { countFromSql, type SqlDriver, type SqlRow, type SqlValue } from '@fee-split-vaults/adapters'

import { normalizeAddress } from '../crypto/address.js'
import {
  ONBOARDING_STATES,
  type NarrativeCandidate,
  type OnboardingEvent,
  type OnboardingRecord,
  type OnboardingSocials,
  type OnboardingState,
  type OnboardingStore,
} from '../onboarding.js'

const COLUMNS = [
  'id',
  'state',
  'vault',
  'token',
  'coin_ref',
  'created_at_unix',
  'updated_at_unix',
  'consent',
  'name',
  'symbol',
  'description',
  'links',
  'narrative_sources',
  'socials',
  'dev_signature',
  'signature_verified_at_unix',
  'screening',
  'diligence',
  'deployed_at_unix',
  'deploy_tx_hash',
  'pointed_at_unix',
  'accepted_at_unix',
  'activated_at_unix',
  'launched_at_unix',
  'decline_reason',
  'narrative_candidate',
  'narrative',
  'history',
] as const

const JSON_COLUMNS: Readonly<Record<string, true>> = {
  consent: true,
  links: true,
  narrative_sources: true,
  socials: true,
  screening: true,
  diligence: true,
  narrative_candidate: true,
  narrative: true,
  history: true,
}

const SELECT = `SELECT ${COLUMNS.join(', ')} FROM onboarding`

const UPSERT = `INSERT INTO onboarding (${COLUMNS.join(', ')})
VALUES (${COLUMNS.map((column, i) => `$${String(i + 1)}${JSON_COLUMNS[column] === true ? '::jsonb' : ''}`).join(', ')})
ON CONFLICT (id) DO UPDATE SET ${COLUMNS.filter((c) => c !== 'id')
  .map((column) => `${column} = EXCLUDED.${column}`)
  .join(', ')}`

export class PgOnboardingStore implements OnboardingStore {
  readonly #sql: SqlDriver

  constructor(sql: SqlDriver) {
    this.#sql = sql
  }

  async put(record: OnboardingRecord): Promise<void> {
    const params: SqlValue[] = [
      record.id,
      record.state,
      normalizeAddress(record.vault),
      normalizeAddress(record.token),
      record.coinRef,
      record.createdAtUnix,
      record.updatedAtUnix,
      JSON.stringify(record.consent),
      record.name,
      record.symbol,
      record.description ?? null,
      JSON.stringify(record.links),
      JSON.stringify(record.narrativeSources),
      record.socials === undefined ? null : JSON.stringify(record.socials),
      record.devSignature ?? null,
      record.signatureVerifiedAtUnix ?? null,
      record.screening === undefined ? null : JSON.stringify(record.screening),
      record.diligence === undefined ? null : JSON.stringify(record.diligence),
      record.deployedAtUnix ?? null,
      record.deployTxHash ?? null,
      record.pointedAtUnix ?? null,
      record.acceptedAtUnix ?? null,
      record.activatedAtUnix ?? null,
      record.launchedAtUnix ?? null,
      record.declineReason ?? null,
      record.narrativeCandidate === undefined ? null : JSON.stringify(record.narrativeCandidate),
      record.narrative === undefined ? null : JSON.stringify(record.narrative),
      JSON.stringify(record.history),
    ]
    await this.#sql.execute(UPSERT, params)
  }

  async get(id: string): Promise<OnboardingRecord | undefined> {
    const rows = await this.#sql.query(`${SELECT} WHERE id = $1`, [id])
    return rows[0] === undefined ? undefined : toRecord(rows[0])
  }

  /** The most recent onboarding for a token. A declined attempt and its retry share one. */
  async byToken(token: Address): Promise<OnboardingRecord | undefined> {
    const rows = await this.#sql.query(
      `${SELECT} WHERE token = $1 ORDER BY created_at_unix DESC, id DESC LIMIT 1`,
      [normalizeAddress(token)],
    )
    return rows[0] === undefined ? undefined : toRecord(rows[0])
  }

  async list(): Promise<OnboardingRecord[]> {
    const rows = await this.#sql.query(`${SELECT} ORDER BY created_at_unix ASC, id ASC`)
    return rows.map(toRecord)
  }
}

// ---------------------------------------------------------------------------

function text(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new TypeError(`onboarding.${column} is not text`)
  return value
}

function optionalText(row: SqlRow, column: string): string | undefined {
  const value = row[column]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`onboarding.${column} is not text`)
  return value
}

function optionalInt(row: SqlRow, column: string): number | undefined {
  const value = row[column]
  if (value === null || value === undefined) return undefined
  return countFromSql(value, `onboarding.${column}`)
}

/** JSONB arrives parsed from `pg` and pglite alike; a TEXT fallback is parsed here. */
function json<T>(row: SqlRow, column: string): T | undefined {
  const value = row[column]
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return JSON.parse(value) as T
  return value as T
}

function requiredJson<T>(row: SqlRow, column: string): T {
  const value = json<T>(row, column)
  if (value === undefined) throw new TypeError(`onboarding.${column} is null`)
  return value
}

function stringArray(row: SqlRow, column: string): string[] {
  const value = requiredJson<unknown>(row, column)
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new TypeError(`onboarding.${column} is not a string array`)
  }
  return value as string[]
}

function toRecord(row: SqlRow): OnboardingRecord {
  const state = text(row, 'state')
  if (!ONBOARDING_STATES.includes(state as OnboardingState)) {
    throw new TypeError(`onboarding.state ${state} is not a known state`)
  }
  const record: OnboardingRecord = {
    id: text(row, 'id'),
    state: state as OnboardingState,
    consent: requiredJson<Consent>(row, 'consent'),
    vault: normalizeAddress(text(row, 'vault')),
    token: normalizeAddress(text(row, 'token')),
    coinRef: text(row, 'coin_ref'),
    createdAtUnix: countFromSql(row.created_at_unix, 'onboarding.created_at_unix'),
    updatedAtUnix: countFromSql(row.updated_at_unix, 'onboarding.updated_at_unix'),
    name: text(row, 'name'),
    symbol: text(row, 'symbol'),
    links: stringArray(row, 'links'),
    narrativeSources: stringArray(row, 'narrative_sources'),
    history: requiredJson<OnboardingEvent[]>(row, 'history'),
  }

  const description = optionalText(row, 'description')
  if (description !== undefined) record.description = description
  const socials = json<OnboardingSocials>(row, 'socials')
  if (socials !== undefined) record.socials = socials
  const devSignature = optionalText(row, 'dev_signature')
  if (devSignature !== undefined) record.devSignature = devSignature
  const signatureVerifiedAtUnix = optionalInt(row, 'signature_verified_at_unix')
  if (signatureVerifiedAtUnix !== undefined) record.signatureVerifiedAtUnix = signatureVerifiedAtUnix
  const screening = json<ScreeningResult>(row, 'screening')
  if (screening !== undefined) record.screening = screening
  const diligence = json<DiligenceReport>(row, 'diligence')
  if (diligence !== undefined) record.diligence = diligence
  const deployedAtUnix = optionalInt(row, 'deployed_at_unix')
  if (deployedAtUnix !== undefined) record.deployedAtUnix = deployedAtUnix
  const deployTxHash = optionalText(row, 'deploy_tx_hash')
  if (deployTxHash !== undefined) record.deployTxHash = deployTxHash
  const pointedAtUnix = optionalInt(row, 'pointed_at_unix')
  if (pointedAtUnix !== undefined) record.pointedAtUnix = pointedAtUnix
  const acceptedAtUnix = optionalInt(row, 'accepted_at_unix')
  if (acceptedAtUnix !== undefined) record.acceptedAtUnix = acceptedAtUnix
  const activatedAtUnix = optionalInt(row, 'activated_at_unix')
  if (activatedAtUnix !== undefined) record.activatedAtUnix = activatedAtUnix
  const launchedAtUnix = optionalInt(row, 'launched_at_unix')
  if (launchedAtUnix !== undefined) record.launchedAtUnix = launchedAtUnix
  const declineReason = optionalText(row, 'decline_reason')
  if (declineReason !== undefined) record.declineReason = declineReason
  const narrativeCandidate = json<NarrativeCandidate>(row, 'narrative_candidate')
  if (narrativeCandidate !== undefined) record.narrativeCandidate = narrativeCandidate
  const narrative = json<NarrativeProfile>(row, 'narrative')
  if (narrative !== undefined) record.narrative = narrative
  return record
}

/**
 * The publisher's four stores over Postgres.
 *
 * ACCOUNT BINDINGS AND ROSTER are trusted operator state: which ticker an
 * account speaks for, which token it may name. Same keys as the in-memory
 * registry - (channel, lowercased account id) and upper-cased ticker - and
 * bind() upserts the roster entry in the same transaction, so an account can
 * never be bound to a coin the roster does not know.
 *
 * POSTS live on 0004's `publication`. The registry is keyed by the platform's
 * post id; the read-back outcome is stored whole and mirrored into the
 * report's read_back_verified / read_back_at_unix / deleted_at_unix columns so
 * the ops reports keep working off the columns they were written against.
 *
 * CREDENTIALS are sealed with AES-256-GCM before they reach the row (see
 * crypto.ts). The store refuses to construct without a key, refuses to open a
 * blob sealed under a different key, and never returns a token it could not
 * authenticate. A wrong key is a typed throw; it is not "no credentials".
 *
 * LABEL ATTESTATIONS are what the automated-label probe reads: a named human
 * said this account carries the platform's label, until this instant.
 */

import type { Channel } from '@fee-split-vaults/core'
import type {
  AccountBinding,
  AccountCredentialStore,
  DisclosureSpec,
  LabelAttestation,
  LabelAttestationStore,
  MutableAccountRegistry,
  PostRecord,
  PostRegistry,
  ReadBackOutcome,
  RosterEntry,
  XCredentials,
} from '@fee-split-vaults/publisher'
import { openSecret, sealSecret, sealedKeyId, sealingKeyFromHex, type SealingKey } from './crypto.js'
import { SecretUnopenableError } from '../errors.js'
import {
  boolFromSql,
  enumFromSql,
  guarded,
  objectFromSql,
  optStrFromSql,
  stringArrayFromSql,
  strFromSql,
  withOptional,
} from './rows.js'
import { countFromSql, type SqlDriver } from './sql.js'

const CHANNELS: readonly Channel[] = ['telegram', 'x_operator', 'x_client_delegated', 'site']

// ---------------------------------------------------------------------------
// Account registry
// ---------------------------------------------------------------------------

const BINDING_COLUMNS = 'channel, account_id, coin_ref, vault, token, ticker, delegated'

function rowToBinding(row: Record<string, unknown>): AccountBinding {
  const f = 'publisher_account_binding'
  return {
    accountId: strFromSql(row.account_id, `${f}.account_id`),
    channel: enumFromSql(row.channel, CHANNELS, `${f}.channel`),
    coinRef: strFromSql(row.coin_ref, `${f}.coin_ref`),
    vault: strFromSql(row.vault, `${f}.vault`),
    token: strFromSql(row.token, `${f}.token`),
    ticker: strFromSql(row.ticker, `${f}.ticker`),
    delegated: boolFromSql(row.delegated, `${f}.delegated`),
  }
}

const ROSTER_UPSERT = `INSERT INTO publisher_roster (ticker_key, ticker, vault, token)
   VALUES ($1, $2, $3, $4)
   ON CONFLICT (ticker_key) DO UPDATE SET
       ticker = EXCLUDED.ticker, vault = EXCLUDED.vault, token = EXCLUDED.token`

export class PgAccountRegistry implements MutableAccountRegistry {
  constructor(private readonly driver: SqlDriver) {}

  async get(channel: Channel, accountId: string): Promise<AccountBinding | null> {
    const rows = await guarded('publisher_account_binding', () =>
      this.driver.query(
        `SELECT ${BINDING_COLUMNS} FROM publisher_account_binding WHERE channel = $1 AND account_id = $2`,
        [channel, accountId.toLowerCase()],
      ),
    )
    const row = rows[0]
    return row === undefined ? null : rowToBinding(row)
  }

  async roster(): Promise<readonly RosterEntry[]> {
    const rows = await guarded('publisher_roster', () =>
      this.driver.query('SELECT ticker, vault, token FROM publisher_roster ORDER BY ticker_key'),
    )
    return rows.map((row) => ({
      ticker: strFromSql(row.ticker, 'publisher_roster.ticker'),
      vault: strFromSql(row.vault, 'publisher_roster.vault'),
      token: strFromSql(row.token, 'publisher_roster.token'),
    }))
  }

  async bind(binding: AccountBinding): Promise<void> {
    await guarded('publisher_account_binding', () =>
      this.driver.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO publisher_account_binding (${BINDING_COLUMNS})
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (channel, account_id) DO UPDATE SET
               coin_ref = EXCLUDED.coin_ref, vault = EXCLUDED.vault, token = EXCLUDED.token,
               ticker = EXCLUDED.ticker, delegated = EXCLUDED.delegated`,
          [
            binding.channel,
            binding.accountId.toLowerCase(),
            binding.coinRef,
            binding.vault,
            binding.token,
            binding.ticker,
            binding.delegated,
          ],
        )
        await tx.execute(ROSTER_UPSERT, [binding.ticker.toUpperCase(), binding.ticker, binding.vault, binding.token])
      }),
    )
  }

  async unbind(channel: Channel, accountId: string): Promise<void> {
    await guarded('publisher_account_binding', () =>
      this.driver.execute('DELETE FROM publisher_account_binding WHERE channel = $1 AND account_id = $2', [
        channel,
        accountId.toLowerCase(),
      ]),
    )
  }

  async addRosterEntry(entry: RosterEntry): Promise<void> {
    await guarded('publisher_roster', () =>
      this.driver.execute(ROSTER_UPSERT, [entry.ticker.toUpperCase(), entry.ticker, entry.vault, entry.token]),
    )
  }
}

// ---------------------------------------------------------------------------
// Post registry
// ---------------------------------------------------------------------------

const POST_COLUMNS =
  'id, vault, channel, account_id, correlation_id, published_at_unix, is_promotional, classification_rules, ' +
  'disclosure, required_tokens, body_hash, body_truncated, approved_by, read_back'

function disclosureFromSql(value: unknown): DisclosureSpec {
  const o = objectFromSql(value, 'publication.disclosure')
  return {
    operatorName: strFromSql(o.operatorName, 'publication.disclosure.operatorName'),
    receiptUrl: strFromSql(o.receiptUrl, 'publication.disclosure.receiptUrl'),
    paidPromotion: boolFromSql(o.paidPromotion, 'publication.disclosure.paidPromotion'),
  }
}

function readBackFromSql(value: unknown): ReadBackOutcome | undefined {
  if (value === null || value === undefined) return undefined
  const o = objectFromSql(value, 'publication.read_back')
  const f = 'publication.read_back'
  const base: ReadBackOutcome = {
    externalId: strFromSql(o.externalId, `${f}.externalId`),
    verifiedAtUnix: countFromSql(o.verifiedAtUnix, `${f}.verifiedAtUnix`),
    ok: boolFromSql(o.ok, `${f}.ok`),
    missing: stringArrayFromSql(o.missing, `${f}.missing`),
    deleted: boolFromSql(o.deleted, `${f}.deleted`),
  }
  const withReason = withOptional(base, 'reason', optStrFromSql(o.reason, `${f}.reason`))
  return withOptional(withReason, 'deleteError', optStrFromSql(o.deleteError, `${f}.deleteError`))
}

function rowToPost(row: Record<string, unknown>): PostRecord {
  const f = 'publication'
  const base: PostRecord = {
    externalId: strFromSql(row.id, `${f}.id`),
    vault: strFromSql(row.vault, `${f}.vault`),
    channel: enumFromSql(row.channel, CHANNELS, `${f}.channel`),
    accountId: strFromSql(row.account_id, `${f}.account_id`),
    correlationId: strFromSql(row.correlation_id, `${f}.correlation_id`),
    publishedAtUnix: countFromSql(row.published_at_unix, `${f}.published_at_unix`),
    isPromotional: boolFromSql(row.is_promotional, `${f}.is_promotional`),
    classificationRules: stringArrayFromSql(row.classification_rules, `${f}.classification_rules`),
    disclosure: disclosureFromSql(row.disclosure),
    requiredTokens: stringArrayFromSql(row.required_tokens, `${f}.required_tokens`),
    publishedTextHash: strFromSql(row.body_hash, `${f}.body_hash`),
    bodyTruncated: boolFromSql(row.body_truncated, `${f}.body_truncated`),
  }
  const withApprover = withOptional(base, 'approvedBy', optStrFromSql(row.approved_by, `${f}.approved_by`))
  return withOptional(withApprover, 'readBack', readBackFromSql(row.read_back))
}

export class PgPostRegistry implements PostRegistry {
  constructor(private readonly driver: SqlDriver) {}

  async put(record: PostRecord): Promise<void> {
    await guarded('publication', () =>
      this.driver.execute(
        `INSERT INTO publication
             (id, external_id, vault, channel, account_id, correlation_id, published_at_unix, is_promotional,
              classification_rules, disclosure, required_tokens, disclosure_tags, body_hash, body_truncated,
              approved_by, read_back, read_back_verified, read_back_at_unix, deleted_at_unix)
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14,
                 $15::jsonb, $16, $17, $18)
         ON CONFLICT (id) DO UPDATE SET
             vault = EXCLUDED.vault, channel = EXCLUDED.channel, account_id = EXCLUDED.account_id,
             correlation_id = EXCLUDED.correlation_id, published_at_unix = EXCLUDED.published_at_unix,
             is_promotional = EXCLUDED.is_promotional, classification_rules = EXCLUDED.classification_rules,
             disclosure = EXCLUDED.disclosure, required_tokens = EXCLUDED.required_tokens,
             disclosure_tags = EXCLUDED.disclosure_tags, body_hash = EXCLUDED.body_hash,
             body_truncated = EXCLUDED.body_truncated, approved_by = EXCLUDED.approved_by,
             read_back = EXCLUDED.read_back, read_back_verified = EXCLUDED.read_back_verified,
             read_back_at_unix = EXCLUDED.read_back_at_unix, deleted_at_unix = EXCLUDED.deleted_at_unix`,
        [
          record.externalId,
          record.vault,
          record.channel,
          record.accountId,
          record.correlationId,
          record.publishedAtUnix,
          record.isPromotional,
          JSON.stringify(record.classificationRules),
          JSON.stringify(record.disclosure),
          JSON.stringify(record.requiredTokens),
          record.requiredTokens.join(','),
          record.publishedTextHash,
          record.bodyTruncated,
          record.approvedBy ?? null,
          record.readBack === undefined ? null : JSON.stringify(record.readBack),
          record.readBack?.ok ?? null,
          record.readBack?.verifiedAtUnix ?? null,
          record.readBack?.deleted === true ? record.readBack.verifiedAtUnix : null,
        ],
      ),
    )
  }

  async get(externalId: string): Promise<PostRecord | null> {
    const rows = await guarded('publication', () =>
      this.driver.query(`SELECT ${POST_COLUMNS} FROM publication WHERE id = $1`, [externalId]),
    )
    const row = rows[0]
    return row === undefined ? null : rowToPost(row)
  }

  async setReadBack(externalId: string, outcome: ReadBackOutcome): Promise<void> {
    await guarded('publication', () =>
      this.driver.execute(
        `UPDATE publication
            SET read_back = $2::jsonb, read_back_verified = $3, read_back_at_unix = $4, deleted_at_unix = $5
          WHERE id = $1`,
        [
          externalId,
          JSON.stringify(outcome),
          outcome.ok,
          outcome.verifiedAtUnix,
          outcome.deleted ? outcome.verifiedAtUnix : null,
        ],
      ),
    )
  }

  async awaitingReadBack(beforeUnix: number): Promise<readonly PostRecord[]> {
    const rows = await guarded('publication', () =>
      this.driver.query(
        `SELECT ${POST_COLUMNS} FROM publication
          WHERE read_back IS NULL AND published_at_unix <= $1
          ORDER BY published_at_unix, id`,
        [beforeUnix],
      ),
    )
    return rows.map(rowToPost)
  }

  async all(): Promise<readonly PostRecord[]> {
    const rows = await guarded('publication', () =>
      this.driver.query(`SELECT ${POST_COLUMNS} FROM publication ORDER BY published_at_unix, id`),
    )
    return rows.map(rowToPost)
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export class PgAccountCredentialStore implements AccountCredentialStore {
  readonly #key: SealingKey

  /** `keyHex` is 32 bytes of hex (PUBLISHER_TOKEN_KEY). Refuses anything else. */
  constructor(
    private readonly driver: SqlDriver,
    keyHex: string,
  ) {
    if (typeof keyHex !== 'string' || keyHex.trim().length === 0) {
      throw new TypeError('PgAccountCredentialStore needs a sealing key; refusing to store OAuth tokens in the clear')
    }
    this.#key = sealingKeyFromHex(keyHex.trim())
  }

  async get(accountId: string): Promise<XCredentials | null> {
    const rows = await guarded('publisher_account_credential', () =>
      this.driver.query<{ key_id: unknown; sealed: unknown }>(
        'SELECT key_id, sealed FROM publisher_account_credential WHERE account_id = $1',
        [accountId],
      ),
    )
    const row = rows[0]
    if (row === undefined) return null
    const sealed = strFromSql(row.sealed, 'publisher_account_credential.sealed')
    const keyId = strFromSql(row.key_id, 'publisher_account_credential.key_id')
    if (keyId !== this.#key.id || sealedKeyId(sealed) !== this.#key.id) {
      throw new SecretUnopenableError(
        'key_mismatch',
        `credentials for ${accountId} were sealed under key ${keyId}; this process holds ${this.#key.id}`,
      )
    }
    const o = objectFromSql(openSecret(this.#key, sealed), 'publisher_account_credential.sealed')
    const f = 'publisher_account_credential'
    const refresh = o.refreshToken
    if (refresh !== null && typeof refresh !== 'string') throw new TypeError(`${f}.refreshToken is not a string`)
    return {
      accessToken: strFromSql(o.accessToken, `${f}.accessToken`),
      refreshToken: refresh,
      expiresAtUnix: countFromSql(o.expiresAtUnix, `${f}.expiresAtUnix`),
      scopes: stringArrayFromSql(o.scopes, `${f}.scopes`),
    }
  }

  async put(accountId: string, creds: XCredentials): Promise<void> {
    const sealed = sealSecret(
      this.#key,
      JSON.stringify({
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAtUnix: creds.expiresAtUnix,
        scopes: [...creds.scopes],
      }),
    )
    await guarded('publisher_account_credential', () =>
      this.driver.execute(
        `INSERT INTO publisher_account_credential (account_id, key_id, sealed, expires_at_unix)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id) DO UPDATE SET
             key_id = EXCLUDED.key_id, sealed = EXCLUDED.sealed, expires_at_unix = EXCLUDED.expires_at_unix`,
        [accountId, this.#key.id, sealed, creds.expiresAtUnix],
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// Label attestations
// ---------------------------------------------------------------------------

export class PgLabelAttestationStore implements LabelAttestationStore {
  constructor(private readonly driver: SqlDriver) {}

  async get(accountId: string): Promise<LabelAttestation | null> {
    const rows = await guarded('publisher_label_attestation', () =>
      this.driver.query(
        'SELECT account_id, attested_by, attested_at_unix, expires_at_unix FROM publisher_label_attestation WHERE account_id = $1',
        [accountId],
      ),
    )
    const row = rows[0]
    if (row === undefined) return null
    const f = 'publisher_label_attestation'
    return {
      accountId: strFromSql(row.account_id, `${f}.account_id`),
      attestedBy: strFromSql(row.attested_by, `${f}.attested_by`),
      attestedAtUnix: countFromSql(row.attested_at_unix, `${f}.attested_at_unix`),
      expiresAtUnix: countFromSql(row.expires_at_unix, `${f}.expires_at_unix`),
    }
  }

  async put(attestation: LabelAttestation): Promise<void> {
    await guarded('publisher_label_attestation', () =>
      this.driver.execute(
        `INSERT INTO publisher_label_attestation (account_id, attested_by, attested_at_unix, expires_at_unix)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id) DO UPDATE SET
             attested_by = EXCLUDED.attested_by, attested_at_unix = EXCLUDED.attested_at_unix,
             expires_at_unix = EXCLUDED.expires_at_unix`,
        [attestation.accountId, attestation.attestedBy, attestation.attestedAtUnix, attestation.expiresAtUnix],
      ),
    )
  }
}

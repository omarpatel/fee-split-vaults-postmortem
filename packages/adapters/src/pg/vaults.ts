/**
 * The orchestrator's vault record over Postgres.
 *
 * State and tier are the two fields the tick loop writes, and they are the two
 * an in-memory repository lost on every restart: a coin promoted to T1 came
 * back as T0 and was measured, promoted and announced again. The consent is
 * stored whole as JSONB because every field of it is immutable and the tick
 * loop reads its bps terms on every run; the enum columns are CHECKed so a
 * state this build does not know cannot be read back as one it does.
 */

import type { Address, Consent, Vault, VaultState } from '@fee-split-vaults/core'
import type { VaultRepository } from '@fee-split-vaults/orchestrator'
import type { TierId } from '../../../../config/protocol.js'
import { boolFromSql, enumFromSql, guarded, objectFromSql, optCountFromSql, strFromSql, withOptional } from './rows.js'
import { countFromSql, type SqlDriver } from './sql.js'

const STATES: readonly VaultState[] = [
  'UNBOUND',
  'PASSTHROUGH',
  'BOUND',
  'PENDING',
  'ACTIVE',
  'SUSPENDED',
  'POISONED',
  'TERMINATED',
]
const TIERS: readonly TierId[] = ['T0', 'T1', 'T2', 'T3']

const COLUMNS =
  'address, token, consent, state, tier, budget_bps, buyback_enabled, creator_tax_bps, deployed_at_unix, activated_at_unix'

function consentFromSql(value: unknown): Consent {
  const o = objectFromSql(value, 'vault_record.consent')
  const s = (key: keyof Consent): string => strFromSql(o[key], `vault_record.consent.${key}`)
  const n = (key: keyof Consent): number => countFromSql(o[key], `vault_record.consent.${key}`)
  return {
    devSigner: s('devSigner'),
    devPayout: s('devPayout'),
    token: s('token'),
    termsHash: s('termsHash'),
    operatorBps: n('operatorBps'),
    budgetBpsMax: n('budgetBpsMax'),
    adapter: s('adapter'),
    referrer: s('referrer'),
    referrerBps: n('referrerBps'),
    expiryUnix: n('expiryUnix'),
    nonce: s('nonce'),
  }
}

function rowToVault(row: Record<string, unknown>): Vault {
  const f = 'vault_record'
  const base: Vault = {
    address: strFromSql(row.address, `${f}.address`),
    token: strFromSql(row.token, `${f}.token`),
    consent: consentFromSql(row.consent),
    state: enumFromSql(row.state, STATES, `${f}.state`),
    tier: enumFromSql(row.tier, TIERS, `${f}.tier`),
    budgetBps: countFromSql(row.budget_bps, `${f}.budget_bps`),
    buybackEnabled: boolFromSql(row.buyback_enabled, `${f}.buyback_enabled`),
    creatorTaxBps: countFromSql(row.creator_tax_bps, `${f}.creator_tax_bps`),
    deployedAtUnix: countFromSql(row.deployed_at_unix, `${f}.deployed_at_unix`),
  }
  return withOptional(base, 'activatedAtUnix', optCountFromSql(row.activated_at_unix, `${f}.activated_at_unix`))
}

export class PgVaultRepository implements VaultRepository {
  constructor(private readonly driver: SqlDriver) {}

  async get(vault: Address): Promise<Vault | undefined> {
    const rows = await guarded('vault_record', () =>
      this.driver.query(`SELECT ${COLUMNS} FROM vault_record WHERE address = $1`, [vault.toLowerCase()]),
    )
    const row = rows[0]
    return row === undefined ? undefined : rowToVault(row)
  }

  async put(vault: Vault): Promise<void> {
    await guarded('vault_record', () =>
      this.driver.execute(
        `INSERT INTO vault_record (${COLUMNS})
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (address) DO UPDATE SET
             token = EXCLUDED.token, consent = EXCLUDED.consent, state = EXCLUDED.state,
             tier = EXCLUDED.tier, budget_bps = EXCLUDED.budget_bps,
             buyback_enabled = EXCLUDED.buyback_enabled, creator_tax_bps = EXCLUDED.creator_tax_bps,
             deployed_at_unix = EXCLUDED.deployed_at_unix, activated_at_unix = EXCLUDED.activated_at_unix`,
        [
          vault.address.toLowerCase(),
          vault.token.toLowerCase(),
          JSON.stringify(vault.consent),
          vault.state,
          vault.tier,
          vault.budgetBps,
          vault.buybackEnabled,
          vault.creatorTaxBps,
          vault.deployedAtUnix,
          vault.activatedAtUnix ?? null,
        ],
      ),
    )
  }

  async list(): Promise<Vault[]> {
    const rows = await guarded('vault_record', () =>
      this.driver.query(`SELECT ${COLUMNS} FROM vault_record ORDER BY deployed_at_unix, address`),
    )
    return rows.map(rowToVault)
  }
}

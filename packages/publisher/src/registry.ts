import type { DisclosureSpec } from './disclosure.js'
import type { AccountBinding, Address, Channel, RosterEntry } from './types.js'

/**
 * Trusted operator state. Nothing in here is ever derived from post content or
 * from anything a community member said: the ticker an account speaks for, and
 * the token address it may name, are configuration.
 *
 * Every method is asynchronous because the production registry is a Postgres
 * table; the in-memory version applies synchronously before it resolves.
 */
export interface AccountRegistry {
  get(channel: Channel, accountId: string): Promise<AccountBinding | null>
  /** Every client coin on the book. Used only to detect cross-promotion. */
  roster(): Promise<readonly RosterEntry[]>
}

export interface MutableAccountRegistry extends AccountRegistry {
  /** Also upserts the coin's roster entry. */
  bind(binding: AccountBinding): Promise<void>
  unbind(channel: Channel, accountId: string): Promise<void>
  addRosterEntry(entry: RosterEntry): Promise<void>
}

function key(channel: Channel, accountId: string): string {
  return `${channel}::${accountId.toLowerCase()}`
}

export function createInMemoryAccountRegistry(
  bindings: readonly AccountBinding[] = [],
  roster: readonly RosterEntry[] = [],
): MutableAccountRegistry {
  const accounts = new Map<string, AccountBinding>()
  const coins = new Map<string, RosterEntry>()

  for (const binding of bindings) accounts.set(key(binding.channel, binding.accountId), binding)
  for (const entry of roster) coins.set(entry.ticker.toUpperCase(), entry)

  return {
    async get(channel, accountId) {
      return accounts.get(key(channel, accountId)) ?? null
    },
    async roster() {
      return [...coins.values()]
    },
    async bind(binding) {
      accounts.set(key(binding.channel, binding.accountId), binding)
      coins.set(binding.ticker.toUpperCase(), {
        vault: binding.vault,
        token: binding.token,
        ticker: binding.ticker,
      })
    },
    async unbind(channel, accountId) {
      accounts.delete(key(channel, accountId))
    },
    async addRosterEntry(entry) {
      coins.set(entry.ticker.toUpperCase(), entry)
    },
  }
}

export interface ReadBackOutcome {
  externalId: string
  verifiedAtUnix: number
  ok: boolean
  /** Disclosure tokens that were absent from the live post. */
  missing: string[]
  deleted: boolean
  reason?: string
  deleteError?: string
}

export interface PostRecord {
  externalId: string
  vault: Address
  channel: Channel
  accountId: string
  correlationId: string
  publishedAtUnix: number
  isPromotional: boolean
  /** Rule ids from the classifier, so a verdict can be explained later. */
  classificationRules: string[]
  disclosure: DisclosureSpec
  requiredTokens: string[]
  /** Hash of the exact published text. The published bytes are the record. */
  publishedTextHash: string
  bodyTruncated: boolean
  approvedBy?: string
  readBack?: ReadBackOutcome
}

export interface PostRegistry {
  put(record: PostRecord): Promise<void>
  get(externalId: string): Promise<PostRecord | null>
  setReadBack(externalId: string, outcome: ReadBackOutcome): Promise<void>
  /** Posts published before `beforeUnix` with no read-back result yet. */
  awaitingReadBack(beforeUnix: number): Promise<readonly PostRecord[]>
  all(): Promise<readonly PostRecord[]>
}

export function createInMemoryPostRegistry(): PostRegistry {
  const records = new Map<string, PostRecord>()

  return {
    async put(record) {
      records.set(record.externalId, record)
    },
    async get(externalId) {
      return records.get(externalId) ?? null
    },
    async setReadBack(externalId, outcome) {
      const existing = records.get(externalId)
      if (existing !== undefined) records.set(externalId, { ...existing, readBack: outcome })
    },
    async awaitingReadBack(beforeUnix) {
      return [...records.values()].filter(
        (record) => record.readBack === undefined && record.publishedAtUnix <= beforeUnix,
      )
    },
    async all() {
      return [...records.values()]
    },
  }
}

import type { Channel } from './types.js'

/**
 * Platform account health, as an account state rather than a failed post.
 *
 * A suspended or locked X account used to be discovered the expensive way: a
 * publish failed, the failure was logged as a transport rejection, and the
 * next publish tried again. That is a retry storm against an enforcement
 * action, which is the one thing a platform appeal cannot survive. So the
 * account's standing is PROBED OUT OF BAND (GET /2/users/me under the
 * account's own token, see channels/x.ts) and RECORDED, and the publisher
 * refuses to post from an account whose latest recorded probe is not `ok` -
 * or is older than HEALTH_MAX_AGE_SECONDS, because an observation nobody has
 * refreshed in a day is not an observation.
 *
 * `unreachable` is a probe result, not an account state: the network, not X,
 * answered. The ops job does not persist it (it fails the run so the
 * scheduler retries), which is why a network blip does not halt publishing
 * while the previous conclusive `ok` is still fresh. The store therefore only
 * ever holds conclusive verdicts, and the freshness bound is what covers a
 * prolonged outage.
 *
 * The store is a port: the in-memory version below is for tests and the
 * sandbox; the Postgres version (adapters/pg/publisher-health.ts) keeps one
 * row per probe so the onset of a suspension is datable from history.
 */

export type ChannelHealthStatus = 'ok' | 'suspended' | 'locked' | 'unauthorized' | 'unreachable'

export interface ChannelHealthProbe {
  status: ChannelHealthStatus
  observedAtUnix: number
  /**
   * The platform's own words for the verdict (HTTP status plus the v2 problem
   * `type` and `detail`), bounded. Operator-facing only; never rendered to a
   * reader.
   */
  detail: string
}

export interface ChannelHealthRecord extends ChannelHealthProbe {
  channel: Channel
  accountId: string
}

export interface ChannelHealthStore {
  /** The latest recorded probe for the account, or null when it has never been probed. */
  get(channel: Channel, accountId: string): Promise<ChannelHealthRecord | null>
  /** Appends. History is kept; `get` reads the newest. */
  put(record: ChannelHealthRecord): Promise<void>
}

/** A health observation older than this is treated as absent. */
export const HEALTH_MAX_AGE_SECONDS = 24 * 3_600

/** Longest `detail` the store accepts. Matches the column CHECK in 0021. */
export const HEALTH_DETAIL_MAX_CHARS = 240

/** The channels whose accounts are probed. Others have no platform standing to observe. */
export const HEALTH_GATED_CHANNELS: readonly Channel[] = ['x_operator', 'x_client_delegated']

export type ChannelHealthVerdict = { ok: true } | { ok: false; reason: string; detail?: string }

/**
 * Pure: may the publisher post from an account given its latest probe. Every
 * doubt is a refusal - no probe, a non-ok probe, a probe older than the bound,
 * or a probe from the future (a skewed clock is not a fresh observation).
 */
export function channelHealthVerdict(
  record: ChannelHealthRecord | null,
  nowUnix: number,
  maxAgeSeconds: number = HEALTH_MAX_AGE_SECONDS,
): ChannelHealthVerdict {
  if (record === null) return { ok: false, reason: 'health_unobserved' }
  if (record.status !== 'ok') return { ok: false, reason: `channel_${record.status}`, detail: record.detail }
  const age = nowUnix - record.observedAtUnix
  if (age < 0 || age >= maxAgeSeconds) {
    return { ok: false, reason: 'health_stale', detail: `last ok observed ${String(age)}s ago; bound ${String(maxAgeSeconds)}s` }
  }
  return { ok: true }
}

export function boundHealthDetail(detail: string): string {
  return detail.length <= HEALTH_DETAIL_MAX_CHARS ? detail : `${detail.slice(0, HEALTH_DETAIL_MAX_CHARS - 1)}…`
}

function key(channel: Channel, accountId: string): string {
  return `${channel}::${accountId.toLowerCase()}`
}

export class InMemoryChannelHealthStore implements ChannelHealthStore {
  readonly #history = new Map<string, ChannelHealthRecord[]>()

  constructor(seed: readonly ChannelHealthRecord[] = []) {
    for (const record of seed) this.#history.set(key(record.channel, record.accountId), [record])
  }

  async get(channel: Channel, accountId: string): Promise<ChannelHealthRecord | null> {
    const rows = this.#history.get(key(channel, accountId))
    return rows === undefined ? null : (rows[rows.length - 1] ?? null)
  }

  async put(record: ChannelHealthRecord): Promise<void> {
    const k = key(record.channel, record.accountId)
    const rows = this.#history.get(k) ?? []
    rows.push({ ...record, detail: boundHealthDetail(record.detail) })
    this.#history.set(k, rows)
  }

  /** Every probe recorded for the account, oldest first. Tests read history through this. */
  history(channel: Channel, accountId: string): readonly ChannelHealthRecord[] {
    return this.#history.get(key(channel, accountId)) ?? []
  }
}

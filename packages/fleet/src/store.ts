/**
 * WHERE A TICK GOES AFTER IT HAPPENS.
 *
 * The orchestrator projects a CoinTickResult into an AgentRunRecord - counts,
 * machine codes and scrubbed gists, with the message bodies, post copy and
 * disbursement internals already dropped. This module is the other half: it
 * keeps those records, and it keeps two things the projection deliberately does
 * not carry because they belong to the RUN rather than to the coin.
 *
 *   THE RUN KEY. The scheduler's (job, scope, period) key. It is the reason a
 *   retry of a tick that already authorized a reimbursement does not authorize
 *   a second one: the store is asked first, and a hit ends the attempt.
 *   THE FAKED DEPENDENCIES. Which parts of this process were substitutes when
 *   this run was served. Recorded per run and never recomputed, because a
 *   process that later gains a credential must not be able to relabel the runs
 *   it already served with fakes.
 *
 * The SQL statements below are the only place ops_agent_run is written. The
 * schema's own CHECK constraints - an all-or-nothing digest, a known provenance,
 * a non-negative cost - are the backstop for anything that gets past here.
 */

import type { Address } from '@fee-split-vaults/core'
import {
  InMemoryAgentRunStore,
  clampLimit,
  parseCursor,
  type AgentRunPage,
  type AgentRunQuery,
  type AgentRunRecord,
  type AgentRunStore,
} from '@fee-split-vaults/orchestrator'

/** One stored run, with the two run-scoped facts the projection does not hold. */
export interface FleetRunRecord {
  /** The scheduler's key. Unique: the whole idempotency argument rests on it. */
  runKey: string
  run: AgentRunRecord
  /** Dependencies that were fakes for this run. Empty means nothing was faked. */
  faked: readonly string[]
  recordedAtUnix: number
}

export interface FleetAgentRunStore extends AgentRunStore {
  put(entry: FleetRunRecord): Promise<void>
  /** The re-entry check. A hit means this run key has already done its work. */
  findByRunKey(runKey: string): Promise<FleetRunRecord | undefined>
}

/**
 * In-memory runs. Wraps the orchestrator's own store rather than reimplementing
 * its paging, so the two cannot drift apart on what a cursor means.
 */
export class InMemoryFleetAgentRunStore implements FleetAgentRunStore {
  readonly #inner: InMemoryAgentRunStore
  readonly #byRunKey = new Map<string, FleetRunRecord>()

  constructor(maxPerVault = 500) {
    this.#inner = new InMemoryAgentRunStore(maxPerVault)
  }

  async put(entry: FleetRunRecord): Promise<void> {
    if (this.#byRunKey.has(entry.runKey)) return
    this.#byRunKey.set(entry.runKey, entry)
    await this.#inner.record(entry.run)
  }

  async record(run: AgentRunRecord): Promise<void> {
    await this.put({ runKey: run.id, run, faked: [], recordedAtUnix: run.atUnix })
  }

  async findByRunKey(runKey: string): Promise<FleetRunRecord | undefined> {
    return this.#byRunKey.get(runKey)
  }

  async list(vault: Address, query?: AgentRunQuery): Promise<AgentRunPage> {
    return this.#inner.list(vault, query)
  }

  async latest(vault: Address): Promise<AgentRunRecord | undefined> {
    return this.#inner.latest(vault)
  }
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export type SqlValue = string | number | boolean | null

/**
 * The narrow SQL surface this store needs, structurally typed for the same
 * reason ops states in its own driver: the package must build, typecheck and be
 * unit-tested with no database and no native module. Production passes the
 * PgDriver the scheduler already holds.
 */
export interface SqlLike {
  execute(sql: string, params?: readonly SqlValue[]): Promise<{ rowsAffected: number }>
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): Promise<T[]>
}

const COLUMNS = [
  'id',
  'run_key',
  'coin_ref',
  'vault',
  'tier',
  'at_unix',
  'next_due_unix',
  'ran_chain_poll',
  'ran_cognition',
  'window_id',
  'window_start_unix',
  'window_end_unix',
  'admitted_message_count',
  'dropped_message_count',
  'distinct_author_count',
  'reader_refusals',
  'rejected_gist_count',
  'topic_counts_json',
  'signals_json',
  'gists_json',
  'skipped',
  'freeze_level',
  'freeze_reason',
  'proposal_count',
  'proposals_json',
  'suppressed_count',
  'suppressed_json',
  'violation_count',
  'violations_json',
  'refusal_count',
  'refusals_json',
  'spend_count',
  'spends_json',
  'publish_count',
  'publishes_json',
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cost_micro_usd',
  'degrade_level',
  'model_provenance',
  'faked_dependencies',
  'recorded_at_unix',
] as const

interface AgentRunRow {
  [column: string]: unknown
}

export class SqlAgentRunStore implements FleetAgentRunStore {
  constructor(private readonly driver: SqlLike) {}

  async put(entry: FleetRunRecord): Promise<void> {
    const run = entry.run
    const digest = run.digest
    const placeholders = COLUMNS.map((_, i) => `$${String(i + 1)}`).join(', ')
    const params: SqlValue[] = [
      run.id,
      entry.runKey,
      run.coinRef,
      run.vault,
      run.tier,
      run.atUnix,
      run.nextDueUnix,
      run.ranChainPoll,
      run.ranCognition,
      digest?.windowId ?? null,
      digest?.windowStartUnix ?? null,
      digest?.windowEndUnix ?? null,
      // NULL, not 0. "We did not measure" and "we measured nothing" are
      // different facts and the schema keeps them different.
      digest?.admittedMessageCount ?? null,
      digest?.droppedMessageCount ?? null,
      digest?.distinctAuthorCount ?? null,
      digest?.readerRefusals ?? null,
      digest?.rejectedGistCount ?? null,
      digest === undefined ? null : JSON.stringify(digest.topicCounts),
      digest === undefined ? null : JSON.stringify(digest.signals),
      digest === undefined ? null : JSON.stringify(digest.gists),
      run.skipped ?? null,
      run.freeze?.level ?? null,
      run.freeze?.reason ?? null,
      run.proposals.length,
      JSON.stringify(run.proposals),
      run.suppressed.length,
      JSON.stringify(run.suppressed),
      run.violations.length,
      JSON.stringify(run.violations),
      run.refusals.length,
      JSON.stringify(run.refusals),
      run.spends.length,
      JSON.stringify(run.spends),
      run.publishes.length,
      JSON.stringify(run.publishes),
      run.cost.usage.inputTokens,
      run.cost.usage.outputTokens,
      run.cost.usage.cacheCreationInputTokens,
      run.cost.usage.cacheReadInputTokens,
      // A bigint crosses as a decimal string: BIGINT accepts it, and a JS number
      // would silently lose precision the day the meter is busy enough to need it.
      run.cost.microUsd.toString(),
      run.cost.degradeLevel,
      run.modelProvenance,
      // Never NULL. "Nothing was faked" is a claim, and it is made explicitly.
      entry.faked.join(','),
      entry.recordedAtUnix,
    ]

    // ON CONFLICT DO NOTHING with no target, because BOTH unique columns are
    // idempotency guarantees: the id catches a re-projection of the same tick,
    // the run key catches a retry of the same scheduled run.
    await this.driver.execute(
      `INSERT INTO ops_agent_run (${COLUMNS.join(', ')}) VALUES (${placeholders})
       ON CONFLICT DO NOTHING`,
      params,
    )
  }

  async record(run: AgentRunRecord): Promise<void> {
    await this.put({ runKey: run.id, run, faked: [], recordedAtUnix: run.atUnix })
  }

  async findByRunKey(runKey: string): Promise<FleetRunRecord | undefined> {
    const rows = await this.driver.query<AgentRunRow>(
      `SELECT ${COLUMNS.join(', ')} FROM ops_agent_run WHERE run_key = $1`,
      [runKey],
    )
    const row = rows[0]
    return row === undefined ? undefined : toFleetRecord(row)
  }

  async list(vault: Address, query: AgentRunQuery = {}): Promise<AgentRunPage> {
    const limit = clampLimit(query.limit)
    const offset = parseCursor(query.cursor)
    // One extra row, so "is there a next page" is answered without a COUNT.
    const rows = await this.driver.query<AgentRunRow>(
      `SELECT ${COLUMNS.join(', ')} FROM ops_agent_run
        WHERE lower(vault) = lower($1)
        ORDER BY at_unix DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [vault, limit + 1, offset],
    )
    const page = rows.slice(0, limit).map((row) => toFleetRecord(row).run)
    return {
      runs: page,
      ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
    }
  }

  async latest(vault: Address): Promise<AgentRunRecord | undefined> {
    const page = await this.list(vault, { limit: 1 })
    return page.runs[0]
  }
}

function text(row: AgentRunRow, column: string): string {
  const value = row[column]
  return typeof value === 'string' ? value : String(value ?? '')
}

function int(row: AgentRunRow, column: string): number {
  const value = row[column]
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number.parseInt(value, 10)
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function optionalInt(row: AgentRunRow, column: string): number | undefined {
  const value = row[column]
  return value === null || value === undefined ? undefined : int(row, column)
}

function bool(row: AgentRunRow, column: string): boolean {
  const value = row[column]
  return value === true || value === 't' || value === 'true' || value === 1
}

function json<T>(row: AgentRunRow, column: string, fallback: T): T {
  const value = row[column]
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    // A row that does not parse is a corrupt row. It is not silently rendered
    // as an empty list, because "the planner proposed nothing" would be a lie.
    throw new Error(`ops_agent_run.${column} is not valid JSON for run ${text(row, 'id')}`)
  }
}

/** One row back into a record. Kept beside the writer so the two stay in step. */
export function toFleetRecord(row: AgentRunRow): FleetRunRecord {
  const provenance = text(row, 'model_provenance')
  const run = {
    id: text(row, 'id'),
    coinRef: text(row, 'coin_ref'),
    vault: text(row, 'vault'),
    atUnix: int(row, 'at_unix'),
    tier: text(row, 'tier'),
    ranChainPoll: bool(row, 'ran_chain_poll'),
    ranCognition: bool(row, 'ran_cognition'),
    nextDueUnix: int(row, 'next_due_unix'),
    proposals: json(row, 'proposals_json', []),
    suppressed: json(row, 'suppressed_json', []),
    violations: json(row, 'violations_json', []),
    refusals: json(row, 'refusals_json', []),
    spends: json(row, 'spends_json', []),
    publishes: json(row, 'publishes_json', []),
    cost: {
      microUsd: BigInt(text(row, 'cost_micro_usd') || '0'),
      usage: {
        inputTokens: int(row, 'input_tokens'),
        outputTokens: int(row, 'output_tokens'),
        cacheCreationInputTokens: int(row, 'cache_creation_input_tokens'),
        cacheReadInputTokens: int(row, 'cache_read_input_tokens'),
      },
      degradeLevel: text(row, 'degrade_level'),
    },
    modelProvenance: provenance === 'live' || provenance === 'fake' ? provenance : 'unknown',
  } as AgentRunRecord

  const windowId = row.window_id
  if (typeof windowId === 'string') {
    run.digest = {
      windowId,
      windowStartUnix: int(row, 'window_start_unix'),
      windowEndUnix: int(row, 'window_end_unix'),
      admittedMessageCount: int(row, 'admitted_message_count'),
      droppedMessageCount: int(row, 'dropped_message_count'),
      distinctAuthorCount: int(row, 'distinct_author_count'),
      topicCounts: json(row, 'topic_counts_json', []),
      signals: json(row, 'signals_json', []),
      gists: json(row, 'gists_json', []),
      rejectedGistCount: optionalInt(row, 'rejected_gist_count') ?? 0,
      readerRefusals: int(row, 'reader_refusals'),
    }
  }
  const skipped = row.skipped
  if (typeof skipped === 'string') run.skipped = skipped
  const freezeLevel = row.freeze_level
  if (freezeLevel === 'purchases' || freezeLevel === 'all') {
    run.freeze = { level: freezeLevel, reason: text(row, 'freeze_reason') }
  }

  const faked = text(row, 'faked_dependencies')
  return {
    runKey: text(row, 'run_key'),
    run,
    faked: faked.length === 0 ? [] : faked.split(','),
    recordedAtUnix: int(row, 'recorded_at_unix'),
  }
}

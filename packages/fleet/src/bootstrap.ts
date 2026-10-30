/**
 * BRINGING A FLEET UP.
 *
 * One function, called by both things that can start the agent teams - the ops
 * scheduler through its ports module, and the fleet CLI - so that there is one
 * answer to "what is real in this process" rather than two that can disagree.
 *
 * THE ORDER MATTERS. The model client is resolved FIRST, because the answer
 * changes what the rest of the process is allowed to do: a scripted model may
 * not author copy that a real channel transport then sends. That rule is
 * enforced below rather than described, and it is the reason a sandbox run
 * cannot become a real post by someone setting one more environment variable.
 */

import type { ModelClient } from '@fee-split-vaults/runtime'
import { MergedMessageSource, type SqlDriver } from '@fee-split-vaults/adapters'
import { fixedClock, systemClock, type Clock, type DeskPort } from '@fee-split-vaults/orchestrator'
import {
  assertDryRunAsksForNothingReal,
  deployBlockResolver,
  realTransportsRequested,
  resolveAdapters,
  resolveFoundation,
  resolveLiveAssets,
  resolveSignals,
  type Foundation,
  type LiveChain,
  type ResolvedAdapters,
  type SyncResult,
} from './adapters.js'
import { CoinDirectory, parseCoinDirectory, type CoinDefinition } from './coins.js'
import { PgCoinDirectory } from './directory-pg.js'
import { FleetStartupRefused } from './errors.js'
import {
  SubstitutionLedger,
  resolveModelClient,
  startupBanner,
  type ModelProvenance,
} from './credentials.js'
import { fixtureSeeds } from './fixtures.js'
import { Fleet, FleetTickRefused, type RegisteredCoin } from './runner.js'
import { createSandboxWorld, type SandboxSeed, type SandboxWorld } from './sandbox.js'
import { InMemoryFleetAgentRunStore, type FleetAgentRunStore } from './store.js'

export { FleetStartupRefused } from './errors.js'

export interface BootstrapOptions {
  nowUnix: number
  /** Defaults to process.env. Injected so startup is testable. */
  env?: Record<string, string | undefined>
  /** Overrides the fixture fleet. A JSON directory is read from FLEET_COINS_FILE. */
  seeds?: readonly SandboxSeed[]
  /** Where run records go. Defaults to memory; the scheduler passes the SQL store. */
  store?: FleetAgentRunStore
  /** Force the scripted model client and refuse every side effect. */
  dryRun?: boolean
  /** Injected in tests, so credential resolution can be exercised both ways. */
  construct?: (apiKey?: string) => Promise<ModelClient>
  /** Read a coin directory file. Injected so startup needs no filesystem in tests. */
  readFile?: (path: string) => string
  /**
   * A Postgres driver, when the process has one.
   *
   * Its presence is what turns the spend counters and the escalation sink from
   * in-memory objects into durable ones. Counters held in memory reset on every
   * restart, and a spend cap that resets is a cap that can be cleared by
   * crashing the process.
   */
  driver?: SqlDriver
  /**
   * The holder desk, when the process built one. Handed to every coin's
   * ticker; absent means the desk phase records `desk_unavailable`.
   */
  desk?: DeskPort
}

export interface BootstrappedFleet {
  fleet: Fleet
  world: SandboxWorld
  store: FleetAgentRunStore
  directory: CoinDirectory
  substitutions: SubstitutionLedger
  provenance: ModelProvenance
  /**
   * The live chain, when FLEET_CHAIN=live resolved one.
   *
   * Absent for a sandbox fleet. The caller needs it because a live chain read
   * model only answers windows its cursor has actually reached: something has
   * to call `sync()` to move that cursor forward before a tick asks about a
   * window, and the honest alternative to syncing is a refusal, not a guess.
   */
  chain?: LiveChain
  /** Everything the loader resolved for real. The ops ports module reads its own ports out of this. */
  adapters: ResolvedAdapters
  /** Already rendered. Print it before the first tick, not after. */
  banner: string
}

/**
 * A scripted model must never author something a real transport sends.
 *
 * `transportsAreReal` is the TRUE answer to "is the publisher's last hop a
 * platform API": it is computed from what the adapter loader actually
 * resolved, never from what was asked for. This is what stops a run with no
 * model credential from posting scripted copy into a client's community.
 */
export function assertNoFakeAuthoredRealSend(
  provenance: ModelProvenance,
  transportsAreReal: boolean,
): void {
  if (provenance !== 'live' && transportsAreReal) {
    throw new FleetStartupRefused(
      'a scripted model client is configured alongside real channel transports; ' +
        'scripted copy must never reach a real channel',
    )
  }
}

export async function bootstrapFleet(options: BootstrapOptions): Promise<BootstrappedFleet> {
  const env = options.env ?? process.env
  const substitutions = new SubstitutionLedger()
  const dryRun = options.dryRun === true

  // A DRY RUN IS ALL FAKES OR NOTHING. Checked before anything is built, so
  // an environment that asks for a live settlement port under --dry-run is
  // refused rather than quietly handed the fake.
  if (dryRun) assertDryRunAsksForNothingReal(env)

  // 1. THE MODEL. Constructed and allowed to throw; the throw is the answer.
  const model = await resolveModelClient({
    env,
    ...(dryRun ? { forceFake: true } : {}),
    ...(options.construct === undefined ? {} : { construct: options.construct }),
  })
  if (model.provenance === 'live') {
    substitutions.real('model', model.detail)
  } else {
    substitutions.fake('model', model.detail, false)
  }

  // 2. THE CLOCK. Decided from the environment before any store is built,
  //    because the stores stamp with it. Real transports get the system clock;
  //    a sandbox gets a settable one that `prepare` moves to the instant the
  //    scheduler asked for.
  const sandboxClock = realTransportsRequested(env) ? undefined : fixedClock(options.nowUnix)
  const clock: Clock = sandboxClock ?? systemClock

  // 3. THE FOUNDATION: the durable stores and the vendor catalog. Built before
  //    the coins because a database directory is read out of those stores.
  const foundation = resolveFoundation({
    env,
    substitutions,
    clock,
    ...(options.driver === undefined ? {} : { driver: options.driver }),
  })

  // 4. THE COINS. Resolved before the remaining adapters, because the live
  //    chain needs the directory: it tracks one vault per coin, from that
  //    coin's own deployment block.
  const seeds = options.seeds ?? (await seedsFromEnv(env, options, foundation))
  if (seeds.length === 0) throw new FleetStartupRefused('the coin directory is empty')
  const directory = new CoinDirectory(seeds.map((seed) => seed.definition))

  // 5. THE ADAPTERS. An operator who asked for a real dependency meant it, so
  //    anything that cannot be honoured is a REFUSAL to start, never a quiet
  //    fall back to fixtures. Falling back would be the single most dangerous
  //    default in this file: a production deployment that reports healthy while
  //    ticking fictional coins. `resolveAdapters` throws rather than returning
  //    a partial result, so there is no half-real world to reason about here.
  const adapters: ResolvedAdapters = resolveAdapters({
    env,
    coins: directory.list(),
    substitutions,
    clock,
    foundation,
    ...(options.driver === undefined ? {} : { driver: options.driver }),
  })

  // A coin from a FILE against a durable vault repository must already have a
  // record there: the sandbox writes fixture consents only into the in-memory
  // repository, and a file names no consent to write. (A database directory
  // refused any coin without one on load.)
  if (adapters.persistence !== undefined) {
    for (const coin of directory.list()) {
      const held = await adapters.persistence.vaults.get(coin.vault)
      if (held === undefined) {
        throw new FleetStartupRefused(
          `coin "${coin.coinRef}" has no vault_record row for ${coin.vault}; with DATABASE_URL the vault ` +
            'repository is Postgres and a coin without a record there would refuse every tick as vault_unknown',
        )
      }
    }
  }

  // 5b. THE ASSETS AND THE SIGNALS, which read the chain and so come after it.
  //     A live chain with a database describes every quote asset from its
  //     contract and the quote_asset table; the signals need that registry
  //     (decimals price the volume) plus the holder replay, so they resolve
  //     last. Neither is asked for by a switch of its own: they are what a
  //     live chain with a database MEANS, and a fleet that read a real chain
  //     while assuming decimals or inventing buyers is the outcome this file
  //     refuses.
  if (adapters.chain !== undefined && options.driver !== undefined) {
    adapters.assets = await resolveLiveAssets(adapters.chain, options.driver, directory.list(), substitutions)
    if (adapters.holders !== undefined) {
      if (adapters.prices === undefined) {
        throw new FleetStartupRefused(
          'FLEET_HOLDERS=index builds the qualification signals, and the pool-share signal prices volume; ' +
            'set FLEET_PRICES=coingecko',
        )
      }
      adapters.signals = resolveSignals({
        chain: adapters.chain,
        holders: adapters.holders,
        assets: adapters.assets,
        prices: adapters.prices,
        ...(adapters.evidence === undefined ? {} : { evidence: adapters.evidence }),
        clock,
      })
      substitutions.real(
        'signals',
        'unique buyers and self-trade from indexed trades, top-10/deployer share from the holder replay, ' +
          `pool share from postings against ${adapters.evidence === undefined ? 'NO aggregator (post-graduation samples REFUSE)' : 'Dexscreener 24h volume'}`,
      )
    }
  }

  // A REAL SETTLEMENT PORT NEEDS THE REAL REGISTRY. A pull is sized in minor
  // units of an asset whose decimals the registry states; a port that would
  // broadcast a pull sized on an assumed six decimals is a real transfer of
  // an assumed amount.
  if (adapters.settlement !== undefined && adapters.assets === undefined) {
    throw new FleetStartupRefused(
      'FLEET_SETTLEMENT=live needs DATABASE_URL: the asset registry a pull is sized against is read from the chain and ' +
        'quote_asset, and without a database the registry is the sandbox fixture',
    )
  }

  // THE SALT is a secret. The sandbox derives one from the coin ref, which is
  // fine for fixtures and a thin coat for anyone real; beside ANY real
  // dependency - a real chain, a real store, a real model whose prompts carry
  // hashed ids - it is refused rather than used.
  const userIdSalt = env.FLEET_USER_ID_SALT?.trim()
  if ((userIdSalt === undefined || userIdSalt.length === 0) && substitutions.realDependencies.length > 0) {
    throw new FleetStartupRefused(
      `FLEET_USER_ID_SALT is required beside a real dependency (${substitutions.realDependencies.map((r) => r.dependency).join(', ')}): ` +
        'the sandbox salt is derived from the coin ref, and a real holder id hashed under it is not pseudonymous',
    )
  }
  if (userIdSalt !== undefined && userIdSalt.length > 0) substitutions.real('userIdSalt', 'FLEET_USER_ID_SALT')

  // 6. THE WORLD. Every substitution it makes is recorded as it is made, and
  //    anything the adapters resolved for real is handed in so the world does
  //    NOT record a fake for it. That is the whole seam: the world builds the
  //    fixture for a dependency only when nothing real was supplied.
  const persistence = adapters.persistence
  // THE DESK: the one handed in, else the one the loader built (loaded once,
  // so yesterday's refusals are on file before the first question).
  if (adapters.desk !== undefined) await adapters.desk.load()
  const desk: DeskPort | undefined = options.desk ?? adapters.desk?.port
  const liveMessages = adapters.messages
  const world = createSandboxWorld({
    nowUnix: options.nowUnix,
    seeds,
    model: model.client,
    ledger: substitutions,
    clock,
    ...(adapters.chain === undefined ? {} : { chain: adapters.chain.model }),
    ...(adapters.counters === undefined ? {} : { fleetCounters: adapters.counters }),
    ...(adapters.escalations === undefined ? {} : { escalations: adapters.escalations }),
    ...(persistence === undefined
      ? {}
      : {
          vaults: persistence.vaults,
          screening: persistence.screening,
          receipts: persistence.receipts,
          approvals: persistence.approvals,
          invoices: persistence.invoices,
          ledgerStore: persistence.ledgerStore,
          images: persistence.images,
          predicates: persistence.predicates,
          pending: persistence.pending,
        }),
    ...(adapters.prices === undefined ? {} : { prices: adapters.prices }),
    ...(adapters.evidence === undefined ? {} : { evidence: adapters.evidence }),
    ...(adapters.catalog === undefined ? {} : { catalog: adapters.catalog }),
    ...(adapters.settlement === undefined
      ? {}
      : { settlement: adapters.settlement.port, treasury: adapters.settlement.treasury }),
    // One stream for the fleet, handed to every coin: the source filters by
    // coin on read and refuses a cross-coin row rather than filtering it. X
    // mentions, when they resolved, are merged into the same per-coin source.
    ...(liveMessages === undefined
      ? {}
      : {
          messages: () =>
            adapters.mentions === undefined
              ? liveMessages.source
              : new MergedMessageSource([liveMessages.source, adapters.mentions.source]),
        }),
    ...(adapters.publisher === undefined ? {} : { publisher: adapters.publisher }),
    ...(userIdSalt === undefined || userIdSalt.length === 0 ? {} : { userIdSalt }),
    ...(adapters.assets === undefined ? {} : { assets: adapters.assets }),
    ...(adapters.signals === undefined ? {} : { signals: adapters.signals }),
    ...(adapters.policyKeyring === undefined ? {} : { policyKeyring: adapters.policyKeyring }),
    ...(desk === undefined ? {} : { desk }),
  })

  // The true value, from what resolved: a live publisher is the only thing in
  // this process whose last hop is a platform API.
  assertNoFakeAuthoredRealSend(model.provenance, adapters.publisher !== undefined)

  if (env.FLEET_REFUSE_FAKES === '1' && substitutions.anyFake) {
    throw new FleetStartupRefused(
      `FLEET_REFUSE_FAKES=1 and these dependencies are fakes: ${substitutions.names().join(', ')}`,
    )
  }

  // A DRY RUN PERSISTS NOTHING. It is not a flag the ports respect one by one -
  // it is a store swap, so there is no path by which a dry run writes a row.
  // Combined with the forced scripted client (which cannot propose a purchase)
  // this makes "dry run" a property of the wiring rather than a promise.
  const store = dryRun ? new InMemoryFleetAgentRunStore() : (options.store ?? new InMemoryFleetAgentRunStore())
  const coins = new Map<string, RegisteredCoin>()
  for (const [coinRef, registered] of world.coins) coins.set(coinRef, registered)

  const prices = adapters.prices
  const messages = adapters.messages
  const liveChain = adapters.chain === undefined ? undefined : memoizedSync(adapters.chain)
  const holders = adapters.holders
  const mentions = adapters.mentions
  let lastMentionsPoll: number | undefined
  const fleet = new Fleet({
    coins,
    store,
    provenance: model.provenance,
    faked: substitutions.names(),
    prepare: async (coinRef, nowUnix) => {
      // The sandbox clock is what a fixture tick reads, so it is moved to the
      // instant the scheduler asked for. A real clock is left alone: it is
      // already that instant, or the scheduler is wrong and moving a real
      // clock would hide it.
      sandboxClock?.set(nowUnix)
      // THE CHAIN, BEFORE THE TICK ASKS IT ANYTHING. A live read model answers
      // only about windows its cursor has reached and refuses the rest, so
      // something has to move the cursor, and the only honest something is a
      // scan. Once per instant, not once per coin: the scan is fleet-wide.
      if (liveChain !== undefined) {
        const coin = coins.get(coinRef)
        if (coin === undefined) throw new FleetTickRefused(coinRef, 'not a coin this fleet holds')
        await assertChainCurrent(liveChain, coin.config.vault, coinRef, nowUnix)
        if (holders !== undefined) await holders.sync(nowUnix)
      }
      // A live price feed re-pins continuously and the spend path refuses a
      // price older than fifteen minutes, so the pins move with the tick -
      // fetched from the feed when it is real, written by hand when it is not.
      // Otherwise every spend would refuse on staleness alone and the refusal
      // would say nothing about the coin.
      if (prices === undefined) {
        world.repin(nowUnix)
      } else {
        await prices.refreshAll()
      }
      // The message stream is a consuming stream: it is drained into the store
      // before the tick reads its window from that store. Fixture text is
      // seeded only into fixture sources (seedWindow is a no-op otherwise).
      if (messages === undefined) {
        world.seedWindow(coinRef, nowUnix)
      } else {
        await messages.poll()
      }
      // X mentions are polled on their own cadence: the API is rate-limited
      // per account, and every coin ticking at one instant shares one poll.
      if (mentions !== undefined && (lastMentionsPoll === undefined || nowUnix - lastMentionsPoll >= mentions.pollSeconds)) {
        lastMentionsPoll = nowUnix
        await mentions.poll()
      }
    },
  })

  return {
    fleet,
    world,
    store,
    directory,
    substitutions,
    provenance: model.provenance,
    ...(liveChain === undefined ? {} : { chain: liveChain }),
    adapters,
    banner: startupBanner(substitutions, model.provenance),
  }
}

/**
 * One scan per instant, however many coins tick at it. The CLI syncs before
 * a pass and `prepare` syncs before each coin; both go through this, so the
 * second call at the same instant is the first call's result rather than a
 * second walk over the same blocks.
 */
export function memoizedSync(chain: LiveChain): LiveChain {
  let last: { atUnix: number; result: Promise<SyncResult> } | undefined
  return {
    ...chain,
    sync: (nowUnix: number): Promise<SyncResult> => {
      if (last !== undefined && last.atUnix === nowUnix) return last.result
      const result = chain.sync(nowUnix)
      last = { atUnix: nowUnix, result }
      // A failed sync is not cached: the next caller retries the scan rather
      // than inheriting the failure.
      result.catch(() => {
        if (last?.result === result) last = undefined
      })
      return result
    },
  }
}

/**
 * Sync, then refuse the tick if this coin's coverage is further behind the
 * instant than the operator's lag bound.
 *
 * A vault that ran out of range budget this pass has NOT caught up. That is
 * the normal state of a cold cursor and it is not, by itself, a refusal: the
 * read model still answers windows the watermark reaches. It becomes one when
 * the watermark is absent or older than FLEET_MAX_COVERAGE_LAG_SECONDS,
 * because then every window the tick would ask about is one nobody has read,
 * and the honest answer is a typed refusal here rather than a coverage gap
 * three phases in.
 */
export async function assertChainCurrent(chain: LiveChain, vault: string, coinRef: string, nowUnix: number): Promise<void> {
  let result: SyncResult
  try {
    result = await chain.sync(nowUnix)
  } catch (error) {
    throw new FleetTickRefused(coinRef, `chain sync failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const behind = result.stillBehind.some((v) => v.toLowerCase() === vault.toLowerCase())
  const feeBehind = chain.indexer !== undefined && result.feeCoverageThroughUnix === undefined
  if (!behind && !feeBehind) return

  const streams: Array<{ stream: 'vault_movements' | 'fees'; scope: string }> = [
    ...(behind ? [{ stream: 'vault_movements' as const, scope: vault }] : []),
    ...(feeBehind ? [{ stream: 'fees' as const, scope: 'fleet' }] : []),
  ]
  for (const { stream, scope } of streams) {
    const cursor = await chain.cursors.get(stream, scope)
    const watermark = cursor?.blockTimestampUnix
    const lag = watermark === undefined ? undefined : nowUnix - watermark
    if (lag !== undefined && lag <= chain.maxCoverageLagSeconds) continue
    throw new FleetTickRefused(
      coinRef,
      `chain scan still behind on ${stream}/${scope}: ` +
        (lag === undefined
          ? 'no coverage watermark yet (cold backfill in progress)'
          : `coverage is ${String(lag)}s behind the tick, bound is ${String(chain.maxCoverageLagSeconds)}s`) +
        '; a tick now would ask about blocks nobody has read',
    )
  }
}

/**
 * The coin directory the environment names.
 *
 *   FLEET_COINS_SOURCE=db    the control plane's `onboarding` table, in Postgres
 *   FLEET_COINS_SOURCE=file  a JSON directory at FLEET_COINS_FILE
 *   unset                    `file` when FLEET_COINS_FILE is set, else the fixtures
 *
 * A coin file carries the definition - refs, addresses, catalog, accounts - and
 * not the demand, because demand is a fact about the chain. Every coin from a
 * file or a database therefore gets the same synthetic demand profile, which
 * the sandbox world only ever writes into the FIXTURE chain; on a live chain
 * the profile is unused and the coin has exactly the history the chain has.
 *
 * FIXTURES NEVER MEET A LIVE CHAIN. Fixture coins have synthetic addresses; a
 * scan for them would be a scan for nothing, reported as a coin with no fees.
 */
async function seedsFromEnv(
  env: Record<string, string | undefined>,
  options: BootstrapOptions,
  foundation: Foundation,
): Promise<SandboxSeed[]> {
  const raw = env.FLEET_COINS_SOURCE?.trim().toLowerCase()
  const file = env.FLEET_COINS_FILE
  const source = raw === undefined || raw.length === 0 ? (file === undefined || file.length === 0 ? 'fixtures' : 'file') : raw
  const liveChain = (env.FLEET_CHAIN ?? '').trim().toLowerCase() === 'live'

  if (source === 'fixtures') {
    if (liveChain) {
      throw new FleetStartupRefused(
        'FLEET_CHAIN=live with no coin directory would scan the chain for fixture coins that do not exist ' +
          'there. Set FLEET_COINS_SOURCE=db or FLEET_COINS_FILE.',
      )
    }
    return fixtureSeeds()
  }

  let definitions: CoinDefinition[]
  if (source === 'file') {
    if (file === undefined || file.length === 0) {
      throw new FleetStartupRefused('FLEET_COINS_SOURCE=file needs FLEET_COINS_FILE')
    }
    if (options.readFile === undefined) {
      throw new FleetStartupRefused('FLEET_COINS_FILE is set but no file reader was provided')
    }
    definitions = parseCoinDirectory(options.readFile(file)).list()
  } else if (source === 'db') {
    definitions = (await loadDatabaseDirectory(env, options, foundation)).list()
  } else {
    throw new FleetStartupRefused(
      `FLEET_COINS_SOURCE=${source} is not a source this build knows. Use "db", "file", or leave it unset.`,
    )
  }

  return definitions.map((definition) => ({
    definition,
    postingDays: 14,
    usdPerDay: 1_000,
    screening: 'CLEAR' as const,
    windowMessages: 6,
    devPayout: '0x3333333333333333333333333333333333333333',
  }))
}

/**
 * The database directory, read out of the foundation's stores.
 *
 * The deployment-block resolver is the live chain's primary endpoint, built
 * only when the chain is live: a sandbox fleet over database coins has no
 * chain to ask and no block to need.
 */
async function loadDatabaseDirectory(
  env: Record<string, string | undefined>,
  options: BootstrapOptions,
  foundation: Foundation,
): Promise<CoinDirectory> {
  const persistence = foundation.persistence
  if (options.driver === undefined || persistence === undefined) {
    throw new FleetStartupRefused('FLEET_COINS_SOURCE=db needs DATABASE_URL; the onboarding table is in Postgres')
  }
  const liveChain = (env.FLEET_CHAIN ?? '').trim().toLowerCase() === 'live'
  const receiptsBaseUrl = env.PUBLISHER_RECEIPTS_BASE_URL?.trim()

  return new PgCoinDirectory({
    driver: options.driver,
    vaults: persistence.vaults,
    images: persistence.images,
    ...(foundation.catalog === undefined ? {} : { catalog: foundation.catalog }),
    ...(receiptsBaseUrl === undefined || receiptsBaseUrl.length === 0 ? {} : { receiptsBaseUrl }),
    ...(liveChain ? { deployBlock: deployBlockResolver(env) } : {}),
  }).load()
}

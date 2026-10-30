/**
 * The poller.
 *
 * One tick is: resolve the watch set, agree a head and a finalized head across
 * two providers, reconcile any reorg, scan three bounded log queries, attribute
 * what came back, promote finalized postings, and run the watchers.
 *
 * The watch set comes from consent issuance and nowhere else. Venue launches are
 * permissionless and run at roughly 25,000 a day; every query this class builds
 * is filtered to coins we issued a consent for, and assertBoundedLogQuery
 * refuses anything wider before it reaches a provider. Cost scales with our
 * customer count, not with the chain.
 *
 * Ticks are idempotent. Posting ids are pure functions of chain position, so a
 * crash mid-tick, an overlapping range, or a re-scan after a reorg all converge
 * on the same rows. That is what makes it safe for the cursor to advance only
 * after a range has been fully processed.
 */

import type { Address } from '@fee-split-vaults/core'
import {
  assertPinnedTopics,
  CREATOR_FEE_RECIPIENT_CHANGE_CANCELLED,
  CREATOR_FEE_RECIPIENT_CHANGE_PROPOSED,
  CREATOR_FEE_RECIPIENT_UPDATED,
  CURVE_BUY,
  CURVE_SELL,
  decodeLaunchedToken,
  derivePoolId,
  encodeAddressArgCall,
  GET_LAUNCHED_TOKEN_SELECTOR,
  POOL_FEES_SWEPT,
  POOL_REGISTERED,
  TOKEN_LAUNCHED,
  type LaunchedToken,
} from './abi.js'
import {
  attributeFeeLogs,
  bindingFromLaunch,
  confirmPoolRegistration,
  decodeLaunch,
  decodePoolRegistration,
} from './attribution.js'
import { ChainTracker, type ChainTrackerOptions, type ReorgOutcome } from './chain.js'
import { DecodeError, WatchSetError } from './errors.js'
import { addressEquals, addressToTopic, normalizeAddress, normalizeHash32, type Hex } from './hex.js'
import type { CoinBinding, IssuedVault, LaunchFacts, WatchTarget } from './model.js'
import { VENUE } from './protocol.js'
import type { QuorumRpc } from './quorum.js'
import { DEFAULT_QUERY_LIMITS, type BlockRef, type LogQuery, type QueryLimits, type RpcLog } from './rpc.js'
import { effectiveIntervalSeconds } from './schedule.js'
import type { CursorKey, IndexerStore } from './store.js'
import {
  OwnerOverrideWatcher,
  RecipientWatcher,
  type HaltNotice,
  type HaltSink,
} from './watchers.js'

/** The bound on everything this package does. Issued consents only. */
export interface VaultRegistry {
  issued(): Promise<readonly IssuedVault[]>
}

export class InMemoryVaultRegistry implements VaultRegistry {
  private readonly byToken = new Map<string, IssuedVault>()

  put(vault: IssuedVault): void {
    this.byToken.set(vault.token.toLowerCase(), vault)
  }

  remove(token: Address): void {
    this.byToken.delete(token.toLowerCase())
  }

  async issued(): Promise<readonly IssuedVault[]> {
    return [...this.byToken.values()]
  }
}

/**
 * Not a performance limit - a blast-radius limit. If the issued set is ever
 * larger than this, something upstream is wrong (a bad registry read, a
 * misconfigured environment pointed at every launch on the chain) and scanning
 * on that basis would be the firehose by another route.
 */
export const MAX_WATCHED_VAULTS = 5_000

export function assertBoundedWatchSet(
  vaults: readonly IssuedVault[],
  max: number = MAX_WATCHED_VAULTS,
): void {
  if (vaults.length > max) {
    throw new WatchSetError(
      `${vaults.length} issued vaults exceeds the ${max} ceiling; refusing to index on this basis`,
    )
  }
  const seen = new Set<string>()
  for (const vault of vaults) {
    const key = normalizeAddress(vault.token)
    if (seen.has(key)) throw new WatchSetError(`token ${key} appears twice in the issued set`)
    seen.add(key)
    normalizeAddress(vault.vault)
  }
}

export interface IndexerConfig {
  /** Where a cold cursor starts. Usually the block our first consent was issued. */
  readonly startBlock: bigint
  /** The watcher deadline and the cadence floor for vaults that can spend. */
  readonly sweepIntervalSeconds: number
  readonly maxWatchedVaults?: number
  readonly queryLimits?: QueryLimits
  /** Ranges per cursor per tick. Bounds backfill work without stalling it. */
  readonly maxRangesPerTick?: number
  readonly antiSnipeWindowSeconds?: number
  /** Contract emitting TokenLaunched and the recipient events, and answering getLaunchedToken. */
  readonly registryContract?: Address
  /** Contract emitting PoolRegistered and PoolFeesSwept; also the PoolKey.hooks address. */
  readonly hookContract?: Address
  readonly recipientRegistry?: Address
  readonly trackerOptions?: ChainTrackerOptions
}

export interface IndexerDeps {
  readonly rpc: QuorumRpc
  readonly store: IndexerStore
  readonly registry: VaultRegistry
  readonly haltSink: HaltSink
  readonly config: IndexerConfig
}

export interface ScannedRange {
  readonly key: CursorKey
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly logs: number
}

export interface TickResult {
  readonly head: BlockRef
  readonly finalized: BlockRef
  readonly reorg: ReorgOutcome
  readonly ranges: readonly ScannedRange[]
  readonly newPostings: number
  readonly newlyFinalized: number
  readonly bindingsResolved: number
  readonly graduations: readonly Address[]
  readonly halts: readonly HaltNotice[]
  readonly warnings: readonly string[]
  readonly caughtUp: boolean
  /** Earliest moment any watched vault is next due. The scheduler sleeps to it. */
  readonly nextPollAtUnix: number
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return []
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export class VaultIndexer {
  readonly recipientWatcher: RecipientWatcher
  readonly overrideWatcher: OwnerOverrideWatcher
  private readonly tracker: ChainTracker
  private readonly rpc: QuorumRpc
  private readonly store: IndexerStore
  private readonly registry: VaultRegistry
  private readonly config: IndexerConfig
  private readonly limits: QueryLimits
  private readonly registryContract: Address
  private readonly hookContract: Address
  /** Cursors that ran out of budget before reaching the head, this tick. */
  private readonly cursorsBehind = new Set<CursorKey>()

  constructor(deps: IndexerDeps) {
    assertPinnedTopics(VENUE.topics)
    this.rpc = deps.rpc
    this.store = deps.store
    this.registry = deps.registry
    this.config = deps.config
    this.limits = deps.config.queryLimits ?? DEFAULT_QUERY_LIMITS
    this.registryContract = deps.config.registryContract ?? VENUE.contracts.v2Factory
    this.hookContract = deps.config.hookContract ?? VENUE.contracts.v2MemeHook
    this.tracker = new ChainTracker(deps.rpc, deps.store, deps.config.trackerOptions)
    this.recipientWatcher = new RecipientWatcher(deps.rpc, deps.store, deps.haltSink, {
      sweepIntervalSeconds: deps.config.sweepIntervalSeconds,
      recipientRegistry: deps.config.recipientRegistry ?? this.registryContract,
    })
    this.overrideWatcher = new OwnerOverrideWatcher(deps.store, deps.haltSink)
  }

  async tick(nowUnix: number): Promise<TickResult> {
    if (!this.rpc.isChainVerified) await this.rpc.assertChain()

    const issued = await this.registry.issued()
    assertBoundedWatchSet(issued, this.config.maxWatchedVaults ?? MAX_WATCHED_VAULTS)
    this.cursorsBehind.clear()

    const head = await this.rpc.head()
    const finalized = await this.rpc.finalized()

    // Reconcile BEFORE recording the new head: recording first would make the
    // tracked tip trivially canonical and hide the divergence below it.
    const reorg = await this.tracker.reconcile(head, finalized)
    await this.tracker.recordBlock(head)

    const blockCache = new Map<Hex, BlockRef>()
    const ranges: ScannedRange[] = []
    const warnings: string[] = [...reorg.removedPostings.map((p) => `rolled back posting ${p.id}`)]
    const halts: HaltNotice[] = []
    const graduations: Address[] = []

    // Retrofit coins first: a coin that launched before our start block has no
    // TokenLaunched for us to find, so its binding arrives with the consent.
    const seeded = await this.seedPreResolvedBindings(issued, head, warnings)

    const registryScan = await this.scanRegistryEvents(issued, head, blockCache, ranges)
    const bindingsResolved = registryScan.resolved + seeded.resolved
    halts.push(...registryScan.halts)
    warnings.push(...registryScan.warnings)

    // A newly bound coin's fees may sit BELOW the fee cursors, which advanced
    // while we did not yet know the coin existed. Rewind to its launch block
    // and let idempotent re-scanning pick the history up. Without this, every
    // coin onboarded after the first would silently lose its back history.
    const earliestNewLaunch = [seeded.earliestLaunchBlock, registryScan.earliestLaunchBlock]
      .filter((block): block is bigint => block !== undefined)
      .reduce<bigint | undefined>((min, block) => (min === undefined || block < min ? block : min), undefined)

    if (earliestNewLaunch !== undefined) {
      const rewindTo = earliestNewLaunch > 0n ? earliestNewLaunch - 1n : 0n
      for (const key of ['curve_trades', 'pool_fees'] as const) {
        const cursor = await this.store.getCursor(key)
        if (cursor !== undefined && cursor > rewindTo) {
          await this.store.setCursor(key, rewindTo)
          warnings.push(`rewound ${key} to ${rewindTo} to backfill a newly bound coin`)
        }
      }
    }

    const bindings = await this.store.bindings()

    // Pre-graduation fees, keyed by the emitting curve. The trade shape is
    // pinned from live evidence (abi.ts CURVE_BUY); a shape that loses a name
    // is refused per log by attributeCurveLog, never scanned around.
    const curveScan = await this.scanFees(
      'curve_trades',
      head,
      blockCache,
      ranges,
      (fromBlock, toBlock) =>
        chunk(
          bindings.map((binding) => binding.curve),
          this.limits.maxAddressesPerQuery,
        ).map((addresses) => ({
          fromBlock,
          toBlock,
          address: addresses,
          topics: [[CURVE_BUY.topic0, CURVE_SELL.topic0]],
        })),
    )
    const curvePostings = curveScan.newPostings
    warnings.push(...curveScan.warnings)

    // One hook query serves both the poolId -> memecoin registration and the
    // sweeps under it. The allowlist is the confirmed id where we have one and
    // the derived candidate where we do not; a sweep under an unconfirmed id is
    // refused by attribution, so a wrong derivation can only ever under-credit.
    const poolScan = await this.scanFees(
      'pool_fees',
      head,
      blockCache,
      ranges,
      (fromBlock, toBlock) =>
        chunk(
          bindings
            .map((binding) => binding.poolId ?? binding.candidatePoolId)
            .filter((poolId): poolId is string => poolId !== undefined)
            .map((poolId) => normalizeHash32(poolId)),
          this.limits.maxTopicValuesPerQuery,
        ).map((poolIds) => ({
          fromBlock,
          toBlock,
          address: [this.hookContract],
          topics: [[POOL_FEES_SWEPT.topic0, POOL_REGISTERED.topic0], poolIds],
        })),
    )

    const newPostings = curvePostings + poolScan.newPostings
    warnings.push(...poolScan.warnings)

    for (const graduation of poolScan.graduations) {
      const binding = await this.store.bindingByToken(graduation.token)
      if (!binding || binding.graduatedAtUnix !== undefined) continue
      await this.store.putBindings([{ ...binding, graduatedAtUnix: graduation.atUnix }])
      graduations.push(binding.token)
    }

    const newlyFinalized = await this.tracker.applyFinality(finalized)

    const watched = await this.runWatchers(issued, head, nowUnix)
    halts.push(...watched.halts)
    warnings.push(...watched.warnings)

    const caughtUp = this.cursorsBehind.size === 0
    const nextPollAtUnix = await this.computeNextPoll(issued, nowUnix, caughtUp)

    return {
      head,
      finalized,
      reorg,
      ranges,
      newPostings,
      newlyFinalized,
      bindingsResolved,
      graduations,
      halts,
      warnings,
      caughtUp,
      nextPollAtUnix,
    }
  }

  /** Bind coins whose launch facts came with the consent rather than from a log. */
  private async seedPreResolvedBindings(
    issued: readonly IssuedVault[],
    head: BlockRef,
    warnings: string[],
  ): Promise<{ resolved: number; earliestLaunchBlock: bigint | undefined }> {
    let resolved = 0
    let earliestLaunchBlock: bigint | undefined

    for (const vault of issued) {
      if (vault.launch === undefined) continue
      if (await this.store.bindingByToken(vault.token)) continue
      await this.store.putBindings([await this.bindWithChainFacts(vault, vault.launch, head, warnings)])
      resolved++
      if (earliestLaunchBlock === undefined || vault.launch.launchBlockNumber < earliestLaunchBlock) {
        earliestLaunchBlock = vault.launch.launchBlockNumber
      }
    }

    return { resolved, earliestLaunchBlock }
  }

  /** factory.getLaunchedToken(token), pinned at the tick's head. */
  private async launchedToken(token: Address, head: BlockRef): Promise<LaunchedToken> {
    const raw = await this.rpc.call({
      to: this.registryContract,
      data: encodeAddressArgCall(GET_LAUNCHED_TOKEN_SELECTOR, token),
      blockHash: head.hash,
    })
    const launched = decodeLaunchedToken(raw)
    if (!launched.exists || !addressEquals(launched.token, token)) {
      throw new DecodeError(`getLaunchedToken(${token}) reports no such launch at ${head.hash}`)
    }
    return launched
  }

  /**
   * A binding is the launch log (or retrofit facts) CONFIRMED by the factory's
   * own record. The record is where the per-token economics live - buyback and
   * creator tax decide the creator rate - and where the pool key material comes
   * from, so the post-graduation attribution key is derived here as a candidate
   * and confirmed later by the hook's PoolRegistered.
   */
  private async bindWithChainFacts(
    vault: IssuedVault,
    launch: LaunchFacts,
    head: BlockRef,
    warnings: string[],
    existing?: CoinBinding,
  ): Promise<CoinBinding> {
    const launched = await this.launchedToken(vault.token, head)
    if (!addressEquals(launched.curve, launch.curve) || !addressEquals(launched.pairToken, launch.quoteAsset)) {
      throw new DecodeError(
        `getLaunchedToken(${vault.token}) names curve ${launched.curve} / pair ${launched.pairToken}; ` +
          `launch facts say curve ${launch.curve} / pair ${launch.quoteAsset}; refusing to bind`,
      )
    }
    const candidatePoolId = derivePoolId({
      token: vault.token,
      pairToken: launched.pairToken,
      fee: launched.poolFee,
      tickSpacing: launched.tickSpacing,
      hooks: this.hookContract,
    })
    if (launch.poolId !== undefined && normalizeHash32(launch.poolId) !== candidatePoolId) {
      throw new DecodeError(
        `retrofit poolId ${launch.poolId} for ${vault.token} does not match the pool key ` +
          `derived from getLaunchedToken (${candidatePoolId}); refusing to bind`,
      )
    }
    if (launched.buybackEnabled !== vault.buybackEnabled || launched.creatorTaxBps !== vault.creatorTaxBps) {
      warnings.push(
        `${vault.token}: consent says buyback=${vault.buybackEnabled} tax=${vault.creatorTaxBps}bps, ` +
          `chain says buyback=${launched.buybackEnabled} tax=${launched.creatorTaxBps}bps; chain applied`,
      )
    }
    return {
      ...bindingFromLaunch(vault, launch),
      candidatePoolId,
      buybackEnabled: launched.buybackEnabled,
      creatorTaxBps: launched.creatorTaxBps,
      ...(existing?.poolId === undefined ? {} : { poolId: existing.poolId }),
      ...(existing?.graduatedAtUnix === undefined ? {} : { graduatedAtUnix: existing.graduatedAtUnix }),
    }
  }

  /**
   * TokenLaunched plus the three recipient events, in one query against the
   * factory. All four carry the token as their first indexed parameter, which is
   * exactly the allowlist that makes a query against a shared contract admissible.
   */
  private async scanRegistryEvents(
    issued: readonly IssuedVault[],
    head: BlockRef,
    blockCache: Map<Hex, BlockRef>,
    ranges: ScannedRange[],
  ): Promise<{
    resolved: number
    earliestLaunchBlock: bigint | undefined
    halts: HaltNotice[]
    warnings: string[]
  }> {
    const halts: HaltNotice[] = []
    const warnings: string[] = []
    let resolved = 0
    let earliestLaunchBlock: bigint | undefined
    if (issued.length === 0) return { resolved, earliestLaunchBlock, halts, warnings }

    const tokenTopics = issued.map((vault) => addressToTopic(vault.token))
    const issuedByToken = new Map(issued.map((vault) => [vault.token.toLowerCase(), vault]))

    await this.scanKey('registry_events', head, ranges, (fromBlock, toBlock) =>
      chunk(tokenTopics, this.limits.maxTopicValuesPerQuery).map((topics) => ({
        fromBlock,
        toBlock,
        address: [this.registryContract],
        topics: [
          [
            TOKEN_LAUNCHED.topic0,
            CREATOR_FEE_RECIPIENT_CHANGE_PROPOSED.topic0,
            CREATOR_FEE_RECIPIENT_CHANGE_CANCELLED.topic0,
            CREATOR_FEE_RECIPIENT_UPDATED.topic0,
          ],
          topics,
        ],
      })),
      async (logs) => {
        await this.hydrate(blockCache, logs)
        for (const log of logs) {
          if (log.removed) {
            warnings.push(`registry log ${log.transactionHash}:${log.logIndex} arrived removed`)
            continue
          }
          const block = blockCache.get(normalizeHash32(log.blockHash))
          if (!block) continue
          const topic = normalizeHash32(log.topics[0] ?? ('0x' as Hex))

          if (topic === TOKEN_LAUNCHED.topic0) {
            const launch = decodeLaunch(log, block)
            const vault = issuedByToken.get(launch.token.toLowerCase())
            if (!vault) continue
            const existing = await this.store.bindingByToken(launch.token)
            await this.store.putBindings([await this.bindWithChainFacts(vault, launch, head, warnings, existing)])
            if (!existing) {
              resolved++
              if (earliestLaunchBlock === undefined || launch.launchBlockNumber < earliestLaunchBlock) {
                earliestLaunchBlock = launch.launchBlockNumber
              }
            }
            continue
          }

          const target = this.targetForLog(log, issuedByToken)
          if (!target) continue

          if (topic === CREATOR_FEE_RECIPIENT_UPDATED.topic0) {
            const notice = await this.recipientWatcher.ingestUpdatedLog(log, target, block)
            if (notice) halts.push(notice)
            continue
          }
          if (topic === CREATOR_FEE_RECIPIENT_CHANGE_PROPOSED.topic0) {
            const proposal = await this.overrideWatcher.ingestProposalLog(log, target, block)
            halts.push(proposal.notice)
            continue
          }
          if (topic === CREATOR_FEE_RECIPIENT_CHANGE_CANCELLED.topic0) {
            for (const cleared of await this.overrideWatcher.ingestCancellationLog(log, target)) {
              warnings.push(
                `override of ${target.token} to ${cleared.newRecipient} (effective ${cleared.effectiveAtUnix}) was cancelled`,
              )
            }
          }
        }
      },
    )

    return { resolved, earliestLaunchBlock, halts, warnings }
  }

  private targetForLog(
    log: RpcLog,
    issuedByToken: Map<string, IssuedVault>,
  ): WatchTarget | undefined {
    const tokenTopic = log.topics[1]
    if (tokenTopic === undefined) return undefined
    const token = `0x${normalizeHash32(tokenTopic).slice(26)}`
    return issuedByToken.get(token.toLowerCase())
  }

  /**
   * Registrations first, then fees. A PoolRegistered in the same range as the
   * first sweep confirms the binding before the sweep is attributed; a sweep
   * under an id no binding has confirmed is an attribution error, not a skip.
   */
  private async scanFees(
    key: CursorKey,
    head: BlockRef,
    blockCache: Map<Hex, BlockRef>,
    ranges: ScannedRange[],
    buildQueries: (fromBlock: bigint, toBlock: bigint) => LogQuery[],
  ): Promise<{
    newPostings: number
    graduations: Array<{ token: Address; atUnix: number; blockNumber: bigint }>
    warnings: string[]
  }> {
    let newPostings = 0
    const graduations: Array<{ token: Address; atUnix: number; blockNumber: bigint }> = []
    const warnings: string[] = []

    await this.scanKey(key, head, ranges, buildQueries, async (logs) => {
      await this.hydrate(blockCache, logs)
      const feeLogs: RpcLog[] = []
      for (const log of logs) {
        const topic0 = log.topics[0]
        if (topic0 === undefined || normalizeHash32(topic0) !== POOL_REGISTERED.topic0) {
          feeLogs.push(log)
          continue
        }
        if (log.removed) continue
        const registration = decodePoolRegistration(log)
        const binding = await this.store.bindingByToken(registration.memecoin)
        if (!binding) {
          throw new DecodeError(
            `PoolRegistered ${registration.poolId} names memecoin ${registration.memecoin}, which is ` +
              `not a coin we bound; the derived pool id collided and must not attribute`,
          )
        }
        if (binding.poolId !== undefined) continue
        await this.store.putBindings([confirmPoolRegistration(binding, registration)])
        warnings.push(`pool ${registration.poolId} confirmed for ${binding.token} at block ${log.blockNumber}`)
      }
      const result = await attributeFeeLogs(feeLogs, {
        bindingByCurve: (curve) => this.store.bindingByCurve(curve),
        bindingByPoolId: (poolId) => this.store.bindingByPoolId(poolId),
        blockFor: (hash) => blockCache.get(hash),
        options: { antiSnipeWindowSeconds: this.config.antiSnipeWindowSeconds },
      })
      newPostings += await this.store.putPostings(result.postings)
      graduations.push(...result.graduations)
      warnings.push(...result.warnings)
    })

    return { newPostings, graduations, warnings }
  }

  /**
   * Advance one cursor over up to maxRangesPerTick bounded ranges. The cursor
   * moves only after a range is fully handled, so a failure re-scans rather than
   * skipping - and re-scanning is free because posting ids are deterministic.
   */
  private async scanKey(
    key: CursorKey,
    head: BlockRef,
    ranges: ScannedRange[],
    buildQueries: (fromBlock: bigint, toBlock: bigint) => LogQuery[],
    handle: (logs: RpcLog[]) => Promise<void>,
  ): Promise<void> {
    const maxRanges = this.config.maxRangesPerTick ?? 8
    this.cursorsBehind.delete(key)

    for (let iteration = 0; iteration < maxRanges; iteration++) {
      const range = await this.tracker.nextScanRange(
        key,
        head,
        this.limits.maxBlockSpan,
        this.config.startBlock,
      )
      if (!range) return

      const queries = buildQueries(range.fromBlock, range.toBlock)
      const logs: RpcLog[] = []
      for (const query of queries) {
        logs.push(...(await this.rpc.getLogs(query)))
      }
      await handle(logs)
      await this.store.setCursor(key, range.toBlock)
      ranges.push({ key, fromBlock: range.fromBlock, toBlock: range.toBlock, logs: logs.length })

      if (range.toBlock >= head.number) return
    }

    // Budget exhausted with blocks still unscanned: still backfilling.
    this.cursorsBehind.add(key)
  }

  private async hydrate(cache: Map<Hex, BlockRef>, logs: readonly RpcLog[]): Promise<void> {
    const missing = [...new Set(logs.map((log) => normalizeHash32(log.blockHash)))].filter(
      (hash) => !cache.has(hash),
    )
    if (missing.length === 0) return
    const resolvedBlocks = await this.tracker.hydrateBlocks(missing)
    for (const [hash, block] of resolvedBlocks) cache.set(hash, block)
  }

  /**
   * Per-vault watchers. One coin's failure must not abort the others: a bad RPC
   * answer for coin A is not a reason to stop watching coin B's recipient.
   *
   * The freshness sweep is applied to vaults that can currently spend. For those,
   * an unconfirmed recipient is a halt; for an idle vault it is merely a gap in
   * observation, and halting it would be noise with no exposure behind it.
   *
   * The same read carries the token's economics. Buyback can be toggled by the
   * owner and it halves the creator rate, so a successful read also refreshes
   * the binding: the rate applied to the next posting is the chain's, never a
   * value remembered from onboarding.
   */
  private async runWatchers(
    issued: readonly IssuedVault[],
    head: BlockRef,
    nowUnix: number,
  ): Promise<{ halts: HaltNotice[]; warnings: string[] }> {
    const halts: HaltNotice[] = []
    const warnings: string[] = []

    for (const vault of issued) {
      const target: WatchTarget = { token: vault.token, vault: vault.vault }
      await this.recipientWatcher.primeFrom(target)

      // Re-read only when this vault's own cadence says it is due. For a vault
      // that can spend, that cadence is floored at the sweep interval, so the
      // halt guarantee survives the optimisation; for an idle vault it is the
      // difference between two RPC calls a week and two per tick per client.
      const interval = await this.vaultIntervalSeconds(vault, nowUnix)
      const lastOk = this.recipientWatcher.lastConfirmedAt(target)
      const due = lastOk === undefined || nowUnix - lastOk >= interval

      let confirmed = !due
      if (due) {
        try {
          const check = await this.recipientWatcher.check(target, head, nowUnix)
          confirmed = check.ok
          halts.push(...check.halted)
          if (check.launched) warnings.push(...(await this.refreshEconomics(vault.token, check.launched)))
        } catch (cause) {
          halts.push({
            vault: vault.vault,
            token: vault.token,
            reason: 'read_failure',
            detail: `recipient read failed: ${String(cause)}`,
            detectedAtUnix: nowUnix,
          })
        }
      }

      if (!confirmed && vault.spendAuthorityActive) {
        const stale = await this.recipientWatcher.assertFresh(target, nowUnix)
        if (stale) halts.push(stale)
      }

      halts.push(...(await this.overrideWatcher.review(target, nowUnix)))
    }

    return { halts, warnings }
  }

  private async refreshEconomics(token: Address, launched: LaunchedToken): Promise<string[]> {
    const bound = await this.store.bindingByToken(token)
    if (!bound) return []
    if (bound.buybackEnabled === launched.buybackEnabled && bound.creatorTaxBps === launched.creatorTaxBps) {
      return []
    }
    await this.store.putBindings([
      { ...bound, buybackEnabled: launched.buybackEnabled, creatorTaxBps: launched.creatorTaxBps },
    ])
    return [
      `${token}: buyback ${bound.buybackEnabled}->${launched.buybackEnabled}, ` +
        `creator tax ${bound.creatorTaxBps}->${launched.creatorTaxBps}bps per getLaunchedToken`,
    ]
  }

  /**
   * This vault's own cadence. Age is measured from LAUNCH when we know it,
   * because the 60s band exists for a coin's first day of trading, not for the
   * first day of our contract with it.
   */
  private async vaultIntervalSeconds(
    vault: IssuedVault,
    nowUnix: number,
    backfilling = false,
  ): Promise<number> {
    const bound = await this.store.bindingByToken(vault.token)
    const pending = await this.store.overrides(vault.token)
    return effectiveIntervalSeconds({
      ageSeconds: nowUnix - (bound?.launchedAtUnix ?? vault.coverageStartUnix),
      spendAuthorityActive: vault.spendAuthorityActive,
      sweepIntervalSeconds: this.config.sweepIntervalSeconds,
      pendingOverride: pending.length > 0,
      backfilling,
    })
  }

  private async computeNextPoll(
    issued: readonly IssuedVault[],
    nowUnix: number,
    caughtUp: boolean,
  ): Promise<number> {
    let earliest = Number.POSITIVE_INFINITY
    for (const vault of issued) {
      const interval = await this.vaultIntervalSeconds(vault, nowUnix, !caughtUp)
      earliest = Math.min(earliest, nowUnix + interval)
    }
    return Number.isFinite(earliest) ? earliest : nowUnix + this.config.sweepIntervalSeconds
  }
}

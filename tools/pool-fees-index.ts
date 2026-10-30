/**
 * pool-fees-index - index PoolFeesSwept across the population and settle the
 * two per-token unknowns the tier gates depend on.
 *
 * WHY THIS ONE MATTERS. creatorNetBps() BRANCHES on buybackEnabled: 0.70% of
 * volume with buyback off, 0.35% with it on. Every gate in TIERS is stated in
 * QF, so the VOLUME a coin needs to clear a gate doubles or halves on that one
 * flag. Nobody has measured which way the population actually sits. This tool
 * measures it, and reports the DISTRIBUTION rather than a mean, because a
 * population that is 90% off and 10% on is a completely different business
 * from one that is uniformly 50/50 - and both have the same mean.
 *
 * It also backs the per-token creatorTax out of the residual, which is the
 * other input creatorNetBps() takes and which nobody has measured either.
 */

import { decodeEventLog, parseEventSignature } from './lib/abi.ts'
import { buildCache } from './lib/cache.ts'
import type { ParsedValues } from './lib/cli.ts'
import { CliError, getBool, getList, getNumber, getString, isEntrypoint, runCli } from './lib/cli.ts'
import { describeConfig, loadConfig, rpcUrlsOrPlaceholder } from './lib/env.ts'
import {
  buybackPopulationRate,
  decomposeSweep,
  profilePool,
  type BuybackPopulationRate,
  type PoolFeeProfile,
  type SweepObservation,
} from './lib/feemath.ts'
import { UNPRICED, banner, bps, heading, num, pct, subheading, table } from './lib/format.ts'
import { buildHttpClient } from './lib/http.ts'
import { BlockTimeResolver, findBlockAtOrAfter, scanLogs } from './lib/logscan.ts'
import { minorToUnits } from './lib/prices.ts'
import { emit, emitDryRun, progress, type Report } from './lib/report.ts'
import { HttpChainReader } from './lib/rpc.ts'
import { histogram, quantiles, valueCounts, type Quantiles } from './lib/stats.ts'
import { SECONDS_PER_DAY } from './lib/time.ts'
import { VENUE, creatorNetBps } from '../config/protocol.ts'

const SCHEMA_VERSION = 'pool-fees-1'

/**
 * VERIFIED 2026-09-07 against Sourcify-verified source for the hook on chain
 * 4663 (`sourcify.dev/server/v2/contract/4663/0xE5e7…e044`, verified
 * 2026-08-05), and cross-checked against a topic0 census of the hook's own
 * logs. The parameter names are the source's; the shape - one indexed bytes32
 * and four uint256 data words - was confirmed on 73 live logs.
 *
 * The previously shipped guess had the same shape and therefore the same
 * topic0, so it decoded correctly by luck. Nothing here is inferred any more.
 */
export const DEFAULT_SWEEP_EVENT =
  'PoolFeesSwept(bytes32 indexed poolId, uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount, uint256 tokensLocked)'

/**
 * The poolId -> token join, VERIFIED the same way. It lives on the HOOK, not
 * the factory.
 *
 * THE PREVIOUS DEFAULT WAS REFUTED, exactly as CurveBuy was. This tool shipped
 * `TokenLaunched(address indexed token, bytes32 indexed poolId, address indexed
 * creator)` on the factory, topic0 0x231c0f2a…. That event does not exist. The
 * factory does emit a `TokenLaunched`, but its verified signature is
 *
 *   TokenLaunched(address indexed token, address indexed curve,
 *                 address indexed deployer, address pairToken,
 *                 uint256 launchConfigId, uint256 graduationThreshold)
 *
 * (topic0 0x8d4aad49…) and it CARRIES NO poolId AT ALL, so no version of it
 * could ever have served this join. What binds a pool to its coin is
 * PoolRegistered on the hook, below.
 *
 * The `creator` field is the address the hook pays the creator leg to:
 * VenueV2MemeHook._payOut(info.creator, …). It is mutable afterwards via
 * setCreatorFeeRecipient, which emits CreatorFeeRecipientUpdated - so treat it
 * as the recipient AT REGISTRATION, not necessarily the recipient today.
 */
export const DEFAULT_POOL_REGISTERED_EVENT =
  'PoolRegistered(bytes32 indexed poolId, address memecoin, address quoteToken, address creator)'

/**
 * Measured span for the PoolRegistered scan, 2026-09-07.
 *
 * VENUE_LOG_CHUNK_BLOCKS is tuned for the ESCROW, which is dense enough that the
 * endpoint's query timeout binds at ~12,000 blocks. PoolRegistered is three
 * orders of magnitude sparser (5,485 logs in the contract's entire life), and
 * 2,000,000-block spans served 3/3 probes returning at most 1,393 logs - well
 * inside the 10,000-result cap. Using the escrow's 10,000 here would turn an
 * 8-request scan into 15,000 requests and a five-hour wait.
 */
export const DEFAULT_ATTRIBUTION_CHUNK_BLOCKS = 2_000_000

const SPEC = {
  name: 'pool-fees-index',
  summary: 'Measure the buyback-on rate and the creatorTax distribution from PoolFeesSwept.',
  detail: `
    Decides whether the tier gates are 0.35% or 0.70% of volume - a 2x swing on the
    entire addressable market. Reports the DISTRIBUTION, unweighted and volume-weighted,
    not a mean. Also backs the per-token creatorTax out of the fee residual and
    flags any pool whose sweeps the verified fee model cannot explain.
  `,
  options: [
    { name: 'days', type: 'number' as const, default: 30, describe: 'Days back from --to to index.' },
    { name: 'to', type: 'string' as const, default: 'latest', placeholder: '<iso|latest>', describe: 'End of the window.' },
    {
      name: 'hook',
      type: 'string' as const,
      placeholder: '<address>',
      default: VENUE.contracts.v2MemeHook,
      describe: 'Meme hook emitting PoolFeesSwept.',
    },
    {
      name: 'event',
      type: 'string' as const,
      placeholder: '<signature>',
      default: DEFAULT_SWEEP_EVENT,
      describe: 'PoolFeesSwept signature, with indexed markers.',
    },
    {
      name: 'factory',
      type: 'string' as const,
      placeholder: '<address>',
      default: VENUE.contracts.v2Factory,
      describe: 'V2 factory. Reported for provenance; its TokenLaunched carries no poolId and cannot serve this join.',
    },
    {
      name: 'pool-registered-event',
      type: 'string' as const,
      placeholder: '<signature>',
      default: DEFAULT_POOL_REGISTERED_EVENT,
      describe: 'Hook event mapping poolId to memecoin. Attribution is skipped if it does not decode.',
    },
    {
      name: 'attribution-chunk-blocks',
      type: 'number' as const,
      default: DEFAULT_ATTRIBUTION_CHUNK_BLOCKS,
      describe: 'Block span per PoolRegistered query. Far wider than the escrow chunk; this event is sparse.',
    },
    {
      name: 'skip-attribution',
      type: 'boolean' as const,
      describe: 'Do not attempt the poolId -> token join. Report pool ids only.',
    },
    {
      name: 'pools',
      type: 'string[]' as const,
      describe: 'Restrict to these poolIds (bytes32). Omit to index every pool the hook swept.',
    },
    {
      name: 'top',
      type: 'number' as const,
      default: 25,
      describe: 'Pool rows shown in the human report, ranked by implied volume.',
    },
    {
      name: 'min-sweeps',
      type: 'number' as const,
      default: 1,
      describe: 'Ignore pools with fewer sweeps than this when computing the population rate.',
    },
    {
      name: 'exact-timestamps',
      type: 'boolean' as const,
      describe: 'Fetch a header per sweep block instead of interpolating.',
    },
    {
      name: 'anchor-spacing',
      type: 'number' as const,
      default: 2_000,
      describe: 'Blocks between timestamp anchors.',
    },
  ],
  examples: [
    'node tools/pool-fees-index.ts --days 30 --out artifacts/pool-fees-30d.json',
    'node tools/pool-fees-index.ts --days 14 --skip-attribution --json',
  ],
}

export interface PoolFeesResult {
  hook: string
  eventSignature: string
  topic0: string
  fromBlock: string
  toBlock: string
  windowStartUnix: number
  windowEndUnix: number
  sweepsDecoded: number
  poolsObserved: number
  /** The headline answer. */
  buybackRate: BuybackPopulationRate
  /** Distribution of the implied per-token creatorTax, in bps. */
  creatorTaxDistribution: {
    quantiles: Quantiles
    /** Exact-value tally at 1bps resolution. The shape, not the average. */
    valueCounts: Array<{ value: string | number; count: number; share: number }>
    histogram: Array<{ lower: number; upper: number; count: number; share: number }>
  }
  /** Distribution of the effective creator rate actually received, in bps. */
  effectiveCreatorBpsDistribution: {
    quantiles: Quantiles
    histogram: Array<{ lower: number; upper: number; count: number; share: number }>
  }
  /** What creatorNetBps() says for each branch, for comparison. */
  reference: {
    creatorBpsBuybackOff: number
    creatorBpsBuybackOn: number
  }
  attribution: {
    attempted: boolean
    poolsMapped: number
    note: string
  }
  pools: Array<
    PoolFeeProfile & {
      token?: string
      /** Address the creator leg was registered to pay. Mutable on chain. */
      creatorRecipient?: string
      totalProtocol: string
      totalBuyback: string
      totalCreator: string
      totalImpliedVolume: string
    }
  >
  modelViolations: Array<{ poolId: string; violations: string[] }>
}

async function main(values: ParsedValues): Promise<void> {
  const config = loadConfig()
  const json = getBool(values, 'json')
  const dryRun = getBool(values, 'dry-run')
  const verbose = getBool(values, 'verbose')
  const outPath = getString(values, 'out')

  const hook = (getString(values, 'hook') ?? VENUE.contracts.v2MemeHook).toLowerCase()
  const factory = (getString(values, 'factory') ?? VENUE.contracts.v2Factory).toLowerCase()
  const sweepSpec = parseEventSignature(getString(values, 'event') ?? DEFAULT_SWEEP_EVENT)
  const launchSpec = parseEventSignature(
    getString(values, 'pool-registered-event') ?? DEFAULT_POOL_REGISTERED_EVENT,
  )
  const days = getNumber(values, 'days', 30)
  if (days <= 0) throw new CliError('--days must be positive')

  const http = buildHttpClient({
    requestsPerSecond: config.requestsPerSecond,
    maxRetries: config.maxRetries,
    timeoutMs: config.requestTimeoutMs,
    onRetry: (attempt, delay, reason) => progress(verbose, `retry ${attempt} in ${delay}ms: ${reason}`),
  })
  const cache = buildCache(config.cacheDir, getBool(values, 'no-cache'))
  const reader = new HttpChainReader(http, rpcUrlsOrPlaceholder(config, dryRun))

  const skipAttribution = getBool(values, 'skip-attribution')
  const attributionChunkBlocks = Math.max(
    1,
    Math.floor(getNumber(values, 'attribution-chunk-blocks', DEFAULT_ATTRIBUTION_CHUNK_BLOCKS)),
  )

  if (dryRun) {
    const estimatedBlocks = Math.ceil((days * SECONDS_PER_DAY) / config.estimatedBlockTimeSeconds)
    const chunks = Math.ceil(estimatedBlocks / config.logChunkBlocks)
    // Attribution scans the hook's WHOLE life, not the window, so its budget is
    // driven by the chain height rather than by --days.
    const attributionChunks = Math.ceil(60_000_000 / attributionChunkBlocks)
    emitDryRun(
      {
        tool: SPEC.name,
        config: {
          ...describeConfig(config),
          hook,
          factory,
          sweepEvent: sweepSpec.canonical,
          sweepTopic0: sweepSpec.topic0,
          registeredEvent: launchSpec.canonical,
          registeredTopic0: launchSpec.topic0,
          windowDays: days,
        },
        steps: [
          { description: 'binary-search the block range for the window', estimatedRequests: 40 },
          {
            description: `eth_getLogs PoolFeesSwept from ${hook} across ~${estimatedBlocks.toLocaleString()} blocks`,
            estimatedRequests: chunks,
          },
          ...(skipAttribution
            ? []
            : [
                {
                  description: `eth_getLogs ${launchSpec.name} from the HOOK ${hook} over its whole life, for the poolId -> token join`,
                  estimatedRequests: attributionChunks,
                },
              ]),
        ],
        estimatedRequestsTotal: 40 + chunks + (skipAttribution ? 0 : attributionChunks),
        notes: [
          `Buyback-on is inferred from buybackSpent > 0 per sweep; a pool is ON if ANY sweep spent.`,
          `Volume is backed out of the PROTOCOL leg (${VENUE.hookFeeBps}bps * ${VENUE.protocolFeeShareBps}bps), which has no per-token variation.`,
          `Reference rates: buyback OFF ${creatorNetBps(false, 0)}bps, ON ${creatorNetBps(true, 0)}bps.`,
          `Block span is ESTIMATED from VENUE_BLOCK_TIME_SECONDS=${config.estimatedBlockTimeSeconds}s for budgeting only.`,
          ...(config.rpcUrls.length === 0 ? ['VENUE_RPC_URL is UNSET; a real run will refuse to start.'] : []),
        ],
      },
      json,
    )
    return
  }

  const chainId = await reader.chainId()
  if (chainId !== VENUE.chainId) {
    throw new CliError(`RPC reports chain ${chainId}, protocol config pins ${VENUE.chainId}.`)
  }

  const toArg = getString(values, 'to') ?? 'latest'
  const latest = await reader.getBlockHeader('latest')
  let toBlock = latest.number
  let toUnix = latest.timestampUnix
  if (toArg !== 'latest') {
    toUnix = Math.floor(Date.parse(toArg) / 1000)
    if (Number.isNaN(toUnix)) throw new CliError(`--to could not be parsed: ${toArg}`)
    toBlock = await findBlockAtOrAfter(reader, toUnix, { low: 1n, high: latest.number })
  }
  const fromUnix = toUnix - days * SECONDS_PER_DAY
  const fromBlock = await findBlockAtOrAfter(reader, fromUnix, { low: 1n, high: toBlock })

  const poolFilter = new Set(getList(values, 'pools').map((p) => p.toLowerCase()))
  const logs = await scanLogs(reader, {
    address: hook,
    topics: [sweepSpec.topic0],
    fromBlock,
    toBlock,
    chunkBlocks: config.logChunkBlocks,
    cache,
    onProgress: (info) =>
      progress(verbose, `sweeps ${info.fromBlock}-${info.toBlock}: ${info.logs} (${((info.done / info.total) * 100).toFixed(1)}%)`),
  })
  progress(verbose, `decoded window: ${logs.length} PoolFeesSwept logs`)

  const resolver = new BlockTimeResolver(reader, {
    exact: getBool(values, 'exact-timestamps'),
    anchorSpacing: Math.floor(getNumber(values, 'anchor-spacing', 2_000)),
    cache,
  })
  await resolver.prime(fromBlock, toBlock)

  const byPool = new Map<string, SweepObservation[]>()
  const decodeFailures: string[] = []
  for (const log of logs) {
    let sweep: SweepObservation
    try {
      sweep = await decodeSweep(sweepSpec, log, (block) => resolver.timestampOf(block))
    } catch (error) {
      decodeFailures.push(error instanceof Error ? error.message : String(error))
      continue
    }
    if (poolFilter.size > 0 && !poolFilter.has(sweep.poolId.toLowerCase())) continue
    const list = byPool.get(sweep.poolId)
    if (list === undefined) byPool.set(sweep.poolId, [sweep])
    else list.push(sweep)
  }

  // --- optional poolId -> token attribution ------------------------------
  // Scanned from block 0 over the hook's whole life, not just the window: a
  // pool that swept this week may have been registered months ago, and a join
  // restricted to the window would silently drop exactly the oldest - which is
  // to say the most established - coins.
  let poolToToken = new Map<string, string>()
  let poolToCreator = new Map<string, string>()
  let attributionNote =
    'Attribution skipped by --skip-attribution. Pools are reported by poolId only.'
  if (!skipAttribution) {
    try {
      const mapped = await mapPoolsToTokens(reader, {
        hook,
        spec: launchSpec,
        fromBlock: 0n,
        toBlock,
        chunkBlocks: attributionChunkBlocks,
        cache,
        onProgress: (message) => progress(verbose, message),
      })
      poolToToken = mapped.token
      poolToCreator = mapped.creator
      attributionNote = `Mapped ${poolToToken.size} poolIds to memecoins via ${launchSpec.canonical} on the hook ${hook}.`
    } catch (error) {
      attributionNote =
        `Attribution FAILED and was skipped: ${error instanceof Error ? error.message : String(error)}. ` +
        `Pin the signature with --pool-registered-event.`
    }
  }

  const minSweeps = Math.max(1, Math.floor(getNumber(values, 'min-sweeps', 1)))
  const profiles: PoolFeeProfile[] = []
  for (const [poolId, sweeps] of byPool) {
    profiles.push(profilePool(poolId, sweeps))
  }
  const eligible = profiles.filter((p) => p.sweeps >= minSweeps && p.totalImpliedVolumeMinor > 0n)
  profiles.sort((a, b) => (b.totalImpliedVolumeMinor > a.totalImpliedVolumeMinor ? 1 : -1))

  const rate = buybackPopulationRate(eligible)
  const taxValues = eligible.map((p) => p.impliedCreatorTaxBps)
  const effectiveValues = eligible.map((p) => p.effectiveCreatorBps)

  const result: PoolFeesResult = {
    hook,
    eventSignature: sweepSpec.canonical,
    topic0: sweepSpec.topic0,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    windowStartUnix: fromUnix,
    windowEndUnix: toUnix,
    sweepsDecoded: logs.length - decodeFailures.length,
    poolsObserved: profiles.length,
    buybackRate: rate,
    creatorTaxDistribution: {
      quantiles: quantiles(taxValues),
      valueCounts: valueCounts(taxValues.map((v) => Math.round(v))).slice(0, 20),
      histogram: histogram(taxValues, [0, 1, 10, 25, 50, 100, 250, 500, 1000, 10_000]),
    },
    effectiveCreatorBpsDistribution: {
      quantiles: quantiles(effectiveValues),
      histogram: histogram(effectiveValues, [0, 10, 20, 30, 35, 40, 50, 60, 70, 80, 100, 200, 2000]),
    },
    reference: {
      creatorBpsBuybackOff: creatorNetBps(false, 0),
      creatorBpsBuybackOn: creatorNetBps(true, 0),
    },
    attribution: {
      attempted: !skipAttribution,
      poolsMapped: poolToToken.size,
      note: attributionNote,
    },
    pools: profiles.slice(0, Math.floor(getNumber(values, 'top', 25))).map((p) => ({
      ...p,
      ...(poolToToken.has(p.poolId) ? { token: poolToToken.get(p.poolId)! } : {}),
      ...(poolToCreator.has(p.poolId) ? { creatorRecipient: poolToCreator.get(p.poolId)! } : {}),
      totalProtocol: p.totalProtocolMinor.toString(),
      totalBuyback: p.totalBuybackMinor.toString(),
      totalCreator: p.totalCreatorMinor.toString(),
      totalImpliedVolume: p.totalImpliedVolumeMinor.toString(),
    })),
    modelViolations: profiles
      .filter((p) => p.modelViolations.length > 0)
      .slice(0, 50)
      .map((p) => ({ poolId: p.poolId, violations: p.modelViolations })),
  }

  const warnings: string[] = [
    `This run decoded "${result.eventSignature}" (topic0 ${result.topic0}). That signature is VERIFIED against Sourcify source for the hook on chain 4663 and against a topic0 census of the hook's live logs. A wrong indexed marker throws rather than shifting fields, so ${decodeFailures.length} decode failure(s) here is a signal, not noise.`,
  ]
  if (!skipAttribution) {
    warnings.push(
      'A pool is attributed to the memecoin named in its PoolRegistered log, and to the creator address registered at that time. setCreatorFeeRecipient can move the creator leg afterwards (CreatorFeeRecipientUpdated); this tool does not replay those, so creatorRecipient is the recipient AT REGISTRATION.',
    )
  }
  if (decodeFailures.length > 0) {
    warnings.push(
      `${decodeFailures.length} of ${logs.length} logs failed to decode. First: ${decodeFailures[0]}. Re-run with the correct --event before reading the distribution.`,
    )
  }
  if (rate.poolsWithModelViolations > 0) {
    warnings.push(
      `${rate.poolsWithModelViolations} of ${eligible.length} pools emit sweeps the verified fee model cannot explain. Until that is resolved, the creatorTax column is an artefact of a wrong model, not a measurement. See modelViolations in the JSON.`,
    )
  }
  if (!rate.measured) {
    warnings.push(
      `NOT MEASURED: no pool cleared --min-sweeps with a non-zero protocol leg, so the buyback-on rate is UNKNOWN. The 0 and the 70bps that the arithmetic produces for an empty population are not findings, and this run must not be quoted as evidence that buyback is off. ${logs.length} sweep log(s) were read and ${decodeFailures.length} failed to decode - check --event and --hook first.`,
    )
  } else if (eligible.length < 20) {
    warnings.push(
      `Only ${eligible.length} pool(s) cleared --min-sweeps. A buyback-on rate over that few pools is not a population rate.`,
    )
  }
  if (rate.measured && !rate.volumeWeightMeasured) {
    warnings.push(
      'Every eligible pool implied ZERO volume, so the volume-weighted rate - the one the addressable-market count needs - could not be computed and is reported as unknown rather than as the unweighted rate.',
    )
  }
  const spread = Math.abs(rate.buybackOnShareUnweighted - rate.buybackOnShareVolumeWeighted)
  if (spread > 0.15) {
    warnings.push(
      `Buyback-on rate is ${pct(rate.buybackOnShareUnweighted)} by pool count but ${pct(rate.buybackOnShareVolumeWeighted)} by volume. The pools with the fees behave differently from the pools without them, so use the VOLUME-WEIGHTED figure for any addressable-market number.`,
    )
  }
  if (!skipAttribution && poolToToken.size === 0) {
    warnings.push(
      'Zero poolIds were mapped to tokens. Per-coin attribution is unavailable in this run, so nothing here may be reported as a per-COIN rate.',
    )
  }
  // A pool that swept but was never registered cannot be named. Silence here
  // would let a partial join be read as a complete one.
  const sweptUnmapped = skipAttribution
    ? 0
    : profiles.filter((p) => !poolToToken.has(p.poolId)).length
  if (sweptUnmapped > 0) {
    warnings.push(
      `${sweptUnmapped} of ${profiles.length} pools that swept in the window have NO PoolRegistered log and are therefore unattributable to a coin. Any per-coin count from this run excludes them and is a LOWER BOUND on the coin population.`,
    )
  }

  const report: Report<PoolFeesResult> = {
    meta: {
      tool: SPEC.name,
      schemaVersion: SCHEMA_VERSION,
      generatedAtUnix: Math.floor(Date.now() / 1000),
      config: { ...describeConfig(config), hook, factory },
      io: { httpRequests: http.requestCount, cacheHits: cache.hits, cacheMisses: cache.misses },
      warnings,
      // The headline this tool exists to produce is the buyback-on rate. If it
      // could not be measured the run failed, whatever else it printed.
      measurementComplete: rate.measured && rate.volumeWeightMeasured,
      ...(rate.measured && rate.volumeWeightMeasured
        ? {}
        : {
            incompleteReasons: [
              rate.measured
                ? 'Eligible pools were found but every one implied zero volume, so no volume-weighted buyback rate exists. The 0.35%-vs-0.70% question is still open.'
                : `No pool cleared --min-sweeps with a non-zero protocol leg out of ${profiles.length} observed, so the 0.35%-vs-0.70% question is still open. The zeros this tool would otherwise print are properties of the empty set, not of the market.`,
              'Nothing from this run may be passed to addressable-market.ts --buyback-on-rate or to reprice.ts --buyback-on-rate.',
            ],
          }),
      methodLimits: [
        'A pool is classified buyback-ON if ANY sweep in the window spent on buyback. A pool that flipped mid-window shows a buybackSweepShare strictly between 0 and 1; check that column before treating the flag as static.',
        'Volume is INFERRED from the protocol leg, not observed. It is exact under the verified parameters (hookFeeBps=100, protocolFeeShareBps=3000) and meaningless if a pool uses different ones - which is what the model-violation flag detects.',
        'The creator tax is a RESIDUAL. If the hook pays the tax outside the creator leg of this event, the residual is ~0 and this tool cannot see the tax at all. A population of exact zeros means the tax is elsewhere, not that it is zero.',
        'Only pools that swept at least once in the window appear. A live pool with no sweep is invisible here.',
        'This tool sees the POST-GRADUATION fee path only. Venue coins also earn fees on a PRE-graduation bonding curve, whose per-launch curve contract credits the escrow directly and emits no PoolFeesSwept at all. Measured over the 7 days to 2026-09-06: 141,653 curve contracts supplied 67.8% of escrow credits, against 31.8% from this hook - but only 28.6% of native VALUE, against 71.4% through the hook. So this tool sees a minority of the coins and a majority of the money, and a coin population taken from PoolFeesSwept alone is a strict subset of the fee-earning population.',
      ],
    },
    result,
  }

  await emit(report, { json, outPath, human: (r) => renderHuman(r.result) })
}

/** Decode one sweep log, by parameter name when named, by position otherwise. */
export async function decodeSweep(
  spec: ReturnType<typeof parseEventSignature>,
  log: { topics: string[]; data: string; blockNumber: bigint },
  timestampOf: (block: bigint) => Promise<number>,
): Promise<SweepObservation> {
  const decoded = decodeEventLog(spec, log.topics, log.data)
  /**
   * Names are tried in order, then position. Two name sets are accepted: the
   * VERIFIED source names (protocolAmount/buybackAmount/creatorAmount) and the
   * inferred ones this tool shipped with (protocol/buybackSpent/creator), so a
   * caller pinning either signature decodes to the same fields.
   */
  const pick = (names: readonly string[], index: number): unknown => {
    for (const name of names) if (name in decoded.byName) return decoded.byName[name]
    return decoded.values[index]
  }

  const poolId = pick(['poolId'], 0)
  const protocol = pick(['protocolAmount', 'protocol'], 1)
  const buybackSpent = pick(['buybackAmount', 'buybackSpent'], 2)
  const creator = pick(['creatorAmount', 'creator'], 3)
  const tokensLocked = pick(['tokensLocked'], 4)

  if (
    typeof poolId !== 'string' ||
    typeof protocol !== 'bigint' ||
    typeof buybackSpent !== 'bigint' ||
    typeof creator !== 'bigint' ||
    typeof tokensLocked !== 'bigint'
  ) {
    throw new Error(
      `PoolFeesSwept did not decode to (bytes32 poolId, uint protocol, uint buybackSpent, uint creator, uint tokensLocked). Pin the signature with --event.`,
    )
  }

  return {
    poolId: poolId.toLowerCase(),
    protocolMinor: protocol,
    buybackSpentMinor: buybackSpent,
    creatorMinor: creator,
    tokensLockedMinor: tokensLocked,
    blockNumber: log.blockNumber,
    timestampUnix: await timestampOf(log.blockNumber),
  }
}

export interface PoolAttribution {
  /** poolId -> the memecoin the pool trades. 1:1 on the live chain. */
  token: Map<string, string>
  /** poolId -> the address the creator leg was registered to pay. */
  creator: Map<string, string>
}

/**
 * Build the poolId -> memecoin map from the HOOK's PoolRegistered event.
 *
 * Not from the factory: the factory's TokenLaunched binds token -> curve ->
 * deployer for the PRE-graduation bonding curve and carries no poolId, so it
 * cannot answer "which coin is this pool". PoolRegistered is emitted by
 * VenueV2MemeHook._registerPool and is the only on-chain binding between a
 * poolId and a token.
 */
export async function mapPoolsToTokens(
  reader: HttpChainReader,
  options: {
    hook: string
    spec: ReturnType<typeof parseEventSignature>
    fromBlock: bigint
    toBlock: bigint
    chunkBlocks: number
    cache?: ReturnType<typeof buildCache>
    onProgress?: (message: string) => void
  },
): Promise<PoolAttribution> {
  const logs = await scanLogs(reader, {
    address: options.hook,
    topics: [options.spec.topic0],
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    chunkBlocks: options.chunkBlocks,
    ...(options.cache ? { cache: options.cache } : {}),
    onProgress: (info) =>
      options.onProgress?.(`registrations ${info.fromBlock}-${info.toBlock}: ${info.logs}`),
  })

  const token = new Map<string, string>()
  const creator = new Map<string, string>()
  for (const log of logs) {
    const decoded = decodeEventLog(options.spec, log.topics, log.data)
    const poolId = 'poolId' in decoded.byName ? decoded.byName.poolId : decoded.values[0]
    const memecoin = 'memecoin' in decoded.byName ? decoded.byName.memecoin : decoded.values[1]
    const registeredTo = 'creator' in decoded.byName ? decoded.byName.creator : decoded.values[3]
    if (typeof poolId !== 'string' || typeof memecoin !== 'string') continue
    token.set(poolId.toLowerCase(), memecoin.toLowerCase())
    if (typeof registeredTo === 'string') creator.set(poolId.toLowerCase(), registeredTo.toLowerCase())
  }
  return { token, creator }
}

function renderHuman(result: PoolFeesResult): string {
  const lines: string[] = []
  const rate = result.buybackRate
  lines.push(heading('THE 0.35% vs 0.70% QUESTION'))
  if (!rate.measured) {
    // Every figure in this block is an arithmetic identity of the empty set.
    // Printing "0.0% of pools run buyback" and a blended 70bps as though they
    // were measured is the same defect as a gate count over unpriced amounts:
    // an absent input rendered as a finding.
    lines.push(
      banner([
        'NOT MEASURED. No pool cleared --min-sweeps with a non-zero protocol leg, so the',
        // no-hardcoded-rates: allow creator-rate-percent - this names the buyback-OFF rate in order to say the blended rate is NOT it; refusing the assumption, not making it.
        'buyback-on rate and the blended creator rate are UNKNOWN, not zero and not 0.70%.',
        'Do NOT feed anything from this run into addressable-market.ts --buyback-on-rate.',
      ]),
    )
    lines.push(`  buyback ON, by pool count : ${UNPRICED} (0 of ${rate.pools} pools eligible)`)
    lines.push(`  buyback ON, by volume     : ${UNPRICED}`)
    lines.push('')
    lines.push(`  creator rate if buyback OFF : ${bps(result.reference.creatorBpsBuybackOff)}   (from config, not measured here)`)
    lines.push(`  creator rate if buyback ON  : ${bps(result.reference.creatorBpsBuybackOn)}   (from config, not measured here)`)
    lines.push(`  blended, VOLUME-weighted    : ${UNPRICED}`)
    lines.push('')
    lines.push(`  Volume needed per $1 of QF  : ${UNPRICED}`)
  } else {
    lines.push(
      `  buyback ON, by pool count : ${pct(rate.buybackOnShareUnweighted)} (${rate.buybackOnPools} of ${rate.pools})`,
    )
    lines.push(
      `  buyback ON, by volume     : ${rate.volumeWeightMeasured ? pct(rate.buybackOnShareVolumeWeighted) : `${UNPRICED} (every eligible pool implied zero volume)`}`,
    )
    lines.push('')
    lines.push(`  creator rate if buyback OFF : ${bps(result.reference.creatorBpsBuybackOff)}`)
    lines.push(`  creator rate if buyback ON  : ${bps(result.reference.creatorBpsBuybackOn)}`)
    lines.push(`  blended, count-weighted     : ${bps(rate.blendedCreatorBpsUnweighted)}`)
    lines.push(
      `  blended, VOLUME-weighted    : ${rate.volumeWeightMeasured ? `${bps(rate.blendedCreatorBpsVolumeWeighted)}   <- use this one` : UNPRICED}`,
    )
    lines.push('')
    lines.push(
      rate.volumeWeightMeasured && rate.blendedCreatorBpsVolumeWeighted > 0
        ? `  A coin needs $${(10_000 / rate.blendedCreatorBpsVolumeWeighted).toFixed(0)} of Venue-pool volume per $1 of QF at the blended rate.`
        : `  Volume needed per $1 of QF  : ${UNPRICED} (no volume-weighted rate was measurable)`,
    )
  }

  lines.push(heading(`PoolFeesSwept: ${result.hook}`))
  lines.push(
    `blocks ${result.fromBlock}..${result.toBlock}  sweeps ${result.sweepsDecoded}  pools ${result.poolsObserved}`,
  )
  lines.push(`event ${result.eventSignature}`)
  lines.push(`attribution: ${result.attribution.note}`)

  lines.push(subheading('Implied creatorTax distribution, bps (the shape, not the mean)'))
  const q = result.creatorTaxDistribution.quantiles
  // An empty distribution has zeros for every quantile and a histogram of empty
  // bins at 0.0% share. Rendered as a table that is indistinguishable from "the
  // whole population sits at exactly 0bps of creator tax", which is a finding.
  if (q.count === 0) {
    lines.push(`  ${UNPRICED} - no eligible pool, so there is no distribution to show.`)
  } else {
    lines.push(
      table(result.creatorTaxDistribution.histogram, [
        { header: 'range bps', value: (b) => `${b.lower} - ${b.upper}` },
        { header: 'pools', value: (b) => String(b.count), align: 'right' },
        { header: 'share', value: (b) => pct(b.share, 1), align: 'right' },
        { header: '', value: (b) => '#'.repeat(Math.round(b.share * 40)) },
      ]),
    )
    lines.push(
      `  n=${q.count}  min ${num(q.min, 1)}  p25 ${num(q.p25, 1)}  median ${num(q.median, 1)}  p75 ${num(q.p75, 1)}  p90 ${num(q.p90, 1)}  max ${num(q.max, 1)}  mean ${num(q.mean, 1)}`,
    )
    lines.push(subheading('Most common creatorTax values, bps'))
    lines.push(
      table(result.creatorTaxDistribution.valueCounts.slice(0, 10), [
        { header: 'bps', value: (v) => String(v.value), align: 'right' },
        { header: 'pools', value: (v) => String(v.count), align: 'right' },
        { header: 'share', value: (v) => pct(v.share, 1), align: 'right' },
      ]),
    )
  }

  lines.push(subheading('Effective creator rate actually received, bps of volume'))
  if (result.effectiveCreatorBpsDistribution.quantiles.count === 0) {
    lines.push(`  ${UNPRICED} - no eligible pool, so no effective rate was observed.`)
    lines.push(
      `  Reference: ${bps(result.reference.creatorBpsBuybackOff)} off / ${bps(result.reference.creatorBpsBuybackOn)} on, at zero creator tax. Both are CONFIG, not observations.`,
    )
    lines.push(subheading(`Top pools by implied volume`))
    lines.push(
      table(result.pools, [
        { header: 'poolId', value: (p) => `${p.poolId.slice(0, 10)}..` },
        { header: 'sweeps', value: (p) => String(p.sweeps), align: 'right' },
        { header: 'buyback', value: (p) => (p.buybackEnabled ? 'ON' : 'off'), align: 'right' },
      ]),
    )
    return lines.join('\n')
  }
  lines.push(
    table(result.effectiveCreatorBpsDistribution.histogram, [
      { header: 'range bps', value: (b) => `${b.lower} - ${b.upper}` },
      { header: 'pools', value: (b) => String(b.count), align: 'right' },
      { header: 'share', value: (b) => pct(b.share, 1), align: 'right' },
      { header: '', value: (b) => '#'.repeat(Math.round(b.share * 40)) },
    ]),
  )
  lines.push(
    `  Reference: ${bps(result.reference.creatorBpsBuybackOff)} off / ${bps(result.reference.creatorBpsBuybackOn)} on, at zero creator tax.`,
  )

  lines.push(subheading(`Top pools by implied volume`))
  lines.push(
    table(result.pools, [
      { header: 'poolId', value: (p) => `${p.poolId.slice(0, 10)}..` },
      { header: 'token', value: (p) => (p.token ? `${p.token.slice(0, 10)}..` : '-') },
      { header: 'sweeps', value: (p) => String(p.sweeps), align: 'right' },
      { header: 'buyback', value: (p) => (p.buybackEnabled ? 'ON' : 'off'), align: 'right' },
      {
        header: 'bb sweep share',
        value: (p) => (p.buybackSweepShare > 0 && p.buybackSweepShare < 1 ? pct(p.buybackSweepShare, 0) : '-'),
        align: 'right',
      },
      {
        header: 'implied vol (units)',
        value: (p) => minorToUnits(p.totalImpliedVolumeMinor, 18).toFixed(2),
        align: 'right',
      },
      { header: 'creatorTax bps', value: (p) => num(p.impliedCreatorTaxBps, 1), align: 'right' },
      { header: 'effective bps', value: (p) => num(p.effectiveCreatorBps, 2), align: 'right' },
      { header: 'model', value: (p) => (p.modelViolations.length > 0 ? 'VIOLATION' : 'ok') },
    ]),
  )
  lines.push('  "implied vol (units)" assumes 18 decimals for display only; the JSON carries exact minor units.')
  lines.push('')
  lines.push(
    '  Next: node tools/addressable-market.ts --buyback-on-rate <volume-weighted share above>',
  )
  return lines.join('\n')
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), main)
}

export { SPEC as POOL_FEES_SPEC }
export { decomposeSweep }

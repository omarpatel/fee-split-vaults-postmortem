/**
 * addressable-market - how many coins clear each QF gate, and how badly does
 * headline volume overstate the fee-bearing volume?
 *
 * TWO TRAPS THIS TOOL EXISTS TO AVOID.
 *
 * 1. THE PAGE CAP. The public pool endpoint serves at most ~200 pools per dex
 *    per query. Phase 0's "200+ coins above $143k/day" is very likely that cap
 *    reporting itself, not a market measurement. This tool enumerates each dex
 *    under several sort orders and unions the results, and it says out loud
 *    whether it hit the cap - so a count is never quoted as complete when it is
 *    a floor.
 *
 * 2. HEADLINE VOLUME. Fees accrue only on the Venue pool. CASHCAT showed a 122x
 *    gap between a token's total observed volume and its Venue-pool volume. A
 *    market count built on headline volume is wrong by up to that factor, so
 *    this computes the Venue-pool share per coin and gates on the Venue leg only.
 *
 * The gate itself is in QF (USD/day of creator fees), and QF-per-unit-volume
 * BRANCHES on buybackEnabled - 0.70% off, 0.35% on. Counts are therefore
 * reported for BOTH branches, and blended when pool-fees-index has measured
 * the population rate.
 */

import type { ParsedValues } from './lib/cli.ts'
import { CliError, getBool, getList, getNumber, getString, isEntrypoint, runCli } from './lib/cli.ts'
import { buildCache } from './lib/cache.ts'
import { describeConfig, loadConfig } from './lib/env.ts'
import { UNPRICED, heading, num, pct, subheading, table, usd } from './lib/format.ts'
import {
  DEFAULT_SORTS,
  GT_LIMITS,
  GeckoTerminalClient,
  type GtCoverage,
  type GtPool,
} from './lib/geckoterminal.ts'
import { buildHttpClient } from './lib/http.ts'
import { emit, emitDryRun, progress, type Report } from './lib/report.ts'
import { quantiles, type Quantiles } from './lib/stats.ts'
import { VENUE, TIERS, TIER_ORDER, creatorNetBps, volumeForQf, type TierId } from '../config/protocol.ts'

const SCHEMA_VERSION = 'addressable-market-1'

const SPEC = {
  name: 'addressable-market',
  summary: 'Count coins above each QF gate from Venue-pool volume, with the method limits stated.',
  detail: `
    Enumerates Venue pools past the ~200-per-dex page cap using several sort orders,
    counts coins above each QF gate for BOTH buyback branches, and computes the
    Venue-pool share of each coin's total observed volume - because headline volume
    overstates fee-bearing volume by up to 122x.
  `,
  options: [
    {
      name: 'dexes',
      type: 'string[]' as const,
      describe: 'Dex ids to enumerate. Defaults to GECKOTERMINAL_DEX_IDS or the three known Venue ids.',
    },
    {
      name: 'sorts',
      type: 'string[]' as const,
      default: [...DEFAULT_SORTS],
      describe: 'Sort orders unioned to widen coverage past the page cap.',
    },
    {
      name: 'max-pages',
      type: 'number' as const,
      default: GT_LIMITS.maxPage,
      describe: 'Pages per sort order. The upstream cap is 10.',
    },
    {
      name: 'venue-share-sample',
      type: 'number' as const,
      default: 25,
      describe:
        'Compute the Venue-pool volume share for this many top coins (one extra request each). 0 disables it.',
    },
    {
      name: 'buyback-on-rate',
      type: 'number' as const,
      describe:
        'Volume-weighted buyback-on share from pool-fees-index, 0..1. Adds a blended count alongside the two branch counts.',
    },
    {
      name: 'creator-tax-bps',
      type: 'number' as const,
      default: 0,
      describe: 'Assumed per-token creator tax added to the creator rate.',
    },
    {
      name: 'gates',
      type: 'string[]' as const,
      describe: 'Extra QF/day thresholds alongside the protocol tiers.',
    },
    { name: 'top', type: 'number' as const, default: 30, describe: 'Coin rows in the human report.' },
    {
      name: 'min-volume-usd',
      type: 'number' as const,
      default: 0,
      describe: 'Ignore pools below this 24h volume when aggregating.',
    },
  ],
  examples: [
    'node tools/addressable-market.ts --venue-share-sample 25',
    'node tools/addressable-market.ts --buyback-on-rate 0.42 --out artifacts/market.json',
  ],
}

export interface CoinRow {
  token: string
  poolCount: number
  /**
   * Pools of this coin whose 24h volume the aggregator did not report. Their
   * volume is NOT zero, it is unknown, so any QF figure below is a floor and
   * the renderer refuses to print one as a measurement when this is non-zero.
   */
  poolsWithUnknownVolume: number
  /** Sum of 24h volume across this coin's VENUE pools only. Fee-bearing. */
  venueVolumeUsd24h: number
  /** Sum across every pool GeckoTerminal knows, when sampled. */
  totalObservedVolumeUsd24h: number | undefined
  /** venueVolume / totalObserved. Undefined when not sampled. */
  venuePoolVolumeShare: number | undefined
  reserveUsd: number
  /** QF/day at each branch of creatorNetBps(). */
  qfBuybackOffUsd: number
  qfBuybackOnUsd: number
  qfBlendedUsd: number | undefined
  poolAddresses: string[]
  newestPoolCreatedAtUnix: number | undefined
}

export interface GateCount {
  id: string
  label: string
  gateQfPerDay: number
  /** Volume needed to clear the gate, per branch. Not universal - hence both. */
  volumeNeededBuybackOff: number
  volumeNeededBuybackOn: number
  countBuybackOff: number
  countBuybackOn: number
  countBlended: number | undefined
}

export interface AddressableMarketResult {
  network: string
  dexIds: string[]
  coverage: GtCoverage[]
  poolsFound: number
  /** Pools the aggregator returned with no 24h volume figure at all. */
  poolsWithUnknownVolume: number
  coinsFound: number
  /** Coins with at least one such pool. Their QF is a floor, not a figure. */
  coinsWithUnknownVolume: number
  buybackOnRate: number | undefined
  creatorTaxBps: number
  creatorBps: { buybackOff: number; buybackOn: number; blended: number | undefined }
  gates: GateCount[]
  venueShare: {
    sampled: number
    /** Distribution of venueVolume/totalObserved across sampled coins. */
    quantiles: Quantiles
    /** Coins whose Venue pool is under 10% of their observed volume. */
    belowTenPercent: number
    worst: Array<{ token: string; share: number; venueVolumeUsd: number; totalVolumeUsd: number }>
  }
  coins: CoinRow[]
}

async function main(values: ParsedValues): Promise<void> {
  const config = loadConfig()
  const json = getBool(values, 'json')
  const dryRun = getBool(values, 'dry-run')
  const verbose = getBool(values, 'verbose')
  const outPath = getString(values, 'out')

  const dexIds = getList(values, 'dexes')
  const dexes = dexIds.length > 0 ? dexIds : config.geckoTerminalDexIds
  const sorts = getList(values, 'sorts')
  const sortOrders = sorts.length > 0 ? sorts : [...DEFAULT_SORTS]
  const maxPages = Math.min(GT_LIMITS.maxPage, Math.floor(getNumber(values, 'max-pages', GT_LIMITS.maxPage)))
  const shareSample = Math.max(0, Math.floor(getNumber(values, 'venue-share-sample', 25)))
  const creatorTaxBps = Math.max(0, Math.floor(getNumber(values, 'creator-tax-bps', 0)))

  const buybackRaw = values['buyback-on-rate']
  const buybackOnRate = typeof buybackRaw === 'number' ? buybackRaw : undefined
  if (buybackOnRate !== undefined && (buybackOnRate < 0 || buybackOnRate > 1)) {
    throw new CliError('--buyback-on-rate must be between 0 and 1')
  }

  if (dryRun) {
    const pagesPerDex = sortOrders.length * maxPages
    emitDryRun(
      {
        tool: SPEC.name,
        config: { ...describeConfig(config), dexes, sortOrders, maxPages, shareSample, creatorTaxBps },
        steps: [
          {
            description: `enumerate ${dexes.length} dex(es) under ${sortOrders.length} sort order(s), ${maxPages} pages each, unioned by pool address`,
            endpoint: `${config.geckoTerminalBase}/networks/${config.geckoTerminalNetwork}/dexes/{dex}/pools`,
            estimatedRequests: dexes.length * pagesPerDex,
          },
          ...(shareSample > 0
            ? [
                {
                  description: `fetch every pool for the top ${shareSample} coins to compute the Venue-pool volume share`,
                  endpoint: `${config.geckoTerminalBase}/networks/${config.geckoTerminalNetwork}/tokens/{token}/pools`,
                  estimatedRequests: shareSample,
                },
              ]
            : []),
        ],
        estimatedRequestsTotal: dexes.length * pagesPerDex + shareSample,
        notes: [
          `The upstream cap is ${GT_LIMITS.pageSize} pools/page and ${GT_LIMITS.maxPage} pages, so ~${GT_LIMITS.maxPoolsPerQuery} pools per dex PER SORT. Unioning ${sortOrders.length} sorts is the workaround, and the result is still a LOWER BOUND.`,
          `At creator tax ${creatorTaxBps}bps: buyback OFF = ${creatorNetBps(false, creatorTaxBps)}bps, ON = ${creatorNetBps(true, creatorTaxBps)}bps.`,
          `T1 ($${TIERS.T1.gateQfPerDay}/day) needs ${usd(volumeForQf(TIERS.T1.gateQfPerDay, false, creatorTaxBps))}/day of Venue volume with buyback off, ${usd(volumeForQf(TIERS.T1.gateQfPerDay, true, creatorTaxBps))}/day with it on.`,
          'This endpoint needs no API key, but it is rate limited; VENUE_HTTP_RPS governs the pace.',
        ],
      },
      json,
    )
    return
  }

  const http = buildHttpClient({
    requestsPerSecond: config.requestsPerSecond,
    maxRetries: config.maxRetries,
    timeoutMs: config.requestTimeoutMs,
    onRetry: (attempt, delay, reason) => progress(verbose, `retry ${attempt} in ${delay}ms: ${reason}`),
  })
  const cache = buildCache(config.cacheDir, getBool(values, 'no-cache'))
  const client = new GeckoTerminalClient({
    baseUrl: config.geckoTerminalBase,
    network: config.geckoTerminalNetwork,
    http,
    cache,
    onProgress: (message) => progress(verbose, message),
  })

  const allPools = new Map<string, GtPool>()
  const coverage: GtCoverage[] = []
  for (const dexId of dexes) {
    const { pools, coverage: dexCoverage } = await client.enumerateDex(dexId, sortOrders, maxPages)
    coverage.push(dexCoverage)
    for (const [address, pool] of pools) {
      const existing = allPools.get(address)
      if (existing === undefined) allPools.set(address, pool)
      else existing.seenVia = [...new Set([...existing.seenVia, ...pool.seenVia])]
    }
  }

  const minVolume = getNumber(values, 'min-volume-usd', 0)
  const byToken = new Map<string, GtPool[]>()
  for (const pool of allPools.values()) {
    if (pool.volumeUsd24h < minVolume) continue
    if (pool.baseTokenAddress.length === 0) continue
    const list = byToken.get(pool.baseTokenAddress)
    if (list === undefined) byToken.set(pool.baseTokenAddress, [pool])
    else list.push(pool)
  }

  const bpsOff = creatorNetBps(false, creatorTaxBps)
  const bpsOn = creatorNetBps(true, creatorTaxBps)
  const bpsBlended =
    buybackOnRate === undefined ? undefined : buybackOnRate * bpsOn + (1 - buybackOnRate) * bpsOff

  const coins: CoinRow[] = []
  for (const [token, pools] of byToken) {
    const venueVolume = pools.reduce((total, p) => total + p.volumeUsd24h, 0)
    const createdAts = pools.map((p) => p.createdAtUnix).filter((c): c is number => c !== undefined)
    coins.push({
      token,
      poolCount: pools.length,
      poolsWithUnknownVolume: pools.filter((p) => p.volumeKnown === false).length,
      venueVolumeUsd24h: venueVolume,
      totalObservedVolumeUsd24h: undefined,
      venuePoolVolumeShare: undefined,
      reserveUsd: pools.reduce((total, p) => total + p.reserveUsd, 0),
      qfBuybackOffUsd: (venueVolume * bpsOff) / 10_000,
      qfBuybackOnUsd: (venueVolume * bpsOn) / 10_000,
      qfBlendedUsd: bpsBlended === undefined ? undefined : (venueVolume * bpsBlended) / 10_000,
      poolAddresses: pools.map((p) => p.address),
      newestPoolCreatedAtUnix: createdAts.length > 0 ? Math.max(...createdAts) : undefined,
    })
  }
  coins.sort((a, b) => b.venueVolumeUsd24h - a.venueVolumeUsd24h)

  // --- Venue-pool volume share, on a sample -------------------------------
  const venueDexIds = new Set(dexes.map((d) => d.toLowerCase()))
  let sampled = 0
  for (const coin of coins.slice(0, shareSample)) {
    try {
      const tokenPools = await client.tokenPools(coin.token)
      const total = tokenPools.reduce((sum, p) => sum + p.volumeUsd24h, 0)
      const venue = tokenPools
        .filter((p) => venueDexIds.has(p.dexId.toLowerCase()))
        .reduce((sum, p) => sum + p.volumeUsd24h, 0)
      coin.totalObservedVolumeUsd24h = total
      // Prefer the Venue volume seen in the token's own pool list when present;
      // it is the same source as the denominator, so the ratio is consistent.
      coin.venuePoolVolumeShare = total > 0 ? (venue > 0 ? venue : coin.venueVolumeUsd24h) / total : undefined
      sampled++
      progress(verbose, `venue share ${coin.token}: ${pct(coin.venuePoolVolumeShare)}`)
    } catch (error) {
      progress(verbose, `venue share ${coin.token} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const shares = coins
    .map((c) => c.venuePoolVolumeShare)
    .filter((s): s is number => s !== undefined && Number.isFinite(s))

  // --- gate counts --------------------------------------------------------
  const gates: GateCount[] = []
  const tierIds: TierId[] = TIER_ORDER.filter((t) => TIERS[t].gateQfPerDay > 0)
  for (const tierId of tierIds) {
    gates.push(makeGateCount(tierId, `${tierId} ${TIERS[tierId].name}`, TIERS[tierId].gateQfPerDay, coins, creatorTaxBps, bpsBlended))
  }
  for (const raw of getList(values, 'gates')) {
    const gate = Number(raw)
    if (!Number.isFinite(gate) || gate <= 0) throw new CliError(`--gates value "${raw}" is not a positive number`)
    gates.push(makeGateCount(`custom:${gate}`, `custom $${gate}/day`, gate, coins, creatorTaxBps, bpsBlended))
  }

  const result: AddressableMarketResult = {
    network: config.geckoTerminalNetwork,
    dexIds: dexes,
    coverage,
    poolsFound: allPools.size,
    poolsWithUnknownVolume: [...allPools.values()].filter((p) => p.volumeKnown === false).length,
    coinsFound: coins.length,
    coinsWithUnknownVolume: coins.filter((c) => c.poolsWithUnknownVolume > 0).length,
    buybackOnRate,
    creatorTaxBps,
    creatorBps: { buybackOff: bpsOff, buybackOn: bpsOn, blended: bpsBlended },
    gates,
    venueShare: {
      sampled,
      quantiles: quantiles(shares),
      belowTenPercent: shares.filter((s) => s < 0.1).length,
      worst: coins
        .filter((c) => c.venuePoolVolumeShare !== undefined)
        .sort((a, b) => (a.venuePoolVolumeShare ?? 1) - (b.venuePoolVolumeShare ?? 1))
        .slice(0, 10)
        .map((c) => ({
          token: c.token,
          share: c.venuePoolVolumeShare ?? 0,
          venueVolumeUsd: c.venueVolumeUsd24h,
          totalVolumeUsd: c.totalObservedVolumeUsd24h ?? 0,
        })),
    },
    coins: coins.slice(0, Math.max(getNumber(values, 'top', 30), 200)),
  }

  const capped = coverage.filter((c) => c.hitPageCap)
  const warnings: string[] = [
    `EVERY COUNT HERE IS A LOWER BOUND. The upstream API serves ${GT_LIMITS.pageSize} pools/page and refuses to page past ${GT_LIMITS.maxPage}, so one query sees at most ~${GT_LIMITS.maxPoolsPerQuery} pools per dex. This run unioned ${sortOrders.length} sort orders to widen that; pools outside every sort's top-${GT_LIMITS.maxPoolsPerQuery} are invisible.`,
    'Volume is a rolling 24h SNAPSHOT, not a trailing 7-day median. The protocol gates on a median precisely because a snapshot is farmable with one day of wash volume, so these counts are an upper bound on the number of coins that would actually clear a tier.',
  ]
  if (capped.length > 0) {
    warnings.push(
      `${capped.length} dex enumeration(s) filled every page and hit the cap (${capped.map((c) => c.dexId).join(', ')}). The true pool count for those dexes is HIGHER than reported, by an unknown amount.`,
    )
  }
  if (shareSample > 0 && sampled === 0) {
    warnings.push(
      'The Venue-pool volume share could not be computed for any coin, so nothing here corrects for the headline-volume overstatement. Treat every count as measuring TOTAL volume, which Phase 0 found overstates fee-bearing volume by up to 122x.',
    )
  } else if (sampled > 0 && sampled < coins.length) {
    warnings.push(
      `The Venue-pool share was sampled for ${sampled} of ${coins.length} coins. Unsampled coins are counted on their Venue-pool volume as enumerated, which is correct only if this dex list is complete.`,
    )
  }
  if (buybackOnRate === undefined) {
    warnings.push(
      'No --buyback-on-rate was given, so no blended count exists. The gap between the two branch columns IS the 2x uncertainty; run pool-fees-index.ts to close it.',
    )
  }
  if (result.coinsWithUnknownVolume > 0) {
    warnings.push(
      `${result.poolsWithUnknownVolume} pool(s) across ${result.coinsWithUnknownVolume} coin(s) came back with NO 24h volume figure. Their volume is unknown, not zero: every count below is a floor by that much on top of the page cap, and those coins' QF columns are marked ">=" rather than printed as measurements.`,
    )
  }
  if (allPools.size === 0) {
    warnings.push(
      `Zero pools returned. Check the network id ("${config.geckoTerminalNetwork}") and the dex ids (${dexes.join(', ')}) before concluding anything about the market. ZERO IS NOT A MEASUREMENT OF THE MARKET - it is the shape of a wrong network id, and this run exits non-zero for that reason.`,
    )
  }

  const report: Report<AddressableMarketResult> = {
    meta: {
      tool: SPEC.name,
      schemaVersion: SCHEMA_VERSION,
      generatedAtUnix: Math.floor(Date.now() / 1000),
      config: { ...describeConfig(config), dexes, sortOrders, maxPages },
      io: { httpRequests: http.requestCount, cacheHits: cache.hits, cacheMisses: cache.misses },
      warnings,
      // An enumeration that saw nothing has not measured a market of zero
      // coins; it has failed. Exiting 0 there would let a wrong network id
      // propagate as "the addressable market is empty".
      measurementComplete: allPools.size > 0,
      ...(allPools.size > 0
        ? {}
        : {
            incompleteReasons: [
              `No pool was returned for network "${config.geckoTerminalNetwork}" and dex ids ${dexes.join(', ')}, so every gate count below is the count of an empty enumeration rather than a market measurement.`,
              'Verify the network id and dex ids against the aggregator before treating any zero here as a fact about Venue.',
            ],
          }),
      methodLimits: [
        `Enumeration method: per-dex, ${sortOrders.length} sort orders (${sortOrders.join(', ')}), up to ${maxPages} pages each, unioned by pool address. Coverage per sort is reported in the coverage block.`,
        'A coin is identified by the BASE token of its pool. A pool whose Venue token sits on the quote side is attributed to the wrong coin, and a token quoted against another memecoin is not handled.',
        'The aggregator, not the chain, is the source here. It can lag, miss a pool, or mis-attribute a dex id. For fee-bearing volume that must be exact, use pool-fees-index.ts, which reads the hook.',
        'QF is derived from volume by creatorNetBps(), which BRANCHES on buybackEnabled. Both branches are reported because a single number would be a 2x lie in one direction or the other.',
      ],
    },
    result,
  }

  await emit(report, { json, outPath, human: (r) => renderHuman(r.result, Math.floor(getNumber(values, 'top', 30))) })
}

function makeGateCount(
  id: string,
  label: string,
  gateQfPerDay: number,
  coins: readonly CoinRow[],
  creatorTaxBps: number,
  bpsBlended: number | undefined,
): GateCount {
  return {
    id,
    label,
    gateQfPerDay,
    volumeNeededBuybackOff: volumeForQf(gateQfPerDay, false, creatorTaxBps),
    volumeNeededBuybackOn: volumeForQf(gateQfPerDay, true, creatorTaxBps),
    countBuybackOff: coins.filter((c) => c.qfBuybackOffUsd >= gateQfPerDay).length,
    countBuybackOn: coins.filter((c) => c.qfBuybackOnUsd >= gateQfPerDay).length,
    countBlended:
      bpsBlended === undefined
        ? undefined
        : // An undefined blended QF is unknown, not zero: it must not be counted
          // as a coin sitting below the gate.
          coins.filter((c) => c.qfBlendedUsd !== undefined && c.qfBlendedUsd >= gateQfPerDay)
            .length,
  }
}

function renderHuman(result: AddressableMarketResult, top: number): string {
  const lines: string[] = []
  lines.push(heading('Addressable market by QF gate'))
  lines.push(
    `network ${result.network}  dexes ${result.dexIds.join(', ')}  pools ${result.poolsFound}  coins ${result.coinsFound}`,
  )
  lines.push(
    `creator rate: buyback OFF ${num(result.creatorBps.buybackOff, 2)}bps, ON ${num(result.creatorBps.buybackOn, 2)}bps` +
      (result.creatorBps.blended === undefined
        ? '  (no measured mix - both branches shown)'
        : `, blended ${num(result.creatorBps.blended, 2)}bps at ${pct(result.buybackOnRate)} buyback-on`),
  )

  lines.push(subheading('Coins above each gate'))
  // A count taken over a population where some members' volume is unknown is a
  // floor, and it is rendered as one. The page cap already makes every count
  // here a floor; an unknown volume makes it a floor for a second, independent
  // reason, and the reader is told which.
  const floored = result.coinsWithUnknownVolume > 0
  const countCell = (value: number): string => (floored ? `>=${value}` : String(value))
  lines.push(
    table(result.gates, [
      { header: 'gate', value: (g) => g.label },
      { header: 'QF $/day', value: (g) => String(g.gateQfPerDay), align: 'right' },
      { header: 'vol needed (bb off)', value: (g) => usd(g.volumeNeededBuybackOff), align: 'right' },
      { header: 'vol needed (bb on)', value: (g) => usd(g.volumeNeededBuybackOn), align: 'right' },
      { header: 'count (bb off)', value: (g) => countCell(g.countBuybackOff), align: 'right' },
      { header: 'count (bb on)', value: (g) => countCell(g.countBuybackOn), align: 'right' },
      {
        header: 'count blended',
        value: (g) => (g.countBlended === undefined ? '-' : countCell(g.countBlended)),
        align: 'right',
      },
    ]),
  )
  lines.push('  The gap between the two count columns is the buyback branch uncertainty. It is a 2x swing on volume needed.')
  if (floored) {
    lines.push(
      `  ">=" because ${result.coinsWithUnknownVolume} coin(s) have a pool with NO reported volume. Unknown volume is not $0/day,`,
    )
    lines.push('  so those coins may sit above a gate without being counted here.')
  }
  if (result.poolsFound === 0) {
    lines.push('')
    lines.push(
      `  NOTHING WAS ENUMERATED. Every count above is ${UNPRICED} in substance: it is the size of an empty result set,`,
    )
    lines.push('  which is what a wrong network id or dex id looks like. Do not read it as "no market".')
  }

  lines.push(subheading('Enumeration coverage (how much of the market this saw)'))
  lines.push(
    table(result.coverage, [
      { header: 'dex', value: (c) => c.dexId },
      { header: 'pages', value: (c) => String(c.pagesFetched), align: 'right' },
      { header: 'union', value: (c) => String(c.unionCount), align: 'right' },
      {
        header: 'per sort',
        value: (c) =>
          Object.entries(c.perSortCounts)
            .map(([sort, count]) => `${sort.replace('_desc', '')}=${count}`)
            .join(' '),
      },
      { header: 'hit cap', value: (c) => (c.hitPageCap ? 'YES - undercount' : 'no') },
    ]),
  )

  lines.push(subheading('Venue-pool share of total observed volume'))
  if (result.venueShare.sampled === 0) {
    lines.push('  Not sampled. Counts above are on enumerated Venue-pool volume with no cross-check.')
  } else {
    const q = result.venueShare.quantiles
    lines.push(
      `  sampled ${result.venueShare.sampled} coins:  median ${pct(q.median)}  p25 ${pct(q.p25)}  p75 ${pct(q.p75)}  min ${pct(q.min)}  max ${pct(q.max)}`,
    )
    lines.push(`  ${result.venueShare.belowTenPercent} coin(s) have under 10% of their volume in a Venue pool.`)
    lines.push('')
    lines.push(
      table(result.venueShare.worst, [
        { header: 'token', value: (w) => `${w.token.slice(0, 12)}..` },
        { header: 'venue share', value: (w) => pct(w.share), align: 'right' },
        { header: 'venue vol 24h', value: (w) => usd(w.venueVolumeUsd), align: 'right' },
        { header: 'total vol 24h', value: (w) => usd(w.totalVolumeUsd), align: 'right' },
        {
          header: 'overstatement',
          value: (w) => (w.share > 0 ? `${(1 / w.share).toFixed(1)}x` : 'inf'),
          align: 'right',
        },
      ]),
    )
    lines.push('  "overstatement" is how far headline volume exceeds fee-bearing volume for that coin. Phase 0 saw up to 122x.')
  }

  lines.push(subheading(`Top ${Math.min(top, result.coins.length)} coins by Venue-pool volume`))
  // A coin with an unknown-volume pool gets ">=" on every volume-derived cell:
  // the figure is a floor, and printing it bare makes a partial sum look total.
  const floor = (c: CoinRow, value: number): string =>
    c.poolsWithUnknownVolume > 0 ? `>=${usd(value)}` : usd(value)
  lines.push(
    table(result.coins.slice(0, top), [
      { header: 'token', value: (c) => `${c.token.slice(0, 12)}..` },
      {
        header: 'pools',
        value: (c) =>
          c.poolsWithUnknownVolume > 0
            ? `${c.poolCount} (${c.poolsWithUnknownVolume} no vol)`
            : String(c.poolCount),
        align: 'right',
      },
      { header: 'venue vol 24h', value: (c) => floor(c, c.venueVolumeUsd24h), align: 'right' },
      { header: 'venue share', value: (c) => (c.venuePoolVolumeShare === undefined ? '-' : pct(c.venuePoolVolumeShare)), align: 'right' },
      { header: 'QF/day bb off', value: (c) => floor(c, c.qfBuybackOffUsd), align: 'right' },
      { header: 'QF/day bb on', value: (c) => floor(c, c.qfBuybackOnUsd), align: 'right' },
      { header: 'reserve', value: (c) => usd(c.reserveUsd), align: 'right' },
    ]),
  )
  lines.push('')
  lines.push('  Next: node tools/reprice.ts --clients-above-gate <count blended> --tenure-days <from tenure.ts>')
  return lines.join('\n')
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), main)
}

export { SPEC as ADDRESSABLE_MARKET_SPEC, makeGateCount }

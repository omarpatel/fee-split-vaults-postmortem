/**
 * escrow-index - per-recipient daily credit series from the Venue V2 fee escrow.
 *
 * THE SINGLE HIGHEST-VALUE QUERY IN THE PROJECT. Phase 0 left three numbers
 * unmeasured, and this one scan settles all three at once:
 *   1. the true T1 population (how many recipients clear TIERS.T1.gateQfPerDay
 *      of QF - $1,000/day as this is written; read it from config, because a
 *      count taken against the old $250 gate answers a question nobody asked),
 *   2. the tenure distribution (fed to tenure.ts),
 *   3. the durable-cohort size (how many hold the gate for 7+ and 14+ days).
 *
 * WHAT IT CANNOT SETTLE. Escrow credits key by (recipient, quoteAsset) and
 * carry no coin identifier, so this counts RECIPIENTS, not coins. One recipient
 * may be the fee address for several coins. Per-coin attribution requires the
 * PoolFeesSwept -> TokenLaunched join in pool-fees-index.ts.
 */

import { buildCache } from './lib/cache.ts'
import type { ParsedValues } from './lib/cli.ts'
import { CliError, getBool, getList, getNumber, getString, isEntrypoint, runCli } from './lib/cli.ts'
import { TOOLS_DIR, describeConfig, loadConfig, rpcUrlsOrPlaceholder } from './lib/env.ts'
import {
  CREDIT_SCAN_MODES,
  DEFAULT_CREDIT_EVENT_BY_MODE,
  NATIVE_CREDIT_EVENT,
  TOKEN_CREDIT_EVENT,
  VERIFIED_CREDIT_TOPIC0,
  buildEscrowBackend,
  discoverTopics,
  resolveCreditEvents,
  type CreditEventMode,
  type CreditEventPlan,
  type CreditScanMode,
  type EscrowCredit,
} from './lib/escrow.ts'
import { buildHttpClient } from './lib/http.ts'
import { UNPRICED, banner, heading, shortAddress, sparkline, subheading, table, usd } from './lib/format.ts'
import { parseJson } from './lib/json.ts'
import {
  DEFAULT_SCAN_BATCH_SIZE,
  findBlockAtOrAfter,
  formatScanProgress,
} from './lib/logscan.ts'
import {
  NATIVE_ASSET_ADDRESS,
  PriceBook,
  defaultQuoteAssets,
  minorToUnits,
  nativeQuoteAsset,
  parseAssetEntriesFile,
} from './lib/prices.ts'
import {
  applyOnchainPrice,
  loadOnchainPriceConfig,
  type OnchainPriceQuote,
} from './lib/onchain-price.ts'
import { emit, emitDryRun, progress, type Report } from './lib/report.ts'
import { HttpChainReader } from './lib/rpc.ts'
import {
  aggregateDailyCredits,
  ESCROW_SERIES_SCHEMA,
  type AssetTotal,
  type EscrowSeriesDocument,
} from './lib/series.ts'
import { SECONDS_PER_DAY, dayStartUnix, isoDate } from './lib/time.ts'
import {
  isFullyPriced,
  peakDailyUsd,
  pricingCoverage,
  trailingMedianUsd,
  unpricedBannerLines,
  unpricedReasons,
  type PricingCoverage,
} from './lib/unpriced.ts'
import { VENUE, TIERS } from '../config/protocol.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const SPEC = {
  name: 'escrow-index',
  summary: 'Index the Venue V2 fee escrow into per-recipient daily credit series.',
  detail: `
    Settles the true T1 population, the tenure distribution and the durable-cohort size.
    Counts RECIPIENTS, not coins: escrow credits carry no coin identifier.
    THE CREDIT IS TWO EVENTS. Credited carries NATIVE value and has no token param;
    CreditedToken carries ERC-20 value and its 2nd indexed param IS the asset.
    --mode both (the default) scans and merges them, because a run against one
    silently undercounts and summing two artifacts by hand is a defect, not a workflow.
  `,
  options: [
    {
      name: 'days',
      type: 'number' as const,
      default: 30,
      describe: 'How many days back from --to to index.',
    },
    {
      name: 'to',
      type: 'string' as const,
      placeholder: '<iso|latest>',
      default: 'latest',
      describe: 'End of the window.',
    },
    {
      name: 'escrow',
      type: 'string' as const,
      placeholder: '<address>',
      default: VENUE.contracts.v2FeeEscrow,
      describe: 'Fee escrow contract to index.',
    },
    {
      name: 'mode',
      type: 'string' as const,
      placeholder: '<native|token|both>',
      default: 'both',
      describe:
        'Which credit event(s) to scan. "both" merges Credited (native) and CreditedToken (ERC-20) over the same window into ONE series - use it for any real number. "native" or "token" scans one event alone, for debugging.',
    },
    {
      name: 'event',
      type: 'string' as const,
      placeholder: '<signature>',
      describe:
        'Override the credit event signature for a single --mode. Rejected under --mode both, where the two events need --event-native / --event-token. A signature whose shape does not match the mode is a hard error, never a positional guess.',
    },
    {
      name: 'event-native',
      type: 'string' as const,
      placeholder: '<signature>',
      describe: `Override the NATIVE credit event. Must have 2 indexed address params and no token param. Default: "${NATIVE_CREDIT_EVENT}".`,
    },
    {
      name: 'event-token',
      type: 'string' as const,
      placeholder: '<signature>',
      describe: `Override the ERC-20 credit event. Must have 3 indexed address params, one of them the asset. Default: "${TOKEN_CREDIT_EVENT}".`,
    },
    {
      name: 'discover-topics',
      type: 'boolean' as const,
      describe:
        'Do not index. Census topic0 over a sample range and report which signatures match. Run this FIRST.',
    },
    {
      name: 'discover-blocks',
      type: 'number' as const,
      default: 20_000,
      describe: 'Block span sampled by --discover-topics, ending at the window end.',
    },
    {
      name: 'assets',
      type: 'string' as const,
      placeholder: '<file>',
      describe:
        'JSON array of quote assets [{address, symbol?, decimals?, priceUsd?}]. Decimals are READ, never assumed - generate this file with tools/token-metadata.ts --out-assets, then fill in priceUsd for the head of the ranking. priceUsd pins to the ADDRESS, which beats symbol matching because issuer-chosen symbols collide. An entry with no decimals stays unpriceable rather than defaulting to 18.',
    },
    {
      name: 'allow-missing-prices',
      type: 'boolean' as const,
      describe:
        'Let the run COMPLETE and the artifact be written with null USD for unpriced assets. It does NOT make the USD conclusions printable: gate counts stay refused, USD figures render UNPRICED, and the run exits 3 (incomplete measurement) rather than 0.',
    },
    {
      name: 'recipients',
      type: 'string[]' as const,
      describe: 'Restrict to these recipient addresses (topic-filtered when possible).',
    },
    {
      name: 'min-usd',
      type: 'number' as const,
      default: 0,
      describe: 'Drop recipients whose total USD over the window is below this, from the report only.',
    },
    {
      name: 'exact-timestamps',
      type: 'boolean' as const,
      describe:
        'Fetch a header for every block containing a credit instead of interpolating between anchors. Slower, exact at day boundaries.',
    },
    {
      name: 'anchor-spacing',
      type: 'number' as const,
      default: 2_000,
      describe: 'Blocks between timestamp anchors when not using --exact-timestamps.',
    },
    {
      name: 'rpc-batch',
      type: 'number' as const,
      default: DEFAULT_SCAN_BATCH_SIZE,
      describe:
        'eth_getLogs per JSON-RPC batch. 10 is the measured optimum on this chain; 25+ gets 429ed. 1 disables batching. VENUE_HTTP_RPS counts SUB-requests, so batching does not silently multiply the rate.',
    },
    {
      name: 'checkpoint-dir',
      type: 'string' as const,
      placeholder: '<dir>',
      describe: 'Where to checkpoint the scan so it can resume. Defaults to tools/.checkpoints.',
    },
    {
      name: 'no-checkpoint',
      type: 'boolean' as const,
      describe: 'Do not checkpoint. A failure then loses the whole scan.',
    },
    {
      name: 'no-resume',
      type: 'boolean' as const,
      describe: 'Ignore an existing checkpoint and scan the window from the start.',
    },
    {
      name: 'keep-checkpoint',
      type: 'boolean' as const,
      describe: 'Keep the checkpoint after a successful run instead of deleting it.',
    },
    {
      name: 'top',
      type: 'number' as const,
      default: 25,
      describe: 'Rows shown in the human report.',
    },
  ],
  examples: [
    'node tools/escrow-index.ts --discover-topics --discover-blocks 50000',
    'node tools/escrow-index.ts --days 1 --out tools/artifacts/escrow-1d-both.json      # merged, the default',
    'node tools/escrow-index.ts --days 1 --mode native   # one event alone, for debugging',
    'node tools/escrow-index.ts --days 1 --mode token --allow-missing-prices',
    'ESCROW_BACKEND=bitquery node tools/escrow-index.ts --days 30 --json',
  ],
}

/** Parse --mode, refusing anything that is not one of the three scan modes. */
function parseScanMode(values: ParsedValues): CreditScanMode {
  const raw = (getString(values, 'mode') ?? 'both').toLowerCase()
  if (!CREDIT_SCAN_MODES.includes(raw as CreditScanMode)) {
    throw new CliError(`--mode must be one of ${CREDIT_SCAN_MODES.join(', ')}, got "${raw}".`)
  }
  return raw as CreditScanMode
}

/**
 * Collect the per-event signature overrides.
 *
 * --event is a convenience for a single-mode run only. Under --mode both it is
 * ambiguous by construction - it cannot say WHICH of the two events it means -
 * so it is refused rather than silently applied to one of them.
 */
function collectEventOverrides(
  values: ParsedValues,
  mode: CreditScanMode,
): Partial<Record<CreditEventMode, string>> {
  const overrides: Partial<Record<CreditEventMode, string>> = {}
  const native = getString(values, 'event-native')
  const token = getString(values, 'event-token')
  const generic = getString(values, 'event')
  if (native !== undefined) overrides.native = native
  if (token !== undefined) overrides.token = token
  if (generic !== undefined) {
    if (mode === 'both') {
      throw new CliError(
        '--event is ambiguous under --mode both: it cannot say which of the two credit events it ' +
          'overrides. Use --event-native and/or --event-token, or pick a single --mode.',
      )
    }
    if (overrides[mode] !== undefined) {
      throw new CliError(`--event and --event-${mode} were both given; they set the same thing.`)
    }
    overrides[mode] = generic
  }
  if (mode !== 'both') {
    const other: CreditEventMode = mode === 'native' ? 'token' : 'native'
    if (overrides[other] !== undefined) {
      throw new CliError(
        `--event-${other} was given but --mode ${mode} does not scan the ${other} event. ` +
          `Drop the override or use --mode both.`,
      )
    }
  }
  return overrides
}

function describeEvents(plans: readonly CreditEventPlan[]): Array<{
  mode: CreditEventMode
  signature: string
  topic0: string
}> {
  return plans.map((plan) => ({
    mode: plan.mode,
    signature: plan.spec.canonical,
    topic0: plan.spec.topic0,
  }))
}

async function main(values: ParsedValues): Promise<void> {
  const config = loadConfig()
  const json = getBool(values, 'json')
  const dryRun = getBool(values, 'dry-run')
  const verbose = getBool(values, 'verbose')
  const outPath = getString(values, 'out')

  const escrow = (getString(values, 'escrow') ?? VENUE.contracts.v2FeeEscrow).toLowerCase()
  const mode = parseScanMode(values)
  // Resolved BEFORE any network I/O: a mis-shaped --event override must fail on
  // the command line, not after a 20-minute scan has produced garbage buckets.
  const eventPlans = resolveCreditEvents(mode, collectEventOverrides(values, mode))
  const eventDescriptors = describeEvents(eventPlans)
  const days = getNumber(values, 'days', 30)
  if (days <= 0) throw new CliError('--days must be positive')

  const http = buildHttpClient({
    requestsPerSecond: config.requestsPerSecond,
    maxRetries: config.maxRetries,
    timeoutMs: config.requestTimeoutMs,
    onRetry: (attempt, delay, reason) =>
      progress(verbose, `retry ${attempt} in ${delay}ms: ${reason}`),
    // Retrying a 429 at the same rate spends the whole run in backoff. Drop the
    // sustained rate on a throttle and climb back towards the operator's
    // configured ceiling - never above it, since that ceiling was measured.
    adaptive: {
      minRequestsPerSecond: Math.max(0.1, config.requestsPerSecond / 8),
      onRateChange: (rps, reason) => progress(verbose, `rate -> ${rps.toFixed(3)}/s (${reason})`),
    },
  })
  const cache = buildCache(config.cacheDir, getBool(values, 'no-cache'))

  const needsRpc = config.escrowBackend === 'rpc' || getBool(values, 'discover-topics')
  const reader = needsRpc
    ? new HttpChainReader(http, rpcUrlsOrPlaceholder(config, dryRun))
    : undefined

  // --- window resolution -------------------------------------------------
  const toArg = getString(values, 'to') ?? 'latest'
  let toBlock: bigint
  let toUnix: number

  if (dryRun) {
    // No I/O in a dry run, so the block span is sized from the estimated block
    // time purely to produce a request budget. A real run binary-searches it.
    toUnix = Math.floor(Date.now() / 1000)
    toBlock = BigInt(Math.ceil((days * SECONDS_PER_DAY) / config.estimatedBlockTimeSeconds))
  } else if (reader !== undefined) {
    const chain = await reader.chainId()
    if (chain !== VENUE.chainId) {
      throw new CliError(
        `RPC endpoint reports chain ${chain}, protocol config pins ${VENUE.chainId}. Refusing to measure the wrong chain.`,
      )
    }
    if (toArg === 'latest') {
      const header = await reader.getBlockHeader('latest')
      toBlock = header.number
      toUnix = header.timestampUnix
    } else {
      toUnix = Math.floor(Date.parse(toArg) / 1000)
      if (Number.isNaN(toUnix)) throw new CliError(`--to could not be parsed: ${toArg}`)
      const latest = await reader.getBlockHeader('latest')
      toBlock = await findBlockAtOrAfter(reader, toUnix, { low: 1n, high: latest.number })
    }
  } else {
    toUnix = toArg === 'latest' ? Math.floor(Date.now() / 1000) : Math.floor(Date.parse(toArg) / 1000)
    toBlock = 0n
  }

  const fromUnix = toUnix - days * SECONDS_PER_DAY
  let fromBlock = 0n
  if (!dryRun && reader !== undefined) {
    fromBlock = await findBlockAtOrAfter(reader, fromUnix, { low: 1n, high: toBlock })
  }

  // --- topic discovery mode ---------------------------------------------
  if (getBool(values, 'discover-topics')) {
    const span = BigInt(Math.floor(getNumber(values, 'discover-blocks', 20_000)))
    if (dryRun) {
      emitDryRun(
        {
          tool: SPEC.name,
          config: describeConfig(config),
          steps: [
            {
              description: `census topic0 over the last ${span} blocks of escrow ${escrow}`,
              estimatedRequests: Math.ceil(Number(span) / config.logChunkBlocks),
            },
          ],
          estimatedRequestsTotal: Math.ceil(Number(span) / config.logChunkBlocks),
          notes: ['Discovery mode makes no assumption about the event ABI; that is the point.'],
        },
        json,
      )
      return
    }
    if (reader === undefined) throw new CliError('--discover-topics needs the RPC backend')
    const start = toBlock > span ? toBlock - span : 0n
    const census = await discoverTopics(reader, {
      escrow,
      fromBlock: start,
      toBlock,
      chunkBlocks: config.logChunkBlocks,
      cache,
    })
    const report: Report<{ escrow: string; fromBlock: string; toBlock: string; topics: typeof census }> = {
      meta: {
        tool: SPEC.name,
        schemaVersion: 'escrow-topic-census-1',
        generatedAtUnix: Math.floor(Date.now() / 1000),
        config: describeConfig(config),
        io: { httpRequests: http.requestCount, cacheHits: cache.hits, cacheMisses: cache.misses },
        warnings: [
          'This census tells you which events the escrow ACTUALLY emits. Pin the credit event with --event before trusting any population or tenure number.',
        ],
        methodLimits: [
          `Only the last ${span} blocks were sampled. A rare event type may not appear.`,
        ],
      },
      result: { escrow, fromBlock: start.toString(), toBlock: toBlock.toString(), topics: census },
    }
    await emit(report, {
      json,
      outPath,
      human: (r) =>
        [
          heading(`Escrow topic0 census: ${escrow}`),
          `blocks ${r.result.fromBlock} .. ${r.result.toBlock}`,
          '',
          table(r.result.topics, [
            { header: 'topic0', value: (t) => t.topic0 },
            { header: 'count', value: (t) => String(t.count), align: 'right' },
            { header: 'topics', value: (t) => String(t.topicCount), align: 'right' },
            { header: 'dataWords', value: (t) => String(t.dataWords), align: 'right' },
            { header: 'matches', value: (t) => t.matchedSignature ?? '-' },
          ]),
        ].join('\n'),
    })
    return
  }

  // --- price book --------------------------------------------------------
  // The native asset is registered FIRST and unconditionally. Native credits key
  // by address(0), and without a registered native asset every one of them
  // prices as n/a no matter what VENUE_PRICE_USD_ETH says - which is exactly what
  // a live run hit. An --assets file may still override it (same address wins),
  // so a chain whose native asset is not 18-decimal ETH stays expressible.
  const assetsPath = getString(values, 'assets')
  const prices = PriceBook.fromConfig(config, defaultQuoteAssets(VENUE.contracts.weth))
  let assetsPricedByAddress = 0
  if (assetsPath !== undefined) {
    // The --assets file is the hand-pricing surface for a long tail: it carries
    // chain-READ decimals (from tools/token-metadata.ts --out-assets) and an
    // operator-pinned priceUsd per ADDRESS. Pinning by address rather than by
    // symbol matters here: across the live 263-asset set, symbols collide -
    // VLAD appears six times, TRUMP five - so a symbol match would price one
    // issuer's token at another's rate.
    const entries = parseAssetEntriesFile(parseJson(await readFile(assetsPath, 'utf8')))
    for (const entry of entries) {
      if (entry.decimals === undefined) {
        // No decimals means the asset stays UNPRICEABLE, which flows into the
        // unpriced coverage. It never falls back to 18.
        continue
      }
      prices.registerAsset(
        {
          address: entry.address,
          symbol: entry.symbol ?? `UNRESOLVED_${entry.address.slice(2, 10)}`,
          decimals: entry.decimals,
        },
        entry.priceUsd,
      )
      if (entry.priceUsd !== undefined) assetsPricedByAddress++
    }
  }

  // --- OPTIONAL on-chain price source -------------------------------------
  // Off unless VENUE_ONCHAIN_PRICE_POOL names a pool. When it does, the pool's
  // TWAP either FILLS an unset VENUE_PRICE_USD_ETH or, if that is pinned, is read
  // anyway and reported next to it with the discrepancy. See tools/lib/
  // onchain-price.ts for why the pinned value still wins.
  const onchainPriceConfig = loadOnchainPriceConfig(process.env, {
    wethAddress: VENUE.contracts.weth,
  })
  let onchainPriceWarnings: string[] = []
  let onchainPriceQuote: OnchainPriceQuote | undefined
  if (onchainPriceConfig !== undefined && !dryRun) {
    if (reader === undefined) {
      throw new CliError(
        'VENUE_ONCHAIN_PRICE_POOL is set but this run has no RPC reader, so the pool cannot be read. ' +
          'An on-chain price that was asked for and not obtained is a refusal, not a fallback.',
      )
    }
    const applied = await applyOnchainPrice({
      reader,
      prices,
      config: onchainPriceConfig,
      pinnedBySymbol: config.priceUsdBySymbol,
    })
    onchainPriceQuote = applied.quote
    onchainPriceWarnings = applied.warnings
    progress(
      verbose,
      `on-chain ${onchainPriceConfig.base.symbol}/${onchainPriceConfig.quote.symbol} TWAP ` +
        `${onchainPriceConfig.twapSeconds}s = $${applied.quote.priceUsd.toFixed(2)} ` +
        `(${applied.applied ? 'APPLIED' : 'cross-check only; pinned value wins'})`,
    )
  }

  const backend = buildEscrowBackend(config, {
    ...(reader ? { reader } : {}),
    http,
    cache,
    exactTimestamps: getBool(values, 'exact-timestamps'),
    anchorSpacing: Math.floor(getNumber(values, 'anchor-spacing', 2_000)),
    onProgress: (message) => progress(verbose, message),
    // Survivability. The definitive 30-day run is ~25.7M blocks and well over
    // an hour of queries; a failure at 90% must not cost 90%.
    ...(getBool(values, 'no-checkpoint')
      ? {}
      : { checkpointDir: getString(values, 'checkpoint-dir') ?? join(TOOLS_DIR, '.checkpoints') }),
    noResume: getBool(values, 'no-resume'),
    keepCheckpoint: getBool(values, 'keep-checkpoint'),
    batchSize: Math.max(1, Math.floor(getNumber(values, 'rpc-batch', DEFAULT_SCAN_BATCH_SIZE))),
    onScanProgress: (p) => process.stderr.write(`${formatScanProgress(p, 'credits')}\n`),
  })

  const recipientFilter = getList(values, 'recipients').map((r) => r.toLowerCase())
  const query = {
    escrow,
    events: eventPlans,
    fromBlock,
    toBlock,
    fromUnix,
    toUnix,
    ...(recipientFilter.length > 0 ? { recipients: recipientFilter } : {}),
  }

  if (dryRun) {
    const steps = backend.plan(query)
    emitDryRun(
      {
        tool: SPEC.name,
        config: {
          ...describeConfig(config),
          escrow,
          mode,
          events: eventDescriptors,
          windowDays: days,
          windowEndsAt: toArg,
        },
        steps: [
          {
            description: `resolve the block range for the ${days}-day window by binary search on block timestamps`,
            estimatedRequests: 40,
          },
          ...steps,
        ],
        estimatedRequestsTotal:
          40 + steps.reduce((total, step) => total + (step.estimatedRequests ?? 0), 0),
        notes: [
          `Scan mode "${mode}": ${eventDescriptors
            .map((e) => `${e.mode} = ${e.signature} (topic0 ${e.topic0})`)
            .join('; ')}.`,
          ...(mode === 'both'
            ? [
                'Both credit events share one eth_getLogs filter (topic0 OR-set), so merging costs no extra requests on the RPC backend.',
              ]
            : [
                `--mode ${mode} scans ONE of the escrow's two credit events. Its totals are a LOWER BOUND on credited value; use --mode both for a number anyone will quote.`,
              ]),
          ...eventPlans
            .filter((p) => p.topic0IsUnverified)
            .map(
              (p) =>
                `The ${p.mode} signature was overridden and its topic0 ${p.spec.topic0} is NOT the census-verified ${VERIFIED_CREDIT_TOPIC0[p.mode]}. Confirm with --discover-topics.`,
            ),
          `Quote assets registered: ${prices.knownAssets().map((a) => a.symbol).join(', ') || 'none'} (native asset ${NATIVE_ASSET_ADDRESS} = ETH).` +
            (assetsPricedByAddress > 0
              ? ` ${assetsPricedByAddress} of them carry an operator-pinned per-ADDRESS price from --assets.`
              : ''),
          `Block span is ESTIMATED from VENUE_BLOCK_TIME_SECONDS=${config.estimatedBlockTimeSeconds}s purely to size the request budget. A real run resolves the range by binary search on block timestamps.`,
          ...(config.rpcUrls.length === 0
            ? ['VENUE_RPC_URL is UNSET. This plan is hypothetical; a real run will refuse to start.']
            : []),
          ...(Object.keys(config.priceUsdBySymbol).length === 0
            ? [
                'No VENUE_PRICE_USD_* prices are set. A real run will refuse to emit USD figures. For the native asset set VENUE_PRICE_USD_ETH.',
              ]
            : Object.keys(config.priceUsdBySymbol).includes('ETH')
              ? []
              : [
                  'VENUE_PRICE_USD_ETH is not set. Native credits will fall back to VENUE_PRICE_USD_WETH if that is set, with a warning; ETH and WETH are not the same asset.',
                ]),
        ],
      },
      json,
    )
    return
  }

  const credits: EscrowCredit[] = await backend.fetch(query)
  progress(verbose, `decoded ${credits.length} credits`)

  const document = aggregateDailyCredits(credits, {
    escrow,
    chainId: config.chainId,
    mode,
    events: eventDescriptors,
    backend: backend.name,
    fromBlock,
    toBlock,
    windowStartUnix: fromUnix,
    windowEndUnix: toUnix,
    prices,
  })

  const coverage = pricingCoverage(document)
  if (!coverage.complete && !getBool(values, 'allow-missing-prices')) {
    throw new CliError(
      `no USD price for ${coverage.assetsUnpriced} of ${coverage.assetsSeen} credit asset(s) ` +
        `(${coverage.unpricedAssetSample.slice(0, 3).join(', ')}` +
        `${coverage.assetsUnpriced > 3 ? `, +${coverage.assetsUnpriced - 3} more` : ''}), covering ` +
        `${coverage.recipientsUnpriced} of ${coverage.recipientsTotal} recipients. Set ` +
        `VENUE_PRICE_USD_<SYMBOL>, pass --assets with the right addresses and decimals, or pass ` +
        `--allow-missing-prices to write the artifact anyway. That flag does NOT make the USD ` +
        `conclusions printable - the gate counts stay refused and the run still exits non-zero.`,
    )
  }

  const warnings = [
    ...buildWarnings(document, eventPlans),
    ...prices.aliasWarnings(),
    ...onchainPriceWarnings,
  ]
  const report: Report<EscrowSeriesDocument> = {
    meta: {
      tool: SPEC.name,
      schemaVersion: ESCROW_SERIES_SCHEMA,
      generatedAtUnix: Math.floor(Date.now() / 1000),
      config: {
        ...describeConfig(config),
        escrow,
        mode,
        events: eventDescriptors,
        // Persist the on-chain reading INTO THE ARTIFACT. A price that only
        // existed in a console line cannot be audited six months later, and
        // "where did $3,200 come from" is exactly the question this answers.
        ...(onchainPriceQuote
          ? {
              onchainPrice: {
                priceUsd: onchainPriceQuote.priceUsd,
                source: onchainPriceQuote.source,
                pool: onchainPriceQuote.pool,
                twapSeconds: onchainPriceQuote.twapSeconds,
                meanTick: onchainPriceQuote.meanTick,
                quoteSymbol: onchainPriceQuote.quoteSymbol,
                quotePegUsd: onchainPriceQuote.quotePegUsd,
                observedAtUnix: onchainPriceQuote.observedAtUnix,
                appliedToNative: config.priceUsdBySymbol.ETH === undefined,
              },
            }
          : {}),
      },
      io: { httpRequests: http.requestCount, cacheHits: cache.hits, cacheMisses: cache.misses },
      warnings,
      // --allow-missing-prices buys the ARTIFACT, not the answer. The raw
      // amounts are worth keeping - repricing them later is a one-line change -
      // but this run did not measure the population, so it does not exit 0 and
      // it does not print a gate count.
      measurementComplete: coverage.complete,
      ...(coverage.complete ? {} : { incompleteReasons: unpricedReasons(coverage) }),
      methodLimits: backend.methodLimits(),
    },
    result: document,
  }

  const minUsd = getNumber(values, 'min-usd', 0)
  const top = Math.floor(getNumber(values, 'top', 25))
  await emit(report, { json, outPath, human: (r) => renderHuman(r.result, { minUsd, top }) })
}

function buildWarnings(
  document: EscrowSeriesDocument,
  plans: readonly CreditEventPlan[],
): string[] {
  const warnings: string[] = [
    `This run decoded ${document.events.length} credit event(s): ${document.events
      .map((e) => `${e.mode} "${e.signature}" (topic0 ${e.topic0})`)
      .join(', ')}.`,
    'This counts RECIPIENTS, not coins. Escrow credits key by (recipient, asset) and carry no coin identifier, so a recipient serving several coins appears once. Do not quote these counts as a coin population.',
    `Observation window is ${document.windowDays} days. Any recipient active on the first or last day of it has a tenure that is TRUNCATED, not measured.`,
  ]

  if (document.mode !== 'both') {
    const missing = document.mode === 'native' ? 'CreditedToken (ERC-20)' : 'Credited (native)'
    warnings.push(
      `--mode ${document.mode} SCANNED ONE OF TWO CREDIT EVENTS. ${missing} credits over the same window are NOT in this document, so every total here is a LOWER BOUND and every gate count understates the population. This mode exists for debugging one decoder at a time; --mode both is what produces a number worth quoting.`,
    )
  }

  const unverified = plans.filter((p) => p.topic0IsUnverified)
  if (unverified.length > 0) {
    warnings.push(
      `${unverified.length} event signature(s) were overridden and no longer hash to the topic0 a live census found on this escrow: ${unverified
        .map((p) => `${p.mode} gave ${p.spec.topic0}, census says ${VERIFIED_CREDIT_TOPIC0[p.mode]}`)
        .join('; ')}. A topic that the escrow never emits scans clean and returns nothing.`,
    )
  }

  const positional = plans.filter((p) => p.tokenByPosition)
  if (positional.length > 0) {
    warnings.push(
      `The asset parameter of ${positional
        .map((p) => p.spec.canonical)
        .join(', ')} was located BY POSITION (indexed param 1) because the signature named no parameters. That matches the verified CreditedToken layout, but naming the parameters removes the assumption.`,
    )
  }

  const native = document.assetTotals.filter((a) => a.kind === 'native')
  if (native.length > 1) {
    warnings.push(
      `${native.length} distinct assets are marked native, which should be impossible - the native sentinel is a single address. Treat the per-asset breakdown as suspect.`,
    )
  }

  if (document.unpricedAssets.length > 0) {
    warnings.push(
      `${document.unpricedAssets.length} asset(s) had no USD price and their days are null, not zero: ${document.unpricedAssets.slice(0, 8).join(', ')}${document.unpricedAssets.length > 8 ? `, +${document.unpricedAssets.length - 8} more` : ''}. Any USD total below excludes them.`,
    )
    if (document.unpricedAssets.includes(NATIVE_ASSET_ADDRESS)) {
      warnings.push(
        `THE NATIVE ASSET ITSELF IS UNPRICED. Set VENUE_PRICE_USD_ETH (or VENUE_PRICE_USD_WETH, which is accepted as a documented fallback alias). Native credits are the bulk of this escrow's value, so without it the USD column is not a measurement.`,
      )
    }
  }
  if (document.totalCredits === 0) {
    warnings.push(
      'ZERO credits decoded. That is far more likely to be a wrong event signature, a wrong escrow address or an endpoint that does not serve this range than a genuinely idle escrow. Do not read this as "no market".',
    )
  }
  return warnings
}

export function renderHuman(
  document: EscrowSeriesDocument,
  options: { minUsd: number; top: number },
): string {
  const lines: string[] = []
  const coverage = pricingCoverage(document)
  // First thing on the page, before any table, because the tables below are
  // what the reader will otherwise take away.
  if (!coverage.complete) lines.push(banner(unpricedBannerLines(coverage)))
  lines.push(heading(`Escrow credits: ${document.escrow}`))
  lines.push(
    `chain ${document.chainId}  backend ${document.backend}  blocks ${document.fromBlock}..${document.toBlock}`,
  )
  lines.push(
    `window ${isoDate(document.windowStartDayUnix)} .. ${isoDate(document.windowEndDayUnix)} (${document.windowDays}d)  credits ${document.totalCredits}`,
  )
  lines.push(`mode ${document.mode}  event(s) ${document.eventSignature}`)
  lines.push(`prices ${document.priceSource} pinned @ ${isoDate(document.pricedAtUnix)}`)

  // An unpriced recipient is never dropped by --min-usd. `(totalUsd ?? 0) >=
  // minUsd` silently deleted every unpriced row the moment anyone passed a
  // threshold, which is the same "unknown becomes zero" bug one layer up: the
  // rows most in need of being seen were the ones that disappeared.
  const shown = document.recipients.filter(
    (r) => r.totalUsd === null || r.totalUsd >= options.minUsd,
  )

  lines.push(subheading('Credited value by asset'))
  const nativeRows = document.assetTotals.filter((a) => a.kind === 'native')
  const erc20Rows = document.assetTotals.filter((a) => a.kind === 'erc20')
  lines.push(
    `  native: ${nativeRows.length} asset, ${sumUsdLabel(nativeRows)}   ` +
      `erc20: ${erc20Rows.length} asset(s), ${sumUsdLabel(erc20Rows)}`,
  )
  lines.push(
    table(document.assetTotals.slice(0, Math.max(options.top, 10)), [
      { header: 'kind', value: (a) => a.kind },
      {
        header: 'asset',
        value: (a) => (a.kind === 'native' ? `${a.symbol} (native)` : shortAddress(a.asset)),
      },
      { header: 'symbol', value: (a) => a.symbol },
      {
        header: 'amount',
        value: (a) => formatUnits(a.totalMinor, a.decimals),
        align: 'right',
      },
      { header: 'usd', value: (a) => usd(a.totalUsd), align: 'right' },
      { header: 'recipients', value: (a) => String(a.recipients), align: 'right' },
      { header: 'credits', value: (a) => String(a.credits), align: 'right' },
    ]),
  )
  if (document.assetTotals.length > Math.max(options.top, 10)) {
    lines.push(
      `  ... ${document.assetTotals.length - Math.max(options.top, 10)} further asset(s) in the JSON under result.assetTotals`,
    )
  }

  lines.push(subheading('Population against the tier gates'))
  const gateRows = (['T1', 'T2', 'T3'] as const).map((tierId) => {
    const tier = TIERS[tierId]
    const counts = countAtGate(document, tier.gateQfPerDay)
    return { tier: `${tierId} ${tier.name}`, gate: `$${tier.gateQfPerDay}/day`, counts }
  })
  // THE DEFECT THIS GUARD EXISTS FOR. These four columns used to be computed
  // over `d.usd ?? 0`, so a run that could price nothing printed 0/0/0/0 and
  // read as "there is no market". The true answer for that same window, once
  // priced, was 140 / 83 / 14. A count over a population containing an
  // unvalued member is not a count, so it is refused rather than shrunk.
  const cell = (row: (typeof gateRows)[number], value: number): string =>
    row.counts.refused ? UNPRICED : String(value)
  lines.push(
    table(gateRows, [
      { header: 'tier', value: (r) => r.tier },
      { header: 'gate', value: (r) => r.gate, align: 'right' },
      { header: 'ever >= gate', value: (r) => cell(r, r.counts.everAbove), align: 'right' },
      { header: '7d median >= gate', value: (r) => cell(r, r.counts.median7dAbove), align: 'right' },
      { header: 'run >= 7d', value: (r) => cell(r, r.counts.longestRunAtLeast7), align: 'right' },
      { header: 'run >= 14d', value: (r) => cell(r, r.counts.longestRunAtLeast14), align: 'right' },
    ]),
  )
  const refusal = gateRows[0]?.counts
  if (refusal?.refused === true) {
    lines.push(
      `  REFUSED, NOT ZERO. ${refusal.unpricedRecipients} of ${document.recipients.length} recipients have at least one day`,
    )
    lines.push(
      '  with no USD value, so none of these columns is a count. A count over a population that includes',
    )
    lines.push(
      `  unvalued members is a lower bound at best, and a lower bound printed under a heading like`,
    )
    lines.push(
      `  "ever >= gate" gets quoted as a measurement. Price the assets and re-run; the raw amounts are`,
    )
    lines.push('  already in the artifact, so nothing has to be re-scanned.')
  } else {
    lines.push(
      '  "7d median >= gate" is the protocol\'s own QF definition (trailing 7-day MEDIAN of daily credits).',
    )
    lines.push('  "run >= Nd" counts recipients with N consecutive days at or above the gate.')
  }

  // Ranking by window total is meaningless when the totals are unknown, so an
  // unpriced document is ranked by credit count - something that WAS measured -
  // and the heading says which.
  const rankedByCredits = !coverage.complete
  const rows = rankedByCredits
    ? [...shown].sort(
        (a, b) =>
          creditCountOf(b) - creditCountOf(a) || a.recipient.localeCompare(b.recipient),
      )
    : shown
  lines.push(
    subheading(
      rankedByCredits
        ? `Top ${Math.min(options.top, rows.length)} recipients by CREDIT COUNT (window total is unpriced and cannot be ranked)`
        : `Top ${Math.min(options.top, rows.length)} recipients by window total`,
    ),
  )
  lines.push(
    table(rows.slice(0, options.top), [
      { header: 'recipient', value: (r) => shortAddress(r.recipient) },
      { header: 'total', value: (r) => usd(r.totalUsd), align: 'right' },
      // Was `usd(Math.max(0, ...days.map((d) => d.usd ?? 0)))`, which printed
      // "$0.00" in the same row whose total already said the value was unknown.
      // The row contradicted itself and the $0.00 won the eye.
      { header: 'peak/day', value: (r) => usd(peakDailyUsd(r)), align: 'right' },
      { header: '7d median', value: (r) => usd(trailingMedianUsd(r, 7)), align: 'right' },
      { header: 'active d', value: (r) => String(r.activeDays), align: 'right' },
      { header: 'credits', value: (r) => String(creditCountOf(r)), align: 'right' },
      {
        header: `daily shape (${document.windowDays}d)`,
        value: (r) => sparkline(r.days.map((d) => d.usd), document.windowDays),
      },
    ]),
  )
  if (!coverage.complete) {
    lines.push(
      `  "${UNPRICED}" is not a small number. "?" in the daily shape is a day whose value is unknown, not an idle day.`,
    )
  }

  const dailyTotals = totalsByDay(document)
  const unpricedDays = dailyTotals.filter((d) => d.usd === null).length
  lines.push(subheading('Escrow-wide daily credit total, USD'))
  lines.push(`  ${sparkline(dailyTotals.map((d) => d.usd), 60)}`)
  lines.push(
    `  first ${isoDate(dailyTotals[0]?.dayUnix ?? 0)} ${usd(dailyTotals[0]?.usd)}   ` +
      `last ${isoDate(dailyTotals[dailyTotals.length - 1]?.dayUnix ?? 0)} ${usd(dailyTotals[dailyTotals.length - 1]?.usd)}`,
  )
  // The mean of a series with unknown members is unknown, not the mean of the
  // members that happened to be known.
  const meanUsd =
    unpricedDays > 0 || dailyTotals.length === 0
      ? null
      : dailyTotals.reduce((a, d) => a + (d.usd ?? 0), 0) / dailyTotals.length
  lines.push(
    `  mean ${usd(meanUsd)}/day across ${document.recipients.length} distinct recipients` +
      (unpricedDays > 0 ? `  (${unpricedDays} of ${dailyTotals.length} days contain unpriced credits)` : ''),
  )
  lines.push('')
  lines.push(`  Next: node tools/tenure.ts --input <this file>   (writes the survival analysis)`)
  return lines.join('\n')
}

function creditCountOf(recipient: { days: ReadonlyArray<{ creditCount: number }> }): number {
  return recipient.days.reduce((total, d) => total + d.creditCount, 0)
}

/** Whole units of an asset, for the human table only. Never fed back into money. */
function formatUnits(minor: string, decimals: number): string {
  const raw = BigInt(minor)
  // Only an amount that IS zero may render as "0". A tiny nonzero amount
  // rounded to "0" by a 4-decimal format is the same "unknown becomes zero"
  // bug as an unpriced total printed as $0.00 - and it bites hardest on the
  // assets whose decimals were assumed rather than read, which is exactly
  // where the reader most needs to see that something is there.
  if (raw === 0n) return '0'
  const value = minorToUnits(raw, decimals)
  const abs = Math.abs(value)
  if (abs >= 1e12 || abs < 1e-3) return value.toExponential(3)
  const rendered = value.toLocaleString('en-US', { maximumFractionDigits: 4 })
  return /[1-9]/.test(rendered) ? rendered : value.toExponential(3)
}

/**
 * USD across a set of assets, or UNPRICED with a coverage count.
 *
 * Never a partial sum: adding up only the priced assets and printing it as the
 * group total is how an unpriced tail disappears from a headline figure.
 */
function sumUsdLabel(rows: readonly AssetTotal[]): string {
  // "none", not "$0.00". No asset of this kind was credited in the window - and
  // under --mode native or --mode token, one whole side of the escrow was never
  // scanned, so a $0.00 there asserts something this run did not look at.
  if (rows.length === 0) return 'none'
  const priced = rows.filter((r) => r.totalUsd !== null)
  if (priced.length < rows.length) {
    return `${usd(null)} (${priced.length}/${rows.length} assets priced)`
  }
  return usd(priced.reduce((total, r) => total + (r.totalUsd ?? 0), 0))
}

function trailingMedianOf(values: readonly number[], window: number): number {
  const slice = [...values.slice(Math.max(0, values.length - window))].sort((a, b) => a - b)
  if (slice.length === 0) return 0
  const mid = Math.floor(slice.length / 2)
  return slice.length % 2 === 1 ? slice[mid]! : (slice[mid - 1]! + slice[mid]!) / 2
}

export interface GateCountAtGate {
  /** Counts over the FULLY PRICED recipients only. Lower bounds when refused. */
  everAbove: number
  median7dAbove: number
  longestRunAtLeast7: number
  longestRunAtLeast14: number
  /** Recipients skipped because at least one of their days has no USD value. */
  unpricedRecipients: number
  pricedRecipients: number
  /**
   * True when unpricedRecipients > 0. The four counts above are then LOWER
   * BOUNDS, and the human renderer prints the unknown marker instead of them:
   * a lower bound in a column headed "ever >= gate" gets quoted as a count.
   */
  refused: boolean
}

/**
 * Recipients at or above a USD gate.
 *
 * Unpriced recipients are EXCLUDED rather than zero-filled. The old body read
 * `recipient.days.map((d) => d.usd ?? 0)`, which put every unpriced recipient
 * below every gate, so an escrow whose assets had no prices produced a tidy
 * table of zeros that read as "no market". The counts here are still computed
 * over the priced subset - they are worth having in the JSON - but `refused`
 * says they are not a population count, and the renderer honours it.
 */
export function countAtGate(document: EscrowSeriesDocument, gate: number): GateCountAtGate {
  let everAbove = 0
  let median7dAbove = 0
  let run7 = 0
  let run14 = 0
  let unpriced = 0
  let priced = 0
  for (const recipient of document.recipients) {
    if (!isFullyPriced(recipient)) {
      unpriced++
      continue
    }
    priced++
    const series = recipient.days.map((d) => d.usd as number)
    if (series.some((v) => v >= gate)) everAbove++
    if (trailingMedianOf(series, 7) >= gate) median7dAbove++
    let longest = 0
    let current = 0
    for (const value of series) {
      current = value >= gate ? current + 1 : 0
      longest = Math.max(longest, current)
    }
    if (longest >= 7) run7++
    if (longest >= 14) run14++
  }
  return {
    everAbove,
    median7dAbove,
    longestRunAtLeast7: run7,
    longestRunAtLeast14: run14,
    unpricedRecipients: unpriced,
    pricedRecipients: priced,
    refused: unpriced > 0,
  }
}

/**
 * Escrow-wide USD per day.
 *
 * A day is null when ANY recipient's contribution to it is unpriced. Summing
 * `day.usd ?? 0` produced a total that silently omitted the unpriced part and
 * then printed it as the escrow's daily total - a partial sum wearing a total's
 * label, which is worse than no number at all.
 */
export function totalsByDay(
  document: EscrowSeriesDocument,
): Array<{ dayUnix: number; usd: number | null }> {
  const totals = new Map<number, number | null>()
  for (const recipient of document.recipients) {
    for (const day of recipient.days) {
      const running = totals.get(day.dayUnix)
      if (running === null) continue
      if (day.usd === null) {
        totals.set(day.dayUnix, null)
        continue
      }
      totals.set(day.dayUnix, (running ?? 0) + day.usd)
    }
  }
  return [...totals.entries()]
    .map(([dayUnix, usdTotal]) => ({ dayUnix: dayStartUnix(dayUnix), usd: usdTotal }))
    .sort((a, b) => a.dayUnix - b.dayUnix)
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), main)
}

export {
  SPEC as ESCROW_INDEX_SPEC,
  trailingMedianOf,
  buildWarnings,
  formatUnits as renderAssetAmount,
}

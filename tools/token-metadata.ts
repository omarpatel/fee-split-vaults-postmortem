/**
 * token-metadata - resolve ERC-20 metadata on chain and state, defensibly, how
 * much of the escrow's asset tail can actually be priced.
 *
 * WHY. A live ERC-20 escrow run found credits in 263 distinct assets over two
 * days, reported every symbol as "UNKNOWN", and defaulted decimals to 18. The
 * defaulting is visible in the output: one asset with 4,450 recipients summed
 * to 1.19e-6 and another with 186 recipients summed to 1.31e+4. Those cannot
 * both be right. Until decimals are READ, the whole ERC-20 side is unmeasured,
 * and a number produced from it is not a small error - it is noise with a
 * dollar sign in front of it.
 *
 * WHAT THIS TOOL WILL NOT DO. It will not price 263 memecoins by guessing. It
 * ranks the asset set, lets the operator price the head by hand, and reports
 * exactly what share of credits, recipients and value the priced set covers.
 * The deliverable is the sentence "assets covering X% of credits are priced;
 * the remainder is unpriced and excluded", not a single confident total.
 *
 * TWO MODES:
 *   --addresses / --addresses-file   resolve metadata for a known asset set.
 *                                    No scan, no coverage - just "how many of
 *                                    these tokens answer decimals()".
 *   (default)                        scan the escrow over a window, census the
 *                                    assets, resolve them, and report coverage
 *                                    and materiality against the native side.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildCache } from './lib/cache.ts'
import type { ParsedValues } from './lib/cli.ts'
import { CliError, getBool, getList, getNumber, getString, isEntrypoint, runCli } from './lib/cli.ts'
import {
  assessMateriality,
  computeCoverage,
  rollupAssets,
  type AssetRollup,
} from './lib/coverage.ts'
import { CheckpointStore } from './lib/checkpoint.ts'
import { TOOLS_DIR, describeConfig, loadConfig, rpcUrlsOrPlaceholder } from './lib/env.ts'
import {
  NATIVE_CREDIT_EVENT,
  TOKEN_CREDIT_EVENT,
  decodeCredit,
  resolveCreditEvent,
  type EscrowCredit,
} from './lib/escrow.ts'
import { heading, num, pct, shortAddress, subheading, table, usd } from './lib/format.ts'
import { buildHttpClient } from './lib/http.ts'
import { parseJson, stringifyJson } from './lib/json.ts'
import {
  DEFAULT_SCAN_BATCH_SIZE,
  findBlockAtOrAfter,
  formatScanProgress,
  scanLogs,
} from './lib/logscan.ts'
import {
  NATIVE_ASSET_ADDRESS,
  PriceBook,
  isNativeAsset,
  nativeQuoteAsset,
  parseAssetEntriesFile,
  type AssetEntry,
} from './lib/prices.ts'
import { emit, emitDryRun, progress, type Report } from './lib/report.ts'
import { HttpChainReader } from './lib/rpc.ts'
import {
  DEFAULT_METADATA_BATCH_SIZE,
  TokenMetadataResolver,
  summarizeMetadata,
  type MetadataSummary,
  type TokenMetadata,
} from './lib/token-metadata.ts'
import { SECONDS_PER_DAY, isoDate } from './lib/time.ts'
import { VENUE } from '../config/protocol.ts'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const SPEC = {
  name: 'token-metadata',
  summary: 'Resolve ERC-20 decimals/symbol/name on chain and report pricing coverage of the asset tail.',
  detail: `
    Reads decimals(), symbol() and name() in batches of 10 eth_calls, caches them
    on disk forever, and handles bytes32 symbols and tokens with no getters at all.
    An unresolved field is UNKNOWN, never 18: an asset with unknown decimals is
    unpriceable and is reported as excluded, not as zero.
    The default mode scans the escrow, censuses the assets it credits, and prints
    the coverage statement plus the ranked list of what to price next.
  `,
  options: [
    {
      name: 'addresses',
      type: 'string[]' as const,
      describe: 'Resolve metadata for these addresses and stop. No scan, no coverage.',
    },
    {
      name: 'addresses-file',
      type: 'string' as const,
      placeholder: '<file>',
      describe:
        'JSON array of addresses, or of objects carrying an "address" field, to resolve instead of scanning.',
    },
    {
      name: 'days',
      type: 'number' as const,
      default: 2,
      describe: 'Window length for the asset census scan.',
    },
    {
      name: 'to',
      type: 'string' as const,
      placeholder: '<iso|latest>',
      default: 'latest',
      describe: 'End of the census window.',
    },
    {
      name: 'escrow',
      type: 'string' as const,
      placeholder: '<address>',
      default: VENUE.contracts.v2FeeEscrow,
      describe: 'Fee escrow contract to census.',
    },
    {
      name: 'with-native',
      type: 'boolean' as const,
      describe:
        'Also scan the native credit event over the same window, so materiality is judged against a native total measured on the SAME blocks.',
    },
    {
      name: 'native-usd',
      type: 'number' as const,
      default: 0,
      describe:
        'Native-side USD total over the same window, when it was measured elsewhere. Ignored if --with-native is set.',
    },
    {
      name: 'assets',
      type: 'string' as const,
      placeholder: '<file>',
      describe:
        'Operator-priced assets: [{address, symbol?, decimals?, priceUsd?}]. priceUsd pins a price to an ADDRESS, which beats symbol matching.',
    },
    {
      name: 'out-assets',
      type: 'string' as const,
      placeholder: '<file>',
      describe:
        'Write a resolved assets skeleton, ranked, with priceUsd left null for the operator to fill in.',
    },
    {
      name: 'price-next',
      type: 'number' as const,
      default: 20,
      describe: 'How many unpriced assets to list as the shortlist to price next.',
    },
    {
      name: 'materiality-threshold',
      type: 'number' as const,
      default: 0.05,
      describe: 'Share of the native total above which the ERC-20 tail is called material.',
    },
    {
      name: 'coverage-floor',
      type: 'number' as const,
      default: 0.9,
      describe: 'Credit coverage required before the tail may be called dust rather than undetermined.',
    },
    {
      name: 'batch',
      type: 'number' as const,
      default: DEFAULT_METADATA_BATCH_SIZE,
      describe: 'eth_calls per JSON-RPC batch. 10 is the measured optimum; 25+ gets 429ed.',
    },
    {
      name: 'scan-batch',
      type: 'number' as const,
      default: DEFAULT_SCAN_BATCH_SIZE,
      describe: 'eth_getLogs per JSON-RPC batch during the census scan. 1 disables batching.',
    },
    {
      name: 'checkpoint-dir',
      type: 'string' as const,
      placeholder: '<dir>',
      describe: 'Where to checkpoint the census scan. Defaults to tools/.checkpoints.',
    },
    {
      name: 'no-resume',
      type: 'boolean' as const,
      describe: 'Ignore any existing checkpoint and scan the whole window again.',
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
      describe: 'Rows shown in the human tables.',
    },
  ],
  examples: [
    'node tools/token-metadata.ts --addresses-file artifacts/erc20-assets.json --out-assets artifacts/assets-resolved.json',
    'node tools/token-metadata.ts --days 2 --with-native --assets artifacts/assets-priced.json --out artifacts/coverage.json',
    'node tools/token-metadata.ts --days 30 --scan-batch 10 --verbose   # resumable',
  ],
}

interface MetadataOnlyResult {
  mode: 'resolve-only'
  chainId: number
  requested: number
  summary: MetadataSummary
  tokens: Array<TokenMetadata & { note: string }>
}

interface CoverageResult {
  mode: 'census'
  chainId: number
  escrow: string
  fromBlock: string
  toBlock: string
  windowStartUnix: number
  windowEndUnix: number
  erc20Credits: number
  nativeCredits: number | null
  nativeUsd: number | null
  metadata: MetadataSummary
  coverage: ReturnType<typeof computeCoverage>
  materiality: ReturnType<typeof assessMateriality> | null
}

async function main(values: ParsedValues): Promise<void> {
  const config = loadConfig()
  const json = getBool(values, 'json')
  const dryRun = getBool(values, 'dry-run')
  const verbose = getBool(values, 'verbose')
  const outPath = getString(values, 'out')
  const top = Math.floor(getNumber(values, 'top', 25))

  const http = buildHttpClient({
    requestsPerSecond: config.requestsPerSecond,
    maxRetries: config.maxRetries,
    timeoutMs: config.requestTimeoutMs,
    onRetry: (attempt, delay, reason) => progress(verbose, `retry ${attempt} in ${delay}ms: ${reason}`),
    adaptive: {
      // Never below a twentieth of the configured rate: an endpoint that keeps
      // 429ing at 0.04/s is broken, and pretending otherwise turns a scan into
      // an infinite polite wait.
      minRequestsPerSecond: Math.max(0.1, config.requestsPerSecond / 8),
      onRateChange: (rps, reason) => progress(verbose, `rate -> ${rps.toFixed(3)}/s (${reason})`),
    },
  })
  const cache = buildCache(config.cacheDir, getBool(values, 'no-cache'))
  const metadataBatch = Math.max(1, Math.floor(getNumber(values, 'batch', DEFAULT_METADATA_BATCH_SIZE)))
  const reader = new HttpChainReader(http, rpcUrlsOrPlaceholder(config, dryRun), metadataBatch)

  const explicit = await collectExplicitAddresses(values)

  // --- mode 1: resolve a known asset set -----------------------------------
  if (explicit !== undefined) {
    if (dryRun) {
      emitDryRun(
        {
          tool: SPEC.name,
          config: describeConfig(config),
          steps: [
            {
              description: `eth_call decimals()/symbol()/name() for ${explicit.length} addresses, ${metadataBatch} calls per batch`,
              estimatedRequests: Math.ceil((explicit.length * 3) / metadataBatch),
            },
          ],
          estimatedRequestsTotal: Math.ceil((explicit.length * 3) / metadataBatch),
          notes: [
            'Metadata is cached on disk forever; a repeat run of the same set costs nothing.',
            'A field that cannot be read stays UNKNOWN and makes its asset unpriceable. Nothing defaults to 18.',
          ],
        },
        json,
      )
      return
    }
    await assertRightChain(reader)
    const resolver = new TokenMetadataResolver(reader, {
      chainId: config.chainId,
      cache,
      batchSize: metadataBatch,
      onProgress: (message) => progress(verbose, message),
    })
    const metadata = await resolver.resolve(explicit)
    const summary = summarizeMetadata(metadata)
    const result: MetadataOnlyResult = {
      mode: 'resolve-only',
      chainId: config.chainId,
      requested: explicit.length,
      summary,
      tokens: [...metadata.values()].map((meta) => ({ ...meta, note: describeToken(meta) })),
    }
    await maybeWriteAssets(values, [...metadata.values()].map(rollupOf), metadata, false)
    await emit(
      {
        meta: {
          tool: SPEC.name,
          schemaVersion: 'token-metadata-resolve-1',
          generatedAtUnix: Math.floor(Date.now() / 1000),
          config: { ...describeConfig(config), metadataBatch, resolverStats: resolver.stats },
          io: { httpRequests: http.requestCount, cacheHits: cache.hits, cacheMisses: cache.misses },
          warnings: metadataWarnings(summary),
          methodLimits: METHOD_LIMITS,
        },
        result,
      } satisfies Report<MetadataOnlyResult>,
      { json, outPath, human: (r) => renderResolveOnly(r.result, top) },
    )
    return
  }

  // --- mode 2: census the escrow, then resolve and price it ----------------
  const days = getNumber(values, 'days', 2)
  if (days <= 0) throw new CliError('--days must be positive')
  const escrow = (getString(values, 'escrow') ?? VENUE.contracts.v2FeeEscrow).toLowerCase()
  const tokenPlan = resolveCreditEvent(TOKEN_CREDIT_EVENT, 'token')
  const nativePlan = resolveCreditEvent(NATIVE_CREDIT_EVENT, 'native')
  const withNative = getBool(values, 'with-native')
  const scanBatch = Math.max(1, Math.floor(getNumber(values, 'scan-batch', DEFAULT_SCAN_BATCH_SIZE)))

  if (dryRun) {
    const blocks = Math.ceil((days * SECONDS_PER_DAY) / config.estimatedBlockTimeSeconds)
    const chunks = Math.ceil(blocks / config.logChunkBlocks)
    const scans = withNative ? 2 : 1
    emitDryRun(
      {
        tool: SPEC.name,
        config: { ...describeConfig(config), escrow, days, scanBatch, metadataBatch },
        steps: [
          { description: 'binary-search the block range for the window', estimatedRequests: 40 },
          {
            description: `eth_getLogs over ~${blocks.toLocaleString()} blocks in ~${chunks.toLocaleString()} chunks x${scans} event(s), batched ${scanBatch} per request, checkpointed`,
            estimatedRequests: Math.ceil((chunks * scans) / scanBatch),
          },
          { description: 'eth_call metadata for every asset found, 3 calls each', estimatedRequests: 0 },
        ],
        estimatedRequestsTotal: 40 + Math.ceil((chunks * scans) / scanBatch),
        notes: [
          `Block span is ESTIMATED from VENUE_BLOCK_TIME_SECONDS=${config.estimatedBlockTimeSeconds}s to size the budget only.`,
          'The scan is checkpointed: an interrupted run resumes from the last completed chunk.',
          ...(config.rpcUrls.length === 0
            ? ['VENUE_RPC_URL is UNSET. A real run will refuse to start.']
            : []),
        ],
      },
      json,
    )
    return
  }

  await assertRightChain(reader)
  const latest = await reader.getBlockHeader('latest')
  const toArg = getString(values, 'to') ?? 'latest'
  let toBlock: bigint
  let toUnix: number
  if (toArg === 'latest') {
    toBlock = latest.number
    toUnix = latest.timestampUnix
  } else {
    toUnix = Math.floor(Date.parse(toArg) / 1000)
    if (Number.isNaN(toUnix)) throw new CliError(`--to could not be parsed: ${toArg}`)
    toBlock = await findBlockAtOrAfter(reader, toUnix, { low: 1n, high: latest.number })
  }
  const fromUnix = toUnix - Math.round(days * SECONDS_PER_DAY)
  const fromBlock = await findBlockAtOrAfter(reader, fromUnix, { low: 1n, high: toBlock })
  progress(verbose, `window ${isoDate(fromUnix)}..${isoDate(toUnix)} blocks ${fromBlock}..${toBlock}`)

  const checkpointRoot =
    getString(values, 'checkpoint-dir') ?? join(TOOLS_DIR, '.checkpoints')

  const erc20Credits = await scanCredits({
    reader,
    config,
    cache,
    escrow,
    plan: tokenPlan,
    fromBlock,
    toBlock,
    scanBatch,
    checkpointRoot,
    resume: !getBool(values, 'no-resume'),
    keepCheckpoint: getBool(values, 'keep-checkpoint'),
    verbose,
    label: 'erc20',
  })

  const nativeCredits = withNative
    ? await scanCredits({
        reader,
        config,
        cache,
        escrow,
        plan: nativePlan,
        fromBlock,
        toBlock,
        scanBatch,
        checkpointRoot,
        resume: !getBool(values, 'no-resume'),
        keepCheckpoint: getBool(values, 'keep-checkpoint'),
        verbose,
        label: 'native',
      })
    : null

  const assetAddresses = [
    ...new Set(erc20Credits.filter((c) => !isNativeAsset(c.asset)).map((c) => c.asset)),
  ]
  progress(verbose, `census found ${erc20Credits.length} credits across ${assetAddresses.length} assets`)

  const resolver = new TokenMetadataResolver(reader, {
    chainId: config.chainId,
    cache,
    batchSize: metadataBatch,
    onProgress: (message) => progress(verbose, message),
  })
  const metadata = await resolver.resolve(assetAddresses)
  const metadataSummary = summarizeMetadata(metadata)

  const overrides = await loadOverrides(values)
  const prices = buildPriceBook(config, metadata, overrides)

  const rollups = rollupAssets(erc20Credits, { metadata, prices })
  const coverage = computeCoverage(erc20Credits, rollups, {
    priceNextCount: Math.floor(getNumber(values, 'price-next', 20)),
  })

  let nativeUsd: number | null = null
  if (nativeCredits !== null) {
    let total = 0
    let unpriced = false
    for (const credit of nativeCredits) {
      const priced = prices.toUsd(credit.asset, credit.amountMinor)
      if (priced === undefined) unpriced = true
      else total += priced.usd
    }
    nativeUsd = unpriced && total === 0 ? null : total
  } else {
    const supplied = getNumber(values, 'native-usd', 0)
    nativeUsd = supplied > 0 ? supplied : null
  }

  const materiality =
    nativeUsd === null
      ? null
      : assessMateriality({
          erc20PricedUsd: coverage.value.pricedUsd,
          nativeUsd,
          creditCoverageShare: coverage.credits.share,
          thresholdShare: getNumber(values, 'materiality-threshold', 0.05),
          coverageFloor: getNumber(values, 'coverage-floor', 0.9),
        })

  await maybeWriteAssets(values, coverage.ranked, metadata, true)

  const result: CoverageResult = {
    mode: 'census',
    chainId: config.chainId,
    escrow,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    windowStartUnix: fromUnix,
    windowEndUnix: toUnix,
    erc20Credits: erc20Credits.length,
    nativeCredits: nativeCredits === null ? null : nativeCredits.length,
    nativeUsd,
    metadata: metadataSummary,
    coverage,
    materiality,
  }

  await emit(
    {
      meta: {
        tool: SPEC.name,
        schemaVersion: 'token-metadata-coverage-1',
        generatedAtUnix: Math.floor(Date.now() / 1000),
        config: {
          ...describeConfig(config),
          escrow,
          scanBatch,
          metadataBatch,
          resolverStats: resolver.stats,
          effectiveRequestsPerSecond: http.currentRequestsPerSecond,
          throttleCount: http.throttleCount,
        },
        io: { httpRequests: http.requestCount, cacheHits: cache.hits, cacheMisses: cache.misses },
        warnings: [
          coverage.statement,
          ...metadataWarnings(metadataSummary),
          ...(materiality === null
            ? [
                'No native baseline: materiality of the ERC-20 tail was NOT assessed. Re-run with --with-native or pass --native-usd.',
              ]
            : [materiality.statement]),
          ...prices.aliasWarnings(),
        ],
        methodLimits: METHOD_LIMITS,
      },
      result,
    } satisfies Report<CoverageResult>,
    { json, outPath, human: (r) => renderCoverage(r.result, top) },
  )
}

const METHOD_LIMITS = [
  'decimals()/symbol()/name() are read at the LATEST block. A token that changed them (an upgradeable proxy can) would be described by its current values, not the ones in force when the credit landed.',
  'A token with no decimals() is UNPRICEABLE here, not 18-decimal. Its credits are excluded from every USD figure and counted in the unpriced share.',
  'USD figures use operator-supplied spot prices pinned at run time. They are not time-weighted: a credit from the start of the window is valued at the same price as one from the end.',
  'Symbols and names are ISSUER-CHOSEN strings from untrusted contracts. Control characters are stripped, but two assets may still present the same or a confusable symbol. Prices are pinned to ADDRESSES for exactly this reason; never match an asset by symbol.',
]

async function assertRightChain(reader: HttpChainReader): Promise<void> {
  const chain = await reader.chainId()
  if (chain !== VENUE.chainId) {
    throw new CliError(
      `RPC endpoint reports chain ${chain}, protocol config pins ${VENUE.chainId}. Refusing to measure the wrong chain.`,
    )
  }
}

async function collectExplicitAddresses(values: ParsedValues): Promise<string[] | undefined> {
  const inline = getList(values, 'addresses')
  const file = getString(values, 'addresses-file')
  if (inline.length === 0 && file === undefined) return undefined
  const out = new Set<string>()
  for (const address of inline) out.add(normalize(address, '--addresses'))
  if (file !== undefined) {
    const parsed = parseJson<unknown>(await readFile(file, 'utf8'))
    if (!Array.isArray(parsed)) throw new CliError(`${file} must contain a JSON array`)
    for (const [i, entry] of parsed.entries()) {
      const address =
        typeof entry === 'string'
          ? entry
          : typeof entry === 'object' && entry !== null
            ? (entry as { address?: unknown }).address
            : undefined
      if (typeof address !== 'string') {
        throw new CliError(`${file}[${i}] has no address`)
      }
      out.add(normalize(address, file))
    }
  }
  if (out.size === 0) throw new CliError('no addresses to resolve')
  return [...out]
}

function normalize(address: string, source: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) {
    throw new CliError(`${source}: "${address}" is not an address`)
  }
  return address.trim().toLowerCase()
}

async function loadOverrides(values: ParsedValues): Promise<AssetEntry[]> {
  const path = getString(values, 'assets')
  if (path === undefined) return []
  return parseAssetEntriesFile(parseJson(await readFile(path, 'utf8')))
}

/**
 * Build the price book.
 *
 * Order matters: the chain-resolved decimals go in first, then the operator's
 * file overrides them. An operator who has actually read a proxy's decimals
 * beats a getter that answered oddly - but only where they said so explicitly.
 */
function buildPriceBook(
  config: ReturnType<typeof loadConfig>,
  metadata: ReadonlyMap<string, TokenMetadata>,
  overrides: readonly AssetEntry[],
): PriceBook {
  const book = PriceBook.fromConfig(config, [nativeQuoteAsset()])
  for (const meta of metadata.values()) {
    if (meta.decimals === null) continue
    book.registerAsset({
      address: meta.address,
      // A token with no readable symbol gets a symbol that cannot collide with
      // any VENUE_PRICE_USD_<SYMBOL> the operator might have set.
      symbol: meta.symbol ?? `UNRESOLVED_${meta.address.slice(2, 10)}`,
      decimals: meta.decimals,
    })
  }
  for (const entry of overrides) {
    const existing = book.asset(entry.address)
    const decimals = entry.decimals ?? existing?.decimals
    if (decimals === undefined) {
      // No decimals from the file and none from the chain: registering it with
      // a price would produce a number scaled by a guess.
      continue
    }
    book.registerAsset(
      {
        address: entry.address,
        symbol: entry.symbol ?? existing?.symbol ?? `UNRESOLVED_${entry.address.slice(2, 10)}`,
        decimals,
      },
      entry.priceUsd,
    )
  }
  return book
}

interface ScanCreditsArgs {
  reader: HttpChainReader
  config: ReturnType<typeof loadConfig>
  cache: ReturnType<typeof buildCache>
  escrow: string
  plan: ReturnType<typeof resolveCreditEvent>
  fromBlock: bigint
  toBlock: bigint
  scanBatch: number
  checkpointRoot: string
  resume: boolean
  keepCheckpoint: boolean
  verbose: boolean
  label: string
}

async function scanCredits(args: ScanCreditsArgs): Promise<EscrowCredit[]> {
  const topics: Array<string | string[] | null> = [args.plan.spec.topic0]
  const identity = {
    chainId: args.config.chainId,
    address: args.escrow,
    topics,
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
    chunkBlocks: args.config.logChunkBlocks,
  }
  const opened = await CheckpointStore.open(args.checkpointRoot, identity)
  const store = opened.store
  if (!args.resume && opened.resumedFrom !== undefined) {
    await store.discard()
    const reopened = await CheckpointStore.open(args.checkpointRoot, identity)
    return runScan(args, reopened.store)
  }
  if (opened.resumedFrom !== undefined) {
    process.stderr.write(
      `[${args.label}] resuming from checkpoint: ${opened.resumedFrom.chunksCompleted} chunks, ` +
        `${opened.resumedFrom.logCount} logs, through block ${opened.resumedFrom.completedThroughBlock}\n`,
    )
  }
  if (opened.discardedReason !== undefined) {
    process.stderr.write(`[${args.label}] ignoring stale checkpoint: ${opened.discardedReason}\n`)
  }
  return runScan(args, store)
}

async function runScan(args: ScanCreditsArgs, store: CheckpointStore): Promise<EscrowCredit[]> {
  const logs = await scanLogs(args.reader, {
    address: args.escrow,
    topics: [args.plan.spec.topic0],
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
    chunkBlocks: args.config.logChunkBlocks,
    cache: args.cache,
    checkpoint: store,
    batchSize: args.scanBatch,
    onScanProgress: (p) => {
      // Progress goes to stderr unconditionally: a scan that runs for an hour
      // with no output is indistinguishable from a hung one, and the operator
      // needs to know whether to wait.
      process.stderr.write(`[${args.label}] ${formatScanProgress(p, 'credits')}\n`)
    },
  })
  if (!args.keepCheckpoint) await store.discard()

  const credits: EscrowCredit[] = []
  for (const log of logs) {
    const decoded = decodeCredit(args.plan, log)
    // Timestamps are not needed for a census: coverage is per asset, not per
    // day. Skipping them saves a header fetch per block.
    credits.push({ ...decoded, timestampUnix: 0 })
  }
  return credits
}

function rollupOf(meta: TokenMetadata): AssetRollup {
  return {
    address: meta.address,
    symbol: meta.symbol,
    decimals: meta.decimals,
    priceUsd: null,
    creditCount: 0,
    recipientCount: 0,
    totalMinor: 0n,
    valueUsd: null,
    priceable: false,
    blockedBy: meta.decimals === null ? 'decimals+price' : 'price',
  }
}

/**
 * Write the hand-pricing skeleton.
 *
 * This file is the Part B workflow: it comes back ranked, with decimals already
 * read from the chain and priceUsd left null, so the operator fills in the head
 * and re-runs. The census columns are informational (parseAssetEntriesFile
 * ignores them) but they are what makes the ranking auditable - they are only
 * written when a census actually produced them, never as a row of zeros that
 * looks like a measurement.
 */
async function maybeWriteAssets(
  values: ParsedValues,
  rollups: readonly AssetRollup[],
  names: ReadonlyMap<string, TokenMetadata> | undefined,
  includeCensus: boolean,
): Promise<void> {
  const path = getString(values, 'out-assets')
  if (path === undefined) return
  const rows = rollups.map((r) => ({
    address: r.address,
    symbol: r.symbol,
    name: names?.get(r.address)?.name ?? null,
    decimals: r.decimals,
    priceUsd: r.priceUsd,
    ...(includeCensus
      ? {
          recipients: r.recipientCount,
          credits: r.creditCount,
          totalMinor: r.totalMinor.toString(),
        }
      : {}),
  }))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${stringifyJson(rows, 'string', 2)}\n`, 'utf8')
  process.stderr.write(`assets skeleton written to ${path}\n`)
}

function describeToken(meta: TokenMetadata): string {
  if (meta.decimalsStatus === 'ok') {
    return `${meta.symbol ?? '(no symbol)'} ${meta.decimals}dp${meta.symbolEncoding === 'bytes32' ? ' [bytes32]' : ''}`
  }
  if (meta.decimalsStatus === 'absent') return 'no decimals() - UNPRICEABLE'
  if (meta.decimalsStatus === 'undecodable') return 'decimals() unreadable - UNPRICEABLE'
  return 'read FAILED (transport) - retry'
}

function metadataWarnings(summary: MetadataSummary): string[] {
  const warnings: string[] = []
  if (summary.total === 0) return warnings
  const unknown = summary.total - summary.decimalsKnown
  if (unknown > 0) {
    warnings.push(
      `${unknown} of ${summary.total} assets have NO readable decimals(). They are UNPRICEABLE and are excluded from every USD figure - not treated as 18-decimal, and not treated as zero.`,
    )
  }
  if (summary.incomplete > 0) {
    warnings.push(
      `${summary.incomplete} assets had at least one field the endpoint failed to answer (transport, not revert). Those reads were NOT cached; re-run to retry them.`,
    )
  }
  if (summary.symbolFromBytes32 > 0) {
    warnings.push(
      `${summary.symbolFromBytes32} tokens return a bytes32 symbol rather than a string. They are decoded, not skipped.`,
    )
  }
  return warnings
}

function renderResolveOnly(result: MetadataOnlyResult, top: number): string {
  const lines: string[] = []
  const s = result.summary
  lines.push(heading(`Token metadata: ${result.requested} addresses on chain ${result.chainId}`))
  lines.push(
    table(
      [
        { field: 'decimals() read', count: s.decimalsKnown, of: s.total },
        { field: 'decimals() absent', count: s.decimalsAbsent, of: s.total },
        { field: 'decimals() unreadable', count: s.decimalsUnreadable, of: s.total },
        { field: 'symbol() read', count: s.symbolKnown, of: s.total },
        { field: '  of which bytes32', count: s.symbolFromBytes32, of: s.symbolKnown },
        { field: 'name() read', count: s.nameKnown, of: s.total },
        { field: 'incomplete (retry)', count: s.incomplete, of: s.total },
      ],
      [
        { header: 'field', value: (r) => r.field },
        { header: 'count', value: (r) => String(r.count), align: 'right' },
        { header: 'of', value: (r) => String(r.of), align: 'right' },
        {
          header: 'share',
          value: (r) => (r.of === 0 ? 'n/a' : pct(r.count / r.of)),
          align: 'right',
        },
      ],
    ),
  )
  lines.push(subheading(`First ${Math.min(top, result.tokens.length)} tokens`))
  lines.push(
    table(result.tokens.slice(0, top), [
      { header: 'address', value: (t) => shortAddress(t.address) },
      { header: 'symbol', value: (t) => t.symbol ?? '-' },
      { header: 'dp', value: (t) => (t.decimals === null ? '?' : String(t.decimals)), align: 'right' },
      { header: 'name', value: (t) => (t.name ?? '-').slice(0, 28) },
      { header: 'note', value: (t) => t.note },
    ]),
  )
  return lines.join('\n')
}

function renderCoverage(result: CoverageResult, top: number): string {
  const lines: string[] = []
  const c = result.coverage
  lines.push(heading(`ERC-20 pricing coverage: ${result.escrow}`))
  lines.push(
    `chain ${result.chainId}  blocks ${result.fromBlock}..${result.toBlock}  ` +
      `window ${isoDate(result.windowStartUnix)} .. ${isoDate(result.windowEndUnix)}`,
  )
  lines.push(
    `${result.erc20Credits.toLocaleString()} ERC-20 credits across ${c.assets.total} assets and ` +
      `${c.recipients.total.toLocaleString()} recipients`,
  )

  lines.push(subheading('Metadata resolution'))
  const m = result.metadata
  lines.push(
    `  decimals read for ${m.decimalsKnown}/${m.total} (${pct(m.total === 0 ? 1 : m.decimalsKnown / m.total)}), ` +
      `symbols ${m.symbolKnown}/${m.total} (${m.symbolFromBytes32} via bytes32), ` +
      `names ${m.nameKnown}/${m.total}, unreadable ${m.decimalsUnreadable}, retryable ${m.incomplete}`,
  )

  lines.push(subheading('Coverage'))
  lines.push(
    table(
      [
        { basis: 'assets', priced: c.assets.priced, total: c.assets.total, share: c.assets.share },
        { basis: 'credits', priced: c.credits.priced, total: c.credits.total, share: c.credits.share },
        {
          basis: 'recipients (fully priced)',
          priced: c.recipients.fullyPriced,
          total: c.recipients.total,
          share: c.recipients.fullyPricedShare,
        },
      ],
      [
        { header: 'basis', value: (r) => r.basis },
        { header: 'priced', value: (r) => r.priced.toLocaleString(), align: 'right' },
        { header: 'total', value: (r) => r.total.toLocaleString(), align: 'right' },
        { header: 'share', value: (r) => pct(r.share), align: 'right' },
      ],
    ),
  )
  lines.push(
    `  ${c.recipients.partiallyUnpriced.toLocaleString()} recipients hold BOTH priced and unpriced assets: ` +
      `their totals are understated, which can drop them below a tier gate.`,
  )
  lines.push(
    `  unpriceable for want of decimals: ${c.value.assetsMissingDecimals} assets;  ` +
      `decimals known but no price: ${c.value.assetsMissingPrice} assets`,
  )
  lines.push(`  priced value: ${usd(c.value.pricedUsd)}  (unpriced value is NOT determinable)`)

  const pricedRows = c.ranked.filter((r) => r.priceable).slice(0, top)
  if (pricedRows.length > 0) {
    lines.push(subheading(`Priced assets, by value (top ${pricedRows.length})`))
    lines.push(
      table(pricedRows, [
        { header: 'address', value: (r) => shortAddress(r.address) },
        { header: 'symbol', value: (r) => r.symbol ?? '-' },
        { header: 'dp', value: (r) => String(r.decimals ?? '?'), align: 'right' },
        { header: 'price', value: (r) => usd(r.priceUsd ?? undefined, 6), align: 'right' },
        { header: 'value', value: (r) => usd(r.valueUsd ?? undefined), align: 'right' },
        { header: 'credits', value: (r) => r.creditCount.toLocaleString(), align: 'right' },
        { header: 'recipients', value: (r) => r.recipientCount.toLocaleString(), align: 'right' },
      ]),
    )
  }

  if (c.priceNext.length > 0) {
    lines.push(subheading(`Price these next - unpriced assets by recipient count (${c.priceNext.length})`))
    lines.push(
      table(c.priceNext, [
        { header: 'address', value: (r) => r.address },
        { header: 'symbol', value: (r) => r.symbol ?? '-' },
        { header: 'dp', value: (r) => (r.decimals === null ? 'UNKNOWN' : String(r.decimals)), align: 'right' },
        { header: 'recipients', value: (r) => r.recipientCount.toLocaleString(), align: 'right' },
        { header: 'credits', value: (r) => r.creditCount.toLocaleString(), align: 'right' },
        {
          header: 'units',
          value: (r) =>
            r.decimals === null ? 'n/a (no decimals)' : num(Number(r.totalMinor) / 10 ** r.decimals, 4),
          align: 'right',
        },
        { header: 'blocked by', value: (r) => r.blockedBy },
      ]),
    )
  }

  lines.push(subheading('Is the ERC-20 tail material?'))
  if (result.materiality === null) {
    lines.push('  NOT ASSESSED: no native baseline. Re-run with --with-native, or pass --native-usd.')
  } else {
    const mat = result.materiality
    lines.push(
      `  verdict: ${mat.verdict.toUpperCase()}   priced ERC-20 ${usd(mat.erc20PricedUsd)} vs native ${usd(mat.nativeUsd)} ` +
        `= ${pct(mat.ratioLowerBound)} (lower bound)`,
    )
    lines.push(`  ${mat.statement}`)
  }

  lines.push('')
  lines.push(`  ${c.statement}`)
  return lines.join('\n')
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), main)
}

export { SPEC as TOKEN_METADATA_SPEC, buildPriceBook, describeToken, metadataWarnings }

/**
 * cross-verify - settle VERDICT.md §6 item 6.
 *
 *   "One RPC endpoint. escrow-index's own method limit asks that the window's
 *    first and last block be cross-checked against a second chain-4663 endpoint
 *    before publishing. STILL NOT DONE. Every scan here shares whatever defect
 *    that node has, and internal cross-checks cannot detect a defect common to
 *    all of them."
 *
 * Every other integrity control in this repo is INTERNAL - merged scan against
 * native scan, streamed totals against declared totals, sweep transactions
 * against hook transactions. All of them pass identically if the single node
 * silently drops logs. This tool is the only EXTERNAL one.
 *
 * It does four things and reports the fifth:
 *
 *   1. AGREEMENT ON THE CHAIN ITSELF. eth_chainId on both, and the window's
 *      first and last block compared field by field - hash, parentHash,
 *      timestamp, and (the load-bearing ones) receiptsRoot and logsBloom, which
 *      are cryptographic commitments to the complete log set of the block.
 *   2. A SEEDED, STRATIFIED SAMPLE of block windows across the period, escrow
 *      logs fetched from BOTH endpoints and compared as ordered
 *      (blockNumber, logIndex, topic0, data) tuples - plus the full topic array,
 *      address and transaction hash.
 *   3. THE EXHAUSTIVE FIRST/LAST BLOCK CHECK the method limit names, block by
 *      block rather than by sample.
 *   4. THE SAME SAMPLE FOR THE MEME HOOK's PoolFeesSwept, since the per-coin
 *      attribution join depends on those logs and they were single-sourced too.
 *   5. THE RESIDUAL RISK, quantified honestly: the bound the sample size
 *      actually supports, under each of the three shapes a defect can take, and
 *      an explicit statement of the one it cannot bound at all.
 *
 * Exit codes
 *   0  every comparison agreed
 *   2  bad flags / bad config
 *   3  the run completed but could not compare what it was asked to (a
 *      secondary that cannot serve the range at any chunk size lands here)
 *   4  MISMATCH. The endpoints disagree. This is a finding, not a failure.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { VENUE } from '../config/protocol.ts'
import { eventTopic } from './lib/abi.ts'
import { CliError, getBool, getNumber, getString, isEntrypoint, runCli } from './lib/cli.ts'
import {
  agreementBound,
  assertNoSharedCache,
  clientFamily,
  compareHeaders,
  boundaryBlockList,
  boundaryRegions,
  checkBlockBloom,
  compareLogSets,
  COMPARED_HEADER_FIELDS,
  describeFleet,
  summarizeBloomChecks,
  interpretBounds,
  planSampleWindows,
  strataFromDayBoundaries,
  summarizeFleet,
  totalBlocks,
  type AgreementBound,
  type BlockWindow,
  type BloomCheck,
  type FleetSummary,
  type HeaderDiff,
  type LogSetDiff,
  type RawBlock,
  type SamplePlan,
  type Stratum,
} from './lib/cross-verify.ts'
import { describeConfig, loadConfig, TOOLS_DIR } from './lib/env.ts'
import { heading, table } from './lib/format.ts'
import { buildHttpClient } from './lib/http.ts'
import { scanLogs, UnservableRangeError } from './lib/logscan.ts'
import { emit, emitDryRun, progress, type Report } from './lib/report.ts'
import { HttpChainReader, type RawLog } from './lib/rpc.ts'

const SCHEMA_VERSION = 'cross-verify-1'
export const EXIT_MISMATCH = 4

export const CREDITED_TOPIC0 = eventTopic('Credited(address,address,uint256)')
export const CREDITED_TOKEN_TOPIC0 = eventTopic('CreditedToken(address,address,address,uint256)')
export const POOL_FEES_SWEPT_TOPIC0 = eventTopic(
  'PoolFeesSwept(bytes32,uint256,uint256,uint256,uint256)',
)

const SPEC = {
  name: 'cross-verify',
  summary:
    'Cross-check escrow and hook logs, and the window boundary blocks, against a SECOND chain-4663 endpoint.',
  detail: `
    Whether the single RPC node every measurement was taken from is dropping logs.

    Internal reconciliation cannot answer this: a node that silently omits logs
    produces a self-consistent short series. Only a second, independently
    operated endpoint can. This tool compares both, reports any divergence
    precisely, and states the bound a clean sample actually supports - separately
    for a per-log defect, a range-clustered defect, and the common-mode defect no
    sample can detect.
  `,
  options: [
    {
      name: 'secondary',
      type: 'string' as const,
      placeholder: '<url>',
      describe: 'Second chain-4663 RPC endpoint. Falls back to VENUE_RPC_URL_SECONDARY.',
    },
    {
      name: 'from-block',
      type: 'string' as const,
      placeholder: '<n>',
      describe: 'First block of the window under verification.',
    },
    {
      name: 'to-block',
      type: 'string' as const,
      placeholder: '<n>',
      describe: 'Last block of the window under verification.',
    },
    {
      name: 'boundaries',
      type: 'string' as const,
      placeholder: '<file>',
      describe:
        'day-boundaries.json. Supplies the window and the per-day strata. Flags override it.',
      default: join(TOOLS_DIR, 'artifacts', 'day-boundaries.json'),
    },
    {
      name: 'windows',
      type: 'number' as const,
      describe: 'Sample windows to draw across the period.',
      default: 40,
    },
    {
      name: 'window-blocks',
      type: 'number' as const,
      describe: 'Blocks per sample window.',
      default: 5000,
    },
    {
      name: 'seed',
      type: 'string' as const,
      placeholder: '<text>',
      describe: 'Sample seed. The same seed and strata always draw the same windows.',
      default: 'venue-cross-verify-1',
    },
    {
      name: 'allocation',
      type: 'string' as const,
      placeholder: 'uniform|sqrt|proportional',
      describe:
        'How windows are spread over the strata. sqrt hedges between covering every day and concentrating on the busy ones.',
      default: 'sqrt',
    },
    {
      name: 'min-per-stratum',
      type: 'number' as const,
      describe: 'Guaranteed windows per day, so the quietest day is never skipped.',
      default: 2,
    },
    {
      name: 'bloom-blocks',
      type: 'number' as const,
      describe:
        "Boundary blocks whose served logs are verified against the block's consensus-committed logsBloom. The only check here that reaches a defect COMMON to both endpoints. 0 disables.",
      default: 10,
    },
    {
      name: 'version-probes',
      type: 'number' as const,
      describe:
        'web3_clientVersion probes per endpoint. >1 reveals a load-balanced pool behind one hostname.',
      default: 5,
    },
    {
      name: 'targets',
      type: 'string[]' as const,
      placeholder: 'escrow,hook',
      describe: 'Which contracts to sample.',
      default: ['escrow', 'hook'],
    },
    {
      name: 'boundary-blocks',
      type: 'number' as const,
      describe:
        'Blocks at each end of the window to compare EXHAUSTIVELY, block by block, per the method limit.',
      default: 25,
    },
    {
      name: 'primary-chunk',
      type: 'number' as const,
      describe: 'Blocks per eth_getLogs on the primary.',
      default: 5000,
    },
    {
      name: 'secondary-chunk',
      type: 'number' as const,
      describe:
        'Blocks per eth_getLogs on the secondary. Measured: it serves 2,000 and refuses 5,000.',
      default: 1000,
    },
    {
      name: 'secondary-rps',
      type: 'number' as const,
      describe: 'Request ceiling for the secondary, requests/second.',
      default: 0.5,
    },
    {
      name: 'confidence',
      type: 'number' as const,
      describe: 'Confidence level for the reported upper bounds.',
      default: 0.95,
    },
    {
      name: 'skip-sample',
      type: 'boolean' as const,
      describe: 'Run only the chain-identity and boundary checks (steps 1 and 3).',
    },
    {
      name: 'escrow',
      type: 'string' as const,
      placeholder: '<address>',
      describe: 'Fee escrow address.',
      default: VENUE.contracts.v2FeeEscrow,
    },
    {
      name: 'hook',
      type: 'string' as const,
      placeholder: '<address>',
      describe: 'Meme hook address.',
      default: VENUE.contracts.v2MemeHook,
    },
  ],
  examples: [
    'node tools/cross-verify.ts --secondary https://rpc.ordofi.network --windows 40 -v',
    'node tools/cross-verify.ts --secondary $ALT --skip-sample   # boundary check only',
  ],
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface EndpointIdentity {
  host: string
  chainId: number | null
  clientVersion: string | null
  clientFamily: string | null
  headBlock: string | null
  error: string | null
  /**
   * What repeated version probes saw behind this hostname. A hostname can front
   * a pool, and one probe cannot tell the difference between a node and a fleet.
   */
  fleet: FleetSummary | null
}

export interface BoundaryLogComparison {
  target: 'escrow' | 'hook'
  region: 'head' | 'tail'
  fromBlock: string
  toBlock: string
  countPrimary: number
  countSecondary: number
  identical: boolean
  diff?: LogSetDiff
  error?: string
}

export interface WindowComparison {
  target: 'escrow' | 'hook'
  stratum: string
  fromBlock: string
  toBlock: string
  countPrimary: number
  countSecondary: number
  identical: boolean
  orderIdentical: boolean
  /** Present only when this window disagreed. Absent rows are agreements. */
  diff?: LogSetDiff
  error?: string
}

export interface TargetSummary {
  target: 'escrow' | 'hook'
  address: string
  topic0s: string[]
  windowsCompared: number
  windowsFailed: number
  windowsMismatched: number
  logsPrimary: number
  logsSecondary: number
  logsMatched: number
  logMismatches: number
  blockMismatches: number
  blocksCompared: number
  /** Stratified estimate of the window's total logs for this filter. */
  estimatedPopulationLogs: number
  bounds: { perLog: AgreementBound; perBlock: AgreementBound; perWindow: AgreementBound }
  interpretation: string[]
}

export interface CrossVerifyResult {
  schema: string
  chainId: number
  window: { fromBlock: string; toBlock: string; blocks: number }
  endpoints: { primary: EndpointIdentity; secondary: EndpointIdentity }
  chainIdentityAgrees: boolean
  /** Step 3: every block in the first and last N of the window. */
  boundaryBlocks: {
    headBlocks: string[]
    tailBlocks: string[]
    compared: number
    mismatched: number
    diffs: HeaderDiff[]
    /**
     * The same boundary blocks compared as LOGS, not only as headers.
     *
     * receiptsRoot agreement already implies the log sets match, but only by
     * an argument about what the root commits to. This is the direct
     * observation, and it is what the method limit literally asks for.
     */
    logs: BoundaryLogComparison[]
    logsMismatched: number
  }
  /**
   * Served logs verified against each block's consensus-committed logsBloom.
   *
   * The only check in this tool that is not a two-node comparison, and so the
   * only one with any power at all against a defect COMMON to both endpoints.
   */
  bloom: {
    checked: number
    matched: number
    failed: number
    checks: Array<BloomCheck & { endpoint: 'primary' | 'secondary' }>
    notes: string[]
  }
  samplePlan: SamplePlan | null
  targets: TargetSummary[]
  windows: WindowComparison[]
  /** The single fact the whole run exists to establish. */
  agreement: 'AGREE' | 'DISAGREE' | 'INCONCLUSIVE'
  residualRisk: string[]
}

// ---------------------------------------------------------------------------

interface Endpoint {
  label: 'primary' | 'secondary'
  url: string
  reader: HttpChainReader
  chunkBlocks: number
}

async function identify(endpoint: Endpoint, versionProbes: number): Promise<EndpointIdentity> {
  const host = hostOf(endpoint.url)
  try {
    const chainId = await endpoint.reader.chainId()
    // Probed REPEATEDLY, not once. A hostname can front a load-balanced pool,
    // and a single draw would be reported as "the endpoint's version" when it
    // is only the version of whichever machine answered. Measured on chain
    // 4663: rpc.mainnet.chain.robinhood.com returns the same nitro build on
    // both linux-amd64 and linux-arm64.
    const observed: string[] = []
    for (let i = 0; i < Math.max(1, versionProbes); i++) {
      try {
        observed.push(await endpoint.reader.rpc<string>('web3_clientVersion', []))
      } catch {
        // Optional. An endpoint that hides its version is less useful for the
        // common-mode question but is still a valid second source.
        break
      }
    }
    const fleet = observed.length > 0 ? summarizeFleet(observed) : null
    const clientVersion = fleet === null ? null : (fleet.versions[0] ?? null)
    const head = await endpoint.reader.blockNumber()
    return {
      host,
      chainId,
      clientVersion,
      clientFamily: clientVersion === null ? null : clientFamily(clientVersion),
      headBlock: head.toString(),
      error: null,
      fleet,
    }
  } catch (error) {
    return {
      host,
      chainId: null,
      clientVersion: null,
      clientFamily: null,
      headBlock: null,
      error: error instanceof Error ? error.message : String(error),
      fleet: null,
    }
  }
}

/**
 * Every log in one block, from every contract.
 *
 * Unfiltered on purpose. A header's logsBloom commits to the whole block, so
 * verifying against it requires the whole block's logs; an address-filtered set
 * would never reproduce the bloom and would report a false mismatch.
 */
async function allLogsInBlock(endpoint: Endpoint, block: bigint): Promise<RawLog[]> {
  const hex = `0x${block.toString(16)}`
  const logs = await endpoint.reader.rpc<RawLog[] | null>('eth_getLogs', [
    { fromBlock: hex, toBlock: hex },
  ])
  return logs ?? []
}

async function rawBlock(endpoint: Endpoint, block: bigint): Promise<RawBlock | null> {
  const result = await endpoint.reader.rpc<RawBlock | null>('eth_getBlockByNumber', [
    `0x${block.toString(16)}`,
    false,
  ])
  return result ?? null
}

/**
 * Fetch one window's logs from one endpoint.
 *
 * NO CACHE, ever - see assertNoSharedCache. The scan cache keys on the filter
 * and range but not on the endpoint, so a shared cache would answer the
 * secondary with the primary's own logs and this tool would pass unconditionally.
 */
async function fetchWindow(
  endpoint: Endpoint,
  address: string,
  topics: Array<string | string[] | null>,
  window: BlockWindow,
): Promise<RawLog[]> {
  const options = {
    address,
    topics,
    fromBlock: window.fromBlock,
    toBlock: window.toBlock,
    chunkBlocks: endpoint.chunkBlocks,
    batchSize: 1,
  }
  assertNoSharedCache(options)
  return scanLogs(endpoint.reader, options)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

interface BoundariesFile {
  fromBlock: string
  toBlock: string
  boundaries: Array<{ iso: string; block: string }>
}

async function readBoundaries(path: string): Promise<BoundariesFile | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as BoundariesFile
  } catch {
    return null
  }
}

/**
 * Measure each stratum's activity instead of assuming it.
 *
 * A weight taken from a guess would decide where the sample looks, so it is
 * probed: one small span in the middle of each day on the PRIMARY, giving
 * logs/block. The probe is recorded in the plan, so the whole sample stays
 * reproducible from the artifact even though the weights were measured live.
 */
async function probeWeights(
  endpoint: Endpoint,
  address: string,
  topics: Array<string | string[] | null>,
  strata: readonly Stratum[],
  probeBlocks: number,
  verbose: boolean,
): Promise<Map<string, number>> {
  const weights = new Map<string, number>()
  for (const stratum of strata) {
    const span = stratum.toBlock - stratum.fromBlock + 1n
    const probe = BigInt(Math.min(probeBlocks, Number(span)))
    const mid = stratum.fromBlock + span / 2n
    const from = mid - probe / 2n
    const to = from + probe - 1n
    try {
      const logs = await fetchWindow(endpoint, address, topics, { fromBlock: from, toBlock: to })
      const rate = logs.length / Number(probe)
      weights.set(stratum.label, rate)
      progress(verbose, `  weight probe ${stratum.label}: ${logs.length} logs / ${probe} blocks = ${rate.toFixed(4)}/blk`)
    } catch (error) {
      // A failed probe must not silently become weight 0 and starve that day of
      // windows; the min-per-stratum floor still covers it, and the note says so.
      weights.set(stratum.label, 0)
      progress(
        verbose,
        `  weight probe ${stratum.label}: FAILED (${error instanceof Error ? error.message : String(error)}); weight 0, floor still applies`,
      )
    }
  }
  return weights
}

// ---------------------------------------------------------------------------

async function main(values: Record<string, unknown>): Promise<void> {
  const config = loadConfig()
  const verbose = getBool(values as never, 'verbose')
  const json = getBool(values as never, 'json')
  const dryRun = getBool(values as never, 'dry-run')
  const outPath = getString(values as never, 'out')

  const primaryUrl = config.rpcUrls[0]
  const secondaryUrl =
    getString(values as never, 'secondary') ??
    process.env.VENUE_RPC_URL_SECONDARY ??
    config.rpcUrls[1]

  if (!dryRun && primaryUrl === undefined) {
    throw new CliError('no primary endpoint. Set VENUE_RPC_URL (chain 4663).')
  }
  if (!dryRun && secondaryUrl === undefined) {
    throw new CliError(
      'no secondary endpoint. Pass --secondary <url> or set VENUE_RPC_URL_SECONDARY. ' +
        'This tool has no purpose with one endpoint: verifying a node against itself is what ' +
        'the existing internal controls already do, and it is exactly what they cannot settle.',
    )
  }
  if (primaryUrl !== undefined && primaryUrl === secondaryUrl) {
    throw new CliError(
      'the primary and secondary endpoints are the same URL. Comparing a node with itself ' +
        'always agrees and proves nothing.',
    )
  }

  // --- window and strata ---------------------------------------------------
  const boundariesPath = getString(values as never, 'boundaries')
  const file = boundariesPath === undefined ? null : await readBoundaries(boundariesPath)
  const fromBlockArg = getString(values as never, 'from-block')
  const toBlockArg = getString(values as never, 'to-block')
  const fromBlock = fromBlockArg !== undefined ? BigInt(fromBlockArg) : file ? BigInt(file.fromBlock) : undefined
  const toBlock = toBlockArg !== undefined ? BigInt(toBlockArg) : file ? BigInt(file.toBlock) : undefined
  if (fromBlock === undefined || toBlock === undefined) {
    throw new CliError(
      'no window. Pass --from-block/--to-block, or point --boundaries at a day-boundaries.json.',
    )
  }
  if (toBlock < fromBlock) throw new CliError('--to-block is below --from-block')
  const window: BlockWindow = { fromBlock, toBlock }
  const windowBlocks = Number(toBlock - fromBlock + 1n)

  const targets = new Set(
    (Array.isArray(values.targets) ? (values.targets as string[]) : ['escrow', 'hook']).map((t) =>
      t.toLowerCase(),
    ),
  )
  for (const t of targets) {
    if (t !== 'escrow' && t !== 'hook') throw new CliError(`--targets: unknown target "${t}"`)
  }

  const escrowAddress = (getString(values as never, 'escrow') ?? VENUE.contracts.v2FeeEscrow).toLowerCase()
  const hookAddress = (getString(values as never, 'hook') ?? VENUE.contracts.v2MemeHook).toLowerCase()
  const sampleWindows = Math.max(0, Math.floor(getNumber(values as never, 'windows', 40)))
  const sampleWindowBlocks = Math.max(1, Math.floor(getNumber(values as never, 'window-blocks', 5000)))
  const boundaryBlocks = Math.max(1, Math.floor(getNumber(values as never, 'boundary-blocks', 25)))
  const bloomBlocks = Math.max(0, Math.floor(getNumber(values as never, 'bloom-blocks', 10)))
  const confidence = getNumber(values as never, 'confidence', 0.95)
  if (confidence <= 0 || confidence >= 1) throw new CliError('--confidence must be in (0,1)')
  const allocationRaw = getString(values as never, 'allocation') ?? 'sqrt'
  if (allocationRaw !== 'uniform' && allocationRaw !== 'sqrt' && allocationRaw !== 'proportional') {
    throw new CliError('--allocation must be uniform, sqrt or proportional')
  }
  const skipSample = getBool(values as never, 'skip-sample')

  if (dryRun) {
    const strataCount = file ? Math.max(1, file.boundaries.length - 1) : 1
    const perWindowPrimary = Math.ceil(sampleWindowBlocks / getNumber(values as never, 'primary-chunk', 5000))
    const perWindowSecondary = Math.ceil(
      sampleWindowBlocks / getNumber(values as never, 'secondary-chunk', 1000),
    )
    const targetCount = targets.size
    // Identity: chainId + head + N version probes, per endpoint.
    const versionProbesPlanned = Math.max(
      1,
      Math.floor(getNumber(values as never, 'version-probes', 5)),
    )
    const identifyRequests = (2 + versionProbesPlanned) * 2
    // Bloom: one unfiltered eth_getLogs per chosen block, per endpoint. The
    // headers themselves are already fetched by the boundary compare above.
    const bloomBlocksPlanned = Math.max(
      0,
      Math.floor(getNumber(values as never, 'bloom-blocks', 10)),
    )
    const bloomRequests =
      bloomBlocksPlanned === 0
        ? 0
        : Math.min(Math.max(1, Math.floor(bloomBlocksPlanned / 2)) * 2, boundaryBlocks * 2) * 2
    const sampleRequests = skipSample
      ? 0
      : sampleWindows * targetCount * (perWindowPrimary + perWindowSecondary) + strataCount
    emitDryRun(
      {
        tool: SPEC.name,
        config: {
          ...describeConfig(config),
          secondary: secondaryUrl === undefined ? '<unset>' : hostOf(secondaryUrl),
          window: `${fromBlock} .. ${toBlock} (${windowBlocks.toLocaleString()} blocks)`,
          strata: strataCount,
        },
        steps: [
          {
            description: `eth_chainId + ${versionProbesPlanned} web3_clientVersion probe(s) + head, both endpoints`,
            estimatedRequests: identifyRequests,
          },
          {
            description: `exhaustive header compare, first and last ${boundaryBlocks} blocks, both endpoints`,
            estimatedRequests: boundaryBlocks * 4,
          },
          {
            description:
              bloomRequests === 0
                ? 'logsBloom verification SKIPPED (--bloom-blocks 0)'
                : `logsBloom verification, ${Math.min(bloomBlocksPlanned, boundaryBlocks * 2)} block(s) x both endpoints`,
            estimatedRequests: bloomRequests,
          },
          {
            description: skipSample
              ? 'sample SKIPPED (--skip-sample)'
              : `${sampleWindows} sampled windows x ${sampleWindowBlocks} blocks x ${targetCount} target(s), both endpoints`,
            estimatedRequests: sampleRequests,
          },
        ],
        estimatedRequestsTotal:
          identifyRequests + boundaryBlocks * 4 + bloomRequests + sampleRequests,
        notes: [
          'No fetch here may be cached: the logscan cache key omits the endpoint, so a shared cache would answer the secondary with the primary result.',
        ],
      },
      json,
    )
    return
  }

  // --- endpoints -----------------------------------------------------------
  const primaryHttp = buildHttpClient({
    requestsPerSecond: config.requestsPerSecond,
    maxRetries: config.maxRetries,
    timeoutMs: config.requestTimeoutMs,
    onRetry: (a, d, r) => progress(verbose, `primary retry ${a} in ${d}ms: ${r}`),
    adaptive: {
      minRequestsPerSecond: Math.max(0.1, config.requestsPerSecond / 8),
      onRateChange: (rps, reason) => progress(verbose, `primary rate -> ${rps.toFixed(3)}/s (${reason})`),
    },
  })
  const secondaryRps = Math.max(0.05, getNumber(values as never, 'secondary-rps', 0.5))
  const secondaryHttp = buildHttpClient({
    requestsPerSecond: secondaryRps,
    maxRetries: config.maxRetries,
    timeoutMs: Math.max(config.requestTimeoutMs, 45_000),
    onRetry: (a, d, r) => progress(verbose, `secondary retry ${a} in ${d}ms: ${r}`),
    adaptive: {
      minRequestsPerSecond: Math.max(0.05, secondaryRps / 8),
      onRateChange: (rps, reason) => progress(verbose, `secondary rate -> ${rps.toFixed(3)}/s (${reason})`),
    },
  })

  const primary: Endpoint = {
    label: 'primary',
    url: primaryUrl!,
    reader: new HttpChainReader(primaryHttp, [primaryUrl!]),
    chunkBlocks: Math.max(1, Math.floor(getNumber(values as never, 'primary-chunk', 5000))),
  }
  const secondary: Endpoint = {
    label: 'secondary',
    url: secondaryUrl!,
    reader: new HttpChainReader(secondaryHttp, [secondaryUrl!]),
    chunkBlocks: Math.max(1, Math.floor(getNumber(values as never, 'secondary-chunk', 1000))),
  }

  const warnings: string[] = []
  const incompleteReasons: string[] = []

  // === STEP 1: do the two nodes agree about the chain at all? ==============
  progress(verbose, 'step 1: endpoint identity')
  const versionProbes = Math.max(1, Math.floor(getNumber(values as never, 'version-probes', 5)))
  const [primaryId, secondaryId] = await Promise.all([
    identify(primary, versionProbes),
    identify(secondary, versionProbes),
  ])
  progress(verbose, `  primary   ${primaryId.host} chainId ${primaryId.chainId} ${primaryId.clientVersion ?? ''}`)
  progress(verbose, `  secondary ${secondaryId.host} chainId ${secondaryId.chainId} ${secondaryId.clientVersion ?? ''}`)

  if (secondaryId.error !== null) {
    throw new CliError(
      `secondary endpoint ${secondaryId.host} is unusable: ${secondaryId.error}. ` +
        'Nothing in this repo is externally verified while that is true.',
    )
  }
  const chainIdentityAgrees =
    primaryId.chainId !== null && primaryId.chainId === secondaryId.chainId
  if (!chainIdentityAgrees) {
    throw new CliError(
      `chainId mismatch: primary ${primaryId.chainId}, secondary ${secondaryId.chainId}. ` +
        'These are different chains. No comparison below would mean anything.',
    )
  }
  if (secondaryId.chainId !== config.chainId) {
    throw new CliError(
      `secondary serves chain ${secondaryId.chainId}, not ${config.chainId}.`,
    )
  }

  const escrowTopics: Array<string | string[] | null> = [[CREDITED_TOPIC0, CREDITED_TOKEN_TOPIC0]]
  const hookTopics: Array<string | string[] | null> = [POOL_FEES_SWEPT_TOPIC0]
  const targetSpecs: Array<{
    target: 'escrow' | 'hook'
    address: string
    topics: Array<string | string[] | null>
    topic0s: string[]
  }> = []
  if (targets.has('escrow')) {
    targetSpecs.push({
      target: 'escrow',
      address: escrowAddress,
      topics: escrowTopics,
      topic0s: [CREDITED_TOPIC0, CREDITED_TOKEN_TOPIC0],
    })
  }
  if (targets.has('hook')) {
    targetSpecs.push({
      target: 'hook',
      address: hookAddress,
      topics: hookTopics,
      topic0s: [POOL_FEES_SWEPT_TOPIC0],
    })
  }

  // === STEP 3 (run early, it is the cheap and load-bearing one) ============
  // The method limit names exactly this: the window's FIRST and LAST block,
  // exhaustively. Doing it before the sample means a boundary disagreement is
  // reported even if the long sample is later interrupted.
  progress(verbose, `step 3: exhaustive boundary compare, ${boundaryBlocks} blocks at each end`)
  const boundaryRegionList = boundaryRegions(window, boundaryBlocks)
  const headRegion = boundaryRegionList.find((r) => r.region === 'head')?.window
  const tailRegion = boundaryRegionList.find((r) => r.region === 'tail')?.window
  const boundarySet = boundaryBlockList(window, boundaryBlocks)

  const headerDiffs: HeaderDiff[] = []
  /** Headers kept so the bloom check below can read logsBloom without refetching. */
  const headersByBlock = new Map<string, { a: RawBlock | null; b: RawBlock | null }>()
  for (const block of boundarySet) {
    const [a, b] = await Promise.all([
      rawBlock(primary, block).catch(() => null),
      rawBlock(secondary, block).catch(() => null),
    ])
    headersByBlock.set(block.toString(), { a, b })
    const diff = compareHeaders(block, a, b, COMPARED_HEADER_FIELDS)
    headerDiffs.push(diff)
    if (!diff.identical) {
      progress(
        verbose,
        `  BOUNDARY MISMATCH at ${block}: ${diff.fields.filter((f) => !f.equal).map((f) => f.field).join(', ')}`,
      )
    }
  }
  const boundaryMismatched = headerDiffs.filter((d) => !d.identical).length
  progress(
    verbose,
    `  ${headerDiffs.length} blocks compared, ${boundaryMismatched} mismatched`,
  )

  // === BLOOM CHECK: the only control here that reaches COMMON MODE =========
  // Every comparison above and below asks whether two nodes agree, and so is
  // blind to a defect they share. This asks something else entirely: do the
  // logs an endpoint SERVES reproduce the logsBloom committed inside the block
  // hash? That commitment comes from consensus, not from the other node, so a
  // shared client bug has nowhere to hide - it either serves the block's real
  // logs or it does not.
  const bloomChecks: Array<BloomCheck & { endpoint: 'primary' | 'secondary' }> = []
  if (bloomBlocks > 0) {
    const half = Math.max(1, Math.floor(bloomBlocks / 2))
    const chosen = [...boundarySet.slice(0, half), ...boundarySet.slice(-half)]
    const unique = [...new Map(chosen.map((b) => [b.toString(), b])).values()]
    progress(verbose, `step 3b: logsBloom verification on ${unique.length} boundary block(s)`)
    for (const block of unique) {
      const headers = headersByBlock.get(block.toString())
      for (const [label, endpoint, header] of [
        ['primary', primary, headers?.a ?? null],
        ['secondary', secondary, headers?.b ?? null],
      ] as const) {
        try {
          // EVERY log in the block, unfiltered: the header's bloom covers the
          // whole block, so a contract-filtered set could never reproduce it.
          const all = await allLogsInBlock(endpoint, block)
          const bloom = header === null ? undefined : (header['logsBloom'] as string | undefined)
          const check = checkBlockBloom(block, bloom, all)
          bloomChecks.push({ ...check, endpoint: label })
          if (!check.matches) {
            progress(
              verbose,
              `  *** BLOOM MISMATCH *** ${label} block ${block}: ${check.logCount} logs do NOT ` +
                `reproduce the header bloom${check.error ? ` (${check.error})` : ''}`,
            )
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          bloomChecks.push({
            endpoint: label,
            blockNumber: block.toString(),
            logCount: -1,
            headerBloom: null,
            computedBloom: '',
            matches: false,
            error: message,
          })
          progress(verbose, `  bloom ${label} block ${block}: FAILED ${message}`)
        }
      }
    }
    const bloomSummary = summarizeBloomChecks(bloomChecks)
    progress(
      verbose,
      `  ${bloomSummary.matched}/${bloomSummary.checked} block-endpoint pairs reproduce the header bloom`,
    )
  }

  // The same blocks, compared as LOGS. The header check above already commits
  // to the log set through receiptsRoot, but that is an argument; this is the
  // observation, and it is the one the method limit literally asks for. It runs
  // even under --skip-sample, because it IS the outstanding item.
  const boundaryLogComparisons: BoundaryLogComparison[] = []
  for (const spec of targetSpecs) {
    for (const { region, window: region_ } of boundaryRegionList) {
      try {
        const a = await fetchWindow(primary, spec.address, spec.topics, region_)
        const b = await fetchWindow(secondary, spec.address, spec.topics, region_)
        const diff = compareLogSets(a, b)
        boundaryLogComparisons.push({
          target: spec.target,
          region,
          fromBlock: region_.fromBlock.toString(),
          toBlock: region_.toBlock.toString(),
          countPrimary: diff.countPrimary,
          countSecondary: diff.countSecondary,
          identical: diff.identical,
          ...(diff.identical ? {} : { diff }),
        })
        progress(
          verbose,
          `  boundary logs ${spec.target}/${region} ${region_.fromBlock}-${region_.toBlock}: ` +
            `${diff.countPrimary} vs ${diff.countSecondary} ${diff.identical ? 'IDENTICAL' : '*** MISMATCH ***'}`,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        boundaryLogComparisons.push({
          target: spec.target,
          region,
          fromBlock: region_.fromBlock.toString(),
          toBlock: region_.toBlock.toString(),
          countPrimary: -1,
          countSecondary: -1,
          identical: false,
          error: message,
        })
        progress(verbose, `  boundary logs ${spec.target}/${region}: FAILED ${message}`)
      }
    }
  }
  const boundaryLogsMismatched = boundaryLogComparisons.filter((c) => !c.identical).length

  // === STEP 2 + 4: the sampled log comparison =============================
  let plan: SamplePlan | null = null
  const comparisons: WindowComparison[] = []
  const targetSummaries: TargetSummary[] = []

  if (!skipSample && sampleWindows > 0) {
    // Strata: one per UTC day when boundaries are available, else the whole
    // window as a single stratum. A single stratum is honest but weaker, and
    // the note says so.
    let strata: Stratum[]
    if (file !== null) {
      strata = strataFromDayBoundaries(file.boundaries, window)
    } else {
      strata = [{ label: 'whole-window', fromBlock, toBlock, weight: 1 }]
      warnings.push(
        'No day boundaries were available, so the sample was drawn from ONE stratum covering the whole window. ' +
          'A defect confined to a single day is less likely to be caught by an unstratified draw.',
      )
    }

    progress(verbose, `step 2: probing activity weights across ${strata.length} strata`)
    const weights =
      allocationRaw === 'uniform'
        ? new Map(strata.map((s) => [s.label, 1]))
        : await probeWeights(primary, escrowAddress, escrowTopics, strata, 500, verbose)
    const weighted = strata.map((s) => ({ ...s, weight: weights.get(s.label) ?? 0 }))

    plan = planSampleWindows({
      strata: weighted,
      windowBlocks: sampleWindowBlocks,
      windowCount: sampleWindows,
      seed: getString(values as never, 'seed') ?? 'venue-cross-verify-1',
      allocation: allocationRaw,
      minPerStratum: Math.max(0, Math.floor(getNumber(values as never, 'min-per-stratum', 2))),
    })
    for (const note of plan.notes) warnings.push(`sample plan: ${note}`)

    for (const spec of targetSpecs) {
      progress(
        verbose,
        `step ${spec.target === 'escrow' ? '2' : '4'}: ${spec.target} ${spec.address}, ${plan.windows.length} windows`,
      )
      let logsPrimary = 0
      let logsSecondary = 0
      let logsMatched = 0
      let logMismatches = 0
      let blockMismatches = 0
      let windowsCompared = 0
      let windowsFailed = 0
      let windowsMismatched = 0
      /** Per stratum: logs seen and blocks compared. Feeds the unbiased estimator. */
      const perStratum = new Map<string, { logs: number; blocks: number }>()

      for (const [i, sampled] of plan.windows.entries()) {
        const label = `${sampled.fromBlock}-${sampled.toBlock} (${sampled.stratum})`
        try {
          // Sequential, not parallel: the secondary has a query-time budget and
          // parallel load is what turns its -32005 into a wall.
          const a = await fetchWindow(primary, spec.address, spec.topics, sampled)
          const b = await fetchWindow(secondary, spec.address, spec.topics, sampled)
          const diff = compareLogSets(a, b)
          windowsCompared++
          logsPrimary += diff.countPrimary
          logsSecondary += diff.countSecondary
          logsMatched += diff.matched
          const stratumRow = perStratum.get(sampled.stratum) ?? { logs: 0, blocks: 0 }
          stratumRow.logs += diff.countPrimary
          stratumRow.blocks += sampleWindowBlocks
          perStratum.set(sampled.stratum, stratumRow)
          // Counted from the diff's own uncapped totals, not re-derived from the
          // truncated tuple lists: a divergence larger than maxReported would
          // otherwise be counted as maxReported and understate itself.
          logMismatches += diff.mismatchedLogCount
          blockMismatches += diff.mismatchedBlockCount
          if (!diff.identical) windowsMismatched++
          comparisons.push({
            target: spec.target,
            stratum: sampled.stratum,
            fromBlock: sampled.fromBlock.toString(),
            toBlock: sampled.toBlock.toString(),
            countPrimary: diff.countPrimary,
            countSecondary: diff.countSecondary,
            identical: diff.identical,
            orderIdentical: diff.orderIdentical,
            ...(diff.identical ? {} : { diff }),
          })
          progress(
            verbose,
            `  [${i + 1}/${plan.windows.length}] ${spec.target} ${label}: ` +
              `${diff.countPrimary} vs ${diff.countSecondary} ${diff.identical ? 'IDENTICAL' : '*** MISMATCH ***'}`,
          )
        } catch (error) {
          windowsFailed++
          const message = error instanceof Error ? error.message : String(error)
          comparisons.push({
            target: spec.target,
            stratum: sampled.stratum,
            fromBlock: sampled.fromBlock.toString(),
            toBlock: sampled.toBlock.toString(),
            countPrimary: -1,
            countSecondary: -1,
            identical: false,
            orderIdentical: false,
            error: message,
          })
          progress(verbose, `  [${i + 1}/${plan.windows.length}] ${spec.target} ${label}: FAILED ${message}`)
          if (error instanceof UnservableRangeError) {
            warnings.push(
              `${spec.target} window ${label} could not be served by one of the endpoints even at single-block granularity: ${message}`,
            )
          }
        }
      }

      const blocksCompared = windowsCompared * sampleWindowBlocks
      const comparableWindows = Math.floor(windowBlocks / sampleWindowBlocks)
      // STRATIFIED estimate of the window's total log count.
      //
      // A pooled density (total logs / total blocks compared) would be BIASED
      // here, and badly: the sqrt allocation deliberately draws more windows
      // from the busy days, so pooling would scale the busy days' density over
      // the whole period. Each stratum's density is therefore scaled by its OWN
      // block count and the strata are summed - the standard stratified
      // estimator, unbiased under this design. A stratum the sample never
      // reached contributes nothing and is reported as uncovered rather than
      // imputed from its neighbours.
      let estimatedPopulationLogs = 0
      let strataCovered = 0
      for (const stratum of plan.strata) {
        const row = perStratum.get(stratum.label)
        if (row === undefined || row.blocks === 0) continue
        strataCovered++
        estimatedPopulationLogs += (row.logs / row.blocks) * stratum.blocksInStratum
      }
      estimatedPopulationLogs = Math.round(estimatedPopulationLogs)
      if (strataCovered < plan.strata.length) {
        warnings.push(
          `${spec.target}: ${plan.strata.length - strataCovered} of ${plan.strata.length} strata contributed no ` +
            'compared window, so the estimated log population below is a lower bound over the covered strata only.',
        )
      }

      const bounds = {
        perLog: agreementBound({
          unit: 'log',
          trials: logsPrimary,
          mismatches: logMismatches,
          confidence,
          populationSize: estimatedPopulationLogs,
        }),
        perBlock: agreementBound({
          unit: 'block',
          trials: blocksCompared,
          mismatches: blockMismatches,
          confidence,
          populationSize: windowBlocks,
        }),
        perWindow: agreementBound({
          unit: `${sampleWindowBlocks}-block window`,
          trials: windowsCompared,
          mismatches: windowsMismatched,
          confidence,
          populationSize: comparableWindows,
        }),
      }

      targetSummaries.push({
        target: spec.target,
        address: spec.address,
        topic0s: spec.topic0s,
        windowsCompared,
        windowsFailed,
        windowsMismatched,
        logsPrimary,
        logsSecondary,
        logsMatched,
        logMismatches,
        blockMismatches,
        blocksCompared,
        estimatedPopulationLogs,
        bounds,
        interpretation: interpretBounds({
          ...bounds,
          windowBlocks: sampleWindowBlocks,
          clientPrimary: primaryId.clientVersion,
          clientSecondary: secondaryId.clientVersion,
        }),
      })

      if (windowsFailed > 0) {
        incompleteReasons.push(
          `${spec.target}: ${windowsFailed} of ${plan.windows.length} sampled windows could not be compared. ` +
            'Those blocks remain single-sourced.',
        )
      }
    }
  } else if (skipSample) {
    incompleteReasons.push(
      '--skip-sample: only the chain identity and the window boundary blocks were verified. ' +
        'The interior of the window remains single-sourced.',
    )
  }

  // --- verdict -------------------------------------------------------------
  // A bloom failure counts as a mismatch even though it is not a disagreement
  // between the two nodes: it says an endpoint served a log set the chain's own
  // commitment contradicts, which is strictly worse news than the two of them
  // differing.
  const bloomFailed = bloomChecks.filter((c) => !c.matches).length
  const anyMismatch =
    boundaryMismatched > 0 ||
    boundaryLogsMismatched > 0 ||
    bloomFailed > 0 ||
    targetSummaries.some((t) => t.windowsMismatched > 0)
  const anyComparison =
    headerDiffs.length > 0 || targetSummaries.some((t) => t.windowsCompared > 0)
  const agreement: CrossVerifyResult['agreement'] = anyMismatch
    ? 'DISAGREE'
    : anyComparison
      ? 'AGREE'
      : 'INCONCLUSIVE'

  const residualRisk: string[] = []
  const sameFamily =
    primaryId.clientFamily !== null && primaryId.clientFamily === secondaryId.clientFamily
  if (sameFamily) {
    const listOf = (id: EndpointIdentity): string =>
      id.fleet !== null && id.fleet.versions.length > 1
        ? id.fleet.versions.map((v) => `"${v}"`).join(' + ')
        : `"${id.clientVersion}"`
    residualRisk.push(
      `BOTH ENDPOINTS RUN THE SAME CLIENT FAMILY (${primaryId.clientFamily}). Primary ` +
        `${listOf(primaryId)}, secondary ${listOf(secondaryId)}. Different builds and ` +
        'architectures reduce the correlation; they do not remove it. A defect in this client\'s log ' +
        'index would be present on BOTH sides, agree perfectly, and be invisible to this tool at any ' +
        'sample size. Closing that requires a second CLIENT IMPLEMENTATION or an independent indexer, ' +
        'neither of which is known to exist for chain 4663 today.',
    )
  }
  // A hostname is not a node. Where the version probe caught a pool, say so -
  // it changes what "one endpoint" meant in every earlier measurement.
  for (const [label, id] of [
    ['primary', primaryId],
    ['secondary', secondaryId],
  ] as const) {
    const note = id.fleet === null ? null : describeFleet(label, id.host, id.fleet)
    if (note !== null) residualRisk.push(note)
  }
  if (bloomChecks.length > 0) {
    for (const note of summarizeBloomChecks(bloomChecks).notes) residualRisk.push(note)
    residualRisk.push(
      `The bloom check covered ${new Set(bloomChecks.map((c) => c.blockNumber)).size} block(s), all at the ` +
        'window BOUNDARY. It is the only control here with power against a shared-client defect, and it ' +
        'was not run over the interior. Extending it to the sampled windows would be the single most ' +
        'valuable addition to this tool.',
    )
  }
  residualRisk.push(
    'Agreement between two nodes bounds NODE-SPECIFIC defects only. It says nothing about whether the ' +
      'events themselves mean what this project reads them to mean; that is settled by the topic census, ' +
      'not here.',
  )
  if (!skipSample && plan !== null) {
    const covered = totalBlocks(plan.windows)
    residualRisk.push(
      `The sample compared ${covered.toLocaleString()} of the window's ${windowBlocks.toLocaleString()} blocks ` +
        `(${((covered / windowBlocks) * 100).toFixed(2)}%). The other ${(100 - (covered / windowBlocks) * 100).toFixed(2)}% ` +
        'is bounded statistically, not observed.',
    )
  }

  const methodLimits = [
    'A clean sample BOUNDS the disagreement rate. It does not prove the two endpoints serve identical logs, and no sample short of a full re-scan can.',
    'The secondary is compared against the primary. Neither is ground truth: an agreement says they do not differ, not that either is right.',
    'receiptsRoot and logsBloom agreement on the boundary blocks is a cryptographic commitment to the complete log set of THOSE blocks only. It does not extend to the interior of the window.',
    'No fetch in this tool is cached, deliberately: the logscan cache key omits the endpoint, so a shared cache would serve the primary result as the secondary answer and every comparison would pass.',
    'Both sides are scanned through logscan, which sorts by (blockNumber, logIndex) before returning, so the orderIdentical flag reports post-sort equality and is NOT evidence about either endpoint\'s native serving order. The secondary cannot serve a whole window in one call, so as-served order is not observable at window scale.',
    'The secondary is fetched in smaller chunks than the primary (its query-time budget refuses larger spans). The chunk tiling is exact - no gap, no overlap - but the two sides are therefore not answering byte-identical HTTP requests, only covering identical block ranges.',
  ]

  if (agreement === 'AGREE') {
    warnings.push(
      'AGREE means no disagreement was found where this tool looked. Read the residual-risk section before ' +
        'treating any single-endpoint measurement as externally verified.',
    )
  }
  if (agreement === 'DISAGREE') {
    warnings.push(
      'THE ENDPOINTS DISAGREE. Every figure in VERDICT.md and MEASUREMENT.md derives from a single-endpoint ' +
        'scan and must be treated as unverified until the divergence below is explained.',
    )
  }

  const result: CrossVerifyResult = {
    schema: SCHEMA_VERSION,
    chainId: config.chainId,
    window: { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), blocks: windowBlocks },
    endpoints: { primary: primaryId, secondary: secondaryId },
    chainIdentityAgrees,
    boundaryBlocks: {
      headBlocks: headRegion === undefined ? [] : [headRegion.fromBlock.toString(), headRegion.toBlock.toString()],
      tailBlocks: tailRegion === undefined ? [] : [tailRegion.fromBlock.toString(), tailRegion.toBlock.toString()],
      compared: headerDiffs.length,
      mismatched: boundaryMismatched,
      diffs: headerDiffs.filter((d) => !d.identical),
      logs: boundaryLogComparisons,
      logsMismatched: boundaryLogsMismatched,
    },
    bloom: {
      ...summarizeBloomChecks(bloomChecks),
      checks: bloomChecks,
    },
    samplePlan: plan,
    targets: targetSummaries,
    windows: comparisons,
    agreement,
    residualRisk,
  }

  const report: Report<CrossVerifyResult> = {
    meta: {
      tool: SPEC.name,
      schemaVersion: SCHEMA_VERSION,
      generatedAtUnix: Math.floor(Date.now() / 1000),
      config: {
        ...describeConfig(config),
        primaryHost: primaryId.host,
        secondaryHost: secondaryId.host,
        secondaryRps,
        sampleSeed: getString(values as never, 'seed'),
        allocation: allocationRaw,
      },
      io: {
        httpRequests: primaryHttp.requestCount + secondaryHttp.requestCount,
        cacheHits: 0,
        cacheMisses: 0,
      },
      warnings,
      methodLimits,
      ...(incompleteReasons.length > 0
        ? { measurementComplete: false, incompleteReasons }
        : {}),
    },
    result,
  }

  await emit(report, { json, outPath, human: renderHuman })
  if (agreement === 'DISAGREE') process.exitCode = EXIT_MISMATCH
}

// ---------------------------------------------------------------------------

function renderHuman(report: Report<CrossVerifyResult>): string {
  const r = report.result
  const lines: string[] = []
  lines.push(heading(`cross-verify - chain ${r.chainId}`))
  lines.push('')
  lines.push(`  window            ${r.window.fromBlock} .. ${r.window.toBlock} (${r.window.blocks.toLocaleString()} blocks)`)
  const endpointLine = (id: CrossVerifyResult['endpoints']['primary']): string => {
    const base = `${id.host}  ${id.clientVersion ?? '<no version>'}`
    if (id.fleet === null || !id.fleet.heterogeneous) return base
    return `${base}  [POOL: ${id.fleet.versions.length} builds in ${id.fleet.samples} probes]`
  }
  lines.push(`  primary           ${endpointLine(r.endpoints.primary)}`)
  lines.push(`  secondary         ${endpointLine(r.endpoints.secondary)}`)
  for (const [label, id] of [
    ['primary', r.endpoints.primary],
    ['secondary', r.endpoints.secondary],
  ] as const) {
    if (id.fleet === null || !id.fleet.heterogeneous) continue
    for (const v of id.fleet.versions) lines.push(`    ${label} pool     ${v}`)
  }
  lines.push(`  chainId agrees    ${r.chainIdentityAgrees ? 'yes' : 'NO'}`)
  lines.push('')
  lines.push(`  VERDICT           ${r.agreement}`)
  lines.push('')

  lines.push(heading('1+3. chain identity and window boundary blocks (exhaustive)'))
  lines.push('')
  lines.push(`  head blocks       ${r.boundaryBlocks.headBlocks[0] ?? '-'} .. ${r.boundaryBlocks.headBlocks.at(-1) ?? '-'}`)
  lines.push(`  tail blocks       ${r.boundaryBlocks.tailBlocks[0] ?? '-'} .. ${r.boundaryBlocks.tailBlocks.at(-1) ?? '-'}`)
  lines.push(`  compared          ${r.boundaryBlocks.compared} blocks, every field of ${COMPARED_HEADER_FIELDS.length}`)
  lines.push(`                    (${COMPARED_HEADER_FIELDS.join(', ')})`)
  lines.push(`  header mismatches ${r.boundaryBlocks.mismatched}`)
  for (const c of r.boundaryBlocks.logs) {
    lines.push(
      `  logs ${`${c.target}/${c.region}`.padEnd(13)} ${c.fromBlock}-${c.toBlock}  ` +
        `${c.error ?? `${c.countPrimary} vs ${c.countSecondary}  ${c.identical ? 'IDENTICAL' : '*** MISMATCH ***'}`}`,
    )
  }
  lines.push(`  log mismatches    ${r.boundaryBlocks.logsMismatched}`)
  if (r.boundaryBlocks.diffs.length > 0) {
    for (const diff of r.boundaryBlocks.diffs.slice(0, 10)) {
      lines.push(`    block ${diff.blockNumber}:`)
      for (const field of diff.fields.filter((f) => !f.equal)) {
        lines.push(`      ${field.field.padEnd(18)} primary=${field.primary} secondary=${field.secondary}`)
      }
    }
  }
  lines.push('')

  if (r.bloom.checked > 0) {
    lines.push(heading('3b. logsBloom verification (vs consensus, not vs the other node)'))
    lines.push('')
    lines.push(`  block-endpoint pairs  ${r.bloom.checked}`)
    lines.push(`  reproduce the header  ${r.bloom.matched}`)
    lines.push(`  FAILED                ${r.bloom.failed}`)
    for (const check of r.bloom.checks.filter((c) => !c.matches).slice(0, 10)) {
      lines.push(
        `    ${check.endpoint} block ${check.blockNumber}: ${check.logCount} logs` +
          `${check.error ? ` - ${check.error}` : ' do not reproduce the committed bloom'}`,
      )
    }
    lines.push('')
    for (const note of r.bloom.notes) lines.push(`  * ${note}`)
    lines.push('')
  }

  if (r.samplePlan !== null) {
    lines.push(heading('2. sample plan'))
    lines.push('')
    lines.push(`  seed "${r.samplePlan.seed}" (${r.samplePlan.seedNumeric})  allocation ${r.samplePlan.allocation}  floor ${r.samplePlan.minPerStratum}/stratum`)
    lines.push(`  ${r.samplePlan.windows.length} windows x ${r.samplePlan.windowBlocks.toLocaleString()} blocks`)
    lines.push('')
    lines.push(
      table(r.samplePlan.strata, [
        { header: 'day', value: (s) => s.label },
        { header: 'blocks', value: (s) => s.blocksInStratum.toLocaleString(), align: 'right' },
        { header: 'logs/blk', value: (s) => s.weight.toFixed(4), align: 'right' },
        { header: 'windows', value: (s) => String(s.windowsAllocated), align: 'right' },
        {
          header: 'coverage',
          value: (s) => `${((s.blocksCovered / s.blocksInStratum) * 100).toFixed(2)}%`,
          align: 'right',
        },
      ]),
    )
    lines.push('')
  }

  for (const target of r.targets) {
    lines.push(heading(`${target.target === 'escrow' ? '2' : '4'}. ${target.target} - ${target.address}`))
    lines.push('')
    lines.push(`  topic0(s)         ${target.topic0s.join('\n                    ')}`)
    lines.push(`  windows compared  ${target.windowsCompared}   failed ${target.windowsFailed}   MISMATCHED ${target.windowsMismatched}`)
    lines.push(`  blocks compared   ${target.blocksCompared.toLocaleString()}`)
    lines.push(`  logs primary      ${target.logsPrimary.toLocaleString()}`)
    lines.push(`  logs secondary    ${target.logsSecondary.toLocaleString()}`)
    lines.push(`  byte-identical    ${target.logsMatched.toLocaleString()}`)
    lines.push(`  mismatched logs   ${target.logMismatches.toLocaleString()} (in ${target.blockMismatches.toLocaleString()} block(s))`)
    lines.push(`  est. window logs  ~${target.estimatedPopulationLogs.toLocaleString()} (stratified estimate, not a count)`)
    lines.push('')
    for (const line of target.interpretation) {
      lines.push(`  * ${line}`)
      lines.push('')
    }
  }

  const mismatched = r.windows.filter((w) => !w.identical)
  if (mismatched.length > 0) {
    lines.push(heading('DIVERGENCES'))
    lines.push('')
    for (const w of mismatched.slice(0, 20)) {
      lines.push(`  ${w.target} ${w.fromBlock}-${w.toBlock} (${w.stratum}): ${w.error ?? `${w.countPrimary} vs ${w.countSecondary}`}`)
      if (w.diff) {
        lines.push(`    first divergence at ${w.diff.firstDivergenceKey}`)
        for (const t of w.diff.onlyInPrimary.slice(0, 5)) {
          lines.push(`    only on PRIMARY   block ${t.blockNumber} logIndex ${t.logIndex} topic0 ${t.topics[0]}`)
        }
        for (const t of w.diff.onlyInSecondary.slice(0, 5)) {
          lines.push(`    only on SECONDARY block ${t.blockNumber} logIndex ${t.logIndex} topic0 ${t.topics[0]}`)
        }
        for (const d of w.diff.fieldDivergences.slice(0, 5)) {
          lines.push(`    field ${d.field} at ${d.key}: primary=${d.primary.slice(0, 40)} secondary=${d.secondary.slice(0, 40)}`)
        }
      }
    }
    lines.push('')
  }

  lines.push(heading('5. residual risk'))
  lines.push('')
  for (const line of r.residualRisk) {
    lines.push(`  * ${line}`)
    lines.push('')
  }
  return lines.join('\n')
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), main as never)
}

export { main as runCrossVerify, SPEC as CROSS_VERIFY_SPEC }

/**
 * fee-bps-probe - verify the V2 fee rate two independent ways and report
 * whether they agree.
 *
 * WHY. config/protocol.ts pins hookFeeBps=100 and protocolFeeShareBps=3000 as
 * "verified on-chain". Phase 0's note is narrower than that: the 1%/70% split
 * is VERIFIED FOR V1 and INFERRED FOR V2. Every gate, every addressable-market
 * count and every revenue projection divides by that number, so an inference
 * sitting where a measurement should be is the highest-leverage unchecked
 * assumption in the repo.
 *
 * TWO READINGS.
 *   1. DECLARED - eth_call the fee getters on the factory, hook and any pool or
 *      curve addresses given. Whatever the contract says about itself.
 *   2. EMPIRICAL - divide the fee field of CurveBuy events by the quote-side
 *      amount, across many trades, and take the distribution.
 *
 * Agreement is the point. A getter that returns 100 while trades charge 30 is
 * a far more useful finding than either number alone, and it is invisible to a
 * tool that only does one of the two. When the two disagree, the EMPIRICAL
 * reading is the one that describes what a creator actually earns.
 */

import { decodeEventLog, decodeStaticReturn, encodeCall, functionSelector, parseEventSignature } from './lib/abi.ts'
import { buildCache } from './lib/cache.ts'
import type { ParsedValues } from './lib/cli.ts'
import { CliError, getBool, getList, getNumber, getString, isEntrypoint, runCli } from './lib/cli.ts'
import { describeConfig, loadConfig, rpcUrlsOrPlaceholder } from './lib/env.ts'
import { bps, heading, num, pct, subheading, table } from './lib/format.ts'
import { buildHttpClient } from './lib/http.ts'
import { findBlockAtOrAfter, scanLogs } from './lib/logscan.ts'
import { emit, emitDryRun, progress, type Report } from './lib/report.ts'
import { CallRevertedError, HttpChainReader } from './lib/rpc.ts'
import { histogram, quantiles, valueCounts, type Quantiles } from './lib/stats.ts'
import { SECONDS_PER_DAY } from './lib/time.ts'
import { VENUE } from '../config/protocol.ts'

const SCHEMA_VERSION = 'fee-bps-probe-1'

/** Getters worth trying. Each is (signature, return types, what it means). */
export const FEE_GETTERS: ReadonlyArray<{
  signature: string
  returns: string[]
  meaning: string
  /** Which protocol.ts constant this should equal, if any. */
  expects?: number
}> = [
  { signature: 'feeBps()', returns: ['uint256'], meaning: 'total pool fee', expects: VENUE.hookFeeBps },
  { signature: 'hookFeeBps()', returns: ['uint256'], meaning: 'base pool fee', expects: VENUE.hookFeeBps },
  { signature: 'swapFeeBps()', returns: ['uint256'], meaning: 'swap fee' },
  { signature: 'totalFeeBps()', returns: ['uint256'], meaning: 'total fee' },
  { signature: 'fee()', returns: ['uint256'], meaning: 'fee, unit unknown' },
  {
    signature: 'protocolFeeShareBps()',
    returns: ['uint256'],
    meaning: "Venue's share, taken first",
    expects: VENUE.protocolFeeShareBps,
  },
  { signature: 'protocolFeeBps()', returns: ['uint256'], meaning: 'protocol fee' },
  {
    signature: 'buybackBurnBps()',
    returns: ['uint256'],
    meaning: 'buyback slice of the remainder',
    expects: VENUE.buybackBurnBps,
  },
  { signature: 'creatorTaxBps()', returns: ['uint256'], meaning: 'per-token creator tax' },
  { signature: 'buybackEnabled()', returns: ['bool'], meaning: 'per-token buyback flag' },
  { signature: 'creatorFeeBps()', returns: ['uint256'], meaning: 'creator fee' },
] as const

/**
 * Curve trade event. Signature unverified, hence a parameter.
 *
 * TREAT THIS DEFAULT AS A GUESS, NOT A FACT. The topic census that settled the
 * escrow's two credit events (see lib/escrow.ts) found NO CurveBuy on this
 * chain. This name survives only because nothing has yet run --discover-topics
 * against the curve source to replace it, and a wrong signature scans clean and
 * decodes nothing - which is why the empirical block prints an explicit NO
 * TRADES DECODED rather than "median 0.00bps". If you get that message, the
 * signature is the first thing to doubt, not the market.
 */
export const DEFAULT_CURVE_BUY_EVENT =
  'CurveBuy(address indexed buyer, address indexed token, uint256 quoteIn, uint256 tokensOut, uint256 fee)'

const SPEC = {
  name: 'fee-bps-probe',
  summary: 'Read the V2 fee rate from contract getters AND from trades, then check they agree.',
  detail: `
    config/protocol.ts calls 1%/70% "verified on-chain". Phase 0 verified that for V1
    and INFERRED it for V2. This probes both a declared rate and an empirical one and
    returns an explicit AGREE / DISAGREE / INSUFFICIENT_DATA verdict.
  `,
  options: [
    {
      name: 'targets',
      type: 'string[]' as const,
      describe:
        'Extra contract addresses to probe (pools, curves, per-coin contracts). The factory and hook are always probed.',
    },
    {
      name: 'curve-event',
      type: 'string' as const,
      placeholder: '<signature>',
      default: DEFAULT_CURVE_BUY_EVENT,
      describe:
        'Curve trade signature used for the empirical back-out. THE DEFAULT IS UNVERIFIED: a live topic census on this chain found no CurveBuy, so expect NO TRADES DECODED until --discover-topics has settled the real name.',
    },
    {
      name: 'curve-source',
      type: 'string' as const,
      placeholder: '<address>',
      describe: 'Contract emitting CurveBuy. Defaults to the factory.',
    },
    {
      name: 'quote-field',
      type: 'string' as const,
      default: 'quoteIn',
      describe: 'Parameter holding the quote-side amount. Positional fallback is index 2.',
    },
    {
      name: 'fee-field',
      type: 'string' as const,
      default: 'fee',
      describe: 'Parameter holding the fee charged. Positional fallback is the last parameter.',
    },
    { name: 'days', type: 'number' as const, default: 7, describe: 'Days of trades to sample.' },
    {
      name: 'max-trades',
      type: 'number' as const,
      default: 20_000,
      describe: 'Stop after this many decoded trades.',
    },
    {
      name: 'tolerance-bps',
      type: 'number' as const,
      default: 1,
      describe: 'How far the declared and empirical rates may differ and still count as agreeing.',
    },
    {
      name: 'block',
      type: 'string' as const,
      default: 'latest',
      placeholder: '<number|latest>',
      describe: 'Block to eth_call the getters at.',
    },
    {
      name: 'skip-empirical',
      type: 'boolean' as const,
      describe: 'Probe getters only. The verdict then reports INSUFFICIENT_DATA by construction.',
    },
  ],
  examples: [
    'node tools/fee-bps-probe.ts --days 7',
    'node tools/fee-bps-probe.ts --targets 0xabc...,0xdef... --curve-event "CurveBuy(address indexed buyer, uint256 quoteIn, uint256 tokensOut, uint256 fee)"',
  ],
}

export type Verdict = 'AGREE' | 'DISAGREE' | 'INSUFFICIENT_DATA'

export interface GetterReading {
  target: string
  signature: string
  selector: string
  meaning: string
  ok: boolean
  rawReturn?: string
  value?: string
  expected?: number
  matchesExpected?: boolean
  error?: string
}

export interface EmpiricalReading {
  trades: number
  /**
   * fee / quoteAmount. If quoteAmount is the gross input this is the true rate;
   * if it is net of fee, this understates slightly - so both readings are given.
   */
  bpsOfGross: Quantiles
  /** fee / (quoteAmount - fee). The other reading of the same trades. */
  bpsOfNet: Quantiles
  /** Most common whole-bps value. On a fixed-rate pool this is THE rate. */
  modeBps: number | undefined
  modeShare: number
  histogram: Array<{ lower: number; upper: number; count: number; share: number }>
  zeroFeeTrades: number
  skippedZeroQuote: number
}

export interface FeeProbeResult {
  block: string
  declared: {
    readings: GetterReading[]
    /** Best available declared total fee rate, in bps. */
    totalFeeBps: number | undefined
    source: string
  }
  empirical: EmpiricalReading | undefined
  agreement: {
    verdict: Verdict
    declaredBps: number | undefined
    empiricalBps: number | undefined
    deltaBps: number | undefined
    toleranceBps: number
    reasoning: string
  }
  protocolConfigClaims: {
    hookFeeBps: number
    protocolFeeShareBps: number
    buybackBurnBps: number
  }
}

/**
 * The verdict function. Deliberately mechanical and fail-closed: absent or thin
 * evidence returns INSUFFICIENT_DATA, never a quiet AGREE.
 */
export function judgeAgreement(options: {
  declaredBps: number | undefined
  empiricalBps: number | undefined
  trades: number
  toleranceBps: number
  minTrades?: number
}): FeeProbeResult['agreement'] {
  const minTrades = options.minTrades ?? 100
  const base = { declaredBps: options.declaredBps, empiricalBps: options.empiricalBps, toleranceBps: options.toleranceBps }

  if (options.declaredBps === undefined) {
    return {
      ...base,
      deltaBps: undefined,
      verdict: 'INSUFFICIENT_DATA',
      reasoning:
        'No fee getter on any probed target returned data. The declared rate is unavailable, so protocol.ts\'s hookFeeBps remains an INFERENCE for V2.',
    }
  }
  if (options.empiricalBps === undefined) {
    return {
      ...base,
      deltaBps: undefined,
      verdict: 'INSUFFICIENT_DATA',
      reasoning: 'No trades were decoded, so there is nothing to check the getter against.',
    }
  }
  if (options.trades < minTrades) {
    return {
      ...base,
      deltaBps: Math.abs(options.declaredBps - options.empiricalBps),
      verdict: 'INSUFFICIENT_DATA',
      reasoning: `Only ${options.trades} trades decoded; ${minTrades} are required before an empirical rate is treated as a measurement.`,
    }
  }
  const delta = Math.abs(options.declaredBps - options.empiricalBps)
  if (delta <= options.toleranceBps) {
    return {
      ...base,
      deltaBps: delta,
      verdict: 'AGREE',
      reasoning: `Declared ${options.declaredBps}bps and empirical ${options.empiricalBps.toFixed(2)}bps differ by ${delta.toFixed(2)}bps, within the ${options.toleranceBps}bps tolerance, across ${options.trades} trades.`,
    }
  }
  return {
    ...base,
    deltaBps: delta,
    verdict: 'DISAGREE',
    reasoning:
      `Declared ${options.declaredBps}bps but trades charge ${options.empiricalBps.toFixed(2)}bps - a ${delta.toFixed(2)}bps gap over ${options.trades} trades. ` +
      `Use the EMPIRICAL rate for anything a creator's earnings depend on, and treat every figure derived from ${options.declaredBps}bps as wrong by ${(options.declaredBps / options.empiricalBps).toFixed(2)}x.`,
  }
}

async function main(values: ParsedValues): Promise<void> {
  const config = loadConfig()
  const json = getBool(values, 'json')
  const dryRun = getBool(values, 'dry-run')
  const verbose = getBool(values, 'verbose')
  const outPath = getString(values, 'out')

  const targets = [
    VENUE.contracts.v2Factory.toLowerCase(),
    VENUE.contracts.v2MemeHook.toLowerCase(),
    ...getList(values, 'targets').map((t) => t.toLowerCase()),
  ]
  const curveSpec = parseEventSignature(getString(values, 'curve-event') ?? DEFAULT_CURVE_BUY_EVENT)
  const curveSource = (getString(values, 'curve-source') ?? VENUE.contracts.v2Factory).toLowerCase()
  const days = getNumber(values, 'days', 7)
  const toleranceBps = getNumber(values, 'tolerance-bps', 1)
  const skipEmpirical = getBool(values, 'skip-empirical')

  const http = buildHttpClient({
    requestsPerSecond: config.requestsPerSecond,
    maxRetries: config.maxRetries,
    timeoutMs: config.requestTimeoutMs,
    onRetry: (attempt, delay, reason) => progress(verbose, `retry ${attempt} in ${delay}ms: ${reason}`),
  })
  const cache = buildCache(config.cacheDir, getBool(values, 'no-cache'))
  const reader = new HttpChainReader(http, rpcUrlsOrPlaceholder(config, dryRun))

  if (dryRun) {
    const estimatedBlocks = Math.ceil((days * SECONDS_PER_DAY) / config.estimatedBlockTimeSeconds)
    const chunks = Math.ceil(estimatedBlocks / config.logChunkBlocks)
    emitDryRun(
      {
        tool: SPEC.name,
        config: {
          ...describeConfig(config),
          targets,
          getters: FEE_GETTERS.map((g) => `${g.signature} -> ${functionSelector(g.signature)}`),
          curveEvent: curveSpec.canonical,
          curveTopic0: curveSpec.topic0,
          curveSource,
        },
        steps: [
          {
            description: `eth_call ${FEE_GETTERS.length} getters against ${targets.length} targets`,
            estimatedRequests: FEE_GETTERS.length * targets.length,
          },
          ...(skipEmpirical
            ? []
            : [
                {
                  description: `eth_getLogs ${curveSpec.name} from ${curveSource} over ~${estimatedBlocks.toLocaleString()} blocks`,
                  estimatedRequests: chunks,
                },
              ]),
        ],
        estimatedRequestsTotal: FEE_GETTERS.length * targets.length + (skipEmpirical ? 0 : chunks),
        notes: [
          'A reverting getter is expected and is not an error: it means the contract does not expose that name.',
          `protocol.ts claims hookFeeBps=${VENUE.hookFeeBps}, protocolFeeShareBps=${VENUE.protocolFeeShareBps}, buybackBurnBps=${VENUE.buybackBurnBps}.`,
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

  const blockArg = getString(values, 'block') ?? 'latest'
  const block: bigint | 'latest' = blockArg === 'latest' ? 'latest' : BigInt(blockArg)

  // --- reading 1: declared ------------------------------------------------
  const readings: GetterReading[] = []
  for (const target of targets) {
    for (const getter of FEE_GETTERS) {
      const selector = functionSelector(getter.signature)
      try {
        const raw = await reader.call(target, encodeCall(getter.signature), block)
        if (raw === '0x' || raw.length < 66) {
          readings.push({
            target,
            signature: getter.signature,
            selector,
            meaning: getter.meaning,
            ok: false,
            error: `empty return (${raw}) - no such function`,
          })
          continue
        }
        const [decoded] = decodeStaticReturn(getter.returns, raw)
        const value = typeof decoded === 'bigint' ? decoded.toString() : String(decoded)
        readings.push({
          target,
          signature: getter.signature,
          selector,
          meaning: getter.meaning,
          ok: true,
          rawReturn: raw,
          value,
          ...(getter.expects !== undefined
            ? { expected: getter.expects, matchesExpected: value === String(getter.expects) }
            : {}),
        })
      } catch (error) {
        readings.push({
          target,
          signature: getter.signature,
          selector,
          meaning: getter.meaning,
          ok: false,
          error:
            error instanceof CallRevertedError
              ? 'reverted (function absent)'
              : error instanceof Error
                ? error.message
                : String(error),
        })
      }
    }
  }

  const declaredTotal = pickDeclaredTotalFeeBps(readings)

  // --- reading 2: empirical ----------------------------------------------
  let empirical: EmpiricalReading | undefined
  if (!skipEmpirical) {
    const latest = await reader.getBlockHeader('latest')
    const fromUnix = latest.timestampUnix - days * SECONDS_PER_DAY
    const fromBlock = await findBlockAtOrAfter(reader, fromUnix, { low: 1n, high: latest.number })
    const logs = await scanLogs(reader, {
      address: curveSource,
      topics: [curveSpec.topic0],
      fromBlock,
      toBlock: latest.number,
      chunkBlocks: config.logChunkBlocks,
      cache,
      onProgress: (info) => progress(verbose, `trades ${info.fromBlock}-${info.toBlock}: ${info.logs}`),
    })
    empirical = backOutFeeRate(curveSpec, logs, {
      quoteField: getString(values, 'quote-field') ?? 'quoteIn',
      feeField: getString(values, 'fee-field') ?? 'fee',
      maxTrades: Math.floor(getNumber(values, 'max-trades', 20_000)),
    })
  }

  const empiricalBps = empirical?.modeBps ?? empirical?.bpsOfGross.median
  const agreement = judgeAgreement({
    declaredBps: declaredTotal.bps,
    empiricalBps,
    trades: empirical?.trades ?? 0,
    toleranceBps,
  })

  const result: FeeProbeResult = {
    block: block === 'latest' ? 'latest' : block.toString(),
    declared: { readings, totalFeeBps: declaredTotal.bps, source: declaredTotal.source },
    empirical,
    agreement,
    protocolConfigClaims: {
      hookFeeBps: VENUE.hookFeeBps,
      protocolFeeShareBps: VENUE.protocolFeeShareBps,
      buybackBurnBps: VENUE.buybackBurnBps,
    },
  }

  const warnings: string[] = []
  if (agreement.verdict === 'DISAGREE') {
    warnings.push(
      `DECLARED AND EMPIRICAL RATES DISAGREE. ${agreement.reasoning} Every QF-to-volume conversion in this repo divides by this number.`,
    )
  }
  if (agreement.verdict === 'INSUFFICIENT_DATA') {
    warnings.push(
      `The V2 fee rate remains UNVERIFIED after this run: ${agreement.reasoning} config/protocol.ts still describes hookFeeBps=${VENUE.hookFeeBps} as verified; for V2 it is an inference.`,
    )
  }
  const mismatched = readings.filter((r) => r.matchesExpected === false)
  if (mismatched.length > 0) {
    warnings.push(
      `${mismatched.length} getter(s) returned a value different from config/protocol.ts: ` +
        mismatched.map((r) => `${r.target.slice(0, 10)}..${r.signature}=${r.value} (config says ${r.expected})`).join('; ') +
        '. config/protocol.ts is owned by another track - report this rather than editing it.',
    )
  }
  if (empirical !== undefined && empirical.modeShare < 0.8 && empirical.trades > 0) {
    warnings.push(
      `The empirical rate is not a single fixed number: the modal ${empirical.modeBps}bps covers only ${pct(empirical.modeShare)} of trades. Either the fee is tiered, or the quote/fee field mapping is wrong. Check --quote-field and --fee-field.`,
    )
  }

  const report: Report<FeeProbeResult> = {
    meta: {
      tool: SPEC.name,
      schemaVersion: SCHEMA_VERSION,
      generatedAtUnix: Math.floor(Date.now() / 1000),
      config: { ...describeConfig(config), targets, curveEvent: curveSpec.canonical },
      io: { httpRequests: http.requestCount, cacheHits: cache.hits, cacheMisses: cache.misses },
      warnings,
      methodLimits: [
        'A reverting getter proves only that the NAME is absent. A contract can charge a fee it does not expose, which is exactly why the empirical reading exists.',
        'The empirical rate assumes the CurveBuy quote field is the gross input. Both readings (of gross and of net) are reported; if they straddle the declared rate, the field mapping is the ambiguity, not the rate.',
        'Pre-graduation curve trades and post-graduation pool swaps can carry different rates. This samples the curve event only.',
        'Getters are read at a single block. A rate changed by governance mid-window is invisible here.',
      ],
    },
    result,
  }

  await emit(report, { json, outPath, human: (r) => renderHuman(r.result) })
}

/** Prefer the most specific declared total-fee getter that actually answered. */
export function pickDeclaredTotalFeeBps(readings: readonly GetterReading[]): {
  bps: number | undefined
  source: string
} {
  const order = ['hookFeeBps()', 'feeBps()', 'totalFeeBps()', 'swapFeeBps()', 'fee()']
  for (const signature of order) {
    const hit = readings.find((r) => r.ok && r.signature === signature && r.value !== undefined)
    if (hit?.value !== undefined) {
      const value = Number(hit.value)
      if (Number.isFinite(value)) return { bps: value, source: `${hit.target} ${signature}` }
    }
  }
  return { bps: undefined, source: 'no getter answered' }
}

/** Divide the fee field by the quote-side amount across many trades. */
export function backOutFeeRate(
  spec: ReturnType<typeof parseEventSignature>,
  logs: ReadonlyArray<{ topics: string[]; data: string }>,
  options: { quoteField: string; feeField: string; maxTrades: number },
): EmpiricalReading {
  const grossBps: number[] = []
  const netBps: number[] = []
  let zeroFee = 0
  let skippedZeroQuote = 0

  for (const log of logs) {
    if (grossBps.length >= options.maxTrades) break
    let decoded
    try {
      decoded = decodeEventLog(spec, log.topics, log.data)
    } catch {
      continue
    }
    const quoteRaw =
      options.quoteField in decoded.byName ? decoded.byName[options.quoteField] : decoded.values[2]
    const feeRaw =
      options.feeField in decoded.byName
        ? decoded.byName[options.feeField]
        : decoded.values[decoded.values.length - 1]
    if (typeof quoteRaw !== 'bigint' || typeof feeRaw !== 'bigint') continue
    if (quoteRaw <= 0n) {
      skippedZeroQuote++
      continue
    }
    if (feeRaw === 0n) zeroFee++

    // Scaled integer division keeps 4 decimals of a bps without a float divide.
    grossBps.push(Number((feeRaw * 10_000_000_000n) / quoteRaw) / 1e6)
    const net = quoteRaw - feeRaw
    if (net > 0n) netBps.push(Number((feeRaw * 10_000_000_000n) / net) / 1e6)
  }

  const rounded = grossBps.map((v) => Math.round(v))
  const counts = valueCounts(rounded)
  const top = counts[0]

  return {
    trades: grossBps.length,
    bpsOfGross: quantiles(grossBps),
    bpsOfNet: quantiles(netBps),
    modeBps: typeof top?.value === 'number' ? top.value : undefined,
    modeShare: top?.share ?? 0,
    histogram: histogram(grossBps, [0, 1, 5, 10, 25, 30, 50, 70, 100, 150, 200, 500, 10_000]),
    zeroFeeTrades: zeroFee,
    skippedZeroQuote,
  }
}

function renderHuman(result: FeeProbeResult): string {
  const lines: string[] = []
  lines.push(heading(`VERDICT: ${result.agreement.verdict}`))
  lines.push(`  ${result.agreement.reasoning}`)
  lines.push('')
  lines.push(`  declared  : ${result.declared.totalFeeBps === undefined ? 'n/a' : bps(result.declared.totalFeeBps)}  (${result.declared.source})`)
  lines.push(
    `  empirical : ${result.agreement.empiricalBps === undefined ? 'n/a' : bps(result.agreement.empiricalBps)}  (${result.empirical?.trades ?? 0} trades)`,
  )
  lines.push(
    `  protocol.ts claims: hookFeeBps=${result.protocolConfigClaims.hookFeeBps}, protocolFeeShareBps=${result.protocolConfigClaims.protocolFeeShareBps}, buybackBurnBps=${result.protocolConfigClaims.buybackBurnBps}`,
  )

  lines.push(subheading('Declared: getters that answered'))
  const answered = result.declared.readings.filter((r) => r.ok)
  lines.push(
    answered.length === 0
      ? '  (none - every getter reverted or returned empty)'
      : table(answered, [
          { header: 'target', value: (r) => `${r.target.slice(0, 10)}..` },
          { header: 'getter', value: (r) => r.signature },
          { header: 'value', value: (r) => r.value ?? '', align: 'right' },
          { header: 'config expects', value: (r) => (r.expected === undefined ? '-' : String(r.expected)), align: 'right' },
          {
            header: 'match',
            value: (r) => (r.matchesExpected === undefined ? '-' : r.matchesExpected ? 'yes' : 'NO'),
          },
          { header: 'meaning', value: (r) => r.meaning },
        ]),
  )
  const absent = result.declared.readings.filter((r) => !r.ok).length
  lines.push(`  ${absent} getter/target pairs returned nothing (expected: absent functions revert).`)

  if (result.empirical !== undefined) {
    const e = result.empirical
    lines.push(subheading('Empirical: fee / quote amount across trades'))
    if (e.trades === 0) {
      // quantiles([]) is all zeros. Printing "median 0.00bps" here says the
      // trades charge nothing, which is a claim about the protocol; the truth
      // is that no trade was decoded. Same defect as a gate count over unpriced
      // amounts, and the verdict above already reads INSUFFICIENT_DATA.
      lines.push(
        `  NO TRADES DECODED. There is no empirical rate: not 0bps, not any bps. ${e.skippedZeroQuote} log(s) were skipped for a zero quote amount.`,
      )
      lines.push(
        '  Check --curve-event, --curve-source and --quote-field/--fee-field before reading the declared rate as confirmed.',
      )
    } else {
      lines.push(
        `  trades ${e.trades}   modal rate ${e.modeBps ?? 'n/a'}bps covering ${pct(e.modeShare)} of them   zero-fee trades ${e.zeroFeeTrades}`,
      )
      lines.push(
        `  as bps of GROSS quote: median ${num(e.bpsOfGross.median, 2)}  p10 ${num(e.bpsOfGross.p10, 2)}  p90 ${num(e.bpsOfGross.p90, 2)}`,
      )
      lines.push(
        e.bpsOfNet.count === 0
          ? '  as bps of NET quote  : n/a (no trade had a positive quote net of its fee)'
          : `  as bps of NET quote  : median ${num(e.bpsOfNet.median, 2)}  p10 ${num(e.bpsOfNet.p10, 2)}  p90 ${num(e.bpsOfNet.p90, 2)}`,
      )
      lines.push('')
      lines.push(
        table(e.histogram.filter((b) => b.count > 0), [
          { header: 'bps range', value: (b) => `${b.lower} - ${b.upper}` },
          { header: 'trades', value: (b) => String(b.count), align: 'right' },
          { header: 'share', value: (b) => pct(b.share, 1), align: 'right' },
          { header: '', value: (b) => '#'.repeat(Math.round(b.share * 40)) },
        ]),
      )
    }
  }
  return lines.join('\n')
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), main)
}

export { SPEC as FEE_BPS_PROBE_SPEC }

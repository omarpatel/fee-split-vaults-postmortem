/**
 * eligibility - one address in, one decisive answer out.
 *
 * "Is this coin eligible, which tier, is it winnable, and if not why not" is the
 * question an operator asks constantly, and until now there was no way to ask
 * it. prospects.ts answers it for the whole standing population at once, which
 * is the wrong shape for a single lookup: it reads a 34MB artifact and a
 * hundred-odd pools to answer a question about one token.
 *
 * WHAT MAKES THIS DECISIVE RATHER THAN INFORMATIVE. Every section ends in a
 * verdict word, and the verdict words are disjoint:
 *
 *   ELIGIBLE / BELOW GATE / NOT MEASURED   - the money question
 *   T0..T3 / NONE                          - the tier actually granted
 *   WINNABLE / LOCKED / UNKNOWN            - whether it can be signed at all
 *
 * NOT MEASURED and UNKNOWN are first-class answers here, not failures to answer.
 * A coin that has never appeared in the measurement window has no QF - it does
 * not have a QF of zero - and a tool that prints $0.00 for it is lying about a
 * coin it has simply never seen. The distinction matters most for exactly the
 * coins an operator is most likely to type in: new ones.
 *
 * WHAT IS LIVE. Everything that decides winnability: the hook's launches()
 * record, eth_getCode on the recipient, the implementation behind any proxy, and
 * the exit-selector scan on both. QF and days-held come from the full-history
 * artifact and are labelled with its window.
 *
 * The contact block is ATTACKER-AUTHORED text from the token contract. It is
 * rendered inert and never reaches a model. See lib/prospects.ts.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { VENUE, TERMS, TIERS, TIER_ORDER, type TierId } from '../config/protocol.ts'
import { functionSelector } from './lib/abi.ts'
import { buildCache } from './lib/cache.ts'
import type { ParsedValues } from './lib/cli.ts'
import { CliError, getBool, getNumber, getString, isEntrypoint, runCli } from './lib/cli.ts'
import { TOOLS_DIR, describeConfig, loadConfig, rpcUrlsOrPlaceholder } from './lib/env.ts'
import { banner, heading, num, pct, subheading, usd } from './lib/format.ts'
import { buildHttpClient } from './lib/http.ts'
import { parseJson } from './lib/json.ts'
import {
  assessWinnability,
  buildContactSurface,
  classifyRecipient,
  creatorRateFor,
  decodeLaunchRecord,
  decodeSingleString,
  decodeStringTuple,
  gateSpell,
  grantTier,
  isSignable,
  KNOWN_DISTRIBUTORS,
  LAUNCHES_SELECTOR,
  restrictedMeanResidualDays,
  scanExitPath,
  trailingMedianSeries,
  type ContactSurface,
  type ExitMode,
  type LaunchRecord,
} from './lib/prospects.ts'
import { emit, emitDryRun, progress, type Report } from './lib/report.ts'
import { HttpChainReader, supportsCode } from './lib/rpc.ts'
import type { SurvivalPoint } from './lib/stats.ts'
import { TokenMetadataResolver } from './lib/token-metadata.ts'
import { isoDate } from './lib/time.ts'

const SCHEMA_VERSION = 'eligibility-1'
const ARTIFACTS = join(TOOLS_DIR, 'artifacts')

const DEFAULTS = {
  gateRows: join(ARTIFACTS, 't1-final-rows.json'),
  allCoinRows: join(ARTIFACTS, '.pool-coin-rows.json'),
  history: join(ARTIFACTS, 'full', 'full-history-reduced-doc.json'),
  tenure: join(ARTIFACTS, 'full', 'tenure-full-median7.json'),
  poolJoin: join(ARTIFACTS, 'join-pool-to-token.json'),
}

const SPEC = {
  name: 'eligibility',
  summary: 'One token or recipient address in; eligible / which tier / winnable / why not, out.',
  detail: `
    The single-coin query. Reads the hook's live launch record for the token, the
    runtime code of whoever currently receives its creator fees, and the exit
    selectors in that code, then answers the four questions an operator asks
    before spending a minute on a coin.
    Pass --token for a memecoin. Pass --recipient to ask the question from the
    other end: which gate-clearing coins does this address hold, and can any of
    them be moved.
    Absent measurement is reported as NOT MEASURED, never as zero.
  `,
  options: [
    {
      name: 'token',
      type: 'string' as const,
      placeholder: '<0x...>',
      describe: 'Memecoin address to interrogate.',
    },
    {
      name: 'recipient',
      type: 'string' as const,
      placeholder: '<0x...>',
      describe: 'Creator-fee recipient address to interrogate, instead of a token.',
    },
    {
      name: 'exit-mode',
      type: 'string' as const,
      default: 'strict',
      placeholder: '<strict|broad>',
      describe:
        'strict counts a contract winnable only on a direct transfer function; broad also counts a generic arbitrary-call hatch.',
    },
    {
      name: 'operator-bps',
      type: 'number' as const,
      default: TERMS.operatorBps,
      describe: 'Operator take of QF, in bps, for the economics block.',
    },
    {
      name: 'contact',
      type: 'boolean' as const,
      default: true,
      describe: 'Read the token socials()/description()/logo(). UNTRUSTED text.',
    },
    {
      name: 'gate-rows',
      type: 'string' as const,
      placeholder: '<file>',
      default: DEFAULTS.gateRows,
      describe: 'Gate-clearing coin artifact, consulted first for QF.',
    },
    {
      name: 'all-coin-rows',
      type: 'string' as const,
      placeholder: '<file>',
      default: DEFAULTS.allCoinRows,
      describe: 'Wider coin-level QF artifact, consulted when the coin is not at the gate.',
    },
    {
      name: 'history',
      type: 'string' as const,
      placeholder: '<file>',
      default: DEFAULTS.history,
      describe: 'Full-history document, for the daily series behind days-held.',
    },
    {
      name: 'tenure',
      type: 'string' as const,
      placeholder: '<file>',
      default: DEFAULTS.tenure,
      describe: 'tenure.ts output, for expected remaining days.',
    },
    {
      name: 'pool-join',
      type: 'string' as const,
      placeholder: '<file>',
      default: DEFAULTS.poolJoin,
      describe: 'pool -> token join.',
    },
    {
      name: 'no-history',
      type: 'boolean' as const,
      describe:
        'Skip the 34MB daily-series read. Faster, and days-held becomes NOT MEASURED rather than a number.',
    },
  ],
  examples: [
    'node tools/eligibility.ts --token 0x767d56c74d762b9a317f5eef46653397031830b1',
    'node tools/eligibility.ts --recipient 0x3a3e6be1e8be67a4e2e7e2e815a66ba03a27f5d4',
    'node tools/eligibility.ts --token 0x694fbee190b5d81b794c8d28f00c65b6982f066d --json',
  ],
}

interface GateRow {
  coin: string
  median7?: number
  total7?: number
  cr?: number
  pr?: number
  dom?: string
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

function requireAddress(raw: string, flag: string): string {
  const trimmed = raw.trim()
  if (!ADDRESS.test(trimmed)) {
    throw new CliError(
      `--${flag} must be a 20-byte hex address, got "${raw}". ` +
        'Venue pool ids are bytes32 and are not accepted here; pass the token address.',
    )
  }
  return trimmed.toLowerCase()
}

async function maybeRead<T>(path: string): Promise<T | null> {
  try {
    return parseJson<T>(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function main(values: ParsedValues): Promise<void> {
  const config = loadConfig()
  const json = getBool(values, 'json')
  const verbose = getBool(values, 'verbose')
  const outPath = getString(values, 'out')
  const dryRun = getBool(values, 'dry-run')

  const tokenRaw = getString(values, 'token')
  const recipientRaw = getString(values, 'recipient')
  if ((tokenRaw === undefined) === (recipientRaw === undefined)) {
    throw new CliError('pass exactly one of --token or --recipient. Try --help.')
  }
  const exitModeRaw = getString(values, 'exit-mode') ?? 'strict'
  if (exitModeRaw !== 'strict' && exitModeRaw !== 'broad') {
    throw new CliError('--exit-mode must be "strict" or "broad"')
  }
  const exitMode: ExitMode = exitModeRaw
  const operatorBps = getNumber(values, 'operator-bps', TERMS.operatorBps)
  const wantContact = values.contact !== false
  const wantHistory = !getBool(values, 'no-history')

  const gateRowsPath = getString(values, 'gate-rows') ?? DEFAULTS.gateRows
  const allCoinRowsPath = getString(values, 'all-coin-rows') ?? DEFAULTS.allCoinRows
  const historyPath = getString(values, 'history') ?? DEFAULTS.history
  const tenurePath = getString(values, 'tenure') ?? DEFAULTS.tenure
  const poolJoinPath = getString(values, 'pool-join') ?? DEFAULTS.poolJoin

  if (dryRun) {
    emitDryRun(
      {
        tool: SPEC.name,
        config: {
          ...describeConfig(config),
          subject: tokenRaw ?? recipientRaw,
          subjectKind: tokenRaw !== undefined ? 'token' : 'recipient',
          exitMode,
          operatorBps,
        },
        steps: [
          { description: 'read the coin-level QF artifacts (no network I/O)' },
          { description: 'eth_call hook.launches(poolId) for the subject pool(s)', estimatedRequests: 1 },
          { description: 'eth_getCode the live creator-fee recipient', estimatedRequests: 1 },
          { description: 'resolve the implementation behind any proxy and read its code', estimatedRequests: 2 },
          { description: 'resolve token symbol/name', estimatedRequests: 1 },
          ...(wantContact
            ? [{ description: 'eth_call socials()/description()/logo() (UNTRUSTED)', estimatedRequests: 1 }]
            : []),
        ],
        estimatedRequestsTotal: wantContact ? 7 : 6,
        notes: [
          'Winnability is always derived live. There is no offline mode here: a stale recipient is the one error this query must never make.',
          ...(config.rpcUrls.length === 0 ? ['VENUE_RPC_URL is UNSET; a real run will refuse to start.'] : []),
        ],
      },
      json,
    )
    return
  }

  if (config.rpcUrls.length === 0) {
    throw new CliError(
      'VENUE_RPC_URL is unset. This query is answered live and has no offline mode - a stale creator-fee\n' +
        '  recipient is the one error it must never make.\n' +
        '  export VENUE_RPC_URL=https://rpc.mainnet.chain.robinhood.com',
    )
  }

  const warnings: string[] = []
  const methodLimits: string[] = []

  // -------------------------------------------------------------------------
  // Artifacts (all optional - their absence degrades to NOT MEASURED)
  // -------------------------------------------------------------------------
  const gateRows = (await maybeRead<GateRow[]>(gateRowsPath)) ?? []
  const allCoinRows = (await maybeRead<GateRow[]>(allCoinRowsPath)) ?? []
  const poolJoin = await maybeRead<{ poolToToken: Record<string, string> }>(poolJoinPath)
  if (poolJoin === null) {
    throw new CliError(
      `the pool -> token join at ${poolJoinPath} is required to find this token's pool.\n` +
        '  Produce it with:  node tools/artifacts/scan-join-events.mjs',
    )
  }
  const tenureDoc = await maybeRead<{
    result: { gates: Array<{ id: string; survival?: { points?: SurvivalPoint[]; restrictedToDays?: number } }> }
  }>(tenurePath)

  const poolsByToken = new Map<string, string[]>()
  for (const [pool, token] of Object.entries(poolJoin.poolToToken ?? {})) {
    const key = token.toLowerCase()
    const list = poolsByToken.get(key)
    if (list) list.push(pool)
    else poolsByToken.set(key, [pool])
  }

  const qfByCoin = new Map<string, GateRow>()
  for (const row of allCoinRows) qfByCoin.set(row.coin.toLowerCase(), row)
  // Gate rows win: they are the corrected, attributed figures.
  for (const row of gateRows) qfByCoin.set(row.coin.toLowerCase(), row)

  // -------------------------------------------------------------------------
  // Chain
  // -------------------------------------------------------------------------
  const http = buildHttpClient({
    requestsPerSecond: config.requestsPerSecond,
    maxRetries: config.maxRetries,
    timeoutMs: config.requestTimeoutMs,
    onRetry: (attempt, delay, reason) => progress(verbose, `retry ${attempt} in ${delay}ms: ${reason}`),
  })
  const cache = buildCache(config.cacheDir, getBool(values, 'no-cache'))
  const reader = new HttpChainReader(http, rpcUrlsOrPlaceholder(config, false))
  const chainId = await reader.chainId()
  if (chainId !== VENUE.chainId) {
    throw new CliError(`connected to chain ${chainId}, expected Venue ${VENUE.chainId}.`)
  }
  const headBlock = await reader.blockNumber()
  if (!supportsCode(reader)) throw new CliError('the configured reader cannot fetch runtime code')

  // -------------------------------------------------------------------------
  // Resolve the subject to a set of coins
  // -------------------------------------------------------------------------
  let coins: string[]
  let subjectKind: 'token' | 'recipient'
  let subject: string
  if (tokenRaw !== undefined) {
    subjectKind = 'token'
    subject = requireAddress(tokenRaw, 'token')
    coins = [subject]
  } else {
    subjectKind = 'recipient'
    subject = requireAddress(recipientRaw!, 'recipient')
    // Which coins does this address receive for? The artifact's `dom` is the
    // observed dominant recipient; the live launches() read below confirms or
    // refutes each one, so a stale artifact costs us a wasted call, not a wrong
    // answer.
    coins = [...new Set([...gateRows, ...allCoinRows].filter((r) => r.dom?.toLowerCase() === subject).map((r) => r.coin.toLowerCase()))]
    if (coins.length === 0) {
      warnings.push(
        `no coin in the artifacts records ${subject} as its dominant creator-fee recipient. That is not proof it holds none: ` +
          'the artifacts cover the measurement window and coins that moved to this address afterwards will not appear. ' +
          'Ask about a specific token with --token to get a live answer.',
      )
    }
  }

  progress(verbose, `subject ${subjectKind} ${subject}; ${coins.length} candidate coin(s)`)

  // -------------------------------------------------------------------------
  // Live launch records
  // -------------------------------------------------------------------------
  const launchByCoin = new Map<string, LaunchRecord>()
  const poolsRead: string[] = []
  for (const coin of coins) {
    const pools = poolsByToken.get(coin) ?? []
    for (const pool of pools) {
      let raw: string
      try {
        raw = await reader.call(VENUE.contracts.v2MemeHook, LAUNCHES_SELECTOR + pool.slice(2))
      } catch {
        continue
      }
      poolsRead.push(pool)
      const record = decodeLaunchRecord(raw)
      if (record === null || !record.registered) continue
      // Layout control: field [2] must be the coin we joined this pool to.
      if (record.memecoin !== coin) continue
      if (!launchByCoin.has(coin)) launchByCoin.set(coin, record)
    }
    if (!launchByCoin.has(coin) && pools.length === 0) {
      warnings.push(
        `no pool for ${coin} appears in ${poolJoinPath}. Either it has not graduated to a pool yet, or the join ` +
          'artifact predates its launch. Its live recipient could not be read and is reported as NOT MEASURED.',
      )
    }
  }

  // -------------------------------------------------------------------------
  // Classify the recipients
  // -------------------------------------------------------------------------
  const findings: Array<{
    coin: string
    launch: LaunchRecord | null
    recipientClass: string
    recipientCodeSize: number | null
    resolvedImplementation: string | null
    exitSelectors: string[]
    verdict: string
    winnable: boolean | null
    reason: string
    route: string | null
    holderId: string | null
    holderNote: string | null
    symbol: string | null
    name: string | null
    quoteSymbol: string | null
    qfPerDayUsd: number | null
    qfSource: string
    tierGranted: string | null
    tierMoneyQualifies: string | null
    daysShortOfMoneyTier: number | null
    daysAtGate: number | null
    currentSpellDays: number | null
    expectedRemainingDays: number | null
    creatorNetBps: number | null
    creatorRatePct: number | null
    buybackEnabled: boolean | null
    creatorTaxBps: number | null
    impliedVolumePerDayUsd: number | null
    operatorPerDayUsd: number | null
    recipientMovedSinceWindow: boolean | null
    contact: ContactSurface | null
  }> = []

  const knownBeacons = KNOWN_DISTRIBUTORS.map((d) => d.beacon)
  const selImplementation = functionSelector('implementation()')

  // History series, read once and only if some coin needs it.
  let seriesByRecipient: Map<string, Array<number | null>> | null = null
  let historyWindowLabel = 'NOT READ'
  const loadHistory = async (): Promise<Map<string, Array<number | null>>> => {
    if (seriesByRecipient !== null) return seriesByRecipient
    seriesByRecipient = new Map()
    const doc = await maybeRead<{
      result: { recipients: Array<{ recipient: string; days: Array<{ dateUtc: string; usd: number | null }> }> }
    }>(historyPath)
    if (doc === null) {
      warnings.push(
        `the full-history document at ${historyPath} could not be read, so days-held is NOT MEASURED rather than a number.`,
      )
      return seriesByRecipient
    }
    let first = ''
    let last = ''
    for (const rec of doc.result?.recipients ?? []) {
      seriesByRecipient.set(
        rec.recipient.toLowerCase(),
        rec.days.map((d) => (typeof d.usd === 'number' ? d.usd : null)),
      )
      if (first === '' && rec.days.length > 0) {
        first = rec.days[0]!.dateUtc
        last = rec.days[rec.days.length - 1]!.dateUtc
      }
    }
    historyWindowLabel = `${first}..${last}`
    return seriesByRecipient
  }

  for (const coin of coins) {
    const launch = launchByCoin.get(coin) ?? null
    const recipient = launch?.creatorFeeRecipient ?? null

    let cls = classifyRecipient(recipient ?? coin, null, knownBeacons)
    let implementation: string | null = null
    let exit = scanExitPath(null, null)
    if (recipient !== null) {
      const code = await reader.getCode(recipient)
      cls = classifyRecipient(recipient, code, knownBeacons)
      if (!isSignable(cls.cls)) {
        // Chase the implementation: a clone carries it inline, a beacon proxy
        // carries the beacon and must be asked.
        if (cls.implementation !== null) {
          implementation = cls.implementation
        } else {
          const candidates = cls.beacon !== null ? [cls.beacon] : cls.addressWords
          for (const candidate of candidates) {
            try {
              const raw = await reader.call(candidate, selImplementation)
              if (raw.length === 66 && !/^0x0+$/.test(raw)) {
                implementation = `0x${raw.slice(26)}`.toLowerCase()
                break
              }
            } catch {
              // A candidate that is not a beacon reverts. Expected, not an error.
            }
          }
        }
        const implCode = implementation === null ? null : await reader.getCode(implementation)
        exit = scanExitPath(code, implCode)
      } else {
        exit = { hits: [], hasDirect: false, hasGeneric: false, scanned: true }
      }
    }

    const assessment =
      recipient === null
        ? {
            verdict: 'UNKNOWN' as const,
            winnable: null,
            reason:
              'no live launches() record could be read for this token, so its creator-fee recipient is NOT MEASURED. ' +
              'This is not "no recipient" and it is certainly not "winnable".',
            holder: null,
            route: null,
          }
        : assessWinnability({ classification: cls, exit, resolvedImplementation: implementation, mode: exitMode })

    // Money
    const qfRow = qfByCoin.get(coin)
    const qf = typeof qfRow?.median7 === 'number' && Number.isFinite(qfRow.median7) ? qfRow.median7 : null
    const qfSource =
      qfRow === undefined
        ? `NOT MEASURED - ${coin} does not appear in ${gateRowsPath} or ${allCoinRowsPath}`
        : gateRows.some((r) => r.coin.toLowerCase() === coin)
          ? `gate artifact ${gateRowsPath} (trailing-7-day median, coin leg)`
          : `wider coin artifact ${allCoinRowsPath} (trailing-7-day median, coin leg)`

    // Days held, on the recipient leg
    let daysAtGate: number | null = null
    let currentSpellDays: number | null = null
    if (wantHistory) {
      const series = await loadHistory()
      const measured = (qfRow?.dom ?? recipient ?? '').toLowerCase()
      const daily = measured === '' ? undefined : series.get(measured)
      if (daily !== undefined) {
        const spell = gateSpell(trailingMedianSeries(daily, 7), TIERS.T1.gateQfPerDay)
        daysAtGate = spell.daysAtGate
        currentSpellDays = spell.currentSpellDays
      }
    }

    const tierList = TIER_ORDER.map((id) => TIERS[id]).map((t) => ({
      id: t.id,
      gateQfPerDay: t.gateQfPerDay,
      sustainedDays: t.sustainedDays,
    }))
    const grant =
      currentSpellDays === null
        ? { granted: null, moneyQualifies: grantTier(qf, Number.MAX_SAFE_INTEGER, tierList).moneyQualifies, daysShortOfMoneyTier: null }
        : grantTier(qf, currentSpellDays, tierList)

    const tierForCosts = TIERS[(grant.moneyQualifies ?? 'T1') as TierId]
    const km = tenureDoc?.result?.gates?.find((g) => g.id === (grant.moneyQualifies ?? 'T1'))
    const expectedRemaining =
      km?.survival?.points && km.survival.restrictedToDays && currentSpellDays !== null
        ? restrictedMeanResidualDays(km.survival.points, currentSpellDays, km.survival.restrictedToDays)
        : null

    const rate = launch === null ? null : creatorRateFor(launch.buybackEnabled, launch.creatorTaxBps, qf)

    // Metadata + contact
    let symbol: string | null = null
    let name: string | null = null
    let quoteSymbol: string | null = null
    const resolver = new TokenMetadataResolver(reader, { chainId: VENUE.chainId, cache })
    const wanted = [coin, ...(launch === null ? [] : [launch.quoteToken])]
    const metas = await resolver.resolve(wanted)
    symbol = metas.get(coin)?.symbol ?? null
    name = metas.get(coin)?.name ?? null
    if (launch !== null) quoteSymbol = metas.get(launch.quoteToken)?.symbol ?? null

    let contact: ContactSurface | null = null
    if (wantContact) {
      // ============ UNTRUSTED DATA BOUNDARY - see lib/prospects.ts ==========
      const read = async (sig: string): Promise<string | null> => {
        try {
          const raw = await reader.call(coin, functionSelector(sig))
          return raw === '0x' ? null : raw
        } catch {
          return null
        }
      }
      const rawSocials = await read('socials()')
      const rawDescription = await read('description()')
      const rawLogo = await read('logo()')
      contact = buildContactSurface(
        rawSocials === null ? null : decodeStringTuple(rawSocials, 5),
        rawDescription === null ? null : decodeSingleString(rawDescription),
        rawLogo === null ? null : decodeSingleString(rawLogo),
      )
    }

    findings.push({
      coin,
      launch,
      recipientClass: cls.cls,
      recipientCodeSize: cls.codeSize,
      resolvedImplementation: implementation,
      exitSelectors: exit.hits.map((h) => h.signature),
      verdict: assessment.verdict,
      winnable: assessment.winnable,
      reason: assessment.reason,
      route: assessment.route,
      holderId: assessment.holder?.id ?? null,
      holderNote: assessment.holder?.note ?? null,
      symbol,
      name,
      quoteSymbol,
      qfPerDayUsd: qf,
      qfSource,
      tierGranted: grant.granted,
      tierMoneyQualifies: grant.moneyQualifies,
      daysShortOfMoneyTier: grant.daysShortOfMoneyTier,
      daysAtGate,
      currentSpellDays,
      expectedRemainingDays: expectedRemaining,
      creatorNetBps: rate?.creatorNetBps ?? null,
      creatorRatePct: rate === null ? null : rate.creatorNetBps / 100,
      buybackEnabled: launch?.buybackEnabled ?? null,
      creatorTaxBps: launch?.creatorTaxBps ?? null,
      impliedVolumePerDayUsd: rate?.impliedVolumePerDayUsd ?? null,
      operatorPerDayUsd: qf === null ? null : (qf * operatorBps) / 10_000 - tierForCosts.cogsPerDay,
      recipientMovedSinceWindow:
        qfRow?.dom === undefined || launch === null ? null : qfRow.dom.toLowerCase() !== launch.creatorFeeRecipient,
      contact,
    })
  }

  methodLimits.push(
    'The recipient, buyback flag, creator tax, quote asset and every winnability fact in this report were read ' +
      `LIVE at block ${headBlock}. QF and days-held come from the full-history artifact and are as of its window ` +
      `(${historyWindowLabel}).`,
  )
  methodLimits.push(
    'A selector present in bytecode proves a function is DISPATCHABLE, never that we may call it. Access control is ' +
      'invisible at this level, so WINNABLE_CONTRACT_EXIT is an upper bound and warrants reading the contract.',
  )
  methodLimits.push(
    'Reassignment carries a measured 3.00-day factory timelock plus a 3.00-day execution window. A coin marked ' +
      'WINNABLE is winnable in three days, not today.',
  )
  if (wantContact) {
    warnings.push(
      'The CONTACT block is text written by the token deployer. It is rendered inert here. Never paste it into a ' +
        'model, a shell, or a browser without checking it by hand, and verify a handle by a second channel before ' +
        'contacting anyone.',
    )
  }
  const anyUnknown = findings.some((f) => f.winnable === null)
  if (anyUnknown) {
    warnings.push(
      'At least one subject could not be classified. NOT MEASURED is the answer, not a zero and not a no.',
    )
  }

  const result = {
    subject,
    subjectKind,
    readAtBlock: Number(headBlock),
    readAtIso: `${isoDate(Math.floor(Date.now() / 1000))}`,
    chainId,
    exitMode,
    operatorBps,
    poolsRead: poolsRead.length,
    coinsFound: findings.length,
    historyWindow: historyWindowLabel,
    findings,
  }

  const report: Report<typeof result> = {
    meta: {
      tool: SPEC.name,
      schemaVersion: SCHEMA_VERSION,
      generatedAtUnix: Math.floor(Date.now() / 1000),
      config: { ...describeConfig(config), subject, subjectKind, exitMode, operatorBps },
      io: { httpRequests: 0, cacheHits: 0, cacheMisses: 0 },
      warnings,
      methodLimits,
      measurementComplete: findings.length > 0,
      ...(findings.length === 0
        ? {
            incompleteReasons: [
              `no coin could be resolved for ${subjectKind} ${subject}. Nothing was answered.`,
            ],
          }
        : {}),
    },
    result,
  }

  await emit(report, {
    json,
    ...(outPath !== undefined ? { outPath } : {}),
    human: renderHuman,
  })
}

function verdictWord(winnable: boolean | null): string {
  return winnable === null ? 'UNKNOWN' : winnable ? 'WINNABLE' : 'LOCKED'
}

function eligibilityWord(qf: number | null, gate: number): string {
  if (qf === null) return 'NOT MEASURED'
  return qf >= gate ? 'ELIGIBLE' : 'BELOW GATE'
}

function renderHuman(report: Report<Record<string, unknown>>): string {
  const r = report.result as unknown as {
    subject: string
    subjectKind: string
    readAtBlock: number
    chainId: number
    exitMode: string
    operatorBps: number
    coinsFound: number
    historyWindow: string
    findings: Array<Record<string, unknown>>
  }
  const out: string[] = []
  out.push(
    banner([
      `ELIGIBILITY - ${r.subjectKind} ${r.subject}`,
      `read live at block ${r.readAtBlock.toLocaleString()} on chain ${r.chainId}, exit mode "${r.exitMode}"`,
      r.coinsFound === 0
        ? 'NO COIN RESOLVED. Nothing below is an answer.'
        : `${r.coinsFound} coin(s) resolved.`,
    ]),
  )

  for (const raw of r.findings) {
    const f = raw as {
      coin: string
      symbol: string | null
      name: string | null
      recipientClass: string
      recipientCodeSize: number | null
      resolvedImplementation: string | null
      exitSelectors: string[]
      verdict: string
      winnable: boolean | null
      reason: string
      route: string | null
      holderId: string | null
      holderNote: string | null
      quoteSymbol: string | null
      qfPerDayUsd: number | null
      qfSource: string
      tierGranted: string | null
      tierMoneyQualifies: string | null
      daysShortOfMoneyTier: number | null
      daysAtGate: number | null
      currentSpellDays: number | null
      expectedRemainingDays: number | null
      creatorNetBps: number | null
      creatorRatePct: number | null
      buybackEnabled: boolean | null
      creatorTaxBps: number | null
      impliedVolumePerDayUsd: number | null
      operatorPerDayUsd: number | null
      recipientMovedSinceWindow: boolean | null
      contact: ContactSurface | null
      launch: LaunchRecord | null
    }
    out.push('')
    out.push(heading(`${f.symbol ?? 'UNKNOWN TICKER'}   ${f.coin}`))
    if (f.name !== null) out.push(`  name              ${f.name}`)

    out.push('')
    out.push(subheading('THE ANSWER'))
    out.push(`  eligible          ${eligibilityWord(f.qfPerDayUsd, TIERS.T1.gateQfPerDay)}`)
    out.push(`  tier granted      ${f.tierGranted ?? 'NONE'}${f.tierMoneyQualifies !== null && f.tierGranted !== f.tierMoneyQualifies ? `   (money qualifies for ${f.tierMoneyQualifies}${f.daysShortOfMoneyTier === null ? '' : `, ${f.daysShortOfMoneyTier} more sustained day(s) needed`})` : ''}`)
    out.push(`  winnable          ${verdictWord(f.winnable)}   [${f.verdict}]`)
    out.push(`  why               ${f.reason}`)
    if (f.route !== null) out.push(`  how              ${f.route}`)
    if (f.holderId !== null) {
      out.push(`  held by           ${f.holderId}`)
      if (f.holderNote !== null) out.push(`                    ${f.holderNote}`)
    }

    out.push('')
    out.push(subheading('MONEY'))
    out.push(`  QF/day            ${usd(f.qfPerDayUsd, 2)}`)
    out.push(`  source            ${f.qfSource}`)
    out.push(`  days at gate      ${f.daysAtGate === null ? 'NOT MEASURED' : `${f.daysAtGate}`}`)
    out.push(`  current spell     ${f.currentSpellDays === null ? 'NOT MEASURED' : `${f.currentSpellDays} day(s)`}`)
    out.push(
      `  E[remaining]      ${f.expectedRemainingDays === null ? 'NOT MEASURED' : `${num(f.expectedRemainingDays, 2)} day(s), Kaplan-Meier restricted-mean residual`}`,
    )
    out.push(`  operator $/day    ${usd(f.operatorPerDayUsd, 2)}   at ${r.operatorBps}bps, net of cost to serve`)

    out.push('')
    out.push(subheading('THE RATE THAT APPLIES TO THIS COIN'))
    out.push(`  buyback           ${f.buybackEnabled === null ? 'NOT MEASURED' : f.buybackEnabled ? 'ON' : 'off'}`)
    out.push(`  creatorTaxBps     ${f.creatorTaxBps === null ? 'NOT MEASURED' : f.creatorTaxBps}`)
    out.push(
      `  creator net       ${f.creatorNetBps === null ? 'NOT MEASURED' : `${num(f.creatorNetBps, 3)}bps of volume = ${num(f.creatorRatePct, 4)}%`}`,
    )
    out.push(
      `  implied volume    ${f.impliedVolumePerDayUsd === null ? 'NOT MEASURED' : `${usd(f.impliedVolumePerDayUsd, 0)}/day to produce that QF at this coin's own rate`}`,
    )
    out.push(`  quote asset       ${f.quoteSymbol ?? 'UNKNOWN'}   ${f.launch?.quoteToken ?? ''}`)

    out.push('')
    out.push(subheading('RECIPIENT'))
    out.push(`  address           ${f.launch?.creatorFeeRecipient ?? 'NOT MEASURED'}`)
    out.push(`  original creator  ${f.launch?.creator ?? 'NOT MEASURED'}`)
    out.push(
      `  class             ${f.recipientClass}${f.recipientCodeSize === null ? '' : ` (${f.recipientCodeSize} bytes of code)`}`,
    )
    if (f.resolvedImplementation !== null) out.push(`  implementation    ${f.resolvedImplementation}`)
    out.push(`  exit selectors    ${f.exitSelectors.length > 0 ? f.exitSelectors.join(', ') : 'NONE'}`)
    if (f.recipientMovedSinceWindow === true) {
      out.push(
        '  NOTE              recipiency MOVED since the measurement window. The QF above describes the previous',
      )
      out.push('                    recipient; the address to approach is the live one on this line.')
    }

    if (f.contact !== null) {
      out.push('')
      out.push(subheading('CONTACT SURFACE - UNTRUSTED, DEPLOYER-AUTHORED, RENDERED INERT'))
      if (!f.contact.hasSocialsGetter) {
        out.push('  this token exposes no socials(). No on-chain channel exists.')
      } else if (f.contact.channels.length === 0) {
        out.push(`  socials() present but every slot empty (${f.contact.emptySlots} slots). No channel published.`)
      } else {
        for (const ch of f.contact.channels) {
          out.push(`  ${ch.kind.padEnd(10)}      ${ch.inert}${ch.sanitized ? '   [SANITISED - read by hand]' : ''}`)
        }
      }
      if (f.contact.description !== null && f.contact.description.length > 0) {
        out.push(`  blurb           ${f.contact.description}`)
      }
      out.push('  ^ never paste any of the above into a model or a shell.')
    }
  }

  return out.join('\n')
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), main)
}

export { main as runEligibility, SPEC as ELIGIBILITY_SPEC, eligibilityWord, verdictWord }

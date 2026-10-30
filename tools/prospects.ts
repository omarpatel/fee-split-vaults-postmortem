/**
 * prospects - turn the STOP verdict into a work instruction.
 *
 * VERDICT.md's answer is 73 of ~125 standing T1 coins are winnable against a
 * break-even requirement of 109, feasibility ratio 0.68, STOP. That number is
 * measured and this tool does not argue with it. What it does is produce the
 * thing the verdict never produced: the LIST. Which 73, ranked, with the creator
 * rate that actually applies to each one, the assets its fees arrive in, how
 * long it has held the gate, and what reachable channel its deployer published.
 * And - just as commercially useful - which 52 are gone, to whom, and whether
 * the contract holding them has any way out at all.
 *
 * An operator deciding whether to proceed at a smaller scale than the plan
 * assumed cannot act on a ratio. They can act on a list.
 *
 * WHAT IS LIVE AND WHAT IS ARTIFACT, because the distinction decides how far a
 * row can be trusted:
 *
 *   LIVE, this run, every row:  the hook's launches() record - which is the
 *   authoritative creator-fee recipient, the buyback flag that branches the
 *   creator rate, the quote token, and the dev-elected creatorTaxBps - plus
 *   eth_getCode on every recipient, the implementation behind every proxy, the
 *   exit-selector scan on both, and the token's own launch metadata.
 *
 *   ARTIFACT, from the 36-day full-history measurement:  the QF figures and the
 *   daily series that produce days-held and spell length. Those cannot be read
 *   live - they are 36 days of escrow credits priced per day - and they are as
 *   of the artifact's window, which is printed on every report.
 *
 * The two disagree for 10 of 125 coins, all in the same direction: recipiency
 * moved after the measurement window closed. That is exactly why the live read
 * is the basis for the commercial question and the artifact is the basis for the
 * historical one, and why each row says which recipient each fact came from.
 *
 * ON THE CONTACT SURFACE. Everything under --contact is attacker-authored text
 * from a token contract. It is rendered inert and it is NEVER interpolated into
 * a prompt. See the long note in lib/prospects.ts. If you are extending this
 * tool, read that note before you touch the contact fields.
 */

import { readFile } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { VENUE, TERMS, TIERS, TIER_ORDER, type TierId } from '../config/protocol.ts'
import type { ParsedValues } from './lib/cli.ts'
import { CliError, getBool, getNumber, getString, isEntrypoint, runCli } from './lib/cli.ts'
import { buildCache } from './lib/cache.ts'
import { TOOLS_DIR, describeConfig, loadConfig, rpcUrlsOrPlaceholder } from './lib/env.ts'
import { banner, heading, num, pct, shortAddress, subheading, table, usd } from './lib/format.ts'
import { buildHttpClient } from './lib/http.ts'
import { parseJson } from './lib/json.ts'
import {
  buildContactSurface,
  creatorRateFor,
  classifyRecipient,
  decodeLaunchRecord,
  decodeSingleString,
  decodeStringTuple,
  gateSpell,
  grantTier,
  inertText,
  isSignable,
  KNOWN_DISTRIBUTORS,
  LAUNCHES_SELECTOR,
  PROSPECTS_SCHEMA,
  rankFunctionById,
  RANK_FUNCTIONS,
  restrictedMeanResidualDays,
  scanExitPath,
  sortByScore,
  toCsv,
  trailingMedianSeries,
  assessWinnability,
  type ContactSurface,
  type CreatorRate,
  type ExitFinding,
  type ExitMode,
  type LaunchRecord,
  type RecipientClassification,
  type WinnabilityAssessment,
} from './lib/prospects.ts'
import { emit, emitDryRun, progress, type Report } from './lib/report.ts'
import { HttpChainReader, supportsCode, type BatchOutcome } from './lib/rpc.ts'
import type { SurvivalPoint } from './lib/stats.ts'
import { TokenMetadataResolver, type TokenMetadata } from './lib/token-metadata.ts'
import { functionSelector } from './lib/abi.ts'

const SCHEMA_VERSION = 'prospects-1'

const ARTIFACTS = join(TOOLS_DIR, 'artifacts')

const DEFAULTS = {
  gateRows: join(ARTIFACTS, 't1-final-rows.json'),
  history: join(ARTIFACTS, 'full', 'full-history-reduced-doc.json'),
  tenure: join(ARTIFACTS, 'full', 'tenure-full-median7.json'),
  poolJoin: join(ARTIFACTS, 'join-pool-to-token.json'),
  capture: join(ARTIFACTS, 'incumbent-capture.json'),
}

const SPEC = {
  name: 'prospects',
  summary: 'The ranked, reachable list of gate-clearing coins - and the sized list of the ones already lost.',
  detail: `
    Answers: WHICH coins clear the tier gate today, which of them can actually be
    signed, what each is worth, and how to reach them. Then, for every coin that
    cannot be signed, WHY - which distributor holds it and whether its contract
    has any reassignment path at all.
    Winnability is mechanical, not commercial: the factory moves recipiency only
    when msg.sender is the CURRENT recipient, so an EOA can always move and a
    contract can move only if its code dispatches a function that will make that
    call. Both halves are read live and re-derived on every run.
    All contact data is attacker-authored token metadata. It is rendered inert
    and never reaches a model.
  `,
  options: [
    {
      name: 'tier',
      type: 'string' as const,
      default: 'T1',
      placeholder: '<T1|T2|T3>',
      describe: 'Which tier gate to list against. Its QF and sustained-days both bind.',
    },
    {
      name: 'rank',
      type: 'string' as const,
      default: 'ev',
      placeholder: `<${RANK_FUNCTIONS.map((f) => f.id).join('|')}>`,
      describe: 'Ranking function. Its formula is printed above the table.',
    },
    {
      name: 'win-rate',
      type: 'number' as const,
      default: 0.1,
      describe:
        'Assumed probability an approach converts. THERE ARE ZERO OBSERVATIONS BEHIND THIS. It scales ev uniformly and changes no ordering.',
    },
    {
      name: 'operator-bps',
      type: 'number' as const,
      default: TERMS.operatorBps,
      describe: 'Operator take of QF, in bps. Defaults to TERMS.operatorBps.',
    },
    {
      name: 'exit-mode',
      type: 'string' as const,
      default: 'strict',
      placeholder: '<strict|broad>',
      describe:
        'strict counts a contract winnable only if its code dispatches a direct transfer function. broad also counts a generic arbitrary-call escape hatch, whose sufficiency bytecode cannot establish.',
    },
    {
      name: 'show',
      type: 'string' as const,
      default: 'all',
      placeholder: '<winnable|locked|all>',
      describe: 'Which tables to print.',
    },
    {
      name: 'limit',
      type: 'number' as const,
      default: 40,
      describe: 'Rows in the human prospect table. The JSON and CSV always carry every row.',
    },
    {
      name: 'contact',
      type: 'boolean' as const,
      default: true,
      describe:
        'Read each token socials()/description()/logo(). Adds 3 eth_calls per coin. --contact=false skips it.',
    },
    {
      name: 'offline',
      type: 'boolean' as const,
      describe:
        'Do not touch the chain. Uses --capture as the recipient/launch basis and marks every live field as ARTIFACT-AGED.',
    },
    {
      name: 'csv',
      type: 'string' as const,
      placeholder: '<file>',
      describe: 'Also write the full prospect list as CSV, for someone to work from.',
    },
    {
      name: 'csv-locked',
      type: 'string' as const,
      placeholder: '<file>',
      describe: 'Also write the non-winnable list as CSV, for sizing the incumbent.',
    },
    {
      name: 'gate-rows',
      type: 'string' as const,
      placeholder: '<file>',
      default: DEFAULTS.gateRows,
      describe: 'Coin-level gate artifact: [{coin, median7, total7, cr, pr, dom}].',
    },
    {
      name: 'history',
      type: 'string' as const,
      placeholder: '<file>',
      default: DEFAULTS.history,
      describe: 'Full-history escrow document, for the daily series behind days-held.',
    },
    {
      name: 'tenure',
      type: 'string' as const,
      placeholder: '<file>',
      default: DEFAULTS.tenure,
      describe: 'tenure.ts output, for the Kaplan-Meier curve behind expected remaining days.',
    },
    {
      name: 'pool-join',
      type: 'string' as const,
      placeholder: '<file>',
      default: DEFAULTS.poolJoin,
      describe: 'pool -> token join, for reading launches() per coin.',
    },
    {
      name: 'capture',
      type: 'string' as const,
      placeholder: '<file>',
      default: DEFAULTS.capture,
      describe: 'Previous live launches() snapshot. Used as the basis under --offline.',
    },
  ],
  examples: [
    'node tools/prospects.ts',
    'node tools/prospects.ts --rank margin --limit 20',
    'node tools/prospects.ts --exit-mode broad --csv artifacts/prospects.csv --csv-locked artifacts/locked.csv',
    'node tools/prospects.ts --json --out tools/artifacts/prospects.json',
    'node tools/prospects.ts --offline --show locked',
  ],
}

// ---------------------------------------------------------------------------
// Artifact shapes
// ---------------------------------------------------------------------------

interface GateRow {
  coin: string
  median7: number
  total7?: number
  cr?: number
  pr?: number
  /** Dominant creator-leg recipient OBSERVED over the artifact's window. */
  dom?: string
}

interface HistoryDay {
  dayUnix: number
  dateUtc: string
  usd: number | null
}

interface HistoryRecipient {
  recipient: string
  days: HistoryDay[]
}

interface CaptureRow extends LaunchRecord {
  coin: string
  median7?: number | null
}

// ---------------------------------------------------------------------------
// The row this tool produces
// ---------------------------------------------------------------------------

export interface ProspectRow {
  rank: number | null
  coin: string
  symbol: string | null
  name: string | null
  /** Live creator-fee recipient from the hook. The address to approach. */
  recipient: string | null
  /** Original deployer, when it differs from the recipient. */
  creator: string | null
  recipientClass: string
  /** True when the live recipient differs from the one the artifact measured. */
  recipientMovedSinceWindow: boolean | null

  qfPerDayUsd: number | null
  qfBasis: string
  tierGranted: string | null
  tierMoneyQualifies: string | null
  daysShortOfMoneyTier: number | null

  daysAtGate: number | null
  currentSpellDays: number | null
  spellBasis: string
  expectedRemainingDays: number | null

  buybackEnabled: boolean | null
  creatorTaxBps: number | null
  creatorNetBps: number | null
  creatorRatePct: number | null
  impliedVolumePerDayUsd: number | null

  quoteToken: string | null
  quoteSymbol: string | null
  /** Every asset the coin's creator leg was credited in, over the window. */
  feeAssets: Array<{ address: string; symbol: string | null }>

  winnable: boolean | null
  verdict: string
  winnabilityReason: string
  route: string | null
  holderId: string | null
  holderLabel: string | null
  exitSelectorsFound: string[]

  /** Attacker-authored. Inert. Never fed to a model. */
  contact: ContactSurface | null

  score: number | null
  operatorPerDayUsd: number | null
  expectedOperatorUsd: number | null
}

// ---------------------------------------------------------------------------

async function readArtifact<T>(path: string, label: string): Promise<T> {
  try {
    return parseJson<T>(await readFile(path, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new CliError(
      `could not read the ${label} artifact at ${path}: ${detail}\n` +
        `  This tool is a VIEW over the 36-day measurement; it does not re-scan the chain for QF.\n` +
        `  Produce it with:  bash tools/artifacts/full/run-analysis.sh\n` +
        `  or point at an existing one with the matching flag.`,
    )
  }
}

/** Chunk an array for batched RPC. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function okValue(outcome: BatchOutcome<string> | undefined): string | null {
  return outcome !== undefined && outcome.ok ? outcome.value : null
}

async function main(values: ParsedValues): Promise<void> {
  const config = loadConfig()
  const json = getBool(values, 'json')
  const verbose = getBool(values, 'verbose')
  const outPath = getString(values, 'out')
  const dryRun = getBool(values, 'dry-run')
  const offline = getBool(values, 'offline')

  const tierId = (getString(values, 'tier') ?? 'T1').toUpperCase()
  if (!(TIER_ORDER as string[]).includes(tierId)) {
    throw new CliError(`--tier must be one of ${TIER_ORDER.join(', ')}, got "${tierId}"`)
  }
  const tier = TIERS[tierId as TierId]

  const rankId = getString(values, 'rank') ?? 'ev'
  let rankFn
  try {
    rankFn = rankFunctionById(rankId)
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error))
  }

  const exitModeRaw = getString(values, 'exit-mode') ?? 'strict'
  if (exitModeRaw !== 'strict' && exitModeRaw !== 'broad') {
    throw new CliError('--exit-mode must be "strict" or "broad"')
  }
  const exitMode: ExitMode = exitModeRaw

  const showRaw = getString(values, 'show') ?? 'all'
  if (!['winnable', 'locked', 'all'].includes(showRaw)) {
    throw new CliError('--show must be "winnable", "locked" or "all"')
  }

  const winRate = getNumber(values, 'win-rate', 0.1)
  if (winRate < 0 || winRate > 1) throw new CliError('--win-rate must be between 0 and 1')
  const operatorBps = getNumber(values, 'operator-bps', TERMS.operatorBps)
  const limit = Math.max(1, Math.floor(getNumber(values, 'limit', 40)))
  const wantContact = values.contact !== false && !offline

  const gateRowsPath = getString(values, 'gate-rows') ?? DEFAULTS.gateRows
  const historyPath = getString(values, 'history') ?? DEFAULTS.history
  const tenurePath = getString(values, 'tenure') ?? DEFAULTS.tenure
  const poolJoinPath = getString(values, 'pool-join') ?? DEFAULTS.poolJoin
  const capturePath = getString(values, 'capture') ?? DEFAULTS.capture

  if (dryRun) {
    emitDryRun(
      {
        tool: SPEC.name,
        config: {
          ...describeConfig(config),
          tier: tierId,
          gate: tier.gateQfPerDay,
          sustainedDays: tier.sustainedDays,
          rank: rankFn.id,
          rankFormula: rankFn.formula,
          exitMode,
          operatorBps,
          winRate,
          offline,
          contact: wantContact,
          inputs: { gateRowsPath, historyPath, tenurePath, poolJoinPath, capturePath },
        },
        steps: [
          { description: `read the coin-level gate artifact (${gateRowsPath})` },
          { description: `read the 36-day daily series (${historyPath})` },
          { description: `read the Kaplan-Meier curve (${tenurePath})` },
          ...(offline
            ? [{ description: `read the previous launches() snapshot (${capturePath})` }]
            : [
                {
                  description: 'eth_call hook.launches(poolId) for every pool of every gate coin',
                  endpoint: 'VENUE_RPC_URL',
                  estimatedRequests: 30,
                },
                {
                  description: 'eth_getCode every live creator-fee recipient',
                  estimatedRequests: 13,
                },
                {
                  description: 'resolve each proxy implementation and eth_getCode it',
                  estimatedRequests: 8,
                },
                { description: 'resolve token symbol/name', estimatedRequests: 38 },
                ...(wantContact
                  ? [
                      {
                        description: 'eth_call socials()/description()/logo() per coin (UNTRUSTED)',
                        estimatedRequests: 38,
                      },
                    ]
                  : []),
              ]),
        ],
        estimatedRequestsTotal: offline ? 0 : 127,
        notes: [
          'Request estimates assume batches of 10 and ~125 gate-clearing coins.',
          'Winnability is derived from bytecode read in THIS run; it is never carried from an artifact unless --offline is passed.',
          'Contact data is attacker-authored token metadata. It is rendered inert and never reaches a model.',
          ...(config.rpcUrls.length === 0 && !offline
            ? ['VENUE_RPC_URL is UNSET; a real run will refuse to start. Pass --offline to work from artifacts alone.']
            : []),
        ],
      },
      json,
    )
    return
  }

  // -------------------------------------------------------------------------
  // Artifacts
  // -------------------------------------------------------------------------
  progress(verbose, `reading gate artifact ${gateRowsPath}`)
  const gateRows = await readArtifact<GateRow[]>(gateRowsPath, 'coin-level gate')
  if (!Array.isArray(gateRows) || gateRows.length === 0) {
    throw new CliError(`${gateRowsPath} held no coin rows. Nothing to rank.`)
  }

  progress(verbose, `reading full-history document ${historyPath} (this file is large)`)
  const historyDoc = await readArtifact<{
    meta?: { warnings?: string[] }
    result: {
      recipients: HistoryRecipient[]
      windowStartDayUnix?: number
      windowEndDayUnix?: number
      windowDays?: number
      assetSymbols?: Record<string, string>
    }
  }>(historyPath, 'full-history daily series')

  progress(verbose, `reading survival curve ${tenurePath}`)
  const tenureDoc = await readArtifact<{
    result: { gates: Array<{ id: string; survival?: { points?: SurvivalPoint[]; restrictedToDays?: number } }> }
  }>(tenurePath, 'tenure survival curve')

  const tenureGate = tenureDoc.result?.gates?.find((g) => g.id === tierId)
  const kmPoints: SurvivalPoint[] = tenureGate?.survival?.points ?? []
  const kmTau = tenureGate?.survival?.restrictedToDays ?? 0
  const kmAvailable = kmPoints.length > 0 && kmTau > 0

  // Daily series, keyed by recipient. This is the RECIPIENT leg over 36 days.
  const seriesByRecipient = new Map<string, Array<number | null>>()
  const dayLabels: string[] = []
  for (const rec of historyDoc.result?.recipients ?? []) {
    const usdSeries = rec.days.map((d) => (typeof d.usd === 'number' ? d.usd : null))
    seriesByRecipient.set(rec.recipient.toLowerCase(), usdSeries)
    if (dayLabels.length === 0) for (const d of rec.days) dayLabels.push(d.dateUtc)
  }

  // -------------------------------------------------------------------------
  // The launch records: live, or from the previous snapshot under --offline
  // -------------------------------------------------------------------------
  const warnings: string[] = []
  const methodLimits: string[] = []
  const launchByCoin = new Map<string, LaunchRecord>()
  const codeByAddress = new Map<string, string | null>()
  let headBlock: bigint | null = null
  let chainIdSeen: number | null = null
  let httpRequests = 0

  const http = buildHttpClient({
    requestsPerSecond: config.requestsPerSecond,
    maxRetries: config.maxRetries,
    timeoutMs: config.requestTimeoutMs,
    onRetry: (attempt, delay, reason) => progress(verbose, `retry ${attempt} in ${delay}ms: ${reason}`),
  })
  const cache = buildCache(config.cacheDir, getBool(values, 'no-cache'))
  const reader = new HttpChainReader(http, rpcUrlsOrPlaceholder(config, offline))
  const batchSize = reader.maxBatchSize

  const metadataByToken = new Map<string, TokenMetadata>()
  const contactByCoin = new Map<string, ContactSurface>()
  let captureAgeIso: string | null = null

  if (offline) {
    progress(verbose, `offline: reading previous launches() snapshot ${capturePath}`)
    const capture = await readArtifact<{ readAtIso?: string; rows: CaptureRow[] }>(
      capturePath,
      'previous launches() snapshot',
    )
    captureAgeIso = capture.readAtIso ?? null
    for (const row of capture.rows ?? []) launchByCoin.set(row.coin.toLowerCase(), row)
    warnings.push(
      `--offline: every live field in this report comes from ${capturePath}, read at ${captureAgeIso ?? 'an unrecorded time'}. ` +
        'Creator-fee recipiency moves. A recipient that has re-pointed since that snapshot will be reported wrong, ' +
        'in the direction of showing a coin as winnable when it is no longer. Do not approach a dev on an --offline row.',
    )
    warnings.push(
      '--offline cannot scan bytecode, so winnability is carried from the snapshot classification rather than re-derived. ' +
        'The exit-selector scan did not run.',
    )
  } else {
    if (config.rpcUrls.length === 0) {
      throw new CliError(
        'VENUE_RPC_URL is unset, so the live reads this tool exists to make cannot happen.\n' +
          '  Set it:      export VENUE_RPC_URL=https://rpc.mainnet.chain.robinhood.com\n' +
          '  Or work from the last snapshot instead:  node tools/prospects.ts --offline',
      )
    }
    chainIdSeen = await reader.chainId()
    httpRequests++
    if (chainIdSeen !== VENUE.chainId) {
      throw new CliError(
        `connected to chain ${chainIdSeen}, expected Venue ${VENUE.chainId}. Refusing to classify recipients on the wrong chain.`,
      )
    }
    headBlock = await reader.blockNumber()
    httpRequests++
    progress(verbose, `chain ${chainIdSeen}, head block ${headBlock}`)

    const poolJoin = await readArtifact<{ poolToToken: Record<string, string> }>(
      poolJoinPath,
      'pool -> token join',
    )
    const poolsByToken = new Map<string, string[]>()
    for (const [pool, token] of Object.entries(poolJoin.poolToToken ?? {})) {
      const key = token.toLowerCase()
      const list = poolsByToken.get(key)
      if (list) list.push(pool)
      else poolsByToken.set(key, [pool])
    }

    const jobs: Array<{ coin: string; pool: string }> = []
    const coinsWithoutPool: string[] = []
    for (const row of gateRows) {
      const coin = row.coin.toLowerCase()
      const pools = poolsByToken.get(coin)
      if (pools === undefined || pools.length === 0) {
        coinsWithoutPool.push(coin)
        continue
      }
      for (const pool of pools) jobs.push({ coin, pool })
    }
    progress(verbose, `reading launches() for ${jobs.length} pools across ${gateRows.length} coins`)

    let decoded = 0
    let layoutControlFailures = 0
    for (const group of chunk(jobs, batchSize)) {
      const outcomes = await reader.callBatch(
        group.map((j) => ({ to: VENUE.contracts.v2MemeHook, data: LAUNCHES_SELECTOR + j.pool.slice(2) })),
      )
      httpRequests++
      for (const [i, outcome] of outcomes.entries()) {
        const job = group[i]!
        const raw = okValue(outcome)
        if (raw === null) continue
        const record = decodeLaunchRecord(raw)
        if (record === null) continue
        // THE DECODE CONTROL. Field [2] of the launch record must be the coin we
        // joined this pool to. If the layout ever shifts, this fails loudly here
        // rather than silently reporting field [4] as a recipient it is not.
        if (record.memecoin !== job.coin) {
          layoutControlFailures++
          continue
        }
        if (!launchByCoin.has(job.coin)) {
          launchByCoin.set(job.coin, record)
          decoded++
        }
      }
      progress(verbose, `launches ${decoded}/${gateRows.length} coins`)
    }
    if (layoutControlFailures > 0) {
      warnings.push(
        `${layoutControlFailures} launches() record(s) decoded to a memecoin that is not the coin the pool was joined to. ` +
          'Those pools were DROPPED rather than trusted. If this count is large the record layout has changed and every ' +
          'recipient in this report is suspect.',
      )
    }
    if (coinsWithoutPool.length > 0) {
      warnings.push(
        `${coinsWithoutPool.length} gate coin(s) have no pool in the join artifact, so no live launch record was read for them. ` +
          'They are reported with EXPLICIT UNKNOWNs, not dropped and not zeroed.',
      )
    }

    // --- recipient code -----------------------------------------------------
    if (!supportsCode(reader)) {
      throw new CliError('the configured reader cannot fetch runtime code, which this tool requires')
    }
    const recipients = [
      ...new Set([...launchByCoin.values()].map((l) => l.creatorFeeRecipient)),
    ]
    progress(verbose, `eth_getCode on ${recipients.length} live recipients`)
    for (const group of chunk(recipients, batchSize)) {
      const outcomes = await reader.getCodeBatch(group)
      httpRequests++
      for (const [i, outcome] of outcomes.entries()) {
        codeByAddress.set(group[i]!.toLowerCase(), okValue(outcome))
      }
    }
  }

  // -------------------------------------------------------------------------
  // Classify, resolve implementations, scan for exits
  // -------------------------------------------------------------------------
  const knownBeacons = KNOWN_DISTRIBUTORS.map((d) => d.beacon)
  const classByRecipient = new Map<string, RecipientClassification>()
  for (const [address, code] of codeByAddress) {
    classByRecipient.set(address, classifyRecipient(address, code, knownBeacons))
  }

  // Resolve one implementation per proxy: a clone carries it in its own body; a
  // beacon proxy carries the BEACON, which must be asked. Anything else stays
  // unresolved and is scanned on its own code only.
  const implByRecipient = new Map<string, string | null>()
  if (!offline) {
    const beaconCandidates = new Set<string>()
    for (const c of classByRecipient.values()) {
      if (c.cls === 'CLONE_1167' && c.implementation) {
        implByRecipient.set(c.address, c.implementation)
      } else if (c.cls === 'BEACON_PROXY' && c.beacon) {
        beaconCandidates.add(c.beacon)
      } else if (c.cls === 'OTHER_CONTRACT') {
        for (const word of c.addressWords) beaconCandidates.add(word)
      }
    }
    const implOfBeacon = new Map<string, string>()
    const beaconList = [...beaconCandidates]
    if (beaconList.length > 0) {
      progress(verbose, `resolving implementation() on ${beaconList.length} beacon candidate(s)`)
      const selImpl = functionSelector('implementation()')
      for (const group of chunk(beaconList, batchSize)) {
        const outcomes = await reader.callBatch(group.map((a) => ({ to: a, data: selImpl })))
        httpRequests++
        for (const [i, outcome] of outcomes.entries()) {
          const raw = okValue(outcome)
          if (raw !== null && raw.length === 66 && !/^0x0+$/.test(raw)) {
            implOfBeacon.set(group[i]!, `0x${raw.slice(26)}`.toLowerCase())
          }
        }
      }
    }
    for (const c of classByRecipient.values()) {
      if (implByRecipient.has(c.address)) continue
      if (c.beacon && implOfBeacon.has(c.beacon)) {
        implByRecipient.set(c.address, implOfBeacon.get(c.beacon)!)
        continue
      }
      const viaWord = c.addressWords.find((w) => implOfBeacon.has(w))
      implByRecipient.set(c.address, viaWord ? implOfBeacon.get(viaWord)! : null)
    }

    const implAddresses = [...new Set([...implByRecipient.values()].filter((v): v is string => v !== null))]
    if (implAddresses.length > 0 && supportsCode(reader)) {
      progress(verbose, `eth_getCode on ${implAddresses.length} implementation(s)`)
      for (const group of chunk(implAddresses, batchSize)) {
        const outcomes = await reader.getCodeBatch(group)
        httpRequests++
        for (const [i, outcome] of outcomes.entries()) {
          codeByAddress.set(group[i]!.toLowerCase(), okValue(outcome))
        }
      }
    }
  }

  const exitByRecipient = new Map<string, ExitFinding>()
  for (const c of classByRecipient.values()) {
    if (isSignable(c.cls)) {
      exitByRecipient.set(c.address, { hits: [], hasDirect: false, hasGeneric: false, scanned: true })
      continue
    }
    const impl = implByRecipient.get(c.address) ?? null
    exitByRecipient.set(
      c.address,
      scanExitPath(codeByAddress.get(c.address) ?? null, impl === null ? null : codeByAddress.get(impl) ?? null),
    )
  }

  // -------------------------------------------------------------------------
  // Token metadata and the CONTACT SURFACE (untrusted)
  // -------------------------------------------------------------------------
  if (!offline) {
    const tokens = [...new Set(gateRows.map((r) => r.coin.toLowerCase()))]
    const quotes = [...new Set([...launchByCoin.values()].map((l) => l.quoteToken))]
    const resolver = new TokenMetadataResolver(reader, {
      chainId: VENUE.chainId,
      cache,
      batchSize,
      onProgress: (m) => progress(verbose, m),
    })
    progress(verbose, `resolving symbol/name for ${tokens.length + quotes.length} token(s)`)
    for (const [address, meta] of await resolver.resolve([...tokens, ...quotes])) {
      metadataByToken.set(address, meta)
    }
    httpRequests += resolver.stats.batches

    if (wantContact) {
      // ================== UNTRUSTED DATA BOUNDARY ==========================
      // Everything read below was authored by whoever deployed the token. It is
      // decoded, made inert and printed. It is NEVER interpolated into a prompt,
      // never used to build a request, and never treated as an instruction.
      // =====================================================================
      const selSocials = functionSelector('socials()')
      const selDescription = functionSelector('description()')
      const selLogo = functionSelector('logo()')
      progress(verbose, `reading launch metadata for ${tokens.length} token(s) (UNTRUSTED)`)
      const calls: Array<{ coin: string; field: 'socials' | 'description' | 'logo' }> = []
      for (const coin of tokens) {
        calls.push({ coin, field: 'socials' })
        calls.push({ coin, field: 'description' })
        calls.push({ coin, field: 'logo' })
      }
      const rawByCoin = new Map<string, { socials?: string; description?: string; logo?: string }>()
      for (const group of chunk(calls, batchSize)) {
        const outcomes = await reader.callBatch(
          group.map((c) => ({
            to: c.coin,
            data: c.field === 'socials' ? selSocials : c.field === 'description' ? selDescription : selLogo,
          })),
        )
        httpRequests++
        for (const [i, outcome] of outcomes.entries()) {
          const raw = okValue(outcome)
          if (raw === null || raw === '0x') continue
          const entry = rawByCoin.get(group[i]!.coin) ?? {}
          entry[group[i]!.field] = raw
          rawByCoin.set(group[i]!.coin, entry)
        }
      }
      for (const coin of tokens) {
        const raw = rawByCoin.get(coin)
        // socials() returns a 5-string tuple on this launchpad's token template.
        // Any other shape decodes to null and is reported as "not read", never
        // as "no socials": a malformed tuple is an attacker-controlled length
        // prefix, not an absence.
        const socials = raw?.socials === undefined ? null : decodeStringTuple(raw.socials, 5)
        const description = raw?.description === undefined ? null : decodeSingleString(raw.description)
        const logo = raw?.logo === undefined ? null : decodeSingleString(raw.logo)
        contactByCoin.set(coin, buildContactSurface(socials, description, logo))
      }
    }
  }

  // -------------------------------------------------------------------------
  // Assemble
  // -------------------------------------------------------------------------
  const rows: ProspectRow[] = []
  const windowStart = historyDoc.result?.windowStartDayUnix ?? null
  const windowDays = historyDoc.result?.windowDays ?? dayLabels.length
  const qfBasis = `coin-leg trailing-7-day median from ${gateRowsPath}`
  const spellBasis =
    `recipient-leg trailing-7-day median over the ${windowDays}-day full history ` +
    `(${dayLabels[0] ?? '?'}..${dayLabels[dayLabels.length - 1] ?? '?'})`

  let multiCoinRecipients = 0
  for (const gateRow of gateRows) {
    const coin = gateRow.coin.toLowerCase()
    const launch = launchByCoin.get(coin) ?? null
    const recipient = launch?.creatorFeeRecipient ?? null
    const cls = recipient === null ? null : classByRecipient.get(recipient) ?? null
    const exit = recipient === null ? null : exitByRecipient.get(recipient) ?? null
    const impl = recipient === null ? null : implByRecipient.get(recipient) ?? null

    const assessment: WinnabilityAssessment =
      cls === null || exit === null
        ? {
            verdict: 'UNKNOWN',
            winnable: null,
            reason: offline
              ? 'under --offline no bytecode was read; winnability was not derived'
              : 'no live launch record was read for this coin, so its recipient is UNKNOWN',
            holder: null,
            route: null,
          }
        : assessWinnability({
            classification: cls,
            exit,
            resolvedImplementation: impl,
            mode: exitMode,
          })

    // Spell, from the recipient leg. Prefer the recipient the artifact measured
    // (dom), because that is whose credits the daily series holds; note when it
    // is not the live recipient, which means the coin moved after the window.
    const measuredRecipient = (gateRow.dom ?? recipient ?? '').toLowerCase()
    const daily = measuredRecipient === '' ? undefined : seriesByRecipient.get(measuredRecipient)
    const median7 = daily === undefined ? null : trailingMedianSeries(daily, 7)
    const spell = median7 === null ? null : gateSpell(median7, tier.gateQfPerDay)

    const qf = typeof gateRow.median7 === 'number' && Number.isFinite(gateRow.median7) ? gateRow.median7 : null
    const grant =
      spell === null
        ? { granted: null, moneyQualifies: null, daysShortOfMoneyTier: null }
        : grantTier(qf, spell.currentSpellDays, TIER_ORDER.map((id) => TIERS[id]).map((t) => ({
            id: t.id,
            gateQfPerDay: t.gateQfPerDay,
            sustainedDays: t.sustainedDays,
          })))

    const expectedRemaining =
      kmAvailable && spell !== null ? restrictedMeanResidualDays(kmPoints, spell.currentSpellDays, kmTau) : null

    const rate: CreatorRate | null =
      launch === null ? null : creatorRateFor(launch.buybackEnabled, launch.creatorTaxBps, qf)

    const meta = metadataByToken.get(coin)
    const quoteMeta = launch === null ? undefined : metadataByToken.get(launch.quoteToken)

    // Divergence between the coin's own QF and its recipient's whole leg tells
    // us whether the spell above is really this coin's. A ratio near 1 means the
    // recipient earns from this coin and nothing else.
    if (
      spell !== null &&
      spell.latestMedian !== null &&
      qf !== null &&
      qf > 0 &&
      spell.latestMedian / qf > 1.25
    ) {
      multiCoinRecipients++
    }

    const operatorPerDay = qf === null ? null : (qf * operatorBps) / 10_000 - tier.cogsPerDay
    const score = rankFn.score({
      qfPerDayUsd: qf,
      expectedRemainingDays: expectedRemaining,
      winnable: assessment.winnable,
      operatorBps,
      cogsPerDay: tier.cogsPerDay,
      winRate,
    })

    rows.push({
      rank: null,
      coin,
      symbol: meta?.symbol ?? null,
      name: meta?.name ?? null,
      recipient,
      creator: launch?.creator ?? null,
      recipientClass: cls?.cls ?? 'UNKNOWN',
      recipientMovedSinceWindow:
        gateRow.dom === undefined || recipient === null ? null : gateRow.dom.toLowerCase() !== recipient,
      qfPerDayUsd: qf,
      qfBasis,
      tierGranted: grant.granted,
      tierMoneyQualifies: grant.moneyQualifies,
      daysShortOfMoneyTier: grant.daysShortOfMoneyTier,
      daysAtGate: spell?.daysAtGate ?? null,
      currentSpellDays: spell?.currentSpellDays ?? null,
      spellBasis,
      expectedRemainingDays: expectedRemaining,
      buybackEnabled: launch?.buybackEnabled ?? null,
      creatorTaxBps: launch?.creatorTaxBps ?? null,
      creatorNetBps: rate?.creatorNetBps ?? null,
      creatorRatePct: rate === null ? null : rate.creatorNetBps / 100,
      impliedVolumePerDayUsd: rate?.impliedVolumePerDayUsd ?? null,
      quoteToken: launch?.quoteToken ?? null,
      quoteSymbol: quoteMeta?.symbol ?? null,
      feeAssets:
        launch === null
          ? []
          : [{ address: launch.quoteToken, symbol: quoteMeta?.symbol ?? null }],
      winnable: assessment.winnable,
      verdict: assessment.verdict,
      winnabilityReason: assessment.reason,
      route: assessment.route,
      holderId: assessment.holder?.id ?? null,
      holderLabel: assessment.holder?.label ?? null,
      exitSelectorsFound: exit?.hits.map((h) => h.signature) ?? [],
      contact: contactByCoin.get(coin) ?? null,
      score,
      operatorPerDayUsd: operatorPerDay,
      expectedOperatorUsd:
        operatorPerDay === null || expectedRemaining === null ? null : operatorPerDay * expectedRemaining,
    })
  }

  const ranked = sortByScore(rows, (r) => r.score)
  ranked.forEach((r, i) => {
    r.rank = i + 1
  })

  const winnable = ranked.filter((r) => r.winnable === true)
  const locked = ranked.filter((r) => r.winnable === false)
  const unknown = ranked.filter((r) => r.winnable === null)

  // -------------------------------------------------------------------------
  // Incumbent sizing: who holds the coins we cannot have
  // -------------------------------------------------------------------------
  interface HolderBucket {
    holderId: string
    label: string
    coins: number
    qfPerDayUsd: number | null
    reassignmentPath: string
  }
  const buckets = new Map<string, HolderBucket>()
  for (const row of [...locked, ...unknown]) {
    const key = row.holderId ?? (row.winnable === null ? 'UNMEASURED' : `UNNAMED_${row.recipientClass}`)
    const existing = buckets.get(key)
    const label =
      row.holderLabel ??
      (row.winnable === null
        ? 'recipient class was not measured'
        : `unaffiliated ${row.recipientClass.toLowerCase().replace(/_/g, ' ')}`)
    const path =
      row.winnable === null
        ? 'UNKNOWN - not measured'
        : row.exitSelectorsFound.length > 0
          ? `conditional: ${row.exitSelectorsFound.join(', ')}`
          : 'NONE - no exit selector in the recipient or its implementation'
    if (existing) {
      existing.coins++
      if (row.qfPerDayUsd !== null) {
        existing.qfPerDayUsd = (existing.qfPerDayUsd ?? 0) + row.qfPerDayUsd
      }
    } else {
      buckets.set(key, {
        holderId: key,
        label,
        coins: 1,
        qfPerDayUsd: row.qfPerDayUsd,
        reassignmentPath: path,
      })
    }
  }
  const holders = [...buckets.values()].sort((a, b) => b.coins - a.coins)

  // -------------------------------------------------------------------------
  // Warnings that must travel with these numbers
  // -------------------------------------------------------------------------
  // A total over rows where one row's QF is null is NOT the sum of the rest: it
  // is unknown. Coercing the missing row to 0 would print a confident dollar
  // figure that silently understates the market - the false zero this codebase
  // refuses everywhere else (qf is explicitly nullable at its source above, and
  // every per-row site guards it). usd(null) renders UNPRICED.
  const sumQfOrUnknown = (rows: ReadonlyArray<{ qfPerDayUsd: number | null }>): number | null =>
    rows.some((r) => r.qfPerDayUsd === null)
      ? null
      : rows.reduce((s, r) => s + (r.qfPerDayUsd ?? 0), 0)
  const totalQfWinnable = sumQfOrUnknown(winnable)
  const totalQfLocked = sumQfOrUnknown(locked)

  methodLimits.push(
    `QF and days-held come from the ${windowDays}-day full-history measurement, not from this run. ` +
      'They are as of that window and they age. Recipiency, buyback, creator tax, quote asset and every ' +
      'winnability fact are read live.',
  )
  methodLimits.push(
    'Days-held and spell length are measured on the RECIPIENT leg, because the daily series exists at ' +
      'recipient granularity. Every gate coin currently has a distinct live recipient, so for these rows ' +
      'the two coincide - except where a recipient also earns from coins below the gate, which inflates ' +
      'its spell relative to this coin. The report counts those rows.',
  )
  methodLimits.push(
    'A selector present in bytecode proves a function is DISPATCHABLE, not that we may call it. Access ' +
      'control is invisible at this level, so the exit scan can only ever overstate winnability. Read the ' +
      'contract before spending money against a WINNABLE_CONTRACT_EXIT row.',
  )
  methodLimits.push(
    'Expected remaining days is a Kaplan-Meier restricted-mean residual, restricted to ' +
      `${kmTau} days because Venue V2 is younger than that. Nothing about tenure past ${kmTau} days is ` +
      'measurable from this chain by any method.',
  )
  if (!kmAvailable) {
    warnings.push(
      `no survival curve for ${tierId} was found in ${tenurePath}, so expected-remaining-days is UNKNOWN for every ` +
        'row and the ev ranking is unavailable. Ranked by the fallback ordering the chosen function produces.',
    )
  }
  warnings.push(
    `The win rate of ${pct(winRate)} is an ASSUMPTION with zero observations behind it. It scales every ev ` +
      'uniformly and changes no ordering. Nothing in this repository has ever measured a conversion.',
  )
  warnings.push(
    'The contact columns are ATTACKER-AUTHORED TEXT read from token contracts. They are rendered inert here ' +
      'and they must never be pasted into a prompt, a browser address bar, or anything that will act on them. ' +
      'A URL in this table is the deployer\'s CLAIM about where they can be reached - it is not verified and ' +
      'not endorsed.',
  )
  if (multiCoinRecipients > 0) {
    warnings.push(
      `${multiCoinRecipients} row(s) have a recipient-leg median more than 25% above the coin's own QF, which means ` +
        'the recipient earns from other coins too. Their days-held is an UPPER BOUND for this coin.',
    )
  }
  const movedCount = rows.filter((r) => r.recipientMovedSinceWindow === true).length
  if (movedCount > 0) {
    warnings.push(
      `${movedCount} coin(s) have re-pointed creator-fee recipiency since the measurement window closed. Their QF and ` +
        'spell describe the PREVIOUS recipient; the address to approach is the live one in the table.',
    )
  }
  if (unknown.length > 0) {
    warnings.push(
      `${unknown.length} coin(s) could not be classified at all and are reported as EXPLICIT UNKNOWN. They are neither ` +
        'winnable nor locked - they are unmeasured, and they are excluded from both totals rather than counted as zero.',
    )
  }
  warnings.push(
    'Everything here was measured inside a gas subsidy that expires 2026-09-29. A prospect list is a forward-looking ' +
      'document and this one has an expiry date on it. Re-run after the subsidy lapses before acting at scale.',
  )

  const result = {
    tier: {
      id: tier.id,
      name: tier.name,
      gateQfPerDay: tier.gateQfPerDay,
      sustainedDays: tier.sustainedDays,
      cogsPerDay: tier.cogsPerDay,
    },
    basis: {
      live: !offline,
      chainId: chainIdSeen,
      headBlock: headBlock === null ? null : Number(headBlock),
      captureReadAtIso: captureAgeIso,
      qfBasis,
      spellBasis,
      windowStartDayUnix: windowStart,
      windowDays,
      survivalRestrictedToDays: kmTau,
    },
    ranking: {
      id: rankFn.id,
      formula: rankFn.formula,
      describe: rankFn.describe,
      operatorBps,
      winRate,
      cogsPerDay: tier.cogsPerDay,
      exitMode,
      available: RANK_FUNCTIONS.map((f) => ({ id: f.id, formula: f.formula })),
    },
    summary: {
      coinsConsidered: rows.length,
      winnable: winnable.length,
      locked: locked.length,
      unmeasured: unknown.length,
      winnableSharePct: rows.length === 0 ? null : (winnable.length / (winnable.length + locked.length)) * 100,
      winnableQfPerDayUsd: totalQfWinnable,
      lockedQfPerDayUsd: totalQfLocked,
      winnableOperatorPerDayUsd:
        totalQfWinnable === null ? null : (totalQfWinnable * operatorBps) / 10_000,
      byClass: countBy(rows, (r) => r.recipientClass),
      byVerdict: countBy(rows, (r) => r.verdict),
      reachable: winnable.filter((r) => r.contact?.reachable === true).length,
      contactRead: winnable.filter((r) => r.contact !== null).length,
    },
    holders,
    prospects: winnable,
    lockedCoins: locked,
    unmeasuredCoins: unknown,
  }

  const report: Report<typeof result> = {
    meta: {
      tool: SPEC.name,
      schemaVersion: SCHEMA_VERSION,
      generatedAtUnix: Math.floor(Date.now() / 1000),
      config: {
        ...describeConfig(config),
        tier: tierId,
        rank: rankFn.id,
        exitMode,
        operatorBps,
        winRate,
        offline,
        contact: wantContact,
        inputs: { gateRowsPath, historyPath, tenurePath, poolJoinPath, capturePath },
      },
      io: { httpRequests, cacheHits: 0, cacheMisses: 0 },
      warnings,
      methodLimits,
      measurementComplete: rows.length > 0 && unknown.length < rows.length,
      ...(unknown.length >= rows.length
        ? { incompleteReasons: ['no coin could be classified; every row is an UNKNOWN'] }
        : {}),
    },
    result,
  }

  // -------------------------------------------------------------------------
  // CSV
  // -------------------------------------------------------------------------
  const csvPath = getString(values, 'csv')
  if (csvPath !== undefined && csvPath.length > 0) {
    await writeCsv(csvPath, prospectCsv(ranked.filter((r) => r.winnable !== false)))
  }
  const csvLockedPath = getString(values, 'csv-locked')
  if (csvLockedPath !== undefined && csvLockedPath.length > 0) {
    await writeCsv(csvLockedPath, lockedCsv([...locked, ...unknown]))
  }

  await emit(report, {
    json,
    ...(outPath !== undefined ? { outPath } : {}),
    human: (r) => renderHuman(r, { limit, show: showRaw, csvPath, csvLockedPath }),
  })
}

function countBy<T>(rows: readonly T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) {
    const k = key(row)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

async function writeCsv(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${content}\n`, 'utf8')
}

/**
 * The working CSV.
 *
 * Every attacker-authored field goes through csvField, which both RFC-4180
 * quotes it and prefixes a leading =, + or - so a spreadsheet cannot execute it.
 * That guard is not decoration: this file is meant to be opened in Excel by a
 * person doing outreach, and a ticker is a string a stranger chose.
 */
function prospectCsv(rows: readonly ProspectRow[]): string {
  const headers = [
    'rank',
    'symbol',
    'name',
    'coin',
    'recipient',
    'recipient_class',
    'winnable',
    'verdict',
    'qf_usd_per_day',
    'tier_granted',
    'tier_money_qualifies',
    'days_at_gate',
    'current_spell_days',
    'expected_remaining_days',
    'buyback_enabled',
    'creator_tax_bps',
    'creator_net_bps',
    'creator_rate_pct_of_volume',
    'implied_volume_usd_per_day',
    'quote_token',
    'quote_symbol',
    'operator_usd_per_day',
    'expected_operator_usd',
    'score',
    'contact_x',
    'contact_telegram',
    'contact_other',
    'contact_sanitized',
    'recipient_moved_since_window',
    'winnability_reason',
  ]
  return toCsv(
    headers,
    rows.map((r) => {
      const chan = (kind: string): string =>
        (r.contact?.channels ?? [])
          .filter((c) => c.kind === kind)
          .map((c) => c.inert)
          .join(' | ')
      const other = (r.contact?.channels ?? [])
        .filter((c) => c.kind !== 'x' && c.kind !== 'telegram')
        .map((c) => `${c.kind}:${c.inert}`)
        .join(' | ')
      return [
        r.rank,
        r.symbol,
        r.name,
        r.coin,
        r.recipient,
        r.recipientClass,
        r.winnable === null ? 'UNKNOWN' : r.winnable,
        r.verdict,
        r.qfPerDayUsd,
        r.tierGranted ?? 'NONE',
        r.tierMoneyQualifies ?? 'NONE',
        r.daysAtGate,
        r.currentSpellDays,
        r.expectedRemainingDays === null ? null : r.expectedRemainingDays.toFixed(2),
        r.buybackEnabled === null ? 'UNKNOWN' : r.buybackEnabled,
        r.creatorTaxBps,
        r.creatorNetBps === null ? null : r.creatorNetBps.toFixed(4),
        r.creatorRatePct === null ? null : r.creatorRatePct.toFixed(4),
        r.impliedVolumePerDayUsd === null ? null : r.impliedVolumePerDayUsd.toFixed(0),
        r.quoteToken,
        r.quoteSymbol,
        r.operatorPerDayUsd === null ? null : r.operatorPerDayUsd.toFixed(2),
        r.expectedOperatorUsd === null ? null : r.expectedOperatorUsd.toFixed(2),
        r.score === null ? null : r.score.toFixed(2),
        chan('x'),
        chan('telegram'),
        other,
        r.contact?.anySanitized === true,
        r.recipientMovedSinceWindow === null ? 'UNKNOWN' : r.recipientMovedSinceWindow,
        r.winnabilityReason,
      ]
    }),
  )
}

function lockedCsv(rows: readonly ProspectRow[]): string {
  const headers = [
    'symbol',
    'coin',
    'recipient',
    'recipient_class',
    'verdict',
    'holder_id',
    'holder_label',
    'reassignment_path',
    'qf_usd_per_day',
    'buyback_enabled',
    'creator_net_bps',
    'quote_symbol',
    'why_not_winnable',
  ]
  return toCsv(
    headers,
    rows.map((r) => [
      r.symbol,
      r.coin,
      r.recipient,
      r.recipientClass,
      r.verdict,
      r.holderId ?? 'NONE',
      r.holderLabel ?? '',
      r.exitSelectorsFound.length > 0 ? r.exitSelectorsFound.join(' | ') : 'NONE',
      r.qfPerDayUsd,
      r.buybackEnabled === null ? 'UNKNOWN' : r.buybackEnabled,
      r.creatorNetBps === null ? null : r.creatorNetBps.toFixed(4),
      r.quoteSymbol,
      r.winnabilityReason,
    ]),
  )
}

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

function contactCell(row: ProspectRow): string {
  if (row.contact === null) return 'not read'
  if (!row.contact.hasSocialsGetter) return 'no socials()'
  const channels = row.contact.channels
  if (channels.length === 0) return 'none published'
  return channels
    .map((c) => `${c.kind}${c.sanitized ? '!' : ''}`)
    .join(',')
}

function renderHuman(
  report: Report<{
    tier: { id: string; name: string; gateQfPerDay: number; sustainedDays: number; cogsPerDay: number }
    basis: Record<string, unknown>
    ranking: { id: string; formula: string; describe: string; operatorBps: number; winRate: number; exitMode: string; available: Array<{ id: string; formula: string }> }
    summary: Record<string, unknown>
    holders: Array<{ holderId: string; label: string; coins: number; qfPerDayUsd: number | null; reassignmentPath: string }>
    prospects: ProspectRow[]
    lockedCoins: ProspectRow[]
    unmeasuredCoins: ProspectRow[]
  }>,
  options: { limit: number; show: string; csvPath?: string | undefined; csvLockedPath?: string | undefined },
): string {
  const r = report.result
  const out: string[] = []
  const s = r.summary as {
    coinsConsidered: number
    winnable: number
    locked: number
    unmeasured: number
    winnableSharePct: number | null
    winnableQfPerDayUsd: number | null
    lockedQfPerDayUsd: number | null
    winnableOperatorPerDayUsd: number | null
    byClass: Record<string, number>
    byVerdict: Record<string, number>
    reachable: number
    contactRead: number
  }
  const basis = r.basis as {
    live: boolean
    chainId: number | null
    headBlock: number | null
    qfBasis: string
    spellBasis: string
    windowDays: number
    survivalRestrictedToDays: number
    captureReadAtIso: string | null
  }

  out.push(
    banner([
      `${r.tier.id} ${r.tier.name} PROSPECT LIST - gate $${r.tier.gateQfPerDay.toLocaleString()}/day, ${r.tier.sustainedDays} sustained days`,
      basis.live
        ? `Recipiency, buyback, creator tax and quote asset read LIVE at block ${basis.headBlock?.toLocaleString() ?? '?'} on chain ${basis.chainId ?? '?'}.`
        : `OFFLINE: recipiency carried from a snapshot taken ${basis.captureReadAtIso ?? 'at an unrecorded time'}. Do not approach a dev on these rows.`,
      `${s.winnable} winnable / ${s.locked} locked / ${s.unmeasured} unmeasured out of ${s.coinsConsidered} coins at the gate.`,
    ]),
  )

  out.push(heading('1. WHAT THIS IS AND IS NOT'))
  out.push(
    `  This is the list VERDICT.md never produced. The verdict's arithmetic is unchanged: the winnable`,
  )
  out.push(
    `  population is ${s.winnable}, and the break-even book needs more than that. What is new is WHICH ${s.winnable}, in`,
  )
  out.push(`  what order, and how to reach them - and which ${s.locked} are gone and to whom.`)
  out.push('')
  out.push(`  QF basis      ${basis.qfBasis}`)
  out.push(`  Spell basis   ${basis.spellBasis}`)
  out.push(
    `  Winnability   ${basis.live ? 'derived live this run from bytecode' : 'carried from an artifact (--offline)'}, exit mode "${r.ranking.exitMode}"`,
  )

  out.push('')
  out.push(heading('2. RANKING FUNCTION'))
  out.push(`  --rank ${r.ranking.id}`)
  out.push(`    ${r.ranking.formula}`)
  out.push(`    ${r.ranking.describe}`)
  out.push(
    `  operatorBps ${r.ranking.operatorBps}   cogs/day $${r.tier.cogsPerDay}   win rate ${pct(r.ranking.winRate)} (ASSUMED, zero observations)`,
  )
  out.push('  swap it with --rank:')
  for (const f of r.ranking.available) {
    if (f.id === r.ranking.id) continue
    out.push(`    --rank ${f.id.padEnd(9)} ${f.formula}`)
  }

  if (options.show === 'winnable' || options.show === 'all') {
    out.push('')
    out.push(heading(`3. THE PROSPECTS - ${s.winnable} winnable coins, ranked`))
    out.push(
      subheading(
        `showing ${Math.min(options.limit, r.prospects.length)} of ${r.prospects.length}; --json and --csv carry every row`,
      ),
    )
    out.push(
      table(r.prospects.slice(0, options.limit), [
        { header: '#', value: (row) => String(row.rank ?? '?'), align: 'right' },
        { header: 'TICKER', value: (row) => inertText(row.symbol ?? 'UNKNOWN', 12) },
        { header: 'QF/DAY', value: (row) => usd(row.qfPerDayUsd, 0), align: 'right' },
        { header: 'TIER', value: (row) => row.tierGranted ?? '-' },
        { header: 'HELD', value: (row) => (row.currentSpellDays === null ? '?' : `${row.currentSpellDays}d`), align: 'right' },
        { header: 'E[REM]', value: (row) => (row.expectedRemainingDays === null ? '?' : `${row.expectedRemainingDays.toFixed(1)}d`), align: 'right' },
        { header: 'BB', value: (row) => (row.buybackEnabled === null ? '?' : row.buybackEnabled ? 'ON' : 'off') },
        { header: 'CREATOR%', value: (row) => (row.creatorRatePct === null ? '?' : `${row.creatorRatePct.toFixed(3)}%`), align: 'right' },
        { header: 'QUOTE', value: (row) => inertText(row.quoteSymbol ?? '?', 8) },
        { header: 'CLASS', value: (row) => row.recipientClass },
        { header: 'REACH', value: contactCell },
        { header: '$/DAY', value: (row) => usd(row.operatorPerDayUsd, 0), align: 'right' },
        { header: 'SCORE', value: (row) => (row.score === null ? 'n/a' : row.score.toFixed(0)), align: 'right' },
        { header: 'RECIPIENT', value: (row) => (row.recipient === null ? 'UNKNOWN' : shortAddress(row.recipient)) },
      ]),
    )
    out.push('')
    out.push(`  CREATOR% is this coin's OWN rate, branched on its own buyback flag via creatorNetBps().`)
    out.push(`  BB ON halves the creator's live leg (the other half vests). Never quote one rate for the book.`)
    out.push(
      `  REACH is the CHANNEL KINDS the deployer published, not the handles - a "!" means the string had to be`,
    )
    out.push(`  sanitised, which is worth reading by hand. The strings themselves are in --json and --csv.`)

    out.push('')
    out.push(subheading('CONTACT SURFACE - top of the list'))
    for (const row of r.prospects.slice(0, Math.min(10, r.prospects.length))) {
      const c = row.contact
      out.push(`  ${String(row.rank).padStart(3)}. ${inertText(row.symbol ?? row.coin, 16).padEnd(16)} ${row.coin}`)
      if (c === null) {
        out.push('       contact: NOT READ (--contact=false or --offline)')
        continue
      }
      if (c.channels.length === 0) {
        out.push(`       contact: none published (${c.emptySlots} empty slot(s) in socials())`)
      }
      for (const ch of c.channels) {
        out.push(`       ${ch.kind.padEnd(9)} ${ch.inert}${ch.sanitized ? '   [SANITISED]' : ''}`)
      }
      if (c.description !== null && c.description.length > 0) {
        out.push(`       blurb     ${c.description}`)
      }
    }
    out.push('')
    out.push(
      '  ^ UNTRUSTED. Written by the token deployer. Rendered inert. Never paste any of it into a model, and',
    )
    out.push('    verify a handle belongs to the dev by a second channel before contacting anyone.')
  }

  if (options.show === 'locked' || options.show === 'all') {
    out.push('')
    out.push(heading(`4. WHY THE OTHERS CANNOT BE WON - ${s.locked} coins, sized by holder`))
    out.push(
      table(r.holders, [
        { header: 'HOLDER', value: (h) => h.holderId },
        { header: 'WHAT IT IS', value: (h) => h.label },
        { header: 'COINS', value: (h) => String(h.coins), align: 'right' },
        { header: 'QF/DAY', value: (h) => usd(h.qfPerDayUsd, 0), align: 'right' },
        { header: 'REASSIGNMENT PATH', value: (h) => h.reassignmentPath },
      ]),
    )
    out.push('')
    for (const d of KNOWN_DISTRIBUTORS) {
      out.push(`  ${d.id}`)
      out.push(`    operator        ${d.operator}`)
      out.push(`    beacon          ${d.beacon}`)
      out.push(`    implementation  ${d.implementation}`)
      out.push(`    factory         ${d.factory}`)
      out.push(`    timelock        ${d.timelock}  minDelay ${d.timelockMinDelaySeconds / 86400}d`)
      out.push(`    ${d.note}`)
    }
    out.push('')
    out.push(subheading('the largest locked coins, by QF/day'))
    out.push(
      table(
        [...r.lockedCoins].sort((a, b) => (b.qfPerDayUsd ?? 0) - (a.qfPerDayUsd ?? 0)).slice(0, 15),
        [
          { header: 'TICKER', value: (row) => inertText(row.symbol ?? 'UNKNOWN', 12) },
          { header: 'QF/DAY', value: (row) => usd(row.qfPerDayUsd, 0), align: 'right' },
          { header: 'CLASS', value: (row) => row.recipientClass },
          { header: 'HOLDER', value: (row) => row.holderId ?? 'unaffiliated' },
          { header: 'EXIT', value: (row) => (row.exitSelectorsFound.length > 0 ? row.exitSelectorsFound.join(',') : 'NONE') },
          { header: 'RECIPIENT', value: (row) => (row.recipient === null ? 'UNKNOWN' : shortAddress(row.recipient)) },
        ],
      ),
    )
  }

  out.push('')
  out.push(heading('5. THE SIZE OF WHAT IS LEFT'))
  out.push(`  coins at the gate            ${s.coinsConsidered}`)
  out.push(`  winnable                     ${s.winnable}   (${pct(s.winnableSharePct === null ? null : s.winnableSharePct / 100)} of classified)`)
  out.push(`  locked                       ${s.locked}`)
  out.push(`  unmeasured (EXPLICIT UNKNOWN) ${s.unmeasured}`)
  out.push(`  QF/day across winnable       ${usd(s.winnableQfPerDayUsd, 0)}`)
  out.push(`  QF/day across locked         ${usd(s.lockedQfPerDayUsd, 0)}`)
  out.push(
    `  operator $/day if ALL winnable signed  ${usd(s.winnableOperatorPerDayUsd, 0)} gross of $${r.tier.cogsPerDay}/coin/day cost to serve`,
  )
  out.push(`  winnable coins with a reachable channel  ${s.reachable} of ${s.contactRead} read`)
  out.push('')
  out.push('  live recipient class:')
  for (const [k, n] of Object.entries(s.byClass).sort((a, b) => b[1] - a[1])) {
    out.push(`    ${String(n).padStart(4)}  ${k}`)
  }
  out.push('  winnability verdict:')
  for (const [k, n] of Object.entries(s.byVerdict).sort((a, b) => b[1] - a[1])) {
    out.push(`    ${String(n).padStart(4)}  ${k}`)
  }

  if (options.csvPath) out.push(`\n  prospect CSV written to ${options.csvPath}`)
  if (options.csvLockedPath) out.push(`  locked CSV written to ${options.csvLockedPath}`)

  out.push('')
  out.push(
    banner([
      'THIS LIST DOES NOT OVERTURN THE STOP.',
      `${s.winnable} winnable coins is what VERDICT.md measured and it is below the ${109} the book needs.`,
      'What the list changes is the shape of the question: a smaller book against a named set of coins is',
      'a decision an operator can now actually take, and reject, on evidence rather than on a ratio.',
    ]),
  )
  return out.join('\n')
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), main)
}

export { main as runProspects, SPEC as PROSPECTS_SPEC, prospectCsv, lockedCsv, PROSPECTS_SCHEMA }

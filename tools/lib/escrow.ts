/**
 * The fee-escrow indexing interface, with two interchangeable backends.
 *
 * WHAT THE ESCROW CAN AND CANNOT TELL US. Escrow credits key by (recipient,
 * asset) and carry NO coin identifier. So this module measures RECIPIENTS, not
 * coins. A recipient that is the designated fee recipient for two coins appears
 * here as one series. Per-coin attribution is a separate join through
 * PoolFeesSwept -> TokenLaunched, which is what pool-fees-index.ts does.
 * Nothing in this file may claim to count coins.
 *
 * THE CREDIT IS TWO EVENTS, NOT ONE. A live topic census on the V2 fee escrow
 * (0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e) established both shapes:
 *
 *   Credited(address indexed recipient, address indexed depositor, uint256 amount)
 *     3 topics, 1 data word. NATIVE value, carried by msg.value.
 *     THERE IS NO TOKEN PARAMETER. The second indexed param is the DEPOSITOR.
 *
 *   CreditedToken(address indexed recipient, address indexed token,
 *                 address indexed depositor, uint256 amount)
 *     4 topics, 1 data word. ERC-20 value. The SECOND indexed param is the asset.
 *
 * Reading either event as "(recipient, asset, amount) by position" is the defect
 * this module was rewritten to make impossible. On the native event that reading
 * keys every per-asset bucket by a DEPOSITOR address - a live run produced
 * buckets headed by 0xe5e7...e044, which is the V2 Meme Hook, listed as if it
 * were a currency - while per-recipient totals still summed correctly, so the
 * headline numbers looked right and the asset breakdown was nonsense.
 *
 * So asset-ness is decided by the DECODED EVENT SHAPE, in one place
 * (resolveCreditEvent): an event with no token parameter credits the chain's
 * native asset, which is address(0), the same sentinel
 * contracts/src/lib/SafeTransferLib.sol uses. A signature whose shape does not
 * match the mode it was handed to is a hard error, never a positional guess.
 */

import type { EventSpec } from './abi.ts'
import { decodeEventLog, normalizeAddress, parseEventSignature } from './abi.ts'
import type { Cache } from './cache.ts'
import { CheckpointStore } from './checkpoint.ts'
import type { ToolConfig } from './env.ts'
import type { HttpClient } from './http.ts'
import type { ScanProgress } from './logscan.ts'
import { BlockTimeResolver, scanLogs } from './logscan.ts'
import { NATIVE_ASSET_ADDRESS } from './prices.ts'
import type { ChainReader, RawLog } from './rpc.ts'

/** Which of the escrow's two credit events a scan is decoding. */
export type CreditEventMode = 'native' | 'token'

/** What a scan covers. `both` is the only mode that cannot silently undercount. */
export type CreditScanMode = CreditEventMode | 'both'

export const CREDIT_SCAN_MODES: readonly CreditScanMode[] = ['native', 'token', 'both']

/**
 * The native-value credit. Verified by live topic census; see the file header.
 * Its second indexed parameter is the DEPOSITOR, not an asset.
 */
export const NATIVE_CREDIT_EVENT =
  'Credited(address indexed recipient, address indexed depositor, uint256 amount)'

/** The ERC-20 credit. Verified by live topic census. Indexed param 1 IS the asset. */
export const TOKEN_CREDIT_EVENT =
  'CreditedToken(address indexed recipient, address indexed token, address indexed depositor, uint256 amount)'

export const DEFAULT_CREDIT_EVENT_BY_MODE: Record<CreditEventMode, string> = {
  native: NATIVE_CREDIT_EVENT,
  token: TOKEN_CREDIT_EVENT,
}

/**
 * topic0 as observed on chain. Pinned so a typo in an --event override that
 * still parses cannot silently scan for a topic the escrow never emits.
 */
export const VERIFIED_CREDIT_TOPIC0: Record<CreditEventMode, string> = {
  native: '0x4e45da441832cf53bdaa69235704fc0575e68210f459ee1562911024b12967d5',
  token: '0x5d104c62f50449fadfe6f4013c8f36588d32737f94b5ac9b83ddad33b3e1ffdf',
}

/**
 * Signatures the topic census can NAME when it meets them.
 *
 * The first two are the verified live shapes. The rest are the guesses this
 * tool shipped with before the census settled the question; they are kept only
 * so a census run against some other escrow can still label what it finds, and
 * NONE of them is a default any more.
 */
export const CANDIDATE_CREDIT_EVENTS = [
  NATIVE_CREDIT_EVENT,
  TOKEN_CREDIT_EVENT,
  'FeesCredited(address indexed recipient, address indexed quoteAsset, uint256 amount)',
  'CreditAdded(address indexed recipient, address indexed token, uint256 amount)',
  'FeeAccrued(address indexed recipient, address indexed token, uint256 amount)',
  'Deposit(address indexed recipient, address indexed token, uint256 amount)',
  'Claimed(address indexed recipient, address indexed token, uint256 amount)',
] as const

export interface EscrowCredit {
  recipient: string
  /** Asset address, or NATIVE_ASSET_ADDRESS for a native credit. */
  asset: string
  /** Which side of the escrow this came from. Never inferred from the address. */
  assetKind: 'native' | 'erc20'
  /** Minor units of `asset`. Never a float, never converted in place. */
  amountMinor: bigint
  blockNumber: bigint
  blockHash: string
  txHash: string
  logIndex: number
  timestampUnix: number
}

export interface EscrowQuery {
  escrow: string
  /** One plan per credit event to scan. Two of them is the merged mode. */
  events: readonly CreditEventPlan[]
  fromBlock: bigint
  toBlock: bigint
  fromUnix: number
  toUnix: number
  /** Restrict to these recipients, when the caller already has a shortlist. */
  recipients?: string[]
}

// ---------------------------------------------------------------------------
// Event shape resolution: the one place asset-ness is decided
// ---------------------------------------------------------------------------

/**
 * A signature that cannot be decoded in the mode it was handed to.
 *
 * This is deliberately fatal. The alternative - decode by position and hope -
 * is what produced per-asset buckets keyed by depositor addresses, and those
 * numbers were plausible enough that nobody caught them from the output.
 */
export class CreditEventShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CreditEventShapeError'
  }
}

/** A validated credit event, with every field located by name or by a checked shape. */
export interface CreditEventPlan {
  mode: CreditEventMode
  spec: EventSpec
  /** Declaration index of the recipient parameter. Always an indexed address. */
  recipientIndex: number
  /** Declaration index of the ERC-20 asset. ABSENT in native mode, by construction. */
  tokenIndex?: number
  /** Declaration index of the uint amount. */
  amountIndex: number
  /** True when the asset parameter was located by position because nothing was named. */
  tokenByPosition: boolean
  /** True when topic0 differs from the census-verified value for this mode. */
  topic0IsUnverified: boolean
}

const RECIPIENT_NAMES = new Set(['recipient', 'to', 'account', 'payee', 'beneficiary', 'creator'])
const TOKEN_NAMES = new Set(['token', 'asset', 'quoteasset', 'quote', 'currency', 'erc20'])
const AMOUNT_NAMES = new Set(['amount', 'value', 'credit', 'fee', 'wad'])

interface ModeShape {
  indexedAddresses: number
  expectation: string
  reference: string
}

const MODE_SHAPE: Record<CreditEventMode, ModeShape> = {
  native: {
    indexedAddresses: 2,
    expectation:
      'exactly 2 indexed address parameters (recipient, depositor) and exactly 1 non-indexed uint amount, and NO token parameter at all',
    reference: NATIVE_CREDIT_EVENT,
  },
  token: {
    indexedAddresses: 3,
    expectation:
      'exactly 3 indexed address parameters (recipient, token, depositor) and exactly 1 non-indexed uint amount',
    reference: TOKEN_CREDIT_EVENT,
  },
}

function shapeError(
  mode: CreditEventMode,
  signature: string,
  spec: EventSpec | undefined,
  problem: string,
): never {
  const shape = MODE_SHAPE[mode]
  throw new CreditEventShapeError(
    [
      `credit event does not match --mode ${mode}.`,
      `  mode ${mode} expects ${shape.expectation},`,
      `  i.e. the shape of  ${shape.reference}`,
      `  the signature given was  ${signature.trim()}`,
      ...(spec ? [`  (canonical ${spec.canonical}, topic0 ${spec.topic0})`] : []),
      `  ${problem}`,
      `Decoding it in ${mode} mode would put the wrong value in the asset column and produce a`,
      `plausible, wrong per-asset breakdown, so this run stops instead of guessing by position.`,
    ].join('\n'),
  )
}

/**
 * Validate a credit-event signature against a mode and locate every field.
 *
 * Fields are located BY NAME when the signature names them. The only positional
 * fallback left is the ERC-20 asset in an entirely unnamed token-mode
 * signature, and even that is only reached after the arity and the types have
 * been checked, is recorded on the plan, and is warned about in the report.
 *
 * Native mode never reads an asset out of the log at all - that is the whole
 * point - so it cannot be fooled by parameter order.
 */
export function resolveCreditEvent(signature: string, mode: CreditEventMode): CreditEventPlan {
  const shape = MODE_SHAPE[mode]
  let spec: EventSpec
  try {
    spec = parseEventSignature(signature)
  } catch (error) {
    shapeError(mode, signature, undefined, error instanceof Error ? error.message : String(error))
  }

  const indexed = spec.inputs
    .map((input, index) => ({ input, index }))
    .filter((entry) => entry.input.indexed)
  const plain = spec.inputs
    .map((input, index) => ({ input, index }))
    .filter((entry) => !entry.input.indexed)
  const nameOf = (i: { input: { name?: string } }): string | undefined => i.input.name?.toLowerCase()

  if (indexed.length !== shape.indexedAddresses) {
    shapeError(
      mode,
      signature,
      spec,
      `it has ${indexed.length} indexed parameter(s), not ${shape.indexedAddresses}.` +
        (mode === 'native' && indexed.length === 3
          ? ' A 3-indexed credit event is the ERC-20 one: use --mode token.'
          : mode === 'token' && indexed.length === 2
            ? ' A 2-indexed credit event carries NO token and credits the native asset: use --mode native.'
            : ''),
    )
  }
  for (const entry of indexed) {
    if (entry.input.type !== 'address') {
      shapeError(
        mode,
        signature,
        spec,
        `indexed parameter ${entry.index} has type "${entry.input.type}", not address.`,
      )
    }
  }
  if (plain.length !== 1) {
    shapeError(
      mode,
      signature,
      spec,
      `it has ${plain.length} non-indexed parameter(s); a credit carries exactly one uint amount.`,
    )
  }
  const amount = plain[0]!
  if (!amount.input.type.startsWith('uint')) {
    shapeError(
      mode,
      signature,
      spec,
      `the non-indexed parameter has type "${amount.input.type}", not a uint amount.`,
    )
  }
  const amountName = nameOf(amount)
  if (amountName !== undefined && !AMOUNT_NAMES.has(amountName)) {
    shapeError(
      mode,
      signature,
      spec,
      `the non-indexed parameter is named "${amountName}", which is not an amount ` +
        `(expected one of ${[...AMOUNT_NAMES].join(', ')}).`,
    )
  }

  const recipient = indexed[0]!
  const recipientName = nameOf(recipient)
  if (recipientName !== undefined && !RECIPIENT_NAMES.has(recipientName)) {
    shapeError(
      mode,
      signature,
      spec,
      `indexed parameter 0 is named "${recipientName}", but the recipient must come first ` +
        `(expected one of ${[...RECIPIENT_NAMES].join(', ')}). Every topic filter and every ` +
        `per-recipient series depends on that position.`,
    )
  }

  const topic0IsUnverified = spec.topic0 !== VERIFIED_CREDIT_TOPIC0[mode]

  if (mode === 'native') {
    // The decisive check. A native credit has NO asset in its log; a signature
    // that names one is the caller telling us they believe otherwise, and the
    // live escrow's second indexed param is the depositor.
    const named = spec.inputs
      .map((input, index) => ({ name: input.name?.toLowerCase(), index }))
      .find((entry) => entry.name !== undefined && TOKEN_NAMES.has(entry.name))
    if (named !== undefined) {
      shapeError(
        mode,
        signature,
        spec,
        `parameter ${named.index} is named "${named.name}", but a native credit carries no asset: ` +
          `its value arrives as msg.value and its second indexed parameter is the DEPOSITOR. ` +
          `If this event really does carry a token, it is the ERC-20 event - use --mode token.`,
      )
    }
    return {
      mode,
      spec,
      recipientIndex: recipient.index,
      amountIndex: amount.index,
      tokenByPosition: false,
      topic0IsUnverified,
    }
  }

  const candidates = indexed.slice(1)
  const byName = candidates.find((entry) => {
    const name = nameOf(entry)
    return name !== undefined && TOKEN_NAMES.has(name)
  })
  if (byName !== undefined) {
    return {
      mode,
      spec,
      recipientIndex: recipient.index,
      tokenIndex: byName.index,
      amountIndex: amount.index,
      tokenByPosition: false,
      topic0IsUnverified,
    }
  }
  const anyNamed = candidates.some((entry) => nameOf(entry) !== undefined)
  if (anyNamed) {
    shapeError(
      mode,
      signature,
      spec,
      `its indexed parameters are named (${candidates
        .map((c) => nameOf(c) ?? '<unnamed>')
        .join(', ')}) but none of them names the asset ` +
        `(expected one of ${[...TOKEN_NAMES].join(', ')}). Name the asset parameter so it is ` +
        `read by name; guessing which of these addresses is the currency is exactly the bug.`,
    )
  }
  // Fully unnamed, shape already checked: the verified ERC-20 event puts the
  // asset at indexed position 1. Recorded so the report can say so.
  return {
    mode,
    spec,
    recipientIndex: recipient.index,
    tokenIndex: candidates[0]!.index,
    amountIndex: amount.index,
    tokenByPosition: true,
    topic0IsUnverified,
  }
}

/** Resolve every plan a scan mode needs, in a stable order. */
export function resolveCreditEvents(
  mode: CreditScanMode,
  overrides: Partial<Record<CreditEventMode, string>> = {},
): CreditEventPlan[] {
  const modes: CreditEventMode[] = mode === 'both' ? ['native', 'token'] : [mode]
  return modes.map((m) => resolveCreditEvent(overrides[m] ?? DEFAULT_CREDIT_EVENT_BY_MODE[m], m))
}

export interface BackendPlanStep {
  description: string
  endpoint?: string
  estimatedRequests?: number
}

export interface EscrowBackend {
  readonly name: string
  plan(query: EscrowQuery): BackendPlanStep[]
  fetch(query: EscrowQuery): Promise<EscrowCredit[]>
  /** Source-specific caveats, merged into the report's methodLimits. */
  methodLimits(): string[]
}

// ---------------------------------------------------------------------------
// Backend 1: direct JSON-RPC log scan
// ---------------------------------------------------------------------------

export interface RpcEscrowBackendOptions {
  chunkBlocks: number
  cache?: Cache
  exactTimestamps: boolean
  anchorSpacing: number
  onProgress?: (message: string) => void
  /**
   * Where to checkpoint the scan. The definitive 30-day run is ~25.7M blocks
   * and thousands of queries over more than an hour; without this, a failure at
   * 90% loses 90%. Absent means no checkpointing.
   */
  checkpointDir?: string
  /** Ignore an existing checkpoint and scan the window again. */
  noResume?: boolean
  /** Keep the checkpoint after a successful scan. */
  keepCheckpoint?: boolean
  /** eth_getLogs per JSON-RPC batch. 1 disables batching. */
  batchSize?: number
  /** Chain id, needed to key the checkpoint so two chains cannot share one. */
  chainId?: number
  /** Rich progress with an ETA, wired to stderr by the CLI. */
  onScanProgress?: (progress: ScanProgress) => void
}

export class RpcEscrowBackend implements EscrowBackend {
  readonly name = 'rpc'
  readonly #reader: ChainReader
  readonly #options: RpcEscrowBackendOptions

  constructor(reader: ChainReader, options: RpcEscrowBackendOptions) {
    this.#reader = reader
    this.#options = options
  }

  plan(query: EscrowQuery): BackendPlanStep[] {
    const blocks = Number(query.toBlock - query.fromBlock + 1n)
    const chunks = Math.ceil(blocks / this.#options.chunkBlocks)
    const anchors = this.#options.exactTimestamps
      ? 0
      : Math.ceil(blocks / this.#options.anchorSpacing) + 1
    const topics = query.events.map((e) => `${e.mode}=${e.spec.topic0}`).join(', ')
    const batchSize = Math.max(1, this.#options.batchSize ?? 1)
    const requests = Math.ceil(chunks / batchSize)
    return [
      {
        description:
          `eth_getLogs over ${blocks.toLocaleString()} blocks in ${chunks.toLocaleString()} chunks of ${this.#options.chunkBlocks}, ` +
          `filtered to escrow ${query.escrow} and ${query.events.length} topic0 value(s) in ONE filter: ${topics}` +
          (batchSize > 1
            ? `, sent ${batchSize} per JSON-RPC batch (${requests.toLocaleString()} HTTP requests)`
            : '') +
          (this.#options.checkpointDir !== undefined ? ', checkpointed and resumable' : ''),
        estimatedRequests: requests,
      },
      {
        description: this.#options.exactTimestamps
          ? 'eth_getBlockByNumber for every distinct block containing a credit (exact timestamps)'
          : `eth_getBlockByNumber for an anchor ladder every ${this.#options.anchorSpacing} blocks, interpolating between anchors`,
        estimatedRequests: anchors,
      },
    ]
  }

  methodLimits(): string[] {
    return [
      'RPC backend: results are exactly what the endpoint serves. A node with a truncated log index, or one pruned below the requested range, produces a SHORT series that looks complete. No internal reconciliation can detect this - a short series is self-consistent. Cross-check the first and last block of the window, and a sample of its interior, against a second endpoint before publishing: `node tools/cross-verify.ts --secondary <url>`.',
      this.#options.exactTimestamps
        ? 'Block timestamps were fetched exactly for every block containing a credit.'
        : `Block timestamps are interpolated between anchors ${this.#options.anchorSpacing} blocks apart. Day bucketing can therefore misplace credits landing within seconds of UTC midnight. Re-run with --exact-timestamps if a day boundary is load-bearing.`,
    ]
  }

  async fetch(query: EscrowQuery): Promise<EscrowCredit[]> {
    if (query.events.length === 0) throw new Error('escrow query has no credit events to scan')
    const byTopic = new Map<string, CreditEventPlan>()
    for (const event of query.events) {
      const existing = byTopic.get(event.spec.topic0)
      if (existing !== undefined && existing.mode !== event.mode) {
        throw new CreditEventShapeError(
          `two credit events resolve to the same topic0 ${event.spec.topic0} in different modes ` +
            `(${existing.mode} and ${event.mode}). A merged scan could not tell their logs apart.`,
        )
      }
      byTopic.set(event.spec.topic0, event)
    }

    // Both credit events live at the same address and differ only in topic0, so
    // ONE filter with a topic0 OR-set covers a merged scan. That halves the
    // request budget against the measured ~1.3 req/s ceiling on this endpoint.
    const topic0s = [...byTopic.keys()]
    const topics: Array<string | string[] | null> = [topic0s.length === 1 ? topic0s[0]! : topic0s]
    // Every resolved plan puts the recipient at indexed position 0 - that is
    // enforced in resolveCreditEvent - so topic 1 is always the recipient. It is
    // re-checked here rather than assumed, because a filter on the wrong topic
    // returns a WRONG SUBSET, which looks exactly like a real, smaller answer.
    if (query.recipients && query.recipients.length > 0) {
      for (const event of query.events) {
        const firstIndexed = event.spec.inputs.findIndex((i) => i.indexed)
        if (firstIndexed !== event.recipientIndex) {
          throw new CreditEventShapeError(
            `${event.spec.canonical}: --recipients filters topic 1, but this event's recipient is ` +
              `not its first indexed parameter. Refusing to filter on the wrong topic.`,
          )
        }
      }
      topics.push(query.recipients.map((r) => `0x${'0'.repeat(24)}${normalizeAddress(r).slice(2)}`))
    }

    // Checkpointing is keyed by the EXACT scan parameters, so a resumed run
    // that changed the window or the topic set starts over instead of merging
    // two different measurements into one plausible-looking answer.
    let checkpoint: CheckpointStore | undefined
    if (this.#options.checkpointDir !== undefined) {
      const dir = this.#options.checkpointDir
      const identity = {
        chainId: this.#options.chainId ?? 0,
        address: query.escrow,
        topics,
        fromBlock: query.fromBlock,
        toBlock: query.toBlock,
        chunkBlocks: this.#options.chunkBlocks,
      }
      const opened = await CheckpointStore.open(dir, identity)
      checkpoint = opened.store
      if (opened.discardedReason !== undefined) {
        this.#options.onProgress?.(`checkpoint ignored: ${opened.discardedReason}`)
      }
      if (opened.resumedFrom !== undefined) {
        if (this.#options.noResume === true) {
          await checkpoint.discard()
          checkpoint = (await CheckpointStore.open(dir, identity)).store
        } else {
          this.#options.onProgress?.(
            `resuming from checkpoint: ${opened.resumedFrom.chunksCompleted} chunks, ` +
              `${opened.resumedFrom.logCount} logs, through block ${opened.resumedFrom.completedThroughBlock}`,
          )
        }
      }
    }

    const logs = await scanLogs(this.#reader, {
      address: query.escrow,
      topics,
      fromBlock: query.fromBlock,
      toBlock: query.toBlock,
      chunkBlocks: this.#options.chunkBlocks,
      ...(this.#options.cache ? { cache: this.#options.cache } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(this.#options.batchSize !== undefined ? { batchSize: this.#options.batchSize } : {}),
      ...(this.#options.onScanProgress ? { onScanProgress: this.#options.onScanProgress } : {}),
      onProgress: (info) =>
        this.#options.onProgress?.(
          `scanned ${info.fromBlock}-${info.toBlock}: ${info.logs} logs (${((info.done / info.total) * 100).toFixed(1)}%)`,
        ),
    })
    // Only once the scan came back whole. A checkpoint deleted before the logs
    // are in hand is a checkpoint that was not worth keeping.
    if (checkpoint !== undefined && this.#options.keepCheckpoint !== true) {
      await checkpoint.discard()
    }

    const resolver = new BlockTimeResolver(this.#reader, {
      exact: this.#options.exactTimestamps,
      anchorSpacing: this.#options.anchorSpacing,
      ...(this.#options.cache ? { cache: this.#options.cache } : {}),
      ...(this.#options.batchSize !== undefined ? { batchSize: this.#options.batchSize } : {}),
      onProgress: (done, total) => {
        // The ladder is the long pole on a 30-day window; a silent hour here
        // looks exactly like a hang.
        if (done % 500 === 0 || done === total) {
          this.#options.onProgress?.(`block-time anchors ${done}/${total}`)
        }
      },
    })
    await resolver.prime(query.fromBlock, query.toBlock)

    const credits: EscrowCredit[] = []
    for (const log of logs) {
      const topic0 = (log.topics[0] ?? '').toLowerCase()
      const plan = byTopic.get(topic0)
      if (plan === undefined) {
        // The endpoint served a topic nobody asked for. Fail closed rather than
        // decode it against whichever plan happens to be first.
        throw new CreditEventShapeError(
          `log at block ${log.blockNumber} index ${log.logIndex} has topic0 ${topic0}, which is not ` +
            `one of the scanned credit events (${topic0s.join(', ')}). The endpoint ignored the topic filter.`,
        )
      }
      const credit = decodeCredit(plan, log)
      credits.push({ ...credit, timestampUnix: await resolver.timestampOf(log.blockNumber) })
    }
    return credits
  }
}

/**
 * Decode one credit log against an already-validated plan.
 *
 * There is no field guessing here. resolveCreditEvent pinned each declaration
 * index before any log was fetched, and the asset comes from the plan's MODE:
 * native mode returns the native sentinel and never reads an address out of the
 * log, token mode reads the parameter the plan identified. That is the whole
 * fix - "which word is the asset" is answered once, from the event shape,
 * rather than per-log by position.
 */
export function decodeCredit(
  plan: CreditEventPlan,
  log: RawLog,
): Omit<EscrowCredit, 'timestampUnix'> {
  const decoded = decodeEventLog(plan.spec, log.topics, log.data)
  const recipient = decoded.values[plan.recipientIndex]
  const amount = decoded.values[plan.amountIndex]

  if (typeof recipient !== 'string' || typeof amount !== 'bigint') {
    throw new CreditEventShapeError(
      `credit event ${plan.spec.canonical} did not decode to (address recipient, ..., uint amount); ` +
        `got ${typeof recipient} recipient and ${typeof amount} amount.`,
    )
  }

  let asset: string
  if (plan.mode === 'native') {
    asset = NATIVE_ASSET_ADDRESS
  } else {
    const token = decoded.values[plan.tokenIndex!]
    if (typeof token !== 'string') {
      throw new CreditEventShapeError(
        `credit event ${plan.spec.canonical}: parameter ${plan.tokenIndex} did not decode to an ` +
          `address, so the asset column would be wrong.`,
      )
    }
    asset = token.toLowerCase()
  }

  return {
    recipient: recipient.toLowerCase(),
    asset,
    assetKind: plan.mode === 'native' ? 'native' : 'erc20',
    amountMinor: amount,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
  }
}

/**
 * Topic0 census over a sample range. This is how the event ABI was settled in
 * the first place: scan a few thousand blocks of escrow logs, count topic0
 * values, and match them against the candidate signatures. Re-run it against
 * any other escrow before trusting the pinned defaults there.
 */
export async function discoverTopics(
  reader: ChainReader,
  options: { escrow: string; fromBlock: bigint; toBlock: bigint; chunkBlocks: number; cache?: Cache },
): Promise<Array<{ topic0: string; count: number; matchedSignature?: string; topicCount: number; dataWords: number }>> {
  const logs = await scanLogs(reader, {
    address: options.escrow,
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    chunkBlocks: options.chunkBlocks,
    ...(options.cache ? { cache: options.cache } : {}),
  })

  const knownByTopic = new Map<string, string>()
  for (const candidate of CANDIDATE_CREDIT_EVENTS) {
    const spec = parseEventSignature(candidate)
    knownByTopic.set(spec.topic0, spec.canonical)
  }

  const census = new Map<string, { count: number; topicCount: number; dataWords: number }>()
  for (const log of logs) {
    const topic0 = log.topics[0]
    if (topic0 === undefined) continue
    const existing = census.get(topic0)
    const dataWords = Math.floor((log.data.length - 2) / 64)
    if (existing) {
      existing.count++
    } else {
      census.set(topic0, { count: 1, topicCount: log.topics.length, dataWords })
    }
  }

  return [...census.entries()]
    .map(([topic0, info]) => ({
      topic0,
      count: info.count,
      topicCount: info.topicCount,
      dataWords: info.dataWords,
      ...(knownByTopic.has(topic0) ? { matchedSignature: knownByTopic.get(topic0)! } : {}),
    }))
    .sort((a, b) => b.count - a.count)
}

// ---------------------------------------------------------------------------
// Backend 2: Bitquery-style GraphQL
// ---------------------------------------------------------------------------

/**
 * GraphQL document, kept in ONE place so a schema correction is a one-line
 * change. The shape follows Bitquery's EVM v2 `Events` selection. If the
 * upstream schema differs, only this constant and parseBitqueryEvents change.
 */
export const BITQUERY_EVENTS_QUERY = `query EscrowCredits(
  $network: evm_network!
  $address: String!
  $topic0: String!
  $since: DateTime
  $till: DateTime
  $limit: Int!
  $offset: Int!
) {
  EVM(network: $network, dataset: archive) {
    Events(
      where: {
        Log: { SmartContract: { is: $address }, Topics: { includes: { Hash: { is: $topic0 } } } }
        Block: { Time: { since: $since, till: $till } }
      }
      orderBy: { ascending: Block_Time }
      limit: { count: $limit, offset: $offset }
    ) {
      Block { Number Time Hash }
      Transaction { Hash }
      Log { Index Data Topics { Hash } }
    }
  }
}`

export interface BitqueryEscrowBackendOptions {
  url: string
  token: string
  network: string
  pageSize: number
  cache?: Cache
  onProgress?: (message: string) => void
}

export class BitqueryEscrowBackend implements EscrowBackend {
  readonly name = 'bitquery'
  readonly #http: HttpClient
  readonly #options: BitqueryEscrowBackendOptions

  constructor(http: HttpClient, options: BitqueryEscrowBackendOptions) {
    this.#http = http
    this.#options = options
  }

  plan(query: EscrowQuery): BackendPlanStep[] {
    // The Events query takes ONE topic0, so a merged scan is one paged query
    // per credit event rather than one filter covering both.
    return query.events.map((event) => ({
      description: `GraphQL Events pages of ${this.#options.pageSize}, network "${this.#options.network}", contract ${query.escrow}, ${event.mode} credit topic0 ${event.spec.topic0}, ${new Date(query.fromUnix * 1000).toISOString()} .. ${new Date(query.toUnix * 1000).toISOString()}`,
      endpoint: this.#options.url,
      estimatedRequests: 10,
    }))
  }

  methodLimits(): string[] {
    return [
      `GraphQL backend: network id "${this.#options.network}" must be the aggregator's id for chain 4663. If the aggregator does not index this chain the query returns an EMPTY result set, which is indistinguishable from "no credits" unless you check the row count against the RPC backend. Run both once and compare before trusting either.`,
      'Aggregator archives lag the chain head, typically by minutes but occasionally by hours. The most recent day in any GraphQL-sourced series is provisional.',
    ]
  }

  async fetch(query: EscrowQuery): Promise<EscrowCredit[]> {
    if (query.events.length === 0) throw new Error('escrow query has no credit events to scan')
    const credits: EscrowCredit[] = []
    for (const event of query.events) {
      let offset = 0
      for (;;) {
        const variables = {
          network: this.#options.network,
          address: query.escrow,
          topic0: event.spec.topic0,
          since: new Date(query.fromUnix * 1000).toISOString(),
          till: new Date(query.toUnix * 1000).toISOString(),
          limit: this.#options.pageSize,
          offset,
        }
        const response = await this.#http.request({
          url: this.#options.url,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.#options.token}`,
          },
          body: JSON.stringify({ query: BITQUERY_EVENTS_QUERY, variables }),
          label: 'bitquery:Events',
        })
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`bitquery: HTTP ${response.status}: ${response.body.slice(0, 300)}`)
        }
        const page = parseBitqueryEvents(response.body, event)
        credits.push(...page)
        this.#options.onProgress?.(
          `bitquery ${event.mode} page offset=${offset}: ${page.length} events`,
        )
        if (page.length < this.#options.pageSize) break
        offset += this.#options.pageSize
        if (offset > 500_000) {
          throw new Error('bitquery: refusing to page past 500k events; narrow the window')
        }
      }
    }
    // One merged, time-ordered series regardless of how many events fed it.
    credits.sort((a, b) => a.timestampUnix - b.timestampUnix || a.logIndex - b.logIndex)
    return credits
  }
}

interface BitqueryEventRow {
  Block?: { Number?: string | number; Time?: string; Hash?: string }
  Transaction?: { Hash?: string }
  Log?: { Index?: string | number; Data?: string; Topics?: Array<string | { Hash?: string }> }
}

/** Parse a GraphQL response into credits. Fails closed on a GraphQL `errors` block. */
export function parseBitqueryEvents(body: string, plan: CreditEventPlan): EscrowCredit[] {
  const parsed = JSON.parse(body) as {
    data?: { EVM?: { Events?: BitqueryEventRow[] } }
    errors?: Array<{ message?: string }>
  }
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`bitquery: ${parsed.errors.map((e) => e.message ?? 'error').join('; ')}`)
  }
  const rows = parsed.data?.EVM?.Events
  if (rows === undefined) {
    throw new Error('bitquery: response has no data.EVM.Events; the schema has changed')
  }

  return rows.map((row, i) => {
    const topics = (row.Log?.Topics ?? []).map((t) =>
      typeof t === 'string' ? t : (t.Hash ?? ''),
    )
    const data = row.Log?.Data ?? '0x'
    const blockTime = row.Block?.Time
    if (blockTime === undefined) throw new Error(`bitquery: row ${i} has no Block.Time`)
    const decoded = decodeCredit(plan, {
      address: '',
      topics: topics.map((t) => t.toLowerCase()),
      data: data.startsWith('0x') ? data : `0x${data}`,
      blockNumber: BigInt(row.Block?.Number ?? 0),
      blockHash: String(row.Block?.Hash ?? ''),
      transactionHash: String(row.Transaction?.Hash ?? ''),
      logIndex: Number(row.Log?.Index ?? 0),
      removed: false,
    })
    return { ...decoded, timestampUnix: Math.floor(Date.parse(blockTime) / 1000) }
  })
}

/** Choose the backend the config asks for, wired with the right dependencies. */
export function buildEscrowBackend(
  config: ToolConfig,
  deps: {
    reader?: ChainReader
    http: HttpClient
    cache?: Cache
    exactTimestamps: boolean
    anchorSpacing: number
    onProgress?: (message: string) => void
    /** Survivability options for a long scan. RPC backend only. */
    checkpointDir?: string
    noResume?: boolean
    keepCheckpoint?: boolean
    batchSize?: number
    onScanProgress?: (progress: ScanProgress) => void
  },
): EscrowBackend {
  if (config.escrowBackend === 'bitquery') {
    if (config.bitqueryToken === undefined) {
      throw new Error('ESCROW_BACKEND=bitquery requires BITQUERY_TOKEN')
    }
    return new BitqueryEscrowBackend(deps.http, {
      url: config.bitqueryUrl,
      token: config.bitqueryToken,
      network: config.bitqueryNetwork,
      pageSize: 25_000,
      ...(deps.cache ? { cache: deps.cache } : {}),
      ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
    })
  }
  if (deps.reader === undefined) throw new Error('rpc backend requires a ChainReader')
  return new RpcEscrowBackend(deps.reader, {
    chunkBlocks: config.logChunkBlocks,
    chainId: config.chainId,
    ...(deps.cache ? { cache: deps.cache } : {}),
    exactTimestamps: deps.exactTimestamps,
    anchorSpacing: deps.anchorSpacing,
    ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
    ...(deps.checkpointDir !== undefined ? { checkpointDir: deps.checkpointDir } : {}),
    ...(deps.noResume !== undefined ? { noResume: deps.noResume } : {}),
    ...(deps.keepCheckpoint !== undefined ? { keepCheckpoint: deps.keepCheckpoint } : {}),
    ...(deps.batchSize !== undefined ? { batchSize: deps.batchSize } : {}),
    ...(deps.onScanProgress ? { onScanProgress: deps.onScanProgress } : {}),
  })
}

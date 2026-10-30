/**
 * watch.ts - the daily monitor.
 *
 * Three families of test, and the third is the point of the file.
 *
 *   THE ROLLING WINDOW. Folding is accumulative and pruning is lossless for the
 *   gate count. Both are load-bearing: a double-counted day inflates the
 *   standing population, and a lossy prune deflates it, and either one moves
 *   the number that decides the business.
 *
 *   THE CAPTURE READ. Classification runs against RECORDED deployed bytecode -
 *   a real beacon proxy over the incumbent's beacon, a real EIP-7702
 *   designator, two real EIP-1167 clones whose implementations differ in
 *   exactly the one respect that decides winnability.
 *
 *   THE REFUSALS. A day nobody scanned, a recipient nobody could price, a
 *   population nobody measured. Each of those has a rendering that is NOT zero
 *   and NOT flat, and each has a test here, because every one of them fails in
 *   the direction that looks like good news.
 */

import { describe, expect, it } from 'vitest'
import {
  INCUMBENT_BEACON,
  TRANSFER_RECIPIENT_SIGNATURE,
  WATCH_STATE_SCHEMA,
  WatchStateError,
  classifyRecipient,
  decideVerdict,
  deriveFlipPoint,
  emptyState,
  flipPointCrossing,
  foldCredits,
  movementOf,
  parseWatchState,
  pruneState,
  readCapture,
  scannedThroughDayUnix,
  seedFromEscrowDocument,
  standingAtGate,
  summarizeCapture,
  usdOfRow,
  type CodeReader,
  type WatchObservation,
  type WatchState,
} from '../watch.ts'
import { functionSelector } from '../lib/abi.ts'
import { NATIVE_ASSET_ADDRESS, PriceBook } from '../lib/prices.ts'
import { parseEscrowSeriesDocument } from '../lib/series.ts'
import { SECONDS_PER_DAY } from '../lib/time.ts'
import type { EscrowCredit } from '../lib/escrow.ts'
import type { RepriceInputs } from '../reprice.ts'
import { TERMS, TIERS } from '../../config/protocol.ts'
import { loadFixture } from './helpers.ts'

const ESCROW = '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e'
const DAY0 = Date.UTC(2026, 8, 1) / 1000
const ALICE = '0x1111111111111111111111111111111111111111'
const BOB = '0x2222222222222222222222222222222222222222'
const CAROL = '0x3333333333333333333333333333333333333333'
const MYSTERY_TOKEN = '0x9999999999999999999999999999999999999999'

function prices(withMystery = false): PriceBook {
  const book = new PriceBook({ ETH: 2_000 }, 'test:fixed', DAY0, [
    { address: NATIVE_ASSET_ADDRESS, symbol: 'ETH', decimals: 18 },
  ])
  book.registerAsset({ address: MYSTERY_TOKEN, symbol: 'MYST', decimals: 18 }, withMystery ? 1 : undefined)
  return book
}

function state(overrides: Partial<WatchState> = {}): WatchState {
  return {
    ...emptyState({
      chainId: 4663,
      escrow: ESCROW,
      mode: 'both',
      gateQfPerDay: TIERS.T1.gateQfPerDay,
      retainMinUsd: 1_000,
      retainDays: 32,
    }),
    ...overrides,
  }
}

function credit(recipient: string, dayIndex: number, eth: string, asset = NATIVE_ASSET_ADDRESS): EscrowCredit {
  return {
    recipient,
    asset,
    assetKind: asset === NATIVE_ASSET_ADDRESS ? 'native' : 'erc20',
    amountMinor: BigInt(eth),
    blockNumber: BigInt(1_000 + dayIndex),
    blockHash: '0xhash',
    txHash: '0xtx',
    logIndex: 0,
    timestampUnix: DAY0 + dayIndex * SECONDS_PER_DAY + 3_600,
  }
}

/** One ETH-denominated credit worth `usd` at the $2,000 fixture price. */
function usdCredit(recipient: string, dayIndex: number, usd: number): EscrowCredit {
  return credit(recipient, dayIndex, String(BigInt(Math.round((usd / 2_000) * 1e18))))
}

/** A state whose days 0..n-1 are all complete, wired for the window helpers. */
function scannedThrough(target: WatchState, days: number): WatchState {
  target.scannedFromDayUnix = DAY0
  // The checkpoint's clock sits inside the day AFTER the last complete one, so
  // scannedThroughDayUnix() lands on day (days - 1).
  target.lastScannedBlockUnix = DAY0 + days * SECONDS_PER_DAY + 3_600
  target.lastScannedBlock = '5000'
  return target
}

// ---------------------------------------------------------------------------
// State identity
// ---------------------------------------------------------------------------

describe('parseWatchState', () => {
  const expected = {
    chainId: 4663,
    escrow: ESCROW,
    mode: 'both' as const,
    gateQfPerDay: TIERS.T1.gateQfPerDay,
    retainMinUsd: 1_000,
  }

  it('accepts a state written for the same measurement', () => {
    expect(parseWatchState(state(), expected).schema).toBe(WATCH_STATE_SCHEMA)
  })

  it('refuses a state written for a different gate, escrow, chain or floor', () => {
    // Continuing would mix two definitions into one trend, and the movement it
    // reported would be an artefact of the flag change rather than the market.
    // no-hardcoded-rates: allow tier-gate-literal - a deliberately mismatched gate, chosen only to differ from the expected one; the thrown message quotes it back
    expect(() => parseWatchState(state({ gateQfPerDay: 2_500 }), expected)).toThrow(/gate 2500/)
    expect(() => parseWatchState(state({ retainMinUsd: 500 }), expected)).toThrow(/retain-min-usd/)
    expect(() => parseWatchState(state({ chainId: 1 }), expected)).toThrow(/chainId/)
    expect(() => parseWatchState({ schema: 'watch-state-0' }, expected)).toThrow(WatchStateError)
  })
})

// ---------------------------------------------------------------------------
// The rolling window
// ---------------------------------------------------------------------------

describe('foldCredits', () => {
  it('accumulates minor units across runs instead of overwriting them', () => {
    const target = state()
    foldCredits(target, [credit(ALICE, 0, '1000'), credit(ALICE, 0, '500')])
    foldCredits(target, [credit(ALICE, 0, '250')])
    expect(target.recipients[ALICE]?.[String(DAY0)]?.byAssetMinor[NATIVE_ASSET_ADDRESS]).toBe('1750')
    expect(target.recipients[ALICE]?.[String(DAY0)]?.credits).toBe(3)
    expect(target.dayTotals[String(DAY0)]?.byAssetMinor[NATIVE_ASSET_ADDRESS]).toBe('1750')
  })

  it('keeps amounts as bigint minor units, never as floats', () => {
    const target = state()
    // 2^63 + 1: unrepresentable as a double, and the exact figure a fee escrow
    // deals in. A float round-trip loses the low digits silently.
    foldCredits(target, [credit(ALICE, 0, '9223372036854775809')])
    foldCredits(target, [credit(ALICE, 0, '1')])
    expect(target.recipients[ALICE]?.[String(DAY0)]?.byAssetMinor[NATIVE_ASSET_ADDRESS]).toBe(
      '9223372036854775810',
    )
  })

  it('separates days and assets', () => {
    const target = state()
    foldCredits(target, [
      credit(ALICE, 0, '100'),
      credit(ALICE, 1, '200'),
      credit(ALICE, 1, '7', MYSTERY_TOKEN),
    ])
    expect(Object.keys(target.recipients[ALICE] ?? {})).toHaveLength(2)
    expect(target.recipients[ALICE]?.[String(DAY0 + SECONDS_PER_DAY)]?.byAssetMinor).toEqual({
      [NATIVE_ASSET_ADDRESS]: '200',
      [MYSTERY_TOKEN]: '7',
    })
  })
})

describe('usdOfRow', () => {
  it('returns null when ANY asset in the row has no price', () => {
    const target = state()
    foldCredits(target, [usdCredit(ALICE, 0, 5_000), credit(ALICE, 0, '1', MYSTERY_TOKEN)])
    const row = target.recipients[ALICE]![String(DAY0)]!
    expect(usdOfRow(row, prices())).toBeNull()
    // A single unpriced dust credit does not make the day $5,000; it makes it
    // unknown. Summing the priced part and calling it the total is the bug.
    expect(usdOfRow(row, prices(true))).toBeCloseTo(5_000, 6)
  })
})

describe('pruneState', () => {
  it('drops complete days below the retention floor and counts what it dropped', () => {
    const target = scannedThrough(state(), 3)
    foldCredits(target, [usdCredit(ALICE, 0, 5_000), usdCredit(BOB, 0, 10)])
    pruneState(target, prices())
    expect(target.recipients[ALICE]?.[String(DAY0)]).toBeDefined()
    expect(target.recipients[BOB]).toBeUndefined()
    expect(target.dayTotals[String(DAY0)]?.prunedRows).toBe(1)
    // The escrow-wide total still carries the pruned amount: the day total is
    // computed before pruning and is never reduced by it.
    expect(target.dayTotals[String(DAY0)]?.byAssetMinor[NATIVE_ASSET_ADDRESS]).toBeDefined()
  })

  it('never prunes an INCOMPLETE day, which could still grow past the floor', () => {
    const target = scannedThrough(state(), 1) // only day 0 is complete
    foldCredits(target, [usdCredit(ALICE, 1, 10)])
    pruneState(target, prices())
    expect(target.recipients[ALICE]?.[String(DAY0 + SECONDS_PER_DAY)]).toBeDefined()
  })

  it('never prunes an UNPRICED day, which is not known to be below anything', () => {
    const target = scannedThrough(state(), 3)
    foldCredits(target, [credit(ALICE, 0, '1', MYSTERY_TOKEN)])
    pruneState(target, prices())
    expect(target.recipients[ALICE]?.[String(DAY0)]).toBeDefined()
  })

  it('drops days that fall out of the retention window entirely', () => {
    const target = scannedThrough(state({ retainDays: 3 }), 10)
    target.retainDays = 3
    foldCredits(target, [usdCredit(ALICE, 0, 5_000), usdCredit(ALICE, 9, 5_000)])
    pruneState(target, prices())
    expect(target.recipients[ALICE]?.[String(DAY0)]).toBeUndefined()
    expect(target.dayTotals[String(DAY0)]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Standing at the gate
// ---------------------------------------------------------------------------

describe('standingAtGate', () => {
  function sevenDayState(): WatchState {
    const target = scannedThrough(state(), 7)
    // ALICE clears on 4 of 7 days - a bare majority, so her median clears.
    for (const day of [0, 1, 2, 3]) foldCredits(target, [usdCredit(ALICE, day, 2_000)])
    for (const day of [4, 5, 6]) foldCredits(target, [usdCredit(ALICE, day, 10)])
    // BOB clears on 3 of 7 - one short, so his median does not.
    for (const day of [0, 1, 2]) foldCredits(target, [usdCredit(BOB, day, 50_000)])
    return target
  }

  it('counts a recipient whose trailing median clears the gate, and only that recipient', () => {
    const target = sevenDayState()
    pruneState(target, prices())
    const standing = standingAtGate(target, prices(), { gate: 1_000, windowDays: 7 })
    expect(standing.count).toBe(1)
    expect(standing.recipients).toEqual([ALICE])
    expect(standing.refused).toBe(false)
  })

  it('gives the same answer after pruning as before it', () => {
    // This is the pruning rule's whole justification. If the two ever differ,
    // the state has been throwing away days the count needs.
    const unpruned = sevenDayState()
    const pruned = sevenDayState()
    pruneState(pruned, prices())
    expect(standingAtGate(pruned, prices(), { gate: 1_000, windowDays: 7 }).count).toBe(
      standingAtGate(unpruned, prices(), { gate: 1_000, windowDays: 7 }).count,
    )
  })

  it('REFUSES the count when a recipient in the window has an unpriced day', () => {
    const target = sevenDayState()
    foldCredits(target, [credit(CAROL, 3, '1', MYSTERY_TOKEN)])
    const standing = standingAtGate(target, prices(), { gate: 1_000, windowDays: 7 })
    expect(standing.count).toBeUndefined()
    expect(standing.refused).toBe(true)
    expect(standing.unpricedRecipients).toBe(1)
    // The lower bound survives in `floor`, but it is never the answer.
    expect(standing.floor).toBe(1)
    expect(standing.refusedReason).toMatch(/lower bound/)
  })

  it('REFUSES when the window is not fully scanned, rather than reading gaps as quiet days', () => {
    const target = scannedThrough(state(), 3)
    foldCredits(target, [usdCredit(ALICE, 0, 50_000)])
    const standing = standingAtGate(target, prices(), { gate: 1_000, windowDays: 7 })
    expect(standing.count).toBeUndefined()
    expect(standing.refusedReason).toMatch(/complete day/)
  })

  it('REFUSES a gate below the retention floor, where pruned days prove nothing', () => {
    const target = scannedThrough(state(), 7)
    const standing = standingAtGate(target, prices(), { gate: 500, windowDays: 7 })
    expect(standing.count).toBeUndefined()
    expect(standing.refusedReason).toMatch(/retention floor/)
  })

  it('REFUSES an even median window, which a pruned series cannot decide', () => {
    const target = scannedThrough(state(), 8)
    const standing = standingAtGate(target, prices(), { gate: 1_000, windowDays: 6 })
    expect(standing.count).toBeUndefined()
    expect(standing.refusedReason).toMatch(/even/)
  })
})

describe('scannedThroughDayUnix', () => {
  it('never claims the current, partly-scanned UTC day', () => {
    const target = scannedThrough(state(), 5)
    expect(scannedThroughDayUnix(target)).toBe(DAY0 + 4 * SECONDS_PER_DAY)
  })

  it('is null before any complete day has been scanned', () => {
    expect(scannedThroughDayUnix(state())).toBeNull()
    const target = state({ scannedFromDayUnix: DAY0, lastScannedBlockUnix: DAY0 + 3_600 })
    expect(scannedThroughDayUnix(target)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Seeding from a recorded escrow-index document
// ---------------------------------------------------------------------------

describe('seedFromEscrowDocument', () => {
  const document = parseEscrowSeriesDocument(loadFixture('watch-seed-escrow.json'))

  it('loads a recorded escrow-index slice and resumes at its end block', () => {
    const target = state()
    seedFromEscrowDocument(target, document)
    expect(Object.keys(target.recipients)).toHaveLength(document.recipients.length)
    expect(target.lastScannedBlock).toBe(document.toBlock)
    expect(target.scannedFromDayUnix).toBe(document.windowStartDayUnix)
    // The document's own last day ends at a block, not at midnight, so it is
    // treated as incomplete and the forward scan finishes it.
    expect(scannedThroughDayUnix(target)).toBe(document.windowEndDayUnix - SECONDS_PER_DAY)
  })

  it('preserves the recorded per-asset minor units exactly', () => {
    const target = state()
    seedFromEscrowDocument(target, document)
    const recipient = document.recipients[0]!
    const day = recipient.days.find((d) => Object.keys(d.byAssetMinor).length > 0)!
    expect(target.recipients[recipient.recipient.toLowerCase()]?.[String(day.dayUnix)]?.byAssetMinor).toEqual(
      Object.fromEntries(Object.entries(day.byAssetMinor).map(([a, v]) => [a.toLowerCase(), v])),
    )
  })

  it('refuses a document for another escrow or chain', () => {
    expect(() => seedFromEscrowDocument(state(), { ...document, escrow: '0xdead' })).toThrow(/escrow/)
    expect(() => seedFromEscrowDocument(state(), { ...document, chainId: 1 })).toThrow(/chain/)
  })

  it('refuses a document that does not record the block it was scanned to', () => {
    // full-history-reduced-doc.json writes toBlock "0". Seeding from it would
    // leave no checkpoint, the forward scan would bootstrap from scratch, and
    // every day the seed loaded would be counted twice.
    expect(() => seedFromEscrowDocument(state(), { ...document, toBlock: '0' })).toThrow(/checkpoint/)
  })
})

// ---------------------------------------------------------------------------
// The capture read, against recorded bytecode
// ---------------------------------------------------------------------------

interface CodeFixture {
  transferCreatorFeeRecipientSelector: string
  code: Record<string, string>
  classes: Record<string, string>
  implementations: Record<string, string>
}

describe('classifyRecipient', () => {
  const fixture = loadFixture<CodeFixture>('watch-recipient-code.json')
  const addresses = Object.keys(fixture.code)

  it('agrees with the recorded classification for every recorded recipient', () => {
    for (const address of addresses) {
      const classified = classifyRecipient(address, fixture.code[address]!)
      expect(classified.cls, address).toBe(fixture.classes[address])
    }
  })

  it('pins the exit selector the whole winnability question turns on', () => {
    expect(functionSelector(TRANSFER_RECIPIENT_SIGNATURE)).toBe(
      fixture.transferCreatorFeeRecipientSelector,
    )
  })

  it('treats an EOA and an EIP-7702 account as winnable', () => {
    for (const [address, cls] of Object.entries(fixture.classes)) {
      if (cls !== 'EOA' && cls !== 'EOA_7702') continue
      // A 7702 designator delegates execution; it does not remove the key. The
      // account can still sign factory.transferCreatorFeeRecipient, so counting
      // it as captured would understate the winnable market.
      expect(classifyRecipient(address, fixture.code[address]!).winnable, address).toBe(true)
    }
  })

  it('treats the incumbent distributor as unwinnable at any acquisition rate', () => {
    const address = Object.entries(fixture.classes).find(([, c]) => c === 'INCUMBENT_DISTRIBUTOR')![0]
    const classified = classifyRecipient(address, fixture.code[address]!)
    expect(classified.winnable).toBe(false)
    expect(fixture.code[address]!.toLowerCase()).toContain(INCUMBENT_BEACON)
    expect(classified.reason).toMatch(/no exit path/)
  })

  it('decides a clone on its IMPLEMENTATION, which is where the exit selector lives', () => {
    const clones = Object.entries(fixture.classes).filter(([, c]) => c === 'CLONE_1167')
    const verdicts = clones.map(([address]) => {
      const first = classifyRecipient(address, fixture.code[address]!)
      const implementationCode = fixture.implementations[first.implementation!]
      return classifyRecipient(address, fixture.code[address]!, implementationCode).winnable
    })
    // The two recorded clones differ in exactly this respect. Judging the
    // 45-byte stub alone would call both unwinnable on a delegation prologue.
    expect(verdicts).toContain(true)
    expect(verdicts).toContain(false)
  })

  it('refuses to call a clone winnable when its implementation was not read', () => {
    const address = Object.entries(fixture.classes).find(([, c]) => c === 'CLONE_1167')![0]
    expect(classifyRecipient(address, fixture.code[address]!).winnable).toBe(false)
    expect(classifyRecipient(address, fixture.code[address]!).reason).toMatch(/not read/)
  })
})

describe('readCapture', () => {
  const fixture = loadFixture<CodeFixture>('watch-recipient-code.json')

  function reader(codes: Record<string, string>): CodeReader {
    return {
      async getCode(addresses: readonly string[]): Promise<Map<string, string>> {
        const out = new Map<string, string>()
        for (const address of addresses) {
          const code = codes[address]
          if (code !== undefined) out.set(address, code)
        }
        return out
      },
    }
  }

  it('resolves clone implementations in a second pass and measures the winnable share', async () => {
    const codes = { ...fixture.code, ...fixture.implementations }
    const { summary, rows } = await readCapture(reader(codes), Object.keys(fixture.code), DAY0)
    expect(summary.classified).toBe(5)
    expect(summary.unreadable).toBe(0)
    // EOA + EOA_7702 + the one clone whose implementation carries the exit.
    expect(summary.winnable).toBe(3)
    expect(summary.winnableShare).toBeCloseTo(0.6, 10)
    expect(rows.filter((r) => r.cls === 'CLONE_1167').map((r) => r.winnable).sort()).toEqual([false, true])
  })

  it('leaves an unreadable recipient OUT of the classification rather than calling it an EOA', () => {
    // eth_getCode returning nothing is a transport failure. '0x' means "there
    // is no code, this is a signable account", which is the winnable class - so
    // a dropped response must never be read as one.
    const missing = '0x4444444444444444444444444444444444444444'
    const summary = summarizeCapture([], { readAtUnix: DAY0, source: 'live', unreadable: 1 })
    expect(summary.classified).toBe(0)
    expect(summary.winnable).toBe(0)
    expect(summary.unreadable).toBe(1)
    expect(classifyRecipient(missing, '0x').cls).toBe('EOA')
  })
})

// ---------------------------------------------------------------------------
// The flip point and the alarm
// ---------------------------------------------------------------------------

describe('deriveFlipPoint', () => {
  it('reproduces the 109 on file from the terms on file, rather than hardcoding it', () => {
    const derived = deriveFlipPoint({
      gateQfPerDay: TIERS.T1.gateQfPerDay,
      operatorBps: TERMS.operatorBps,
      cogsPerDayUsd: TIERS.T1.cogsPerDay,
      fixedCostMonthlyUsd: 12_000,
      winRate: 0.1,
    })
    expect(derived.contributionPerClientDayUsd).toBeCloseTo(37, 10)
    expect(derived.breakEvenConcurrentClients).toBeCloseTo(10.8108, 4)
    expect(derived.population).toBe(109)
  })

  it('moves when the take moves, which is why it is derived', () => {
    const at1000 = deriveFlipPoint({
      gateQfPerDay: TIERS.T1.gateQfPerDay,
      operatorBps: 1_000,
      cogsPerDayUsd: 13,
      fixedCostMonthlyUsd: 12_000,
      winRate: 0.1,
    })
    expect(at1000.population).toBe(46)
  })

  it('has no flip point at all when the client loses money', () => {
    const derived = deriveFlipPoint({
      // no-hardcoded-rates: allow tier-gate-literal - the $250/day gate config/protocol.ts DELETED, kept here to show it is the losing one
      gateQfPerDay: 250,
      operatorBps: 500,
      cogsPerDayUsd: 13,
      fixedCostMonthlyUsd: 12_000,
      winRate: 0.1,
    })
    expect(derived.population).toBeNull()
    expect(derived.breakEvenConcurrentClients).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('decideVerdict', () => {
  const flip = deriveFlipPoint({
    gateQfPerDay: TIERS.T1.gateQfPerDay,
    operatorBps: TERMS.operatorBps,
    cogsPerDayUsd: TIERS.T1.cogsPerDay,
    fixedCostMonthlyUsd: 12_000,
    winRate: 0.1,
  })

  function inputs(overrides: Partial<RepriceInputs> = {}): RepriceInputs {
    return {
      tenureDays: 11.59,
      buybackOnRate: 0,
      operatorBps: TERMS.operatorBps,
      qfPerDayUsd: TIERS.T1.gateQfPerDay,
      tier: 'T1',
      cogsPerDayUsd: TIERS.T1.cogsPerDay,
      budgetBps: TERMS.budgetBpsDefault,
      fixedCostMonthlyUsd: 12_000,
      cacUsd: 0,
      onboardingCostUsd: 0,
      clientsAboveGate: 73,
      winRate: 0.1,
      goThreshold: 20,
      stopThreshold: 40,
      ...overrides,
    }
  }

  it('reproduces the STOP on file when the population is measured', () => {
    const line = decideVerdict(inputs(), flip, 73)
    expect(line.verdict).toBe('STOP')
    expect(line.feasibilityRatio).toBeCloseTo(0.6753, 4)
  })

  it('REFUSES rather than returning GO when the winnable population is unmeasured', () => {
    // This is the dangerous case and the reason decideVerdict exists as its own
    // function. reprice.ts skips the acquisition-feasibility check when no
    // population is supplied, and that check is the ONLY one the measured
    // verdict failed - so passing the unknown through returns a confident GO on
    // exactly the morning the monitor's inputs went missing.
    const line = decideVerdict(inputs({ clientsAboveGate: undefined }), flip, null)
    expect(line.verdict).toBe('UNKNOWN')
    expect(line.verdict).not.toBe('GO')
    expect(line.feasibilityRatio).toBeNull()
    expect(line.headline).toMatch(/REFUSED/)
  })

  it('still reports the feasibility ratio without a tenure, which it is invariant in', () => {
    const line = decideVerdict(inputs({ tenureDays: Number.NaN }), flip, 73)
    expect(line.verdict).toBe('UNKNOWN')
    expect(line.feasibilityRatio).toBeCloseTo(0.6753, 4)
    // Same ratio at any tenure: the identity the whole monitor leans on.
    for (const tenure of [3.01, 8.59, 11.59, 32]) {
      expect(decideVerdict(inputs({ tenureDays: tenure }), flip, 73).feasibilityRatio).toBeCloseTo(
        0.6753,
        4,
      )
    }
  })
})

function observation(overrides: Partial<WatchObservation> = {}): WatchObservation {
  return {
    atUnix: DAY0,
    headBlock: '1',
    headBlockUnix: DAY0,
    scannedFromDayUnix: DAY0,
    scannedThroughDayUnix: DAY0,
    gateQfPerDay: TIERS.T1.gateQfPerDay,
    medianWindowDays: 7,
    standingT1: 130,
    standingT1Floor: 130,
    standingRefused: false,
    standingRefusedReason: null,
    capture: null,
    winnableT1: 73,
    escrowDailyTotalUsd: 1_000_000,
    escrowDailyTotalDayUnix: DAY0,
    ethPriceUsd: 2_000,
    priceSource: 'test',
    flipPointPopulation: 109,
    feasibilityRatio: 0.675,
    verdict: 'STOP',
    verdictHeadline: 'test',
    ...overrides,
  }
}

describe('movementOf', () => {
  it('reports a rate of travel between two real observations', () => {
    const previous = observation({ atUnix: DAY0, winnableT1: 60 })
    const current = observation({ atUnix: DAY0 + 2 * SECONDS_PER_DAY, winnableT1: 73 })
    const movement = movementOf('winnable', 'count', current, previous, (o) => o.winnableT1)
    expect(movement.delta).toBe(13)
    expect(movement.perDay).toBeCloseTo(6.5, 10)
    expect(movement.direction).toBe('rising')
    expect(movement.spanDays).toBeCloseTo(2, 10)
  })

  it('calls a missing measurement UNKNOWN, never flat', () => {
    // "flat" is a statement about the market. A metric that could not be
    // measured has not stayed the same; it has not been read.
    const movement = movementOf(
      'winnable',
      'count',
      observation({ winnableT1: null }),
      observation(),
      (o) => o.winnableT1,
    )
    expect(movement.direction).toBe('unknown')
    expect(movement.delta).toBeNull()
    expect(movement.perDay).toBeNull()
  })

  it('calls the first observation UNKNOWN rather than a zero change', () => {
    const movement = movementOf('winnable', 'count', observation(), undefined, (o) => o.winnableT1)
    expect(movement.direction).toBe('unknown')
    expect(movement.previous).toBeNull()
  })
})

describe('flipPointCrossing', () => {
  it('fires UPWARD when the winnable population crosses the flip point', () => {
    const crossing = flipPointCrossing(
      observation({ winnableT1: 112 }),
      observation({ winnableT1: 104 }),
      109,
    )
    expect(crossing.crossed).toBe('UPWARD')
    expect(crossing.undecidedReason).toBeNull()
  })

  it('fires DOWNWARD on the way back', () => {
    expect(
      flipPointCrossing(observation({ winnableT1: 100 }), observation({ winnableT1: 109 }), 109).crossed,
    ).toBe('DOWNWARD')
  })

  it('does not fire while the population moves without crossing', () => {
    const crossing = flipPointCrossing(observation({ winnableT1: 90 }), observation({ winnableT1: 73 }), 109)
    expect(crossing.crossed).toBeNull()
    expect(crossing.undecidedReason).toBeNull()
  })

  it('treats an unmeasurable population as UNDECIDED, not as silence', () => {
    // A monitor whose alarm cannot fire because an input went missing has
    // failed in the direction that looks like good news, so the undecided case
    // is reported rather than being indistinguishable from "no crossing".
    const missing = flipPointCrossing(observation({ winnableT1: null }), observation(), 109)
    expect(missing.crossed).toBeNull()
    expect(missing.undecidedReason).toMatch(/could not be measured/)

    const first = flipPointCrossing(observation(), undefined, 109)
    expect(first.undecidedReason).toMatch(/no previous observation/)

    const noFlip = flipPointCrossing(observation(), observation(), null)
    expect(noFlip.undecidedReason).toMatch(/flip point could not be derived/)
  })
})

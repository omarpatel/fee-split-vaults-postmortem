/**
 * The full-history measurement: merge every escrow-index window over V2's whole
 * life, price each day at ITS OWN close, and re-run the gate and tenure math.
 *
 *   node --max-old-space-size=16384 tools/artifacts/full-history.mjs <plan.json>
 *
 * WHY THIS EXISTS AND NOT ONE BIG SCAN. A single 36-day escrow-index document
 * would be roughly 4 GB of pretty-printed JSON. `emit()` serialises through
 * `JSON.stringify`, and V8 refuses any string over 536,870,888 bytes, so that
 * run does not produce a truncated artifact - it produces an exception after
 * hours of scanning and no artifact at all. The window is therefore scanned in
 * six documents and merged HERE, one recipient at a time, through the same
 * byte-level streamer the 7-day repricing used.
 *
 * WHY PER-DAY PRICES. The 7-day measurement pinned every price as of
 * 2026-09-06. Over V2's whole life that is simply the wrong price for 35 of the
 * 36 days: ETH closed at $1,858.81 on the day V2 was deployed and $2,515.72 on
 * 2026-08-21, a 35% range. Applying one number across the window would inflate
 * every native figure before 2026-08-19 by up to a third and push that error
 * straight into the gate counts and the tenure spells. Every day here is valued
 * at the close of THAT day.
 *
 * THE ARITHMETIC IS EXACT, THE PRICES ARE THE ESTIMATE. Amounts stay bigint
 * minor units until the moment they meet a price, exactly as the toolkit
 * requires. USD is a derived reporting figure and is never fed back.
 *
 * FAIL CLOSED, PER DAY AND PER ASSET. An asset with no bar for a given day is
 * unpriced FOR THAT DAY. It is not carried forward from the day before, not
 * back-filled, and above all not treated as zero. A recipient holding any
 * unpriced credit on any day is EXCLUDED from every cohort, which is what
 * tenure.ts does, rather than being silently counted at a understated value.
 *
 * THE TENURE MATH IS THE TOOLKIT'S OWN. extractSpells, survivalCurve,
 * littlesLawCheck, trailingMedian and quantiles are imported from
 * tools/lib/stats.ts - the same functions tenure.ts calls, under the same tests.
 * This file supplies the series; it does not reimplement the estimator.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { readHeader, streamRecipients } from '../lib/doc-stream.ts'
import {
  extractSpells,
  survivalCurve,
  littlesLawCheck,
  trailingMedian,
  quantiles,
} from '../lib/stats.ts'

const planPath = process.argv[2]
if (!planPath) { console.error('usage: full-history.mjs <plan.json>'); process.exit(2) }
const plan = JSON.parse(readFileSync(planPath, 'utf8'))

const DAY = 86400
const NATIVE = '0x0000000000000000000000000000000000000000'
const isoOf = (u) => new Date(u * 1000).toISOString().slice(0, 10)
const unixOf = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000)

const DAYS = []
for (let u = unixOf(plan.windowFrom); u <= unixOf(plan.windowTo); u += DAY) DAYS.push(u)
const DATES = DAYS.map(isoOf)
const dayIndex = new Map(DAYS.map((u, i) => [u, i]))
const N = DAYS.length
console.error(`window ${plan.windowFrom} .. ${plan.windowTo}  (${N} UTC days)`)

// ---------------------------------------------------------------------------
// The per-day price book.
// ---------------------------------------------------------------------------
const ethDaily = JSON.parse(readFileSync(plan.ethDailyPath, 'utf8'))
const ethClose = new Map(ethDaily.perDay.map((r) => [r.date, r.closeUsd]))
for (const d of DATES) {
  if (!ethClose.has(d) || ethClose.get(d) === null) {
    console.error(`REFUSING: no ETH close for ${d}. Native credits on that day cannot be valued and a run that guesses one is not a measurement.`)
    process.exit(2)
  }
}
const tokenDaily = JSON.parse(readFileSync(plan.dailyPricesPath, 'utf8'))
/** address -> Map<date, closeUsd|null> */
const tokenClose = new Map()
const tokenMeta = new Map()
for (const a of tokenDaily.assets) {
  tokenClose.set(a.address.toLowerCase(), new Map(Object.entries(a.dailyCloseUsd)))
  tokenMeta.set(a.address.toLowerCase(), a)
}
/** The single as-of book, kept alongside so the correction can be QUANTIFIED. */
const asOfBook = new Map()
for (const e of JSON.parse(readFileSync(plan.asOfAssetsPath, 'utf8'))) {
  if (e.priceUsd !== undefined && e.priceUsd !== null) asOfBook.set(String(e.address).toLowerCase(), e.priceUsd)
}
const AS_OF_ETH = plan.asOfEthUsd

/** USD per whole unit for `asset` on `date`, or null. Never carried, never zero. */
function priceOn(asset, date) {
  if (asset === NATIVE) return ethClose.get(date) ?? null
  const m = tokenClose.get(asset)
  if (m === undefined) return null
  const v = m.get(date)
  return v === undefined || v === null ? null : v
}
function asOfPriceOf(asset) {
  if (asset === NATIVE) return AS_OF_ETH
  return asOfBook.get(asset) ?? null
}

/**
 * THE CARRY BASIS - a SENSITIVITY, never the headline.
 *
 * Fail-closed pricing excludes a recipient outright if it holds a credit in an
 * asset that has no OHLCV bar on that day, and over 36 days a thinly traded
 * tokenised equity has many such days. That is the right default, but on its own
 * it cannot distinguish "the exclusion is immaterial" from "the exclusion just
 * deleted half the market". So the same amounts are valued a second way, with a
 * missing day filled from the asset's nearest own bar - carried forward where
 * one exists before it, back-filled from the first bar otherwise.
 *
 * A carried price is an ASSUMPTION wearing a measurement's clothes. It is
 * reported only as the bound on what the exclusion could be hiding, and every
 * headline number in this file comes from the exact basis.
 */
const carriedIndex = new Map()
function carriedFor(asset) {
  let idx = carriedIndex.get(asset)
  if (idx !== undefined) return idx
  const m = asset === NATIVE ? ethClose : tokenClose.get(asset)
  if (m === undefined) { carriedIndex.set(asset, null); return null }
  const pts = [...m.entries()].filter(([, v]) => v !== null && v !== undefined).sort((a, b) => (a[0] < b[0] ? -1 : 1))
  idx = pts.length === 0 ? null : pts
  carriedIndex.set(asset, idx)
  return idx
}
let carriedFills = 0
const carriedFillPairs = new Set()
function priceOnCarried(asset, date) {
  const exact = priceOn(asset, date)
  if (exact !== null) return exact
  const pts = carriedFor(asset)
  if (pts === null) return null
  let best = null
  for (const [d, v] of pts) { if (d <= date) best = v; else break }
  if (best === null) best = pts[0][1]
  carriedFills++
  carriedFillPairs.add(`${asset}@${date}`)
  return best
}

// ---------------------------------------------------------------------------
// Pass 1: stream every window document into one per-recipient daily series.
// ---------------------------------------------------------------------------
/** recipient -> { usd:Float64Array, asOfUsd:Float64Array, unpriced:Uint8Array, credits, first, last } */
const rec = new Map()
const assetTotals = new Map()   // asset -> { minor:bigint, credits, usd, asOfUsd, holders:Set }
const decimalsOf = new Map()
const symbolOf = new Map()
const kindOf = new Map()
const scale = new Map()
const dailyTotals = new Float64Array(N)
const dailyTotalsAsOf = new Float64Array(N)
const dailyTotalsCarried = new Float64Array(N)
const dailyCredits = new Float64Array(N)
const dailyNativeMinor = new Array(N).fill(0n)
let totalCredits = 0
let unpricedCredits = 0
let carriedUnpricedCredits = 0
let unpricedAssetDayPairs = new Set()
const docSummaries = []

function scaleOf(asset) {
  let s = scale.get(asset)
  if (s === undefined) {
    const d = decimalsOf.get(asset)
    if (d === undefined) return undefined
    s = 10 ** d
    scale.set(asset, s)
  }
  return s
}

for (const win of plan.windows) {
  const { result: doc, recipientsOffset } = readHeader(win.path)
  if (doc.schema !== 'escrow-daily-credits-2') {
    console.error(`REFUSING: ${win.path} declares schema "${doc.schema}". A schema-1 document keys byAssetMinor by the DEPOSITOR, not the asset; reading it here would produce a per-asset breakdown of nonsense.`)
    process.exit(2)
  }
  for (const [a, d] of Object.entries(doc.assetDecimals ?? {})) decimalsOf.set(a.toLowerCase(), d)
  for (const [a, s] of Object.entries(doc.assetSymbols ?? {})) symbolOf.set(a.toLowerCase(), s)
  for (const [a, k] of Object.entries(doc.assetKinds ?? {})) kindOf.set(a.toLowerCase(), k)

  const own = new Set(win.ownDates)
  const declared = doc.pricing?.recipientsTotal ?? null
  let seen = 0, kept = 0, creditsInOwned = 0, creditsAll = 0

  for (const r of streamRecipients(win.path, recipientsOffset)) {
    seen++
    const addr = r.recipient.toLowerCase()
    let entry = null
    for (const day of r.days) {
      creditsAll += day.creditCount
      if (!own.has(day.dateUtc)) continue          // slivers and overlaps belong to another window
      const idx = dayIndex.get(day.dayUnix)
      if (idx === undefined) continue
      const assets = Object.entries(day.byAssetMinor)
      if (assets.length === 0 && day.creditCount === 0) continue
      creditsInOwned += day.creditCount
      if (entry === null) {
        entry = rec.get(addr)
        if (entry === undefined) {
          entry = { usd: new Float64Array(N), asOf: new Float64Array(N), carried: new Float64Array(N), unpriced: new Uint8Array(N), unpricedCarried: new Uint8Array(N), credits: 0, first: Infinity, last: -Infinity }
          rec.set(addr, entry)
          kept++
        }
      }
      entry.credits += day.creditCount
      if (day.dayUnix < entry.first) entry.first = day.dayUnix
      if (day.dayUnix > entry.last) entry.last = day.dayUnix
      dailyCredits[idx] += day.creditCount
      totalCredits += day.creditCount

      for (const [assetRaw, minorStr] of assets) {
        const asset = assetRaw.toLowerCase()
        const minor = BigInt(minorStr)
        if (minor === 0n) continue
        let at = assetTotals.get(asset)
        if (at === undefined) { at = { minor: 0n, credits: 0, usd: 0, asOfUsd: 0, holders: new Set() }; assetTotals.set(asset, at) }
        at.minor += minor
        at.holders.add(addr)
        if (asset === NATIVE) dailyNativeMinor[idx] += minor

        const s = scaleOf(asset)
        const p = priceOn(asset, day.dateUtc)
        // minor units -> whole units without losing low digits to a 2^53 step
        const whole = s === undefined ? null
          : Number(minor / BigInt(Math.round(s))) + Number(minor % BigInt(Math.round(s))) / s
        if (s === undefined || p === null) {
          // Charged ONCE per recipient-day, not once per unpriced asset in it.
          // A day carries a credit count but not a per-asset breakdown of it, so
          // this is the credits on days that contain an unpriced asset - an
          // UPPER bound on the credits actually unpriced, and it must not be
          // inflated further by counting the same day twice.
          if (entry.unpriced[idx] === 0) unpricedCredits += day.creditCount
          entry.unpriced[idx] = 1
          unpricedAssetDayPairs.add(`${asset}@${day.dateUtc}`)
        } else {
          const v = whole * p
          entry.usd[idx] += v
          at.usd += v
          dailyTotals[idx] += v
          const ap = asOfPriceOf(asset)
          if (ap !== null) {
            const av = whole * ap
            entry.asOf[idx] += av
            at.asOfUsd += av
            dailyTotalsAsOf[idx] += av
          }
        }
        // the carry SENSITIVITY, computed for every credit including the ones
        // the exact basis had to drop
        const pc = s === undefined ? null : priceOnCarried(asset, day.dateUtc)
        if (pc === null) {
          if (entry.unpricedCarried[idx] === 0) carriedUnpricedCredits += day.creditCount
          entry.unpricedCarried[idx] = 1
        } else {
          const vc = whole * pc
          entry.carried[idx] += vc
          at.carriedUsd = (at.carriedUsd ?? 0) + vc
          dailyTotalsCarried[idx] += vc
        }
      }
    }
  }
  // A short read on a 200 MB file must never be reported as a smaller market.
  if (declared !== null && seen !== declared) {
    console.error(`REFUSING: ${win.path} declares ${declared} recipients, the stream yielded ${seen}. A short read here reports a SMALLER MARKET, silently.`)
    process.exit(2)
  }
  docSummaries.push({ path: win.path, ownDates: win.ownDates, recipientsStreamed: seen, recipientsDeclared: declared, recipientsNewToMerge: kept, creditsInOwnedDays: creditsInOwned, creditsInDocument: doc.totalCredits, creditsSeenStreaming: creditsAll })
  console.error(`  ${win.path}: ${seen} recipients streamed (declared ${declared}), ${creditsInOwned} credits in its ${win.ownDates.length} owned days`)
}
console.error(`merged: ${rec.size} distinct recipients, ${totalCredits} credits over ${N} days`)

// ---------------------------------------------------------------------------
// Pass 2: gates and tenure, over the merged series.
// ---------------------------------------------------------------------------
const GATES = plan.gates ?? [
  { id: 'T1', label: 'T1 Desk', gate: 1000, sustainedDays: 7 },
  { id: 'T2', label: 'T2 Campaign', gate: 2500, sustainedDays: 7 },
  { id: 'T3', label: 'T3 Flagship', gate: 20000, sustainedDays: 14 },
]
const WSTART = DAYS[0], WEND = DAYS[N - 1]

/** median7 gate series, identical to tenure.ts gateSeries() + stats.trailingMedian(). */
function median7(values) {
  const out = new Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = trailingMedian(values.slice(0, i + 1), 7)
  return out
}

const LOWEST_GATE = Math.min(...GATES.map((g) => g.gate))
let fullyPriced = 0, excludedUnpriced = 0
let fullyPricedCarried = 0, excludedUnpricedCarried = 0
const cohortSeries = []          // exact basis: [addr, dailyUsd[], entry]
const cohortCarried = []         // carry sensitivity: the same, valued under carry
const cohortFloor = []           // priced-only LOWER BOUND, no recipient excluded
const excludedList = []          // recipients the exact basis had to drop, named
for (const [addr, e] of rec) {
  // Only recipients with a peak DAY at or above the lowest gate can ever produce
  // a spell at any gate: a trailing median of a series whose maximum is below
  // the gate is below the gate at every point. Dropping the rest is exact, not
  // an approximation, and it keeps the cohort pass out of a 500k x 36 blowup.
  let badCarried = false
  for (let i = 0; i < N; i++) if (e.unpricedCarried[i]) { badCarried = true; break }
  if (badCarried) excludedUnpricedCarried++
  else {
    fullyPricedCarried++
    let peakC = 0
    for (const v of e.carried) if (v > peakC) peakC = v
    if (peakC >= LOWEST_GATE) cohortCarried.push([addr, Array.from(e.carried), e])
  }

  // THE PRICED-ONLY FLOOR. `e.usd` already sums only the assets that HAD a price
  // on the day, so a recipient's floor series is what it earned in instruments we
  // can value and nothing else. Its unpriced credits are worth an unknown
  // NON-NEGATIVE amount, so a recipient whose floor series clears the gate clears
  // the gate whatever that unknown turns out to be. That makes this basis a true
  // LOWER BOUND on the standing population - which excluding the recipient is
  // not, and which zero-filling a day would only be if the zero were a claim
  // rather than a floor. Nothing here is reported as the value of anything.
  let peakF = 0
  for (const v of e.usd) if (v > peakF) peakF = v
  if (peakF >= LOWEST_GATE) cohortFloor.push([addr, Array.from(e.usd), e])

  let bad = false
  for (let i = 0; i < N; i++) if (e.unpriced[i]) { bad = true; break }
  if (bad) {
    excludedUnpriced++
    // Name the biggest of them. "89 recipients excluded" is only reassuring if
    // none of them would have cleared a gate, and that has to be shown.
    let peakC = 0, totC = 0
    for (const v of e.carried) { totC += v; if (v > peakC) peakC = v }
    excludedList.push({ recipient: addr, carriedTotalUsd: totC, carriedPeakDayUsd: peakC, credits: e.credits })
    continue
  }
  fullyPriced++
  const daily = Array.from(e.usd)
  let peak = 0
  for (const v of daily) if (v > peak) peak = v
  if (peak < LOWEST_GATE) continue
  cohortSeries.push([addr, daily, e])
}
console.error(`fully priced ${fullyPriced}, excluded unpriced ${excludedUnpriced}, gate-eligible (peak day >= lowest gate) ${cohortSeries.length}`)
console.error(`carry sensitivity: fully priced ${fullyPricedCarried}, excluded ${excludedUnpricedCarried}, gate-eligible ${cohortCarried.length}`)

const gateResults = []
for (const g of GATES) {
  for (const basis of ['perDay', 'asOf', 'perDayCarried', 'perDayPricedFloor']) {
    const cohort = basis === 'perDayCarried' ? cohortCarried : basis === 'perDayPricedFloor' ? cohortFloor : cohortSeries
    const spells = []
    let everAbove = 0, sustained7 = 0, sustained14 = 0, standing = 0, meetsTier = 0, standingQfTotal = 0
    const standingList = []
    // How many subjects hold the gate on EACH day, not only on the last one.
    // The 7-day measurement read its population on 2026-09-06; reading the same
    // date off this curve is an independent check on a 36-day merge.
    const standingByDate = new Int32Array(N)
    for (const [addr, daily, e] of cohort) {
      const raw = basis === 'asOf' ? Array.from(e.asOf) : daily
      const gs = median7(raw)
      for (let i = 0; i < N; i++) if (gs[i] >= g.gate) standingByDate[i]++
      const series = gs.map((v, i) => ({ dayUnix: DAYS[i], value: v }))
      const sp = extractSpells(addr, series, g.gate, { allowGapDays: 0, windowStartDayUnix: WSTART, windowEndDayUnix: WEND })
      if (sp.length === 0) continue
      everAbove++
      spells.push(...sp)
      const longest = Math.max(...sp.map((s) => s.days))
      if (longest >= 7) sustained7++
      if (longest >= 14) sustained14++
      if (longest >= g.sustainedDays) meetsTier++
      const last = series[series.length - 1]
      if (last.value >= g.gate) { standing++; standingQfTotal += last.value; standingList.push({ recipient: addr, qfUsd: last.value, peakDayUsd: Math.max(...raw), activeDays: raw.filter((v) => v > 0).length, credits: e.credits }) }
    }
    const curve = survivalCurve(spells)
    const ll = littlesLawCheck(spells, { windowStartDayUnix: WSTART, windowEndDayUnix: WEND, curve })
    standingList.sort((a, b) => b.qfUsd - a.qfUsd)
    gateResults.push({
      id: g.id, label: g.label, gateQfPerDay: g.gate, sustainedDaysRequired: g.sustainedDays, priceBasis: basis,
      cohortSize: cohort.length,
      cohort: {
        everAbove, sustained7, sustained14, standingAtWindowEnd: standing, meetsTierSustainedDays: meetsTier,
        excludedUnpriced: basis === 'perDayCarried' ? excludedUnpricedCarried : basis === 'perDayPricedFloor' ? 0 : excludedUnpriced,
        populationFullyPriced: basis === 'perDayPricedFloor' ? true : (basis === 'perDayCarried' ? excludedUnpricedCarried : excludedUnpriced) === 0,
      },
      spells: { total: spells.length, completed: curve.completedSpells, rightCensored: curve.censoredSpells, leftCensored: spells.filter((s) => s.leftCensored).length },
      survival: { medianDays: curve.medianDays, restrictedMeanDays: curve.restrictedMeanDays, restrictedToDays: curve.restrictedToDays, naiveMeanDays: curve.naiveMeanDays, completedMeanDays: curve.completedMeanDays, points: curve.points },
      tenureQuantiles: quantiles(spells.map((s) => s.days)),
      littlesLaw: ll,
      meanQfOfStandingStockUsd: standing === 0 ? null : standingQfTotal / standing,
      standingByDate: DATES.map((d, i) => ({ date: d, standing: standingByDate[i] })),
      standingTop: standingList.slice(0, 40),
      spellLengthHistogram: (() => { const h = {}; for (const s of spells) h[s.days] = (h[s.days] ?? 0) + 1; return h })(),
    })
  }
}

// ---------------------------------------------------------------------------
// Asset table and daily totals.
// ---------------------------------------------------------------------------
const assetRows = [...assetTotals.entries()].map(([asset, t]) => ({
  asset, kind: kindOf.get(asset) ?? 'erc20', symbol: symbolOf.get(asset) ?? 'UNKNOWN',
  decimals: decimalsOf.get(asset) ?? null, totalMinor: t.minor.toString(),
  recipients: t.holders.size, totalUsdPerDayPriced: t.usd > 0 ? t.usd : null,
  totalUsdAtAsOfPrice: t.asOfUsd > 0 ? t.asOfUsd : null,
  totalUsdCarried: (t.carriedUsd ?? 0) > 0 ? t.carriedUsd : null,
  pricedPerDay: tokenClose.has(asset) || asset === NATIVE,
})).sort((a, b) => (b.totalUsdPerDayPriced ?? 0) - (a.totalUsdPerDayPriced ?? 0))

const perDayRows = DATES.map((d, i) => ({
  date: d, credits: dailyCredits[i],
  usdPerDayPriced: dailyTotals[i], usdAtAsOfPrice: dailyTotalsAsOf[i], usdCarried: dailyTotalsCarried[i],
  nativeEth: Number(dailyNativeMinor[i] / 10n ** 12n) / 1e6,
  ethCloseUsd: ethClose.get(d),
}))

const totalPerDay = dailyTotals.reduce((a, b) => a + b, 0)
const totalAsOf = dailyTotalsAsOf.reduce((a, b) => a + b, 0)
const totalCarried = dailyTotalsCarried.reduce((a, b) => a + b, 0)

const out = {
  generatedAtIso: new Date().toISOString(),
  window: { from: plan.windowFrom, to: plan.windowTo, days: N, windowStartDayUnix: WSTART, windowEndDayUnix: WEND },
  v2Genesis: plan.v2Genesis,
  method: {
    pricing: 'every asset on every UTC day at the close of THAT day. ETH from the median of Kraken/Coinbase/Bitstamp daily closes; ERC-20 from the token\'s own daily OHLCV close in its deepest pool on chain 4663. No price is carried across days.',
    asOfComparison: `the "asOf" basis re-values the SAME minor-unit amounts at the single 2026-09-06 book the 7-day measurement used (ETH $${AS_OF_ETH}). It exists to quantify the error a single as-of price introduces over a 36-day window, not to be quoted.`,
    tenure: 'extractSpells / survivalCurve / littlesLawCheck / trailingMedian imported from tools/lib/stats.ts - the same functions tenure.ts calls.',
    exclusion: 'a recipient holding ANY credit in an asset with no bar for that day is excluded from every cohort, never zero-filled.',
    pricedFloor: 'the "perDayPricedFloor" basis excludes nobody. It values only the assets that had a price on the day and lets the rest stand as an unknown NON-NEGATIVE amount, so a subject whose priced-only trailing median clears a gate clears it whatever the unknown is worth. Its cohort counts are a genuine LOWER BOUND on the standing population; its spells can be split by a day whose unpriced share mattered, so its tenure figures are conservative too. No dollar total is quoted from it.',
    carrySensitivity: 'the "perDayCarried" basis values the SAME amounts with a missing day filled from that asset\'s nearest own bar (carried forward where one exists, back-filled from its first bar otherwise). A carried price is an ASSUMPTION, and this basis exists ONLY to bound what the fail-closed exclusion could be hiding. No headline number is taken from it.',
  },
  documents: docSummaries,
  totals: {
    recipients: rec.size, credits: totalCredits,
    recipientsFullyPriced: fullyPriced, recipientsExcludedUnpriced: excludedUnpriced,
    gateEligibleCohort: cohortSeries.length,
    gateEligibleCohortPricedFloor: cohortFloor.length,
    excludedRecipientsTopByCarriedValue: excludedList.sort((a, b) => b.carriedTotalUsd - a.carriedTotalUsd).slice(0, 20),
    creditsOnRecipientDaysHoldingAnUnpricedAsset: unpricedCredits,
    assetsSeen: assetTotals.size,
    assetsPricedPerDay: assetRows.filter((r) => r.pricedPerDay).length,
    unpricedAssetDayPairs: unpricedAssetDayPairs.size,
    unpricedAssetDayList: [...unpricedAssetDayPairs].sort().map((k) => { const [a, d] = k.split('@'); return { asset: a, symbol: symbolOf.get(a) ?? 'UNKNOWN', date: d } }),
    totalCreditValueUsdPerDayPriced: totalPerDay,
    totalCreditValueUsdAtAsOfPrice: totalAsOf,
    asOfOverstatementPct: totalPerDay > 0 ? ((totalAsOf / totalPerDay - 1) * 100) : null,
    carrySensitivity: {
      recipientsFullyPriced: fullyPricedCarried,
      recipientsExcluded: excludedUnpricedCarried,
      gateEligibleCohort: cohortCarried.length,
      creditsOnRecipientDaysStillUnpriced: carriedUnpricedCredits,
      assetDayPairsFilledByCarry: carriedFillPairs.size,
      carryLookups: carriedFills,
      totalCreditValueUsd: totalCarried,
      upliftOverExactPct: totalPerDay > 0 ? ((totalCarried / totalPerDay - 1) * 100) : null,
    },
  },
  perDay: perDayRows,
  assetTotals: assetRows.slice(0, 80),
  gates: gateResults,
}
mkdirSync(dirname(plan.outPath), { recursive: true })
writeFileSync(plan.outPath, `${JSON.stringify(out, null, 2)}\n`)
console.error(`wrote ${plan.outPath}`)

// ---------------------------------------------------------------------------
// The reduced, schema-valid document, so the REAL tenure.ts can be run on this
// series unchanged and its answer compared against the one computed above.
// Every recipient whose peak day reaches the lowest gate is included, in full;
// the rest cannot produce a spell at any gate and are omitted.
// ---------------------------------------------------------------------------
if (plan.reducedDocPath) {
  const SYN = '0x0000000000000000000000000000000000000001'   // USD-denominated synthetic unit, 6dp
  const recipients = []
  for (const [addr, daily, e] of cohortSeries) {
    const days = daily.map((v, i) => {
      const minor = BigInt(Math.round(v * 1e6))
      return { dayUnix: DAYS[i], dateUtc: DATES[i], byAssetMinor: minor === 0n ? {} : { [SYN]: minor.toString() }, usd: v, creditCount: 0 }
    })
    const total = daily.reduce((a, b) => a + b, 0)
    recipients.push({
      recipient: addr, firstCreditUnix: e.first === Infinity ? WSTART : e.first,
      lastCreditUnix: e.last === -Infinity ? WEND : e.last,
      activeDays: daily.filter((v) => v > 0).length,
      totalByAssetMinor: { [SYN]: BigInt(Math.round(total * 1e6)).toString() },
      totalUsd: total, days,
    })
  }
  const doc = {
    meta: {
      tool: 'full-history', schemaVersion: 'escrow-daily-credits-2', generatedAtUnix: Math.floor(Date.now() / 1000),
      config: {}, io: { httpRequests: 0, cacheHits: 0, cacheMisses: 0 },
      warnings: [
        `REDUCED DOCUMENT. It contains the ${recipients.length} recipients whose PEAK single day reaches $${Math.min(...GATES.map((g) => g.gate))}, out of ${fullyPriced} fully priced and ${rec.size} total. Every other recipient is below the lowest gate on every day, so a trailing median of its series is below the gate at every point and it can produce no spell at any gate here. Cohort counts and survival curves are therefore exact; DENOMINATORS ARE NOT - read them from the full-history JSON.`,
        'Daily values are pre-converted USD at each day\'s own close, carried in a synthetic 6-decimal unit priced at $1.00 so the schema can hold them. The underlying minor-unit amounts live in the six window documents.',
      ],
      methodLimits: [], measurementComplete: true,
    },
    result: {
      schema: 'escrow-daily-credits-2', escrow: plan.escrow, chainId: 4663,
      eventSignature: 'Credited(address,address,uint256) + CreditedToken(address,address,address,uint256)',
      topic0: '0x4e45da441832cf53bdaa69235704fc0575e68210f459ee1562911024b12967d5',
      mode: 'both',
      events: [
        { mode: 'native', signature: 'Credited(address,address,uint256)', topic0: '0x4e45da441832cf53bdaa69235704fc0575e68210f459ee1562911024b12967d5' },
        { mode: 'token', signature: 'CreditedToken(address,address,address,uint256)', topic0: '0x5d104c62f50449fadfe6f4013c8f36588d32737f94b5ac9b83ddad33b3e1ffdf' },
      ],
      backend: 'rpc', fromBlock: String(plan.fromBlock ?? 0), toBlock: String(plan.toBlock ?? 0),
      windowStartDayUnix: WSTART, windowEndDayUnix: WEND, windowDays: N,
      priceSource: 'per-day close; see full-history.json', pricedAtUnix: Math.floor(Date.now() / 1000),
      priceUsdByAsset: { [SYN]: 1 }, assetDecimals: { [SYN]: 6 }, assetSymbols: { [SYN]: 'USD' }, assetKinds: { [SYN]: 'erc20' },
      assetTotals: [{ asset: SYN, kind: 'erc20', symbol: 'USD', decimals: 6, totalMinor: '0', recipients: recipients.length, credits: 0, priceUsd: 1, totalUsd: 0 }],
      unpricedAssets: [], totalCredits,
      pricing: { assetsSeen: 1, assetsUnpriced: 0, unpricedAssetSample: [], recipientsTotal: recipients.length, recipientsUnpriced: 0, creditsTotal: totalCredits, creditsUnpriced: 0, complete: true },
      recipients,
    },
  }
  writeFileSync(plan.reducedDocPath, `${JSON.stringify(doc, null, 2)}\n`)
  console.error(`wrote ${plan.reducedDocPath} (${recipients.length} recipients)`)
}

// ---------------------------------------------------------------------------
// Human report.
// ---------------------------------------------------------------------------
const money = (v) => (v === null || v === undefined ? 'UNPRICED' : `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
const L = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`)
console.log(`\nFULL-HISTORY ESCROW MEASUREMENT  ${plan.windowFrom} .. ${plan.windowTo}  (${N} UTC days)`)
console.log(`V2 genesis ${plan.v2Genesis?.iso ?? '?'} block ${plan.v2Genesis?.block ?? '?'}`)
console.log(`recipients ${rec.size.toLocaleString()}   credits ${totalCredits.toLocaleString()}   assets ${assetTotals.size.toLocaleString()}`)
console.log(`fully priced ${fullyPriced.toLocaleString()}   excluded (any unpriced day) ${excludedUnpriced.toLocaleString()}`)
console.log(`total credit value, per-day prices : ${money(totalPerDay)}`)
console.log(`the same amounts at the single 2026-09-06 book : ${money(totalAsOf)}  (${((totalAsOf / totalPerDay - 1) * 100).toFixed(1)}% off)`)

L('Daily escrow credit value')
console.log('  date         credits        ETH close   value (per-day px)   value (as-of px)')
for (const r of perDayRows) {
  console.log(`  ${r.date}  ${String(r.credits).padStart(9)}   $${r.ethCloseUsd.toFixed(2).padStart(8)}   ${money(r.usdPerDayPriced).padStart(14)}   ${money(r.usdAtAsOfPrice).padStart(14)}`)
}

L('Population against the tier gates (median7 QF), per-day prices')
console.log('  tier              gate   ever >= gate   standing at end   run >= 7d   run >= 14d   KM median   KM restricted mean')
for (const g of gateResults.filter((x) => x.priceBasis === 'perDay')) {
  console.log(`  ${g.label.padEnd(14)} $${String(g.gateQfPerDay).padStart(6)}   ${String(g.cohort.everAbove).padStart(12)}   ${String(g.cohort.standingAtWindowEnd).padStart(15)}   ${String(g.cohort.sustained7).padStart(9)}   ${String(g.cohort.sustained14).padStart(10)}   ${String(g.survival.medianDays ?? 'not reached').padStart(9)}   ${g.survival.restrictedMeanDays.toFixed(2).padStart(18)}`)
}
L('The same, priced at the single 2026-09-06 book (what a naive re-run would print)')
console.log('  tier              gate   ever >= gate   standing at end   KM restricted mean')
for (const g of gateResults.filter((x) => x.priceBasis === 'asOf')) {
  console.log(`  ${g.label.padEnd(14)} $${String(g.gateQfPerDay).padStart(6)}   ${String(g.cohort.everAbove).padStart(12)}   ${String(g.cohort.standingAtWindowEnd).padStart(15)}   ${g.survival.restrictedMeanDays.toFixed(2).padStart(18)}`)
}

for (const g of gateResults.filter((x) => x.priceBasis === 'perDay')) {
  L(`${g.label}: Kaplan-Meier survival of time above the gate`)
  console.log(`  spells ${g.spells.total} (completed ${g.spells.completed}, right-censored ${g.spells.rightCensored}, left-censored ${g.spells.leftCensored})`)
  console.log(`  KM median ${g.survival.medianDays ?? 'NOT REACHED'}   restricted mean ${g.survival.restrictedMeanDays.toFixed(3)} d out to ${g.survival.restrictedToDays} d`)
  console.log(`  naive mean ${g.survival.naiveMeanDays.toFixed(3)} d   completed-only mean ${g.survival.completedMeanDays.toFixed(3)} d`)
  console.log(`  quantiles p50 ${g.tenureQuantiles.p50} p90 ${g.tenureQuantiles.p90} max ${g.tenureQuantiles.max}`)
  console.log(`  Little's Law: L ${g.littlesLaw.meanStandingStock.toFixed(2)}  lambda ${g.littlesLaw.arrivalsPerDay.toFixed(2)}/d  implied W ${g.littlesLaw.impliedMeanTenureDays?.toFixed(2) ?? '-'} d  ratio ${g.littlesLaw.consistencyRatio?.toFixed(3) ?? '-'}`)
  console.log('   day   atRisk   ended   censored   S(t)')
  for (const p of g.survival.points) {
    console.log(`  ${String(p.day).padStart(4)}   ${String(p.atRisk).padStart(6)}   ${String(p.ended).padStart(5)}   ${String(p.censored).padStart(8)}   ${p.survival.toFixed(4)}`)
  }
}

L('Standing population above each gate, day by day (median7 QF, per-day prices)')
{
  const t1 = gateResults.find((x) => x.id === 'T1' && x.priceBasis === 'perDay')
  const t2 = gateResults.find((x) => x.id === 'T2' && x.priceBasis === 'perDay')
  const t3 = gateResults.find((x) => x.id === 'T3' && x.priceBasis === 'perDay')
  const t1a = gateResults.find((x) => x.id === 'T1' && x.priceBasis === 'asOf')
  console.log('  date          T1     T2     T3    T1 at the as-of price')
  for (let i = 0; i < N; i++) {
    console.log(`  ${DATES[i]}  ${String(t1.standingByDate[i].standing).padStart(5)}  ${String(t2.standingByDate[i].standing).padStart(5)}  ${String(t3.standingByDate[i].standing).padStart(5)}    ${String(t1a.standingByDate[i].standing).padStart(5)}`)
  }
}

L('PRICED-ONLY FLOOR - a LOWER BOUND that excludes nobody (unpriced credits count as an unknown >= 0)')
console.log('  tier              gate   standing (exact, excl.)   standing (FLOOR)   ever>=gate (exact)   ever>=gate (FLOOR)   RMST exact   RMST floor')
for (const g of gateResults.filter((x) => x.priceBasis === 'perDayPricedFloor')) {
  const e = gateResults.find((x) => x.priceBasis === 'perDay' && x.id === g.id)
  console.log(`  ${g.label.padEnd(14)} $${String(g.gateQfPerDay).padStart(6)}   ${String(e.cohort.standingAtWindowEnd).padStart(22)}   ${String(g.cohort.standingAtWindowEnd).padStart(16)}   ${String(e.cohort.everAbove).padStart(18)}   ${String(g.cohort.everAbove).padStart(18)}   ${e.survival.restrictedMeanDays.toFixed(2).padStart(10)}   ${g.survival.restrictedMeanDays.toFixed(2).padStart(10)}`)
}

L('CARRY SENSITIVITY - what the fail-closed exclusion could be hiding (an ASSUMPTION, not a measurement)')
console.log(`  recipients excluded by the exact basis      : ${excludedUnpriced.toLocaleString()}`)
console.log(`  recipients excluded under carry             : ${excludedUnpricedCarried.toLocaleString()}`)
console.log(`  asset-days filled by a carried price        : ${carriedFillPairs.size.toLocaleString()}`)
console.log(`  credit value, exact  ${money(totalPerDay)}   under carry ${money(totalCarried)}   (+${((totalCarried / totalPerDay - 1) * 100).toFixed(2)}%)`)
console.log('  tier              gate   standing (exact)   standing (carry)   ever>=gate (exact)   ever>=gate (carry)   RMST exact   RMST carry')
for (const g of gateResults.filter((x) => x.priceBasis === 'perDayCarried')) {
  const e = gateResults.find((x) => x.priceBasis === 'perDay' && x.id === g.id)
  console.log(`  ${g.label.padEnd(14)} $${String(g.gateQfPerDay).padStart(6)}   ${String(e.cohort.standingAtWindowEnd).padStart(16)}   ${String(g.cohort.standingAtWindowEnd).padStart(16)}   ${String(e.cohort.everAbove).padStart(18)}   ${String(g.cohort.everAbove).padStart(18)}   ${e.survival.restrictedMeanDays.toFixed(2).padStart(10)}   ${g.survival.restrictedMeanDays.toFixed(2).padStart(10)}`)
}

L('Top assets by credited value (per-day prices)')
console.log('  kind    symbol       recipients      value')
for (const a of assetRows.slice(0, 20)) {
  console.log(`  ${a.kind.padEnd(6)}  ${String(a.symbol).slice(0, 10).padEnd(10)}   ${String(a.recipients).padStart(10)}   ${money(a.totalUsdPerDayPriced).padStart(12)}`)
}

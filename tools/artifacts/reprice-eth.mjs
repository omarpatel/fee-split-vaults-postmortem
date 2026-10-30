/**
 * Re-count the QF gate populations at a VERIFIED ETH price instead of the
 * hand-pinned $3,200 the 7-day measurement shipped with.
 *
 *   node --max-old-space-size=8192 tools/artifacts/reprice-eth.mjs <native.json> [completeDays]
 *
 * This re-counts; it does not re-scan and it does not re-price the artifact.
 * Every USD figure is derived from the EXACT bigint wei in the document, so the
 * $3,200 that was pinned at scan time never enters the arithmetic here.
 *
 * Two counting bases are produced, and they answer different questions:
 *
 *   SINGLE PRICE   every day of the window valued at one price. This is what the
 *                  shipped measurement did, and it is the basis the sensitivity
 *                  table in MEASUREMENT.md 3.2 uses, so it is the one that can be
 *                  compared against that table row for row.
 *
 *   PER-DAY PRICE  each UTC day valued at THAT DAY's own price. A credit banked on
 *                  2026-09-02 was worth 2026-09-02 dollars, not 2026-09-06
 *                  dollars, and the QF gate is a test on a daily figure. This is
 *                  the more defensible basis and it is the one to quote.
 *
 * The per-day prices are an INPUT and must be passed in below with provenance.
 * A day with no price is a REFUSAL, never a zero.
 */
import { readFileSync } from 'node:fs'

const NATIVE_SENTINEL = '0x0000000000000000000000000000000000000000'
const iso = (u) => new Date(u * 1000).toISOString().slice(0, 10)

/**
 * VERIFIED ETH/USD, by UTC day. Daily VWAP from Kraken's public OHLC endpoint
 * (pair XETHZUSD, interval 1440), retrieved 2026-09-07. Kraken's daily candles
 * are UTC-aligned, which is the same bucketing escrow-index uses.
 *
 * Corroborated to within 0.02% at the close by Coinbase Exchange
 * (products/ETH-USD/candles, granularity 86400), Bitstamp (v2/ohlc/ethusd,
 * step 86400) and CoinGecko (coins/ethereum historical). See PROVENANCE below.
 */
const ETH_VWAP_BY_DAY = {
  '2026-08-31': 2449.14,
  '2026-09-01': 2432.31,
  '2026-09-02': 2390.71,
  '2026-09-03': 2475.56,
  '2026-09-04': 2481.20,
  '2026-09-05': 2465.71,
  '2026-09-06': 2496.59,
}

/** Daily CLOSE, same four venues, used for the window range and the close-basis run. */
const ETH_CLOSE_BY_DAY = {
  '2026-08-31': 2467.29,
  '2026-09-01': 2417.25,
  '2026-09-02': 2390.83,
  '2026-09-03': 2507.47,
  '2026-09-04': 2456.60,
  '2026-09-05': 2480.61,
  '2026-09-06': 2514.31,
}

const [nativePath, completeDaysArg] = process.argv.slice(2)
const COMPLETE_DAYS = Number(completeDaysArg ?? 7)
const doc = JSON.parse(readFileSync(nativePath, 'utf8'))
const nd = doc.result ?? doc

console.log('PROVENANCE OF THE PRICE INPUT')
console.log('-----------------------------')
console.log('  Kraken     https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=1440   (VWAP + OHLC, UTC days)')
console.log('  Coinbase   https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=86400')
console.log('  Bitstamp   https://www.bitstamp.net/api/v2/ohlc/ethusd/?step=86400')
console.log('  CoinGecko  https://api.coingecko.com/api/v3/coins/ethereum/history?date=06-09-2026')
console.log('  All four retrieved 2026-09-07. Agreement at the 2026-09-06 UTC close: $2,514.01-$2,514.52 (0.02%).')
console.log(`  Document was scanned with a pinned ETH price of $${nd.priceUsdByAsset[NATIVE_SENTINEL]}.`)
console.log('  NOTHING BELOW USES THAT PINNED NUMBER: every figure is rebuilt from the exact bigint wei.')

// --------------------------------------------------------------------------
// Same boundary-sliver trim as analyze-7d.mjs: by CONTENT, and refuse if the
// trim does not leave exactly COMPLETE_DAYS.
// --------------------------------------------------------------------------
const allDays = [...new Set(nd.recipients.flatMap((r) => r.days.map((d) => d.dayUnix)))].sort((a, b) => a - b)
const creditsOnDay = new Map(allDays.map((d) => [d, 0]))
for (const r of nd.recipients) for (const d of r.days) creditsOnDay.set(d.dayUnix, creditsOnDay.get(d.dayUnix) + d.creditCount)
const meanDailyCredits = [...creditsOnDay.values()].reduce((a, b) => a + b, 0) / allDays.length
const SLIVER_MAX = meanDailyCredits * 0.01
let lo = 0
let hi = allDays.length - 1
while (hi - lo + 1 > COMPLETE_DAYS && lo <= hi) {
  const l = creditsOnDay.get(allDays[lo])
  const h = creditsOnDay.get(allDays[hi])
  if (l <= h && l < SLIVER_MAX) lo++
  else if (h < SLIVER_MAX) hi--
  else break
}
const days = allDays.slice(lo, hi + 1)
if (days.length !== COMPLETE_DAYS) {
  console.error(`REFUSING: trimming left ${days.length} day buckets, not ${COMPLETE_DAYS}.`)
  process.exit(2)
}

// Every analysed day must carry a verified price. A missing one is a refusal.
const missing = days.map(iso).filter((d) => ETH_VWAP_BY_DAY[d] === undefined || ETH_CLOSE_BY_DAY[d] === undefined)
if (missing.length > 0) {
  console.error(`REFUSING: no verified ETH price for ${missing.join(', ')}. A missing price is an UNKNOWN, never a zero.`)
  process.exit(2)
}

/**
 * Exact native wei per (recipient, day), over the analysed days only.
 * Built once; every price basis below is a different multiplication over it.
 */
const weiSeries = nd.recipients.map((r) => {
  const byDay = new Map(r.days.map((d) => [d.dayUnix, d]))
  return days.map((day) => {
    const v = byDay.get(day)?.byAssetMinor[NATIVE_SENTINEL]
    return v === undefined ? 0 : Number(BigInt(v)) / 1e18
  })
})

function median(values) {
  const s = [...values].sort((a, b) => a - b)
  if (s.length === 0) return 0
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2
}
function longestRun(series, gate) {
  let best = 0
  let cur = 0
  for (const v of series) {
    cur = v >= gate ? cur + 1 : 0
    best = Math.max(best, cur)
  }
  return best
}

const GATES = [
  ['T1', 1000],
  ['T2', 2500],
  ['T3', 20000],
]

/** Count ever / median7 / all-N-days against a per-day price vector. */
function countAt(priceByDayIndex) {
  const out = {}
  for (const [id, gate] of GATES) {
    let ever = 0
    let med = 0
    let run = 0
    for (const eth of weiSeries) {
      const usd = eth.map((e, i) => e * priceByDayIndex[i])
      if (usd.some((v) => v >= gate)) ever++
      if (median(usd.slice(-7)) >= gate) med++
      if (longestRun(usd, gate) >= COMPLETE_DAYS) run++
    }
    out[id] = { ever, med, run }
  }
  return out
}

const dayIsos = days.map(iso)
const flat = (p) => days.map(() => p)

console.log(`\nWINDOW: ${dayIsos[0]} .. ${dayIsos[dayIsos.length - 1]}  (${days.length} complete UTC days)`)

// --------------------------------------------------------------------------
console.log('\nVERIFIED ETH/USD BY UTC DAY')
console.log('---------------------------')
console.log('  date          VWAP      close     ETH credited (exact)        USD @ that day\'s VWAP')
let totalEth = 0
let totalUsdVwap = 0
let totalUsdPinned = 0
for (let i = 0; i < days.length; i++) {
  let dayEth = 0
  for (const s of weiSeries) dayEth += s[i]
  const vwap = ETH_VWAP_BY_DAY[dayIsos[i]]
  totalEth += dayEth
  totalUsdVwap += dayEth * vwap
  totalUsdPinned += dayEth * 3200
  console.log(
    `  ${dayIsos[i]}  ${vwap.toFixed(2).padStart(8)}  ${ETH_CLOSE_BY_DAY[dayIsos[i]].toFixed(2).padStart(8)}  ` +
      `${dayEth.toFixed(4).padStart(16)} ETH  ${('$' + (dayEth * vwap).toLocaleString('en-US', { maximumFractionDigits: 0 })).padStart(16)}`,
  )
}
const vwapMean = dayIsos.reduce((a, d) => a + ETH_VWAP_BY_DAY[d], 0) / days.length
const closeMean = dayIsos.reduce((a, d) => a + ETH_CLOSE_BY_DAY[d], 0) / days.length
const creditWeighted = totalUsdVwap / totalEth
console.log(`  TOTAL                              ${totalEth.toFixed(4).padStart(16)} ETH  ${('$' + totalUsdVwap.toLocaleString('en-US', { maximumFractionDigits: 0 })).padStart(16)}`)
console.log('')
console.log(`  7-day mean of daily VWAP        : $${vwapMean.toFixed(2)}`)
console.log(`  7-day mean of daily close       : $${closeMean.toFixed(2)}`)
console.log(`  ETH-WEIGHTED price of the window: $${creditWeighted.toFixed(2)}   <- the single number that reprices the window total exactly`)
console.log(`  window close (2026-09-06 24:00Z): $${ETH_CLOSE_BY_DAY['2026-09-06'].toFixed(2)}`)
console.log('')
console.log(`  TOTAL AT THE PINNED $3,200      : $${totalUsdPinned.toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
console.log(`  TOTAL AT VERIFIED PER-DAY VWAP  : $${totalUsdVwap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
console.log(`  OVERSTATEMENT BY THE PINNED RATE: $${(totalUsdPinned - totalUsdVwap).toLocaleString('en-US', { maximumFractionDigits: 0 })} (+${(((totalUsdPinned / totalUsdVwap) - 1) * 100).toFixed(1)}%)`)

// --------------------------------------------------------------------------
console.log('\nGATE POPULATIONS, PER-DAY VERIFIED PRICE (the defensible basis)')
console.log('--------------------------------------------------------------')
const perDay = countAt(dayIsos.map((d) => ETH_VWAP_BY_DAY[d]))
console.log('  gate            ever >= gate   trailing-7d-median >= gate   all 7 days >= gate')
for (const [id, gate] of GATES) {
  const c = perDay[id]
  console.log(
    `  ${id} $${String(gate).padEnd(6)}/day ${String(c.ever).padStart(12)} ${String(c.med).padStart(28)} ${String(c.run).padStart(20)}`,
  )
}

// --------------------------------------------------------------------------
console.log('\nGATE POPULATIONS, SINGLE PRICE (comparable to MEASUREMENT.md 3.2)')
console.log('-----------------------------------------------------------------')
console.log('  ETH price   basis                              T1 ever  T1 med7   T2 ever  T2 med7   T3 ever  T3 med7')
const singles = [
  [2355.20, 'window intraday LOW  (2026-09-02)'],
  [Number(vwapMean.toFixed(2)), 'mean of daily VWAP'],
  [Number(creditWeighted.toFixed(2)), 'ETH-WEIGHTED window price'],
  [Number(closeMean.toFixed(2)), 'mean of daily close'],
  [2514.31, 'window CLOSE (2026-09-06)'],
  [2546.54, 'window intraday HIGH (2026-09-04)'],
  [3200, 'THE PINNED, UNVERIFIED INPUT'],
]
for (const [price, label] of singles) {
  const c = countAt(flat(price))
  console.log(
    `  $${price.toFixed(2).padStart(8)}  ${label.padEnd(34)} ${String(c.T1.ever).padStart(7)} ${String(c.T1.med).padStart(8)}   ` +
      `${String(c.T2.ever).padStart(7)} ${String(c.T2.med).padStart(8)}   ${String(c.T3.ever).padStart(7)} ${String(c.T3.med).padStart(8)}` +
      (price === 3200 ? '   <- was quoted' : ''),
  )
}

// --------------------------------------------------------------------------
console.log('\nWHAT FLIPS THE VERDICT')
console.log('----------------------')
console.log('  reprice.ts returns GO when the standing population reaches 108 (at tenure 3.02d,')
console.log('  operator 500bps). Solving for the ETH price at which T1 median7 first reaches 108:')
let flipPrice = null
for (let p = 2000; p <= 6400; p += 25) {
  let med = 0
  for (const eth of weiSeries) {
    if (median(eth.map((e) => e * p).slice(-7)) >= 1000) med++
  }
  if (med >= 108) {
    flipPrice = p
    break
  }
}
console.log(
  flipPrice === null
    ? '  no price in $2,000..$6,400 reaches 108 on native value alone.'
    : `  T1 median7 first reaches 108 at about $${flipPrice}/ETH - ${((flipPrice / creditWeighted - 1) * 100).toFixed(0)}% above the verified price.`,
)
console.log('  NATIVE VALUE ALONE CANNOT GET THERE AT THE REAL PRICE. Closing the gap requires')
console.log('  pricing the ERC-20 tail (gap a), not a different ETH number.')

/**
 * Reads the 7-day artifacts and prints the figures the CLIs do not print:
 * the rank distribution, the day-1 -> day-7 retention of the T1 cohort, and a
 * merged-vs-native cross-check. Everything here is arithmetic over numbers the
 * toolkit already produced; nothing is re-priced or re-scanned.
 *
 *   node tools/artifacts/analyze-7d.mjs <native.json> <merged.json>
 */
import { readFileSync } from 'node:fs'

const [nativePath, mergedPath, completeDaysArg] = process.argv.slice(2)
/**
 * How many COMPLETE UTC days the window is meant to be.
 *
 * escrow-index derives windowStart as `to - days*86400` and then buckets by UTC
 * day, so a window pinned to 7 complete days always produces one extra bucket:
 * a sliver holding whatever fell in the boundary second. The run is deliberately
 * pinned so that sliver lands at the FRONT, which puts the TRAILING 7 buckets
 * exactly on the 7 complete days - and the trailing 7 is what the protocol's own
 * QF definition (trailing-7-day median) reads. Everything below analyses those
 * trailing N buckets and reports the sliver separately rather than letting a
 * near-empty day dilute a median or a consecutive-day run.
 */
const COMPLETE_DAYS = Number(completeDaysArg ?? 7)
const native = JSON.parse(readFileSync(nativePath, 'utf8'))
const nd = native.result ?? native
// The merged document is OPTIONAL: it takes far longer to scan than the native
// one, and everything in sections 1-4 is a property of the native side alone.
// Sections 5 and 6 (coverage, materiality, cross-check) need it and say so.
const merged =
  mergedPath !== undefined && mergedPath !== '-' ? JSON.parse(readFileSync(mergedPath, 'utf8')) : null
const md = merged === null ? null : (merged.result ?? merged)

const NATIVE_SENTINEL = '0x0000000000000000000000000000000000000000'
const iso = (u) => new Date(u * 1000).toISOString().slice(0, 10)
const money = (v) =>
  v === null || v === undefined ? 'UNPRICED' : `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`

function section(t) {
  console.log(`\n${t}\n${'-'.repeat(t.length)}`)
}

// ---------------------------------------------------------------------------
section('WINDOW')
console.log(`native doc : ${iso(nd.windowStartDayUnix)} .. ${iso(nd.windowEndDayUnix)}  ${nd.windowDays}d  blocks ${nd.fromBlock}..${nd.toBlock}`)
console.log(`             mode=${nd.mode} credits=${nd.totalCredits.toLocaleString()} recipients=${nd.recipients.length.toLocaleString()}`)
if (md === null) {
  console.log('merged doc : NOT SUPPLIED. Sections 5 and 6 (ERC-20 coverage, materiality, cross-check) are skipped.')
} else {
  console.log(`merged doc : ${iso(md.windowStartDayUnix)} .. ${iso(md.windowEndDayUnix)}  ${md.windowDays}d  blocks ${md.fromBlock}..${md.toBlock}`)
  console.log(`             mode=${md.mode} credits=${md.totalCredits.toLocaleString()} recipients=${md.recipients.length.toLocaleString()}`)
}
console.log(`price source: ${nd.priceSource}  pinned ${new Date(nd.pricedAtUnix * 1000).toISOString()}`)
console.log(`ETH price   : ${JSON.stringify(nd.priceUsdByAsset[NATIVE_SENTINEL])} (AN INPUT, not a measurement)`)

// ---------------------------------------------------------------------------
// 1. Escrow-wide daily totals (native side; every native day is priced).
// ---------------------------------------------------------------------------
section('1. ESCROW-WIDE DAILY CREDIT TOTAL (native asset, priced at the pinned ETH rate)')
const allDays = [...new Set(nd.recipients.flatMap((r) => r.days.map((d) => d.dayUnix)))].sort((a, b) => a - b)
const creditsOnDay = new Map(allDays.map((d) => [d, 0]))
for (const r of nd.recipients) {
  for (const d of r.days) creditsOnDay.set(d.dayUnix, creditsOnDay.get(d.dayUnix) + d.creditCount)
}

/**
 * Trim boundary buckets, by CONTENT rather than by assumption.
 *
 * Which end the sliver lands on depends on how `--to` was pinned, so guessing
 * "it is the first one" silently deletes a real day when the run was pinned the
 * other way. A boundary bucket is only dropped when it holds under 1% of the
 * mean daily credit count - i.e. it is the boundary-second artefact it claims to
 * be - and if trimming does not leave exactly COMPLETE_DAYS days, this refuses
 * rather than analysing a window it cannot describe.
 */
const meanDailyCredits = [...creditsOnDay.values()].reduce((a, b) => a + b, 0) / allDays.length
const SLIVER_MAX = meanDailyCredits * 0.01
let lo = 0
let hi = allDays.length - 1
const dropped = []
while (hi - lo + 1 > COMPLETE_DAYS && lo <= hi) {
  const loCredits = creditsOnDay.get(allDays[lo])
  const hiCredits = creditsOnDay.get(allDays[hi])
  if (loCredits <= hiCredits && loCredits < SLIVER_MAX) dropped.push({ day: allDays[lo], credits: loCredits, end: 'leading' }), lo++
  else if (hiCredits < SLIVER_MAX) dropped.push({ day: allDays[hi], credits: hiCredits, end: 'trailing' }), hi--
  else break
}
const days = allDays.slice(lo, hi + 1)
for (const d of dropped) {
  console.log(
    `excluded ${d.end} boundary bucket ${iso(d.day)}: ${d.credits} credit(s), under 1% of the ` +
      `${meanDailyCredits.toFixed(0)}/day mean - a UTC-day-boundary artefact, not a day of trading.`,
  )
}
if (days.length !== COMPLETE_DAYS) {
  console.error(
    `REFUSING: the document has ${allDays.length} day bucket(s) and trimming boundary slivers left ` +
      `${days.length}, not the ${COMPLETE_DAYS} complete days asked for. Credits per bucket: ` +
      allDays.map((d) => `${iso(d)}=${creditsOnDay.get(d)}`).join(' ') +
      `. A window that is not the window requested cannot be reported as if it were.`,
  )
  process.exit(2)
}
const inWindow = new Set(days)
/** A recipient's daily USD over the ANALYSED days only, in day order. */
const seriesOf = (r) => days.map((day) => r.days.find((d) => d.dayUnix === day)?.usd ?? 0)
/** A recipient's window total over the ANALYSED days only. */
const totalOf = (r) =>
  r.days.filter((d) => inWindow.has(d.dayUnix)).reduce((a, d) => a + (d.usd ?? 0), 0)

const dailyUsd = new Map(days.map((d) => [d, 0]))
const dailyWei = new Map(days.map((d) => [d, 0n]))
const dailyRecipients = new Map(days.map((d) => [d, new Set()]))
const dailyCredits = new Map(days.map((d) => [d, 0]))
let anyNull = false
for (const r of nd.recipients) {
  for (const d of r.days) {
    if (!inWindow.has(d.dayUnix)) continue
    if (d.usd === null) anyNull = true
    else dailyUsd.set(d.dayUnix, dailyUsd.get(d.dayUnix) + d.usd)
    const wei = d.byAssetMinor[NATIVE_SENTINEL]
    if (wei !== undefined) dailyWei.set(d.dayUnix, dailyWei.get(d.dayUnix) + BigInt(wei))
    if (d.creditCount > 0) {
      dailyRecipients.get(d.dayUnix).add(r.recipient)
      dailyCredits.set(d.dayUnix, dailyCredits.get(d.dayUnix) + d.creditCount)
    }
  }
}
console.log(anyNull ? 'WARNING: at least one native day is unpriced.' : 'every native day is priced (no UNPRICED days)')
console.log('  date          ETH (exact, from wei)        USD @ pinned rate   recipients   credits')
let totalWei = 0n
for (const d of days) {
  const wei = dailyWei.get(d)
  totalWei += wei
  const eth = Number(wei / 10n ** 12n) / 1e6
  console.log(
    `  ${iso(d)}  ${eth.toFixed(4).padStart(14)} ETH  ${money(dailyUsd.get(d)).padStart(18)}  ` +
      `${String(dailyRecipients.get(d).size).padStart(10)}  ${String(dailyCredits.get(d)).padStart(8)}`,
  )
}
const totalEth = Number(totalWei / 10n ** 12n) / 1e6
console.log(`  TOTAL         ${totalEth.toFixed(4).padStart(14)} ETH  ${money([...dailyUsd.values()].reduce((a, b) => a + b, 0)).padStart(18)}`)
console.log(`  total wei (exact, bigint): ${totalWei}`)
console.log(`  mean/day: ${(totalEth / days.length).toFixed(4)} ETH = ${money((totalEth / days.length) * nd.priceUsdByAsset[NATIVE_SENTINEL])}`)

// ---------------------------------------------------------------------------
// 2. Population at each gate.
// ---------------------------------------------------------------------------
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

section('2. POPULATION AT EACH GATE (native, fully priced)')
console.log('  gate        ever>=gate   trailing-7d-median>=gate   all 7 consecutive days>=gate')
const gates = [1000, 2500, 20000]
const gateResults = {}
for (const gate of gates) {
  let ever = 0
  let med7 = 0
  let run7 = 0
  for (const r of nd.recipients) {
    const series = seriesOf(r)
    if (series.some((v) => v >= gate)) ever++
    if (median(series.slice(-7)) >= gate) med7++
    if (longestRun(series, gate) >= COMPLETE_DAYS) run7++
  }
  gateResults[gate] = { ever, med7, run7 }
  console.log(
    `  $${String(gate).padEnd(6)}/day ${String(ever).padStart(10)} ${String(med7).padStart(26)} ${String(run7).padStart(30)}`,
  )
}

// ---------------------------------------------------------------------------
// 2b. How much of the answer rests on the ETH price input.
// ---------------------------------------------------------------------------
section('2b. SENSITIVITY OF THE GATE COUNTS TO THE ETH PRICE INPUT')
const pinnedEth = nd.priceUsdByAsset[NATIVE_SENTINEL]
console.log(`  Every USD figure here is (exact bigint wei) x $${pinnedEth} / 1e18. The ETH price is an`)
console.log('  UNVERIFIED INPUT, not a measurement. USD totals scale linearly in it; gate COUNTS do')
console.log('  not, because they are threshold counts over a distribution. Re-counting at other prices:')
console.log('')
console.log('  ETH price    T1 ever  T1 median7    T2 ever  T2 median7    T3 ever  T3 median7')
for (const price of [1600, 2400, 3200, 4000, 6400]) {
  // A recipient's USD at price p is its USD at the pinned price times p/pinned,
  // so counting at price p is counting against a rescaled gate. Exact, and it
  // needs neither a re-price nor a re-scan.
  const scale = pinnedEth / price
  const cells = []
  for (const gate of [1000, 2500, 20000]) {
    const g = gate * scale
    let ever = 0
    let med = 0
    for (const r of nd.recipients) {
      const s = seriesOf(r)
      if (s.some((v) => v >= g)) ever++
      if (median(s.slice(-7)) >= g) med++
    }
    cells.push(ever, med)
  }
  console.log(
    `  $${String(price).padEnd(8)} ${cells.map((c) => String(c).padStart(10)).join(' ')}` +
      (price === pinnedEth ? '   <- the pinned input' : ''),
  )
}

// ---------------------------------------------------------------------------
// 3. Tenure signal: day-1 T1 cohort still above T1 on day 7.
// ---------------------------------------------------------------------------
section('3. TENURE SIGNAL: the day-1 T1 cohort, followed to day 7')
const firstDay = days[0]
const lastDay = days[days.length - 1]
for (const gate of [1000, 2500, 20000]) {
  const day1Cohort = nd.recipients.filter((r) => {
    const d = r.days.find((x) => x.dayUnix === firstDay)
    return d && (d.usd ?? 0) >= gate
  })
  const stillDay7 = day1Cohort.filter((r) => {
    const d = r.days.find((x) => x.dayUnix === lastDay)
    return d && (d.usd ?? 0) >= gate
  })
  const everyDay = day1Cohort.filter((r) => seriesOf(r).every((v) => v >= gate))
  const pct = day1Cohort.length === 0 ? 0 : (stillDay7.length / day1Cohort.length) * 100
  console.log(
    `  $${gate}/day: ${day1Cohort.length} above on ${iso(firstDay)} -> ${stillDay7.length} still above on ${iso(lastDay)} ` +
      `(${pct.toFixed(1)}%);  ${everyDay.length} held it on ALL ${days.length} days`,
  )
}
// Mean observed days-above-gate, the crude tenure read.
for (const gate of [1000]) {
  const above = nd.recipients
    .map((r) => seriesOf(r).filter((v) => v >= gate).length)
    .filter((n) => n > 0)
  if (above.length === 0) {
    console.log(`  no recipient was ever above $${gate}/day, so there is no days-above distribution.`)
  } else {
    const mean = above.reduce((a, b) => a + b, 0) / above.length
    console.log(
      `  days above $${gate}/day among the ${above.length} recipients ever above it: mean ${mean.toFixed(2)}d, ` +
        `median ${median(above)}d, max ${Math.max(...above)}d (CENSORED by a ${days.length}-day window)`,
    )
  }
}

// ---------------------------------------------------------------------------
// 4. Distribution.
// ---------------------------------------------------------------------------
section('4. DISTRIBUTION of per-recipient MEAN DAILY USD over the window (native)')
const perDay = nd.recipients
  .map((r) => {
    const total = totalOf(r)
    return { recipient: r.recipient, usdPerDay: total / days.length, total }
  })
  .sort((a, b) => b.usdPerDay - a.usdPerDay)
for (const rank of [1, 10, 100, 500, 1000, 2000, 5000]) {
  const row = perDay[rank - 1]
  console.log(
    row
      ? `  rank ${String(rank).padStart(5)}: ${money(row.usdPerDay).padStart(14)}/day   (window total ${money(row.total)})  ${row.recipient}`
      : `  rank ${String(rank).padStart(5)}: n/a (only ${perDay.length} recipients)`,
  )
}
console.log(`  median  : ${money(median(perDay.map((p) => p.usdPerDay)))}/day  across ${perDay.length.toLocaleString()} recipients`)
const totalAll = perDay.reduce((a, p) => a + p.total, 0)
const top100 = perDay.slice(0, 100).reduce((a, p) => a + p.total, 0)
console.log(`  top 100 recipients hold ${((top100 / totalAll) * 100).toFixed(1)}% of all native credit value in the window`)

// ---------------------------------------------------------------------------
// 5. Coverage / materiality from the MERGED document.
// ---------------------------------------------------------------------------
if (md === null) {
  console.log('\n5-6. SKIPPED: no merged document was supplied, so the ERC-20 share and the')
  console.log('     merged-vs-native cross-check cannot be computed. The native figures above')
  console.log('     stand on their own as a LOWER BOUND on total escrow credit value.')
  process.exit(0)
}
section('5. UNPRICED SHARE AND ERC-20 MATERIALITY (merged document)')
const cov = md.pricing
if (cov) {
  console.log(`  assets seen        : ${cov.assetsSeen.toLocaleString()}  unpriced ${cov.assetsUnpriced.toLocaleString()}`)
  console.log(`  recipients         : ${cov.recipientsTotal.toLocaleString()}  holding >=1 unpriced credit ${cov.recipientsUnpriced.toLocaleString()} (${((cov.recipientsUnpriced / cov.recipientsTotal) * 100).toFixed(1)}%)`)
  console.log(`  credits            : ${cov.creditsTotal.toLocaleString()}  unpriced ${cov.creditsUnpriced.toLocaleString()} (${(cov.unpricedCreditShare * 100).toFixed(1)}%)`)
  console.log(`  exact (not reconstructed): ${cov.exact}   complete: ${cov.complete}`)
}
const nativeRow = md.assetTotals.find((a) => a.kind === 'native')
const erc20Rows = md.assetTotals.filter((a) => a.kind === 'erc20')
const erc20Priced = erc20Rows.filter((a) => a.totalUsd !== null)
console.log(`  native row (merged): ${nativeRow.totalMinor} wei = ${money(nativeRow.totalUsd)}  credits ${nativeRow.credits.toLocaleString()} recipients ${nativeRow.recipients.toLocaleString()}`)
console.log(`  erc20 assets       : ${erc20Rows.length.toLocaleString()}  priced ${erc20Priced.length}  priced value ${money(erc20Priced.reduce((a, r) => a + r.totalUsd, 0))}`)
const nativeUsd = nativeRow.totalUsd ?? 0
const ercUsd = erc20Priced.reduce((a, r) => a + r.totalUsd, 0)
console.log(`  priced ERC-20 as a share of native: ${((ercUsd / nativeUsd) * 100).toFixed(1)}%  <- A LOWER BOUND (unpriced tail can only add)`)
console.log('  top 12 ERC-20 assets by RECIPIENT COUNT (the only ranking an unpriced asset supports):')
for (const a of [...erc20Rows].sort((x, y) => y.recipients - x.recipients).slice(0, 12)) {
  console.log(
    `    ${a.asset}  sym=${String(a.symbol).padEnd(12)} dec=${String(a.decimals).padStart(2)} ` +
      `recipients=${String(a.recipients).padStart(6)} credits=${String(a.credits).padStart(7)} usd=${money(a.totalUsd)}`,
  )
}

// ---------------------------------------------------------------------------
// 6. Cross-check: the native side of the merged doc must equal the native doc.
// ---------------------------------------------------------------------------
section('6. CROSS-CHECK: merged doc\'s native side vs the native-only doc')
// COMPARE LIKE WITH LIKE. `totalWei` is summed over the ANALYSED days only,
// while the document's assetTotals row covers every bucket including the
// excluded boundary sliver. Comparing the two directly reports a mismatch that
// is really just the sliver, and a cross-check that cries wolf is worse than no
// cross-check at all. So the sliver is added back explicitly and named.
let sliverWei = 0n
for (const r of nd.recipients) {
  for (const d of r.days) {
    if (inWindow.has(d.dayUnix)) continue
    sliverWei += BigInt(d.byAssetMinor[NATIVE_SENTINEL] ?? '0')
  }
}
const totalWeiAllBuckets = totalWei + sliverWei
console.log(`  native-only total wei, ${days.length} analysed days : ${totalWei}`)
console.log(`  + excluded boundary bucket(s)               : ${sliverWei} wei (${money((Number(sliverWei / 10n ** 9n) / 1e9) * pinnedEth)})`)
console.log(`  = native-only total, all buckets            : ${totalWeiAllBuckets}`)
console.log(`  merged native row wei                      : ${nativeRow.totalMinor}`)
console.log(`  EXACT MATCH: ${String(totalWeiAllBuckets) === nativeRow.totalMinor ? 'YES' : 'NO  <-- INVESTIGATE'}`)
console.log(`  native-only credits ${nd.totalCredits.toLocaleString()} vs merged native row credits ${nativeRow.credits.toLocaleString()}: ${nd.totalCredits === nativeRow.credits ? 'MATCH' : 'MISMATCH <-- INVESTIGATE'}`)
console.log(`  native-only recipients ${nd.recipients.length.toLocaleString()} vs merged native row recipients ${nativeRow.recipients.toLocaleString()}: ${nd.recipients.length === nativeRow.recipients ? 'MATCH' : 'MISMATCH <-- INVESTIGATE'}`)

// Per-(recipient,day) native wei must agree cell by cell.
let cells = 0
let mismatches = 0
const mergedByRecipient = new Map(md.recipients.map((r) => [r.recipient, r]))
for (const r of nd.recipients) {
  const m = mergedByRecipient.get(r.recipient)
  if (!m) {
    mismatches++
    continue
  }
  const mDays = new Map(m.days.map((d) => [d.dayUnix, d]))
  for (const d of r.days) {
    const a = d.byAssetMinor[NATIVE_SENTINEL] ?? '0'
    const b = mDays.get(d.dayUnix)?.byAssetMinor[NATIVE_SENTINEL] ?? '0'
    cells++
    if (a !== b) mismatches++
  }
}
console.log(`  per-(recipient,day) native wei cells compared: ${cells.toLocaleString()}, mismatches: ${mismatches}`)

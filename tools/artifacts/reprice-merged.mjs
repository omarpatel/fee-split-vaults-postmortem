/**
 * Re-price an EXISTING merged escrow document against an expanded price book,
 * and re-count the QF gate populations. No re-scan, no network.
 *
 *   node tools/artifacts/reprice-merged.mjs <merged.json> <assets.json> <completeDays> [out.json]
 *
 * WHY THIS IS SOUND WITHOUT RE-SCANNING. The merged document already carries,
 * per recipient and per UTC day, the EXACT minor-unit amount credited in every
 * asset (`days[].byAssetMinor`). USD is a derived reporting figure, never an
 * input to an amount, so re-deriving it from a different price book is exact
 * arithmetic over data already on disk. The chain is not consulted and cannot
 * disagree.
 *
 * THE BOUND, STATED PRECISELY. Every credit adds a NON-NEGATIVE amount of value.
 * So for any recipient and day, summing only the assets that have a price gives
 * a value no larger than the truth. Gate counts are threshold counts over that
 * value, a pointwise-larger series has a pointwise-larger trailing median, and a
 * run of N consecutive days can only lengthen. Therefore:
 *
 *     every gate count printed here is a LOWER BOUND on the true population.
 *
 * That is a bounding argument, not an approximation, and it is the SAME argument
 * that made the native-only count of 99 a lower bound. Adding prices moves the
 * bound up; it never invalidates it.
 *
 * WHAT IS NOT DONE. Unpriced assets are NOT dropped from the reckoning and NOT
 * treated as a measurement of zero. They are counted, their reach is reported,
 * and - the number that actually matters for a STOP/GO sitting 8% from flipping
 * - the recipients who fall BELOW a gate on priced value while still holding
 * unpriced credits are counted separately as the residual headroom. That is the
 * honest form of "how much room is left in the bound".
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { readHeader, streamRecipients } from '../lib/doc-stream.ts'
import { longestRun, median, scaleTable, valueDay } from '../lib/doc-reprice.ts'

const [mergedPath, assetsPath, completeDaysArg, outPath] = process.argv.slice(2)
const COMPLETE_DAYS = Number(completeDaysArg ?? 7)
const NATIVE = '0x0000000000000000000000000000000000000000'
const GATES = [
  { id: 'T1', label: 'T1 Desk', usdPerDay: 1000 },
  { id: 'T2', label: 'T2 Campaign', usdPerDay: 2500 },
  { id: 'T3', label: 'T3 Flagship', usdPerDay: 20000 },
]

const { result: doc, recipientsOffset } = readHeader(mergedPath)
/**
 * The recipient count the document declares. `readHeader` truncates the array
 * itself, so this comes from the pricing block written at aggregation time -
 * and it is reconciled against what the stream actually yielded, because a
 * short read on a 229 MB file must never be reported as a smaller market.
 */
const declaredRecipients = doc.pricing?.recipientsTotal ?? null

// ---------------------------------------------------------------------------
// The price books. THREE of them, run side by side, because the question is not
// "what is the number" but "how much did pricing the ERC-20 head move it".
// ---------------------------------------------------------------------------
const decimalsOf = new Map(Object.entries(doc.assetDecimals ?? {}))
const symbolOf = new Map(Object.entries(doc.assetSymbols ?? {}))
const kindOf = new Map(Object.entries(doc.assetKinds ?? {}))

/** Book A: exactly what the stored document was priced with. */
const bookStored = new Map()
for (const [asset, price] of Object.entries(doc.priceUsdByAsset ?? {})) {
  if (price !== null && price !== undefined) bookStored.set(asset.toLowerCase(), price)
}
/** Book N: the native asset alone - the basis the 99 was measured on. */
const bookNative = new Map([[NATIVE, bookStored.get(NATIVE)]])
if (bookNative.get(NATIVE) === undefined) {
  console.error('REFUSING: the document has no native price. Every comparison below is against it.')
  process.exit(2)
}
/** Book X: stored, plus every operator-supplied price in the assets file. */
const entries = JSON.parse(readFileSync(assetsPath, 'utf8'))
const bookExpanded = new Map(bookStored)
const added = []
const refusedEntries = []
for (const entry of entries) {
  const address = String(entry.address).toLowerCase()
  if (entry.priceUsd === undefined || entry.priceUsd === null) continue
  if (typeof entry.priceUsd !== 'number' || !Number.isFinite(entry.priceUsd) || entry.priceUsd <= 0) {
    console.error(`REFUSING: ${address} has a non-positive or non-finite price.`)
    process.exit(2)
  }
  // The scale a price is applied at must be the scale the chain READ. An entry
  // whose decimals disagree with the document's is a factor-of-ten error
  // waiting to happen - the exact error that once rendered $9.03M as 9.033e-6.
  const documentDecimals = decimalsOf.get(address)
  if (entry.decimals !== undefined && documentDecimals !== undefined && entry.decimals !== documentDecimals) {
    refusedEntries.push({ address, reason: `decimals ${entry.decimals} != document ${documentDecimals}` })
    continue
  }
  if (documentDecimals === undefined) {
    refusedEntries.push({ address, reason: 'asset not present in this document' })
    continue
  }
  if (!bookStored.has(address)) added.push(address)
  bookExpanded.set(address, entry.priceUsd)
}
if (refusedEntries.length > 0) {
  console.error(`REFUSED ${refusedEntries.length} price entr(ies):`)
  for (const r of refusedEntries.slice(0, 10)) console.error(`  ${r.address}: ${r.reason}`)
}

const scaleOf = scaleTable(doc.assetDecimals)

// ---------------------------------------------------------------------------
// Pass 1: establish which day buckets are the COMPLETE days.
// Identical rule to analyze-7d.mjs so the counts are comparable line for line:
// a boundary bucket is dropped only when it holds under 1% of the mean daily
// credit count, and if trimming does not leave exactly COMPLETE_DAYS, refuse.
// ---------------------------------------------------------------------------
const creditsOnDay = new Map()
let streamed = 0
let creditsSeen = 0
for (const recipient of streamRecipients(mergedPath, recipientsOffset)) {
  streamed++
  for (const day of recipient.days) {
    creditsOnDay.set(day.dayUnix, (creditsOnDay.get(day.dayUnix) ?? 0) + day.creditCount)
    creditsSeen += day.creditCount
  }
}
if (streamed === 0) {
  console.error('REFUSING: streamed zero recipients. That is a read failure, not an empty market.')
  process.exit(2)
}
if (creditsSeen !== doc.totalCredits) {
  console.error(
    `REFUSING: streamed ${creditsSeen} credits but the document declares ${doc.totalCredits}. ` +
      `A short read must never be reported as a smaller market.`,
  )
  process.exit(2)
}
if (declaredRecipients !== null && streamed !== declaredRecipients) {
  console.error(
    `REFUSING: streamed ${streamed} recipients but the document declares ${declaredRecipients}. ` +
      `A short read must never be reported as a smaller market.`,
  )
  process.exit(2)
}

const allDays = [...creditsOnDay.keys()].sort((a, b) => a - b)
const meanDaily = [...creditsOnDay.values()].reduce((a, b) => a + b, 0) / allDays.length
const SLIVER_MAX = meanDaily * 0.01
let lo = 0
let hi = allDays.length - 1
const dropped = []
while (hi - lo + 1 > COMPLETE_DAYS && lo <= hi) {
  const loCredits = creditsOnDay.get(allDays[lo])
  const hiCredits = creditsOnDay.get(allDays[hi])
  if (loCredits <= hiCredits && loCredits < SLIVER_MAX) {
    dropped.push({ day: allDays[lo], credits: loCredits, end: 'leading' })
    lo++
  } else if (hiCredits < SLIVER_MAX) {
    dropped.push({ day: allDays[hi], credits: hiCredits, end: 'trailing' })
    hi--
  } else break
}
const days = allDays.slice(lo, hi + 1)
if (days.length !== COMPLETE_DAYS) {
  console.error(
    `REFUSING: ${allDays.length} bucket(s), trimming slivers left ${days.length}, not ${COMPLETE_DAYS}.`,
  )
  process.exit(2)
}
const dayIndex = new Map(days.map((d, i) => [d, i]))
const iso = (u) => new Date(u * 1000).toISOString().slice(0, 10)

// ---------------------------------------------------------------------------
// Pass 2: value every recipient under all three books and count the gates.
// ---------------------------------------------------------------------------
const books = [
  { key: 'native', label: 'native only (ETH)', book: bookNative },
  { key: 'stored', label: 'native + USDG (the published run)', book: bookStored },
  { key: 'expanded', label: 'native + USDG + priced ERC-20 head', book: bookExpanded },
]
const counts = {}
for (const b of books) {
  counts[b.key] = {}
  for (const g of GATES) counts[b.key][g.id] = { ever: 0, median7: 0, allDays: 0 }
}
/**
 * Recipients below the gate on PRICED value that still hold unpriced credits.
 *
 * Banded by how close they already are, because "42,839 could still cross" is
 * true and useless: almost all of them are dust three orders of magnitude below
 * the gate, and the ones that could realistically cross are the ones already
 * within a factor of two or four. The bands make the residual uncertainty a
 * number instead of a shrug.
 */
const headroom = {}
for (const g of GATES) {
  headroom[g.id] = { belowWithUnpriced: 0, belowFullyPriced: 0, within2x: 0, within4x: 0, within10x: 0 }
}
/** Gate counts restricted to recipients with NO unpriced credit at all. */
const strictCounts = {}
for (const g of GATES) strictCounts[g.id] = { median7: 0 }
let strictPopulation = 0

const totals = {
  nativeUsd: 0,
  erc20PricedUsd: 0,
  creditsPriced: 0,
  creditsUnpricedDayLevel: 0,
  recipientsWithUnpriced: 0,
  recipientsTotal: 0,
}
const dailyNativeWei = new Map(days.map((d) => [d, 0n]))
const perRecipient = []
/**
 * Per-recipient daily value split into its NATIVE and its priced-ERC-20 halves.
 *
 * Kept so the ETH-price sensitivity below costs no extra pass over the 229 MB
 * document. It matters because the ETH price is an INPUT nobody in this
 * measurement verified, gate counts are threshold counts rather than linear in
 * it, and the published run showed the T1 population moving from 56 to 141
 * across $1,600-$6,400 on native value alone. Pricing the ERC-20 head adds a
 * component that does NOT move with ETH, so the whole point is to find out
 * whether the answer is still ETH-dominated. Two Float64Arrays of 7 cells per
 * recipient is ~13 MB, which is cheap next to re-streaming the file five times.
 */
const nativeSeries = []
const erc20Series = []

for (const recipient of streamRecipients(mergedPath, recipientsOffset)) {
  totals.recipientsTotal++
  const series = { native: new Array(COMPLETE_DAYS).fill(0), stored: new Array(COMPLETE_DAYS).fill(0), expanded: new Array(COMPLETE_DAYS).fill(0) }
  const nativeDaily = new Float64Array(COMPLETE_DAYS)
  const erc20Daily = new Float64Array(COMPLETE_DAYS)
  let anyUnpricedExpanded = false
  let creditsInWindow = 0

  for (const day of recipient.days) {
    const i = dayIndex.get(day.dayUnix)
    if (i === undefined) continue
    creditsInWindow += day.creditCount
    for (const b of books) {
      const { usd, unpricedAssets } = valueDay(day.byAssetMinor, b.book, scaleOf)
      series[b.key][i] = usd
      if (b.key === 'expanded' && unpricedAssets > 0) anyUnpricedExpanded = true
    }
    const wei = day.byAssetMinor[NATIVE]
    if (wei !== undefined) dailyNativeWei.set(day.dayUnix, dailyNativeWei.get(day.dayUnix) + BigInt(wei))
    if (day.creditCount > 0) {
      if (Object.keys(day.byAssetMinor).some((a) => !bookExpanded.has(a))) {
        totals.creditsUnpricedDayLevel += day.creditCount
      } else {
        totals.creditsPriced += day.creditCount
      }
    }
    // Value split native vs ERC-20, expanded book.
    for (const [asset, minorText] of Object.entries(day.byAssetMinor)) {
      const price = bookExpanded.get(asset)
      if (price === undefined) continue
      const scale = scaleOf.get(asset)
      const minor = BigInt(minorText)
      const usd = (Number(minor / scale) + Number(minor % scale) / Number(scale)) * price
      if (asset === NATIVE) {
        totals.nativeUsd += usd
        nativeDaily[i] += usd
      } else {
        totals.erc20PricedUsd += usd
        erc20Daily[i] += usd
      }
    }
  }
  nativeSeries.push(nativeDaily)
  erc20Series.push(erc20Daily)

  if (anyUnpricedExpanded) totals.recipientsWithUnpriced++
  else strictPopulation++

  for (const b of books) {
    const s = series[b.key]
    for (const g of GATES) {
      const c = counts[b.key][g.id]
      if (s.some((v) => v >= g.usdPerDay)) c.ever++
      if (median(s.slice(-7)) >= g.usdPerDay) c.median7++
      if (longestRun(s, g.usdPerDay) >= COMPLETE_DAYS) c.allDays++
    }
  }
  for (const g of GATES) {
    const med = median(series.expanded.slice(-7))
    if (med < g.usdPerDay) {
      if (anyUnpricedExpanded) {
        headroom[g.id].belowWithUnpriced++
        if (med >= g.usdPerDay / 2) headroom[g.id].within2x++
        else if (med >= g.usdPerDay / 4) headroom[g.id].within4x++
        else if (med >= g.usdPerDay / 10) headroom[g.id].within10x++
      } else headroom[g.id].belowFullyPriced++
    } else if (!anyUnpricedExpanded) {
      strictCounts[g.id].median7++
    }
  }

  if (creditsInWindow > 0) {
    const total = series.expanded.reduce((a, b) => a + b, 0)
    perRecipient.push({ recipient: recipient.recipient, total, hasUnpriced: anyUnpricedExpanded })
  }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
const line = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`)
const money = (v) => (v === null ? 'UNPRICED' : `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`)

console.log(`document : ${mergedPath}`)
console.log(`window   : ${iso(days[0])} .. ${iso(days[days.length - 1])}  (${days.length} complete UTC days)`)
for (const d of dropped) {
  console.log(`  excluded ${d.end} boundary bucket ${iso(d.day)}: ${d.credits} credit(s), a UTC-day artefact`)
}
console.log(
  `recipients streamed: ${totals.recipientsTotal.toLocaleString()}` +
    (declaredRecipients === null
      ? ' (the document declares no recipient total to reconcile against)'
      : ` == document pricing.recipientsTotal ${declaredRecipients.toLocaleString()}`),
)
console.log(`credits reconciled : ${creditsSeen.toLocaleString()} == document totalCredits ${doc.totalCredits.toLocaleString()}`)
console.log(`ETH price (INPUT)  : $${bookNative.get(NATIVE)}`)

line('PRICE BOOK')
console.log(`  stored book   : ${bookStored.size} asset(s) priced`)
console.log(`  expanded book : ${bookExpanded.size} asset(s) priced  (+${added.length} newly priced)`)
console.log(`  refused       : ${refusedEntries.length} entr(ies)`)

line('COVERAGE AFTER REPRICING')
const assetsSeen = decimalsOf.size
const pricedAssets = [...bookExpanded.keys()].filter((a) => decimalsOf.has(a)).length
console.log(`  assets      : ${pricedAssets.toLocaleString()} priced of ${assetsSeen.toLocaleString()} seen`)

/**
 * EXACT per-credit coverage, from the document's own per-asset credit counts.
 *
 * This is the figure comparable to the published "44.0% of credits unpriced":
 * it counts a CREDIT EVENT as priced when its own asset has a price, which is
 * exact. The cell-level figure below counts every credit sharing a
 * (recipient,day) cell with an unpriced asset and is therefore an upper bound
 * on unpriced - two different questions, and quoting one for the other
 * overstates the gap.
 */
let creditsAssetPriced = 0
let creditsAssetUnpriced = 0
let unpricedAssetCount = 0
for (const row of doc.assetTotals ?? []) {
  if (bookExpanded.has(row.asset.toLowerCase())) creditsAssetPriced += row.credits
  else {
    creditsAssetUnpriced += row.credits
    unpricedAssetCount++
  }
}
console.log(
  `  credits     : ${creditsAssetPriced.toLocaleString()} of ${creditsSeen.toLocaleString()} ` +
    `(${((creditsAssetPriced / creditsSeen) * 100).toFixed(1)}%) are in a PRICED ASSET  <- exact, per credit`,
)
console.log(
  `                ${creditsAssetUnpriced.toLocaleString()} (${((creditsAssetUnpriced / creditsSeen) * 100).toFixed(1)}%) ` +
    `are in one of the ${unpricedAssetCount.toLocaleString()} assets still unpriced`,
)
console.log(
  `                ${totals.creditsPriced.toLocaleString()} (${((totals.creditsPriced / creditsSeen) * 100).toFixed(1)}%) ` +
    `sit in a (recipient,day) cell where EVERY asset is priced; the other ` +
    `${totals.creditsUnpricedDayLevel.toLocaleString()} share a cell with something unpriced`,
)
console.log(
  `  recipients  : ${totals.recipientsWithUnpriced.toLocaleString()} of ${totals.recipientsTotal.toLocaleString()} ` +
    `(${((totals.recipientsWithUnpriced / totals.recipientsTotal) * 100).toFixed(1)}%) hold >=1 unpriced credit`,
)
console.log(`  value       : native ${money(totals.nativeUsd)}  +  priced ERC-20 ${money(totals.erc20PricedUsd)}`)
console.log(`                total priced ${money(totals.nativeUsd + totals.erc20PricedUsd)}  <- STILL A LOWER BOUND`)
console.log(`                priced ERC-20 as a share of native: ${((totals.erc20PricedUsd / totals.nativeUsd) * 100).toFixed(1)}%`)

line('POPULATION AT EACH GATE, BY PRICE BOOK (every count is a LOWER BOUND)')
console.log('  gate          book                                    ever>=gate   median7>=gate   all 7 days')
for (const g of GATES) {
  for (const b of books) {
    const c = counts[b.key][g.id]
    console.log(
      `  ${g.label.padEnd(12)}  ${b.label.padEnd(36)} ${String(c.ever).padStart(10)} ${String(c.median7).padStart(15)} ${String(c.allDays).padStart(12)}`,
    )
  }
  console.log('')
}

line('THE DELTA THAT MATTERS')
for (const g of GATES) {
  const before = counts.native[g.id].median7
  const after = counts.expanded[g.id].median7
  console.log(
    `  ${g.label.padEnd(12)} $${String(g.usdPerDay).padStart(5)}/day standing: ${String(before).padStart(4)} (native only)  ->  ` +
      `${String(after).padStart(4)} (head priced)   ${after - before >= 0 ? '+' : ''}${after - before}` +
      `  (${before === 0 ? 'n/a' : `${(((after - before) / before) * 100).toFixed(1)}%`})`,
  )
}

line('RESIDUAL HEADROOM: how much room is left in the bound')
console.log('  Recipients BELOW the gate on priced value that still hold unpriced credits could')
console.log('  still cross it. Recipients below it with everything priced cannot.')
for (const g of GATES) {
  const h = headroom[g.id]
  console.log(
    `  ${g.label.padEnd(12)} standing ${String(counts.expanded[g.id].median7).padStart(5)}  |  ` +
      `below-with-unpriced ${String(h.belowWithUnpriced).padStart(7)} (could still cross)  |  ` +
      `below-fully-priced ${String(h.belowFullyPriced).padStart(7)} (cannot)`,
  )
  console.log(
    `  ${' '.repeat(12)}   of those that could cross, priced median7 is already within ` +
      `2x of the gate for ${h.within2x}, 4x for ${h.within4x}, 10x for ${h.within10x}` +
      ` - the rest are further than 10x below and would need an unpriced holding ` +
      `an order of magnitude larger than everything they were priced on.`,
  )
}
console.log('')
console.log(`  Fully-priced sub-population: ${strictPopulation.toLocaleString()} recipients have NO unpriced credit at all.`)
console.log('  Their gate counts are EXACT rather than bounded:')
for (const g of GATES) {
  console.log(`    ${g.label.padEnd(12)} ${String(strictCounts[g.id].median7).padStart(5)} standing (exact, over that sub-population)`)
}

line('SENSITIVITY OF THE NEW COUNTS TO THE ETH PRICE INPUT')
console.log(`  The ETH price is an UNVERIFIED INPUT pinned at $${bookNative.get(NATIVE)}. Native value scales`)
console.log('  linearly in it; the priced ERC-20 value does NOT move with it at all. So re-counting at')
console.log('  other ETH prices asks a question the native-only measurement could not: how much of the')
console.log('  standing population still rests on that one unverified number.')
console.log('')
console.log('  ETH price   T1 native-only   T1 head-priced   T2 head-priced   T3 head-priced')
const ethSensitivity = []
// The published table's five points, plus a finer grid between $1,600 and
// $2,400: that is where the head-priced T1 count crosses the ~109 standing
// population at which reprice.ts flips STOP to GO, so a five-point sweep would
// report "GO at 3,200, STOP at 1,600" without saying where the line is.
// $2,460.02 is the ETH-WEIGHTED price of the measurement window and $2,514.31
// the 2026-09-06 close, both established from four independent venues agreeing
// to 0.02%. They are the only two rows here that are a MEASUREMENT rather than
// a what-if; the rest of the grid exists to show how much the answer rides on
// the input. $2,514.31 is the row that matches the ERC-20 head's own as-of
// date, so the two halves of the book are priced on the same day.
const VERIFIED_ETH_PRICES = new Set([2460.02, 2514.31])
for (const price of [1600, 1800, 2000, 2200, 2400, 2460.02, 2514.31, 2800, 3200, 4000, 6400]) {
  const ratio = price / bookNative.get(NATIVE)
  const row = { ethPriceUsd: price }
  for (const g of GATES) {
    let nativeOnly = 0
    let expanded = 0
    for (let r = 0; r < nativeSeries.length; r++) {
      const nat = nativeSeries[r]
      const erc = erc20Series[r]
      const scaledNative = new Array(COMPLETE_DAYS)
      const combined = new Array(COMPLETE_DAYS)
      for (let d = 0; d < COMPLETE_DAYS; d++) {
        scaledNative[d] = nat[d] * ratio
        combined[d] = scaledNative[d] + erc[d]
      }
      if (median(scaledNative.slice(-7)) >= g.usdPerDay) nativeOnly++
      if (median(combined.slice(-7)) >= g.usdPerDay) expanded++
    }
    row[`${g.id}NativeOnly`] = nativeOnly
    row[`${g.id}HeadPriced`] = expanded
  }
  row.verified = VERIFIED_ETH_PRICES.has(price)
  ethSensitivity.push(row)
  console.log(
    `  $${String(price).padEnd(8)} ${String(row.T1NativeOnly).padStart(14)} ${String(row.T1HeadPriced).padStart(16)} ` +
      `${String(row.T2HeadPriced).padStart(16)} ${String(row.T3HeadPriced).padStart(16)}` +
      (price === bookNative.get(NATIVE) ? '   <- the pinned (UNVERIFIED) input' : '') +
      (VERIFIED_ETH_PRICES.has(price) ? '   <- VERIFIED, 4 venues' : ''),
  )
}
const worstT1 = Math.min(...ethSensitivity.map((r) => r.T1HeadPriced))
console.log('')
console.log(
  `  Across the whole $1,600-$6,400 range the T1 standing population never falls below ${worstT1}.`,
)

line('DAILY NATIVE TOTAL (unchanged by this repricing; a consistency check)')
let totalWei = 0n
for (const d of days) totalWei += dailyNativeWei.get(d)
console.log(`  total wei over the ${days.length} analysed days: ${totalWei}`)
console.log(`  = ${(Number(totalWei / 10n ** 12n) / 1e6).toFixed(4)} ETH = ${money((Number(totalWei / 10n ** 12n) / 1e6) * bookNative.get(NATIVE))}`)

if (outPath !== undefined) {
  perRecipient.sort((a, b) => b.total - a.total)
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        source: mergedPath,
        assetsFile: assetsPath,
        windowDays: days.map(iso),
        ethPriceUsd: bookNative.get(NATIVE),
        priceBook: { stored: bookStored.size, expanded: bookExpanded.size, added: added.length, refused: refusedEntries },
        coverage: {
          assetsSeen,
          assetsPriced: pricedAssets,
          creditsTotal: creditsSeen,
          creditsInPricedAsset: creditsAssetPriced,
          creditsInUnpricedAsset: creditsAssetUnpriced,
          assetsStillUnpriced: unpricedAssetCount,
          creditsFullyPriced: totals.creditsPriced,
          creditsInCellWithUnpriced: totals.creditsUnpricedDayLevel,
          recipientsTotal: totals.recipientsTotal,
          recipientsWithUnpriced: totals.recipientsWithUnpriced,
          nativeUsd: totals.nativeUsd,
          erc20PricedUsd: totals.erc20PricedUsd,
        },
        gates: counts,
        ethSensitivity,
        headroom,
        strict: { population: strictPopulation, counts: strictCounts },
        top50: perRecipient.slice(0, 50),
      },
      null,
      2,
    )}\n`,
  )
  console.log(`\nwrote ${outPath}`)
}

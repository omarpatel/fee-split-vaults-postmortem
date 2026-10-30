/**
 * Project the NATIVE side out of a merged escrow-index document.
 *
 * WHY THIS EXISTS. A merged (`--mode both`) document is the only one that cannot
 * undercount, but with an unpriced ERC-20 tail every `day.usd` in it is null, so
 * every USD conclusion over it is correctly REFUSED. The native side of that same
 * document is fully priced, and it is the part that can be measured. This derives
 * the native-only daily USD series from the per-day bigint wei the document
 * already carries - no re-scan, no re-price, no estimate.
 *
 * WHY IT IS TRUSTWORTHY. Run with two arguments it does not just project, it
 * VALIDATES: it projects the native side out of a merged document and compares it
 * cell by cell against a native-only document produced by an INDEPENDENT scan of
 * the same window. If the projection is faithful the two agree exactly, and if
 * they do not, this says so and exits non-zero rather than letting a derived
 * series be quoted as a measured one.
 *
 *   node tools/artifacts/native-from-merged.mjs <merged.json> [<native.json>]
 *
 * WHAT IT DELIBERATELY DOES NOT PRODUCE. Per-day credit COUNTS. A merged
 * document's `creditCount` is the total across all assets in that day and cannot
 * be split by asset, so this reports native value and native recipients per day
 * and leaves per-day native credit counts to the native-only scan. Inventing a
 * split would be exactly the kind of plausible-looking guess the toolkit exists
 * to refuse.
 */
import { readFileSync } from 'node:fs'

const NATIVE = '0x0000000000000000000000000000000000000000'
const [mergedPath, nativePath] = process.argv.slice(2)
const merged = JSON.parse(readFileSync(mergedPath, 'utf8'))
const md = merged.result ?? merged

const ethPrice = md.priceUsdByAsset[NATIVE]
if (typeof ethPrice !== 'number' || !(ethPrice > 0)) {
  console.error(
    `REFUSING: the merged document has no USD price for the native asset (${JSON.stringify(ethPrice)}). ` +
      'Re-run escrow-index with VENUE_PRICE_USD_ETH set; nothing here may substitute a price.',
  )
  process.exit(2)
}
const decimals = md.assetDecimals[NATIVE] ?? 18

/** Whole units from minor units, split before touching a float. Mirrors prices.ts. */
function minorToUnits(minor, dec) {
  const scale = 10n ** BigInt(dec)
  const neg = minor < 0n
  const mag = neg ? -minor : minor
  const value = Number(mag / scale) + Number(mag % scale) / Number(scale)
  return neg ? -value : value
}

/** recipient -> [{dayUnix, wei, usd}], native only, in day order. */
export function projectNative(doc) {
  const out = new Map()
  for (const r of doc.recipients) {
    const days = r.days.map((d) => {
      const wei = BigInt(d.byAssetMinor[NATIVE] ?? '0')
      return { dayUnix: d.dayUnix, wei, usd: minorToUnits(wei, decimals) * ethPrice }
    })
    if (days.some((d) => d.wei > 0n)) out.set(r.recipient, days)
  }
  return out
}

const projected = projectNative(md)
let totalWei = 0n
for (const days of projected.values()) for (const d of days) totalWei += d.wei
const nativeRow = md.assetTotals.find((a) => a.kind === 'native')

console.log(`merged document : ${mergedPath}`)
console.log(`  ETH price used: $${ethPrice} (an INPUT, from ${md.priceSource})`)
console.log(`  projected native recipients: ${projected.size.toLocaleString()}`)
console.log(`  projected native total     : ${totalWei} wei`)
console.log(`  document's own native row  : ${nativeRow?.totalMinor} wei`)
const selfConsistent = String(totalWei) === nativeRow?.totalMinor
console.log(`  self-consistent with assetTotals: ${selfConsistent ? 'YES' : 'NO'}`)
if (!selfConsistent) {
  console.error('REFUSING: the projection disagrees with the document\'s own per-asset total.')
  process.exit(2)
}

if (nativePath === undefined) process.exit(0)

// ---------------------------------------------------------------------------
// Validation against an independently scanned native-only document.
// ---------------------------------------------------------------------------
const native = JSON.parse(readFileSync(nativePath, 'utf8'))
const ndoc = native.result ?? native
console.log(`\nvalidating against an INDEPENDENT native-only scan: ${nativePath}`)
if (ndoc.fromBlock !== md.fromBlock || ndoc.toBlock !== md.toBlock) {
  console.error(
    `REFUSING to compare: the two documents cover different block ranges ` +
      `(${ndoc.fromBlock}..${ndoc.toBlock} vs ${md.fromBlock}..${md.toBlock}). ` +
      'Two different windows agreeing or disagreeing would prove nothing.',
  )
  process.exit(2)
}

let cells = 0
let weiMismatch = 0
let usdMismatch = 0
let missing = 0
for (const r of ndoc.recipients) {
  const proj = projected.get(r.recipient)
  if (proj === undefined) {
    missing++
    continue
  }
  const byDay = new Map(proj.map((d) => [d.dayUnix, d]))
  for (const d of r.days) {
    const p = byDay.get(d.dayUnix)
    const expectedWei = BigInt(d.byAssetMinor[NATIVE] ?? '0')
    cells++
    if ((p?.wei ?? 0n) !== expectedWei) weiMismatch++
    // USD is a float; require agreement to within a cent on a per-day figure.
    if (d.usd !== null && Math.abs((p?.usd ?? 0) - d.usd) > 0.01) usdMismatch++
  }
}
const extra = [...projected.keys()].filter((k) => !ndoc.recipients.some((r) => r.recipient === k)).length

console.log(`  native-only recipients: ${ndoc.recipients.length.toLocaleString()}   projected: ${projected.size.toLocaleString()}`)
console.log(`  recipients in the native scan missing from the projection: ${missing}`)
console.log(`  recipients in the projection absent from the native scan  : ${extra}`)
console.log(`  per-(recipient,day) cells compared: ${cells.toLocaleString()}`)
console.log(`  wei mismatches: ${weiMismatch}    usd mismatches (>1c): ${usdMismatch}`)

const ok = missing === 0 && extra === 0 && weiMismatch === 0 && usdMismatch === 0
console.log(
  ok
    ? '\nVALIDATED: the native side projected from the merged document is IDENTICAL to the independent native-only scan.'
    : '\nFAILED: the projection does NOT reproduce the independent scan. Do not use the projection.',
)
process.exit(ok ? 0 : 1)

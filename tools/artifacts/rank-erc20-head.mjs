/**
 * Rank the ERC-20 asset set of a merged escrow document and cut the head that
 * carries a given share of ERC-20 credits.
 *
 *   node tools/artifacts/rank-erc20-head.mjs <merged.json> [coverageShare] [out.json]
 *
 * WHY A HEAD CUT AT ALL. The window saw 1,698 distinct ERC-20 assets. Pricing
 * 1,698 instruments by hand is not a thing anyone will do correctly, and most of
 * them are dust: the measurement showed 248 assets carry 99.5% of ERC-20 credits
 * and the other 1,450 carry 4,015 credits between them. So the honest move is to
 * price the head, leave the tail explicitly UNPRICED, and REPORT the residual
 * share rather than let it round to zero.
 *
 * Reads only the document HEADER, via tools/lib/doc-stream.ts: `assetTotals`
 * sits before `recipients` in the serialized document, and `recipients` is
 * ~228 MB of the 229 MB file, so parsing the whole thing to read a 500 KB table
 * would be absurd - and on the machine that produced the measurement, with
 * 10.8 GB free, quite possibly fatal.
 */
import { writeFileSync } from 'node:fs'
import { readHeader } from '../lib/doc-stream.ts'

const [mergedPath, shareArg, outPath] = process.argv.slice(2)
const TARGET_SHARE = Number(shareArg ?? 0.99)
if (!(TARGET_SHARE > 0 && TARGET_SHARE <= 1)) {
  console.error(`coverage share must be in (0,1], got ${String(shareArg)}`)
  process.exit(2)
}

const { result } = readHeader(mergedPath)
if (!Array.isArray(result.assetTotals)) {
  console.error(`${mergedPath} has no assetTotals; is it an escrow-index document?`)
  process.exit(2)
}
const assetTotals = result.assetTotals
const erc20 = assetTotals.filter((a) => a.kind === 'erc20')
const native = assetTotals.filter((a) => a.kind === 'native')
const creditsTotal = erc20.reduce((a, b) => a + b.credits, 0)
const recipientsMax = erc20.reduce((a, b) => Math.max(a, b.recipients), 0)

// Rank by CREDITS. Recipient count is the ranking the measurement used because
// it is the only one an unpriced asset supports for reach, but credits is what
// the coverage claim below is denominated in, so the head is cut on credits and
// recipient reach is reported alongside.
const byCredits = [...erc20].sort((a, b) => b.credits - a.credits || b.recipients - a.recipients)

const head = []
let cum = 0
for (const asset of byCredits) {
  if (cum / creditsTotal >= TARGET_SHARE) break
  head.push(asset)
  cum += asset.credits
}

console.log(`${mergedPath}`)
console.log(`  native assets      : ${native.length}`)
console.log(`  ERC-20 assets      : ${erc20.length.toLocaleString()}`)
console.log(`  ERC-20 credits     : ${creditsTotal.toLocaleString()}`)
console.log(
  `  head for ${(TARGET_SHARE * 100).toFixed(1)}% of ERC-20 credits: ${head.length} asset(s), ` +
    `${cum.toLocaleString()} credits (${((cum / creditsTotal) * 100).toFixed(3)}%)`,
)
console.log(
  `  tail left over     : ${(erc20.length - head.length).toLocaleString()} asset(s), ` +
    `${(creditsTotal - cum).toLocaleString()} credits (${(((creditsTotal - cum) / creditsTotal) * 100).toFixed(3)}%)`,
)
console.log('')
console.log('  rank  address                                      symbol        dec   credits  recipients   cum%  priced')
for (const [i, a] of head.entries()) {
  const runningShare =
    (head.slice(0, i + 1).reduce((x, y) => x + y.credits, 0) / creditsTotal) * 100
  console.log(
    `  ${String(i + 1).padStart(4)}  ${a.asset}  ${String(a.symbol).padEnd(12)} ` +
      `${String(a.decimals).padStart(3)}  ${String(a.credits).padStart(8)}  ${String(a.recipients).padStart(10)}  ` +
      `${runningShare.toFixed(2).padStart(6)}  ${a.priceUsd === null ? 'no' : `$${a.priceUsd}`}`,
  )
}
void recipientsMax

if (outPath !== undefined) {
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        source: mergedPath,
        targetShare: TARGET_SHARE,
        erc20Assets: erc20.length,
        erc20Credits: creditsTotal,
        headAssets: head.length,
        headCredits: cum,
        headShare: cum / creditsTotal,
        head,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`\nwrote ${outPath}`)
}

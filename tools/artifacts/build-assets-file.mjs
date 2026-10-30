/**
 * Build the `--assets` file for a re-priced escrow-index run.
 *
 *   node tools/artifacts/build-assets-file.mjs <merged.json> <metadata.json> <out.json>
 *
 * Takes the asset set the merged scan actually saw, attaches the decimals the
 * on-chain resolver READ (never 18 by default), and attaches a USD price only
 * where one is defensible.
 *
 * WHAT GETS A PRICE, AND WHY ONLY THAT. Exactly one class of asset is priced
 * here: a fiat-referenced stablecoin at its stated peg, and only when the
 * resolver confirms its identity on chain. Everything else in this tail is a
 * tokenized equity, an ETF or a memecoin, and this repo has no verified quote
 * feed for any of them. Writing a plausible number for NVDA or TSLA would be
 * the exact failure the toolkit exists to prevent - it would turn an UNPRICED
 * refusal into a confident wrong total - so those are deliberately left null and
 * reported as unpriced.
 *
 * The peg is an ASSUMPTION and is labelled as one everywhere it is used. It is
 * defensible here only because it is used to establish a LOWER BOUND: the claim
 * is "the ERC-20 tail is worth at least this much", and a stablecoin trading
 * slightly off peg cannot move that claim materially.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const NATIVE = '0x0000000000000000000000000000000000000000'
const [mergedPath, metadataPath, outPath] = process.argv.slice(2)

/** address -> {priceUsd, why}. Pinned to ADDRESSES: symbols collide on this chain. */
const PEGGED_STABLECOINS = {
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': {
    priceUsd: 1,
    expectSymbol: 'USDG',
    expectDecimals: 6,
    why: 'Global Dollar (USDG), a USD-referenced stablecoin, valued at its $1.00 peg. AN ASSUMPTION, not a market quote.',
  },
}

const merged = JSON.parse(readFileSync(mergedPath, 'utf8'))
const md = merged.result ?? merged
const meta = JSON.parse(readFileSync(metadataPath, 'utf8'))
const tokens = new Map(
  (meta.result?.tokens ?? meta.tokens ?? []).map((t) => [t.address.toLowerCase(), t]),
)

const assets = []
let priced = 0
let withDecimals = 0
let unresolved = 0
for (const row of md.assetTotals) {
  if (row.kind === 'native') continue // the native asset is registered unconditionally
  const address = row.asset.toLowerCase()
  const t = tokens.get(address)
  const entry = { address }
  if (t?.symbol) entry.symbol = t.symbol
  if (typeof t?.decimals === 'number') {
    entry.decimals = t.decimals
    withDecimals++
  } else {
    // No decimals means UNPRICEABLE, which is the correct outcome. It must never
    // silently become 18.
    unresolved++
  }
  const peg = PEGGED_STABLECOINS[address]
  if (peg !== undefined) {
    // Refuse the peg if the chain disagrees about what this address is. A price
    // pinned to the wrong asset is worse than no price.
    if (t === undefined || t.symbol !== peg.expectSymbol || t.decimals !== peg.expectDecimals) {
      console.error(
        `REFUSING to price ${address}: expected ${peg.expectSymbol}/${peg.expectDecimals}dp, ` +
          `chain says ${t?.symbol ?? 'unresolved'}/${t?.decimals ?? '?'}dp.`,
      )
      process.exit(2)
    }
    entry.priceUsd = peg.priceUsd
    priced++
  }
  assets.push(entry)
}

writeFileSync(outPath, `${JSON.stringify(assets, null, 2)}\n`)
console.log(`wrote ${outPath}`)
console.log(`  ERC-20 assets in the window : ${assets.length}`)
console.log(`  with decimals READ on chain : ${withDecimals}`)
console.log(`  decimals unresolved (stay unpriceable): ${unresolved}`)
console.log(`  priced (pegged stablecoins only)      : ${priced}`)
for (const [addr, peg] of Object.entries(PEGGED_STABLECOINS)) {
  if (assets.some((a) => a.address === addr && a.priceUsd !== undefined)) {
    console.log(`    ${addr}  $${peg.priceUsd}  ${peg.why}`)
  }
}
console.log(`  left UNPRICED on purpose             : ${assets.length - priced}`)
console.log(
  '  (tokenized equities, ETFs and memecoins have no verified quote feed in this repo; a made-up',
)
console.log('   price would convert an honest refusal into a confident wrong number.)')
void NATIVE

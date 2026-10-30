/**
 * Build the EXPANDED `--assets` file: every ERC-20 asset the window saw, with
 * the decimals the chain READ, plus a USD price wherever one is defensible.
 *
 *   node tools/artifacts/build-priced-assets.mjs <merged.json> <gt-prices.json> <out.json>
 *
 * This supersedes `build-assets-file.mjs` for pricing purposes. That script
 * priced exactly one class of asset - a fiat-referenced stablecoin at its stated
 * peg - and left the rest UNPRICED on the stated grounds that "this repo has no
 * verified quote feed" for tokenized equities. That premise turned out to be
 * wrong in a specific and useful way: the assets are indexed on this very chain
 * by GeckoTerminal, so each one has a traded price of its OWN, keyed by the
 * ADDRESS the escrow credited. No equity feed and no symbol join is needed, and
 * the "does a tokenized equity trade at its underlying's price" question is
 * side-stepped rather than assumed away.
 *
 * THREE CLASSES OF ENTRY COME OUT OF HERE, and they are labelled differently:
 *
 *   1. `token-own-dex-close` - the token's own daily close on this chain for the
 *      as-of UTC day. A measurement of the credited asset itself.
 *   2. `stablecoin-peg` - USDG at $1.00. An ASSUMPTION, retained from the
 *      published run so the two are comparable, and defensible only because it
 *      is used to establish a lower bound. The DEX close for USDG is recorded
 *      next to it as corroboration.
 *   3. no price at all - the asset carries decimals so it can be counted, and no
 *      priceUsd, so every USD figure derived from it is REFUSED rather than
 *      quietly set to zero.
 *
 * An asset whose decimals were never read on chain gets neither decimals nor a
 * price. It must never be assumed to have 18.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { readHeader } from '../lib/doc-stream.ts'

const [mergedPath, gtPath, outPath] = process.argv.slice(2)

/**
 * Addresses priced at a stated fiat peg rather than a market quote.
 * Pinned to ADDRESSES: symbols collide on this chain (GME x2, AMC x3, UPS x2,
 * TAO x2 among the head alone), so a symbol join would mis-price.
 */
const PEGGED = {
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': {
    priceUsd: 1,
    expectSymbol: 'USDG',
    expectDecimals: 6,
    source:
      'Global Dollar (USDG) valued at its stated $1.00 USD peg. AN ASSUMPTION, not a market ' +
      'quote; retained from the published run so the two measurements are comparable, and ' +
      'defensible only because it is used to establish a LOWER bound.',
    basis: 'stablecoin-peg',
  },
}

const { result: doc } = readHeader(mergedPath)
const gt = JSON.parse(readFileSync(gtPath, 'utf8'))
const quotes = new Map(gt.results.map((r) => [r.address.toLowerCase(), r]))

const assets = []
let pricedMarket = 0
let pricedPeg = 0
let withDecimals = 0
let unresolvedDecimals = 0
let unpriced = 0
const pricedCredits = { market: 0, peg: 0 }
let totalErc20Credits = 0

for (const row of doc.assetTotals) {
  if (row.kind === 'native') continue // registered unconditionally by the toolkit
  totalErc20Credits += row.credits
  const address = row.asset.toLowerCase()
  const entry = { address }
  if (row.symbol !== undefined && row.symbol !== 'UNKNOWN') entry.symbol = row.symbol

  // `assetDecimals` defaults to 18 in the document for assets whose decimals were
  // never resolved, so the document alone cannot say which is which. The
  // unpricedAssets/symbol pair does: an asset with symbol UNKNOWN was never
  // resolved on chain and must stay decimals-less here.
  const resolved = row.symbol !== undefined && row.symbol !== 'UNKNOWN'
  if (resolved) {
    entry.decimals = row.decimals
    withDecimals++
  } else {
    unresolvedDecimals++
  }

  const peg = PEGGED[address]
  const quote = quotes.get(address)

  if (peg !== undefined) {
    if (!resolved || row.symbol !== peg.expectSymbol || row.decimals !== peg.expectDecimals) {
      console.error(
        `REFUSING to price ${address}: expected ${peg.expectSymbol}/${peg.expectDecimals}dp, ` +
          `the document says ${row.symbol}/${row.decimals}dp.`,
      )
      process.exit(2)
    }
    entry.priceUsd = peg.priceUsd
    entry.priceBasis = peg.basis
    entry.priceSource = peg.source
    entry.priceAsOf = gt.asOfDate
    if (quote?.priceUsd != null) {
      entry.corroboratingDexCloseUsd = quote.priceUsd
      entry.priceSource += ` The token's own DEX close on ${gt.asOfDate} was $${Number(quote.priceUsd).toFixed(6)}, which corroborates the peg to within ${(Math.abs(quote.priceUsd - 1) * 100).toFixed(3)}%.`
    }
    pricedPeg++
    pricedCredits.peg += row.credits
    assets.push(entry)
    continue
  }

  if (quote !== undefined && quote.priceUsd != null && resolved) {
    // Belt and braces: the fetcher already refused on an identity mismatch, but
    // the document is the authority on decimals and it is checked again here.
    if (quote.chainDecimals !== row.decimals || quote.chainSymbol !== row.symbol) {
      console.error(
        `REFUSING ${address}: the price book says ${quote.chainSymbol}/${quote.chainDecimals}dp, ` +
          `the document says ${row.symbol}/${row.decimals}dp.`,
      )
      process.exit(2)
    }
    entry.priceUsd = quote.priceUsd
    entry.priceBasis = quote.priceBasis
    entry.priceAsOf = quote.asOf
    entry.priceSource = quote.priceSource
    entry.priceBarOpenUsd = quote.barOpenUsd
    entry.priceBarHighUsd = quote.barHighUsd
    entry.priceBarLowUsd = quote.barLowUsd
    entry.priceBarVolumeUsd = quote.barVolumeUsd
    if (quote.indexName) entry.instrument = quote.indexName
    pricedMarket++
    pricedCredits.market += row.credits
    assets.push(entry)
    continue
  }

  if (quote !== undefined && quote.unpricedReason) entry.unpricedReason = quote.unpricedReason
  unpriced++
  assets.push(entry)
}

writeFileSync(outPath, `${JSON.stringify(assets, null, 2)}\n`)
console.log(`wrote ${outPath}`)
console.log(`  ERC-20 assets in the window      : ${assets.length.toLocaleString()}`)
console.log(`  decimals READ on chain           : ${withDecimals.toLocaleString()}`)
console.log(`  decimals unresolved (unpriceable): ${unresolvedDecimals.toLocaleString()}`)
console.log(`  priced at a traded DEX close     : ${pricedMarket}  covering ${pricedCredits.market.toLocaleString()} ERC-20 credits`)
console.log(`  priced at a stated peg           : ${pricedPeg}  covering ${pricedCredits.peg.toLocaleString()} ERC-20 credits`)
console.log(
  `  ERC-20 credit coverage           : ${(((pricedCredits.market + pricedCredits.peg) / totalErc20Credits) * 100).toFixed(2)}% ` +
    `of ${totalErc20Credits.toLocaleString()}`,
)
console.log(`  left UNPRICED (reported, never zeroed): ${unpriced.toLocaleString()}`)

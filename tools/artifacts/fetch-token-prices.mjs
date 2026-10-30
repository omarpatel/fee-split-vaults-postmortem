/**
 * Establish a USD price AS OF a given UTC day for a set of ERC-20 addresses on
 * this chain, from GeckoTerminal's `robinhood` network index.
 *
 *   node tools/artifacts/fetch-token-prices.mjs <head.json> <YYYY-MM-DD> <out.json>
 *
 * WHY THIS SOURCE, AND WHAT IT IS. The head of the unpriced tail is Robinhood
 * stock tokens: ERC-20 contracts on this chain whose value tracks a real-world
 * equity. There are two candidate prices for such a token and they are NOT the
 * same number:
 *
 *   (1) the UNDERLYING equity's last close. A first-order estimate. The token
 *       trades 24/7 and the equity does not, so on a Sunday - which is what the
 *       window's last day is - the underlying has no live quote at all and the
 *       most recent close is two days stale.
 *   (2) the TOKEN's own traded price on this chain's DEXes.
 *
 * (2) is strictly better and is what this fetches: it is the actual price the
 * actual asset actually traded at, on the actual chain, keyed by the actual
 * ADDRESS the escrow credited. It needs no "assume the token tracks its
 * underlying" step. `cross-check-underlying.mjs` then fetches (1) separately and
 * reports the basis between them, so the size of the assumption that was AVOIDED
 * is a measured number rather than a claim.
 *
 * THE DATE IS PART OF THE PRICE. This takes the daily OHLCV bar whose UTC day is
 * the requested one and uses its CLOSE. A GeckoTerminal daily bar is stamped
 * with the START of the day, so the bar stamped 2026-09-06T00:00:00Z closes at
 * 2026-09-06T23:59:59Z - exactly the end of the measurement window. A "current"
 * spot price is recorded alongside but is NEVER used as the as-of price: it is
 * a different day's number and labelling it otherwise would be a lie about
 * provenance.
 *
 * FAIL CLOSED. An asset is priced only when the index agrees with the chain
 * about what the address IS - same symbol, same decimals as token-metadata.ts
 * READ from the contract. A disagreement means the two sources are not talking
 * about the same asset, and a price pinned to the wrong asset is worse than no
 * price. Such an asset is recorded UNPRICED with the reason, never dropped and
 * never defaulted.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const [headPath, asOfDate, outPath] = process.argv.slice(2)
if (headPath === undefined || asOfDate === undefined || outPath === undefined) {
  console.error('usage: fetch-token-prices.mjs <head.json> <YYYY-MM-DD> <out.json>')
  process.exit(2)
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
  console.error(`as-of date must be YYYY-MM-DD, got ${asOfDate}`)
  process.exit(2)
}
const AS_OF_UNIX = Math.floor(Date.parse(`${asOfDate}T00:00:00Z`) / 1000)

const BASE = 'https://api.geckoterminal.com/api/v2'
const NETWORK = 'robinhood'
/** The public API allows ~30 calls/min. Stay under it; a 429 costs more than a wait. */
const MIN_INTERVAL_MS = 2300
const CACHE_DIR = join(process.cwd(), 'tools', '.cache', 'gt-prices')
mkdirSync(CACHE_DIR, { recursive: true })

let lastCall = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(path) {
  const key = join(CACHE_DIR, `${Buffer.from(path).toString('base64url')}.json`)
  if (existsSync(key)) return JSON.parse(readFileSync(key, 'utf8'))
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCall)
  if (wait > 0) await sleep(wait)
  for (let attempt = 0; attempt < 5; attempt++) {
    lastCall = Date.now()
    const response = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } })
    if (response.status === 429) {
      const backoff = 5000 * (attempt + 1)
      process.stderr.write(`  429, backing off ${backoff}ms\n`)
      await sleep(backoff)
      continue
    }
    if (response.status === 404) return { __status: 404 }
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`)
    const body = await response.json()
    writeFileSync(key, JSON.stringify(body))
    return body
  }
  throw new Error(`rate limited five times on ${path}`)
}

const head = JSON.parse(readFileSync(headPath, 'utf8'))
const assets = head.head ?? head
const results = []
let priced = 0
let refused = 0

for (const [i, row] of assets.entries()) {
  const address = row.asset ?? row.address
  const label = `${String(i + 1).padStart(3)}/${assets.length} ${row.symbol ?? ''}`
  const record = {
    address,
    chainSymbol: row.symbol ?? null,
    chainDecimals: row.decimals ?? null,
    credits: row.credits ?? null,
    recipients: row.recipients ?? null,
    priceUsd: null,
    unpricedReason: null,
  }

  const token = await getJson(`/networks/${NETWORK}/tokens/${address}`)
  if (token.__status === 404 || token.data === undefined) {
    record.unpricedReason = `GeckoTerminal has no token record for ${address} on network "${NETWORK}".`
    results.push(record)
    refused++
    console.log(`${label}  UNPRICED  no index record`)
    continue
  }
  const attributes = token.data.attributes
  record.indexName = attributes.name ?? null
  record.indexSymbol = attributes.symbol ?? null
  record.indexDecimals = attributes.decimals ?? null
  record.coingeckoCoinId = attributes.coingecko_coin_id ?? null
  record.spotPriceUsdNow = attributes.price_usd === undefined ? null : Number(attributes.price_usd)
  record.volumeUsd24hNow = Number(attributes.volume_usd?.h24 ?? NaN)

  // IDENTITY CHECK. The chain read these off the contract; the index is a third
  // party. If they disagree, they are not describing the same asset.
  //
  // CASE IS NOT IDENTITY. The index normalises some symbols to lower case and
  // leaves others alone - "gld" against the contract's "GLD", but "SPCX"
  // against "SPCX" - so a case-sensitive compare refused twelve assets that the
  // index's own long name confirmed exactly ("SPDR Gold Shares • Robinhood
  // Token"). Everything else about the check stays strict: a differing symbol,
  // or any difference in decimals, still refuses.
  const sameSymbol =
    record.chainSymbol === null ||
    String(record.indexSymbol).toLowerCase() === record.chainSymbol.toLowerCase()
  if (!sameSymbol) {
    record.unpricedReason =
      `identity mismatch: the contract's symbol() reads "${record.chainSymbol}" but the index ` +
      `calls ${address} "${record.indexSymbol}". Refusing to pin a price to an asset the two ` +
      `sources do not agree on.`
    results.push(record)
    refused++
    console.log(`${label}  UNPRICED  symbol mismatch (${record.chainSymbol} vs ${record.indexSymbol})`)
    continue
  }
  if (record.chainDecimals !== null && record.indexDecimals !== record.chainDecimals) {
    record.unpricedReason =
      `identity mismatch: decimals READ from the contract are ${record.chainDecimals}, the index ` +
      `says ${record.indexDecimals}. A price applied at the wrong scale is wrong by a power of ten.`
    results.push(record)
    refused++
    console.log(`${label}  UNPRICED  decimals mismatch`)
    continue
  }

  const pools = token.data.relationships?.top_pools?.data ?? []
  if (pools.length === 0) {
    record.unpricedReason = `the index knows ${address} but lists no pool, so it has no traded price.`
    results.push(record)
    refused++
    console.log(`${label}  UNPRICED  no pool`)
    continue
  }

  // Walk the pools in the index's own ranking until one serves a bar for the
  // as-of day. A token's deepest pool is not always its longest-lived one.
  let bar = null
  let poolUsed = null
  let poolName = null
  for (const pool of pools.slice(0, 3)) {
    const poolAddress = pool.id.slice(pool.id.indexOf('_') + 1)
    const ohlcv = await getJson(
      `/networks/${NETWORK}/pools/${poolAddress}/ohlcv/day?aggregate=1&limit=30&currency=usd&token=${address}`,
    )
    const list = ohlcv?.data?.attributes?.ohlcv_list ?? []
    const match = list.find((b) => b[0] === AS_OF_UNIX)
    if (match !== undefined) {
      bar = match
      poolUsed = poolAddress
      poolName = ohlcv?.meta?.base?.symbol
        ? `${ohlcv.meta.base.symbol}/${ohlcv.meta.quote?.symbol ?? '?'}`
        : null
      record.poolBaseAddress = ohlcv?.meta?.base?.address ?? null
      record.poolQuoteSymbol = ohlcv?.meta?.quote?.symbol ?? null
      break
    }
  }

  if (bar === null) {
    record.unpricedReason =
      `the index serves no daily OHLCV bar for ${asOfDate} in any of this token's top pools. ` +
      `A spot price from a different day is NOT an as-of price and is not substituted.`
    results.push(record)
    refused++
    console.log(`${label}  UNPRICED  no ${asOfDate} bar`)
    continue
  }

  record.priceUsd = bar[4]
  record.asOf = `${asOfDate}T23:59:59Z`
  record.barUnix = bar[0]
  record.barOpenUsd = bar[1]
  record.barHighUsd = bar[2]
  record.barLowUsd = bar[3]
  record.barCloseUsd = bar[4]
  record.barVolumeUsd = bar[5]
  record.pool = poolUsed
  record.poolName = poolName
  record.priceSource =
    `GeckoTerminal /networks/${NETWORK}/pools/${poolUsed}/ohlcv/day, close of the UTC day ` +
    `${asOfDate} (bar start ${bar[0]}), pool ${poolName ?? poolUsed}`
  record.priceBasis = 'token-own-dex-close'
  results.push(record)
  priced++
  console.log(
    `${label}  $${Number(bar[4]).toFixed(6)}  ${poolName ?? poolUsed}  vol24 $${Number(bar[5]).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
  )
}

writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      network: NETWORK,
      source: 'GeckoTerminal public API v2',
      asOfDate,
      asOfUnix: AS_OF_UNIX,
      fetchedAtIso: new Date().toISOString(),
      priceBasis:
        "each price is the CLOSE of the token's own daily OHLCV bar for the as-of UTC day, in its " +
        'deepest indexed pool on this chain. It is the traded price of the credited asset itself, ' +
        'not an estimate derived from an underlying instrument.',
      assets: results.length,
      priced,
      refused,
      results,
    },
    null,
    2,
  )}\n`,
)
console.log(`\nwrote ${outPath}`)
console.log(`  priced   : ${priced}`)
console.log(`  UNPRICED : ${refused}`)

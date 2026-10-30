/**
 * Cross-check the on-chain token prices against the UNDERLYING instruments.
 *
 *   node tools/artifacts/cross-check-underlying.mjs <gt-prices.json> <YYYY-MM-DD> <out.json>
 *
 * WHAT THIS IS FOR. `fetch-token-prices.mjs` prices each credited asset at its
 * OWN traded close on this chain, which needs no assumption about tracking. This
 * script fetches the underlying equity/commodity/crypto close for the same
 * window and prints the BASIS - (token / underlying - 1) - per asset.
 *
 * That number is the point. The brief's honesty requirement is that "a tokenized
 * equity is not guaranteed to trade at its underlying's price". Rather than
 * assert that as a caveat and then use the underlying anyway, this MEASURES it.
 * A wide basis is evidence the underlying would have been the wrong input; a
 * narrow one is independent corroboration that the on-chain quote is sane and
 * that the address→instrument mapping is right. Either way the number, not the
 * caveat, goes in the report.
 *
 * DATE ALIGNMENT IS NOT COSMETIC. The window ends Sunday 2026-09-06. US equities
 * do not trade on a Sunday, and 2026-09-07 is Labor Day, so the last equity
 * close before the window ends is FRIDAY 2026-09-04 - up to 60 hours stale
 * against a token that traded continuously through the weekend. Each row
 * therefore carries the underlying bar's own date, and the staleness is
 * reported rather than papered over.
 *
 * Underlying quotes come from Yahoo Finance's chart endpoint, which serves dated
 * daily bars. The bar used is the LAST one at or before the as-of day.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const [pricesPath, asOfDate, outPath] = process.argv.slice(2)
const AS_OF_UNIX = Math.floor(Date.parse(`${asOfDate}T23:59:59Z`) / 1000)
const CACHE_DIR = join(process.cwd(), 'tools', '.cache', 'yf-quotes')
mkdirSync(CACHE_DIR, { recursive: true })

/**
 * Chain symbol -> the ticker of the instrument the token tracks.
 *
 * Deliberately EXPLICIT rather than "use the symbol as the ticker". Two of these
 * are not equities at all (cbBTC is wrapped bitcoin, TAO is a crypto asset), and
 * an automatic symbol->ticker rule would have quietly looked up a stock for
 * them. An entry that is absent here is simply not cross-checked; it is never
 * guessed.
 */
const UNDERLYING = {
  NVDA: 'NVDA', SPY: 'SPY', GLD: 'GLD', GME: 'GME', DJT: 'DJT', QQQ: 'QQQ',
  GOOGL: 'GOOGL', TSLA: 'TSLA', RBLX: 'RBLX', AAPL: 'AAPL', RDDT: 'RDDT',
  TTWO: 'TTWO', MSFT: 'MSFT', HIMS: 'HIMS', AMZN: 'AMZN', PLTR: 'PLTR',
  COST: 'COST', MSTR: 'MSTR', COIN: 'COIN', AMD: 'AMD', META: 'META',
  SGOV: 'SGOV', MU: 'MU', LULU: 'LULU', CRCL: 'CRCL', RIVN: 'RIVN',
  USO: 'USO', UPS: 'UPS', SNDK: 'SNDK', AMC: 'AMC', PFE: 'PFE', BULL: 'BULL',
  BB: 'BB', BABA: 'BABA', NFLX: 'NFLX', SNAP: 'SNAP', LLY: 'LLY',
  SKHY: 'SKHY', JNJ: 'JNJ', DELL: 'DELL', TSM: 'TSM', F: 'F', IBM: 'IBM',
  INDA: 'INDA', SHOP: 'SHOP', MRVL: 'MRVL', FIG: 'FIG', WYFI: 'WYFI',
  BE: 'BE', SPCX: 'SPCX',
  // Not an equity. Named explicitly so nobody reads a stock ticker into it.
  cbBTC: 'BTC-USD',
  // TAO is deliberately ABSENT. The obvious "TAO-USD" resolves at Yahoo to
  // "Together As One USD", a different asset that serves no bars at all. Mapping
  // it anyway would have produced a confident cross-check against the wrong
  // instrument, which is worse than no cross-check. Its own DEX close stands
  // unaided, which is what every price in this book rests on anyway.
}

/** Instruments whose quote is 24/7, so a weekend as-of date is not stale. */
const TRADES_247 = new Set(['BTC-USD', 'TAO-USD'])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function chart(ticker) {
  const key = join(CACHE_DIR, `${ticker.replace(/[^A-Za-z0-9.-]/g, '_')}.json`)
  if (existsSync(key)) return JSON.parse(readFileSync(key, 'utf8'))
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1mo`
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
    if (response.status === 429 || response.status >= 500) {
      await sleep(3000 * (attempt + 1))
      continue
    }
    if (!response.ok) return { __status: response.status }
    const body = await response.json()
    writeFileSync(key, JSON.stringify(body))
    return body
  }
  return { __status: 'retries-exhausted' }
}

const book = JSON.parse(readFileSync(pricesPath, 'utf8'))
const rows = []
for (const asset of book.results) {
  const symbol = asset.chainSymbol
  const ticker = UNDERLYING[symbol]
  const row = {
    address: asset.address,
    symbol,
    tokenPriceUsd: asset.priceUsd,
    tokenAsOf: asset.asOf ?? null,
    underlyingTicker: ticker ?? null,
  }
  if (ticker === undefined) {
    row.note = `no underlying mapped for "${symbol}"; not cross-checked (never guessed).`
    rows.push(row)
    continue
  }
  const data = await chart(ticker)
  const result = data?.chart?.result?.[0]
  if (result === undefined) {
    row.note = `Yahoo served no chart for ${ticker} (status ${String(data.__status ?? 'no result')}).`
    rows.push(row)
    continue
  }
  const stamps = result.timestamp ?? []
  const closes = result.indicators?.quote?.[0]?.close ?? []
  let chosen = -1
  for (let i = 0; i < stamps.length; i++) {
    if (stamps[i] <= AS_OF_UNIX && closes[i] !== null && closes[i] !== undefined) chosen = i
  }
  if (chosen === -1) {
    row.note = `no ${ticker} bar at or before ${asOfDate}.`
    rows.push(row)
    continue
  }
  row.underlyingName = result.meta?.longName ?? result.meta?.shortName ?? null
  row.underlyingCurrency = result.meta?.currency ?? null
  row.underlyingCloseUsd = closes[chosen]
  row.underlyingBarUnix = stamps[chosen]
  row.underlyingBarIso = new Date(stamps[chosen] * 1000).toISOString()
  row.underlyingBarDate = row.underlyingBarIso.slice(0, 10)
  row.stalenessHours = Math.round(((AS_OF_UNIX - stamps[chosen]) / 3600) * 10) / 10
  row.tradesContinuously = TRADES_247.has(ticker)
  row.underlyingSource = `Yahoo Finance chart API, ${ticker}, daily bar ${row.underlyingBarDate} close`
  if (typeof asset.priceUsd === 'number' && typeof closes[chosen] === 'number' && closes[chosen] > 0) {
    row.basisPct = (asset.priceUsd / closes[chosen] - 1) * 100
  }
  rows.push(row)
  console.log(
    `${String(symbol).padEnd(8)} token $${asset.priceUsd === null ? 'UNPRICED' : Number(asset.priceUsd).toFixed(4)}  ` +
      `underlying ${ticker} $${Number(closes[chosen]).toFixed(4)} (${row.underlyingBarDate})  ` +
      `basis ${row.basisPct === undefined ? 'n/a' : `${row.basisPct >= 0 ? '+' : ''}${row.basisPct.toFixed(2)}%`}`,
  )
}

const withBasis = rows.filter((r) => typeof r.basisPct === 'number')
const abs = withBasis.map((r) => Math.abs(r.basisPct)).sort((a, b) => a - b)
const median = abs.length === 0 ? null : abs[Math.floor(abs.length / 2)]
writeFileSync(
  outPath,
  `${JSON.stringify(
    { asOfDate, comparedAt: new Date().toISOString(), crossChecked: withBasis.length, medianAbsBasisPct: median, rows },
    null,
    2,
  )}\n`,
)
console.log(`\nwrote ${outPath}`)
console.log(`  cross-checked      : ${withBasis.length} of ${rows.length}`)
console.log(`  median |basis|     : ${median === null ? 'n/a' : `${median.toFixed(2)}%`}`)
console.log(`  max    |basis|     : ${abs.length === 0 ? 'n/a' : `${abs[abs.length - 1].toFixed(2)}%`}`)

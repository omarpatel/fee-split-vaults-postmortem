/**
 * Per-UTC-day ETH/USD close across the measurement window, from several venues.
 *
 *   node tools/artifacts/fetch-eth-daily.mjs <fromDate> <toDate> <out.json>
 *
 * WHY. The 7-day measurement established ONE ETH price ($2,514.31 at the
 * 2026-09-06 close, $2,460.02 window-weighted) against four venues. A 36-day
 * window is a different problem: ETH moved, and a single pinned price is wrong
 * for 35 of the 36 days by however much it moved. The fix is not a better single
 * number, it is a SERIES.
 *
 * FOUR INDEPENDENT VENUES, cross-checked per day. A single exchange's daily bar
 * can be wrong (a bad print, a maintenance window, a different day convention);
 * three that agree to a few basis points cannot all be wrong the same way. The
 * per-day spread is reported, so any day where the venues disagree is visible
 * rather than averaged away.
 *
 * DAY CONVENTION. Every venue here is asked for UTC daily candles and the CLOSE
 * is taken. Kraken, Coinbase and Bitstamp all stamp a candle with its START.
 * The bar stamped 2026-08-14T00:00:00Z closes at 2026-08-14T23:59:59Z, which is
 * the same instant the escrow's UTC day bucket ends.
 */
import { writeFileSync } from 'node:fs'

const [fromDate, toDate, outPath] = process.argv.slice(2)
if (!fromDate || !toDate || !outPath) {
  console.error('usage: fetch-eth-daily.mjs <from> <to> <out.json>')
  process.exit(2)
}
const DAY = 86400
const FROM = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000)
const TO = Math.floor(Date.parse(`${toDate}T00:00:00Z`) / 1000)
const DAYS = []
for (let d = FROM; d <= TO; d += DAY) DAYS.push(d)
const iso = (u) => new Date(u * 1000).toISOString().slice(0, 10)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function j(url) {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'venue-measurement/1.0' },
        signal: AbortSignal.timeout(30000),
      })
      if (r.status === 429) { await sleep(3000 * (a + 1)); continue }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url} ${(await r.text()).slice(0, 160)}`)
      return await r.json()
    } catch (e) { if (a === 4) throw e; await sleep(1500 * (a + 1)) }
  }
}
const venues = {}

// --- Kraken: /0/public/OHLC interval=1440, `since` in seconds ---------------
try {
  const k = await j(`https://api.kraken.com/0/public/OHLC?pair=XETHZUSD&interval=1440&since=${FROM - DAY}`)
  if (k.error?.length) throw new Error(k.error.join(';'))
  const key = Object.keys(k.result).find((x) => x !== 'last')
  const m = {}
  for (const row of k.result[key]) { const t = Number(row[0]); if (t >= FROM && t <= TO) m[iso(t)] = Number(row[4]) }
  venues.kraken = { endpoint: 'api.kraken.com /0/public/OHLC pair=XETHZUSD interval=1440', closes: m }
  console.log('kraken   ', Object.keys(m).length, 'bars')
} catch (e) { venues.kraken = { error: String(e.message) }; console.log('kraken ERR', e.message) }

// --- Coinbase Exchange: candles granularity=86400 ---------------------------
try {
  const start = new Date(FROM * 1000).toISOString()
  const end = new Date((TO + DAY) * 1000).toISOString()
  const c = await j(`https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=86400&start=${start}&end=${end}`)
  const m = {}
  for (const row of c) { const t = Number(row[0]); if (t >= FROM && t <= TO) m[iso(t)] = Number(row[4]) }
  venues.coinbase = { endpoint: 'api.exchange.coinbase.com /products/ETH-USD/candles granularity=86400', closes: m }
  console.log('coinbase ', Object.keys(m).length, 'bars')
} catch (e) { venues.coinbase = { error: String(e.message) }; console.log('coinbase ERR', e.message) }

// --- Bitstamp: /api/v2/ohlc/ethusd step=86400 -------------------------------
try {
  const b = await j(`https://www.bitstamp.net/api/v2/ohlc/ethusd/?step=86400&limit=200&start=${FROM}&end=${TO + DAY}`)
  const m = {}
  for (const row of b.data.ohlc) { const t = Number(row.timestamp); if (t >= FROM && t <= TO) m[iso(t)] = Number(row.close) }
  venues.bitstamp = { endpoint: 'bitstamp.net /api/v2/ohlc/ethusd step=86400', closes: m }
  console.log('bitstamp ', Object.keys(m).length, 'bars')
} catch (e) { venues.bitstamp = { error: String(e.message) }; console.log('bitstamp ERR', e.message) }

// --- Binance spot klines 1d (ETHUSDT; a USDT pair, noted as such) -----------
try {
  const bn = await j(`https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1d&startTime=${FROM * 1000}&endTime=${(TO + DAY) * 1000}&limit=200`)
  const m = {}
  for (const row of bn) { const t = Math.floor(Number(row[0]) / 1000); if (t >= FROM && t <= TO) m[iso(t)] = Number(row[4]) }
  venues.binance = { endpoint: 'api.binance.com /api/v3/klines ETHUSDT 1d (USDT-quoted, not USD)', closes: m }
  console.log('binance  ', Object.keys(m).length, 'bars')
} catch (e) { venues.binance = { error: String(e.message) }; console.log('binance ERR', e.message) }

// --- On-chain corroboration: WETH's own daily close on chain 4663 -----------
try {
  const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
  const tok = await j(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${WETH}`)
  const pools = tok.data?.relationships?.top_pools?.data ?? []
  const m = {}
  let poolName = null
  for (const p of pools.slice(0, 4)) {
    await sleep(2400)
    const pa = p.id.slice(p.id.indexOf('_') + 1)
    const o = await j(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${pa}/ohlcv/day?aggregate=1&limit=200&currency=usd&token=${WETH}`)
    for (const bar of o?.data?.attributes?.ohlcv_list ?? []) {
      const t = Number(bar[0])
      if (t >= FROM && t <= TO && m[iso(t)] === undefined) m[iso(t)] = Number(bar[4])
    }
    if (poolName === null && o?.meta?.base?.symbol) poolName = `${o.meta.base.symbol}/${o.meta.quote?.symbol ?? '?'}`
    if (Object.keys(m).length >= DAYS.length) break
  }
  venues.onchainWeth = {
    endpoint: `GeckoTerminal robinhood WETH daily OHLCV (${poolName ?? 'pool'}) - CORROBORATION ONLY, an ERC-20 wrapper on the measured chain, not an ETH/USD venue`,
    closes: m,
  }
  console.log('onchain  ', Object.keys(m).length, 'bars', poolName)
} catch (e) { venues.onchainWeth = { error: String(e.message) }; console.log('onchain ERR', e.message) }

// --- consensus: median of the three USD-quoted venues -----------------------
const USD_VENUES = ['kraken', 'coinbase', 'bitstamp']
const perDay = []
for (const d of DAYS) {
  const date = iso(d)
  const quotes = {}
  for (const v of USD_VENUES) { const p = venues[v]?.closes?.[date]; if (p !== undefined) quotes[v] = p }
  const vals = Object.values(quotes).sort((a, b) => a - b)
  const consensus = vals.length === 0
    ? null
    : (vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2)
  perDay.push({
    date, closeUsd: consensus, venues: quotes, venueCount: vals.length,
    spreadUsd: vals.length > 1 ? vals[vals.length - 1] - vals[0] : null,
    spreadPct: vals.length > 1 && consensus ? ((vals[vals.length - 1] - vals[0]) / consensus) * 100 : null,
    binanceUsdt: venues.binance?.closes?.[date] ?? null,
    onchainWethUsd: venues.onchainWeth?.closes?.[date] ?? null,
  })
}
const closes = perDay.map((r) => r.closeUsd).filter((v) => v !== null)
if (closes.length === 0) { console.error('REFUSING: not one venue served a bar. No ETH series, no USD figures.'); process.exit(2) }
writeFileSync(outPath, `${JSON.stringify({
  asset: 'ETH',
  windowFrom: fromDate, windowTo: toDate, fetchedAtIso: new Date().toISOString(),
  method: 'per UTC day, the median of the daily CLOSE across Kraken, Coinbase and Bitstamp USD spot. Binance ETHUSDT and the chain own WETH close are carried alongside as corroboration and are NOT in the median.',
  daysCovered: closes.length, daysRequested: DAYS.length,
  minUsd: Math.min(...closes), maxUsd: Math.max(...closes),
  meanUsd: closes.reduce((a, b) => a + b, 0) / closes.length,
  venues, perDay,
}, null, 2)}\n`)
console.log(`\nwrote ${outPath}`)
console.log(`  days covered ${closes.length}/${DAYS.length}   range $${Math.min(...closes).toFixed(2)} .. $${Math.max(...closes).toFixed(2)}   mean $${(closes.reduce((a, b) => a + b, 0) / closes.length).toFixed(2)}`)
for (const r of perDay) {
  console.log(`  ${r.date}  $${r.closeUsd?.toFixed(2) ?? 'UNKNOWN'}  venues ${r.venueCount}  spread ${r.spreadPct !== null ? r.spreadPct.toFixed(3) + '%' : '-'}  onchainWETH ${r.onchainWethUsd !== null ? '$' + r.onchainWethUsd.toFixed(2) : '-'}`)
}

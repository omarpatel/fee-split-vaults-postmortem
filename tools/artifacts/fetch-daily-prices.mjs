/**
 * Per-day USD close for every priced asset, across a multi-week window.
 *
 *   node tools/artifacts/fetch-daily-prices.mjs <assets-head-priced.json> <fromDate> <toDate> <out.json>
 *
 * WHY THIS EXISTS. The 7-day measurement pinned 53 ERC-20 prices AS OF
 * 2026-09-06. Over a 36-day window an as-of price is simply the wrong price for
 * the other 35 days: these are tokenised equities and they move. Applying one
 * price across the window would push a dated error into every daily figure and
 * therefore into every gate count and every tenure spell.
 *
 * WHAT IT FETCHES. For each asset, the token's own daily OHLCV bars from its
 * deepest indexed pool on this chain, and the CLOSE of each UTC day in the
 * window. Same source, same identity checks and same basis as
 * fetch-token-prices.mjs - this is that script generalised from one day to N,
 * in ONE request per pool rather than N.
 *
 * FAIL CLOSED, PER DAY. A day with no bar is recorded as null, not carried
 * forward and not back-filled from a neighbouring day. A carried price is an
 * assumption wearing a measurement's clothes. The consumer decides what to do
 * with a null; the honest options are "leave that day's credits unpriced" or
 * "state the carry explicitly", never "pretend the bar existed".
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const [assetsPath, fromDate, toDate, outPath] = process.argv.slice(2)
if (!assetsPath || !fromDate || !toDate || !outPath) {
  console.error('usage: fetch-daily-prices.mjs <assets.json> <YYYY-MM-DD from> <YYYY-MM-DD to> <out.json>')
  process.exit(2)
}
const DAY = 86400
const FROM = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000)
const TO = Math.floor(Date.parse(`${toDate}T00:00:00Z`) / 1000)
if (!Number.isFinite(FROM) || !Number.isFinite(TO) || TO < FROM) { console.error('bad dates'); process.exit(2) }
const DAYS = []
for (let d = FROM; d <= TO; d += DAY) DAYS.push(d)
const iso = (u) => new Date(u * 1000).toISOString().slice(0, 10)

const BASE = 'https://api.geckoterminal.com/api/v2'
const NETWORK = 'robinhood'
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
  for (let attempt = 0; attempt < 6; attempt++) {
    lastCall = Date.now()
    const response = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } })
    if (response.status === 429) { const b = 5000 * (attempt + 1); process.stderr.write(`  429, backoff ${b}ms\n`); await sleep(b); continue }
    if (response.status === 404) return { __status: 404 }
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`)
    const body = await response.json()
    writeFileSync(key, JSON.stringify(body))
    return body
  }
  throw new Error(`rate limited on ${path}`)
}

const entries = JSON.parse(readFileSync(assetsPath, 'utf8'))
const priced = entries.filter((e) => e.priceUsd !== undefined && e.priceUsd !== null)
console.log(`${priced.length} priced assets, ${DAYS.length} UTC days ${fromDate}..${toDate}`)

const out = []
for (const [i, row] of priced.entries()) {
  const address = String(row.address).toLowerCase()
  const label = `${String(i + 1).padStart(3)}/${priced.length} ${(row.symbol ?? '').padEnd(6)}`
  const rec = {
    address, symbol: row.symbol ?? null, decimals: row.decimals ?? null,
    priceBasis: row.priceBasis ?? null,
    asOfPriceUsd: row.priceUsd,            // the single 2026-09-06 price, for comparison
    dailyCloseUsd: {}, poolUsed: null, poolName: null, barsFound: 0, daysMissing: [],
    note: null,
  }
  // USDG is held at its stated peg by the published book; still fetch its own bars
  // so the peg assumption is quantified per day rather than assumed silently.
  const token = await getJson(`/networks/${NETWORK}/tokens/${address}`)
  if (token.__status === 404 || token.data === undefined) {
    rec.note = 'no index record'; out.push(rec); console.log(`${label} NO INDEX RECORD`); continue
  }
  const pools = token.data.relationships?.top_pools?.data ?? []
  const found = new Map()
  for (const pool of pools.slice(0, 4)) {
    const poolAddress = pool.id.slice(pool.id.indexOf('_') + 1)
    const ohlcv = await getJson(
      `/networks/${NETWORK}/pools/${poolAddress}/ohlcv/day?aggregate=1&limit=200&currency=usd&token=${address}`,
    )
    const list = ohlcv?.data?.attributes?.ohlcv_list ?? []
    let added = 0
    for (const bar of list) {
      if (bar[0] < FROM || bar[0] > TO) continue
      if (found.has(bar[0])) continue
      found.set(bar[0], { close: bar[4], open: bar[1], high: bar[2], low: bar[3], volUsd: bar[5], pool: poolAddress })
      added++
    }
    if (rec.poolUsed === null && added > 0) {
      rec.poolUsed = poolAddress
      rec.poolName = ohlcv?.meta?.base?.symbol ? `${ohlcv.meta.base.symbol}/${ohlcv.meta.quote?.symbol ?? '?'}` : null
    }
    if (found.size >= DAYS.length) break
  }
  for (const d of DAYS) {
    const bar = found.get(d)
    if (bar === undefined) { rec.dailyCloseUsd[iso(d)] = null; rec.daysMissing.push(iso(d)) }
    else { rec.dailyCloseUsd[iso(d)] = bar.close; rec.barsFound++ }
  }
  const vals = Object.values(rec.dailyCloseUsd).filter((v) => v !== null)
  const lo = vals.length ? Math.min(...vals) : null
  const hi = vals.length ? Math.max(...vals) : null
  rec.rangeUsd = { min: lo, max: hi }
  rec.asOfErrorVsWindow = lo !== null && rec.asOfPriceUsd
    ? { maxOverstatementPct: ((rec.asOfPriceUsd / lo - 1) * 100), maxUnderstatementPct: ((rec.asOfPriceUsd / hi - 1) * 100) }
    : null
  out.push(rec)
  console.log(`${label} bars ${String(rec.barsFound).padStart(3)}/${DAYS.length}  range $${lo?.toFixed(4) ?? '-'}..$${hi?.toFixed(4) ?? '-'}  asOf $${Number(rec.asOfPriceUsd).toFixed(4)}  ${rec.poolName ?? ''}`)
}

writeFileSync(outPath, `${JSON.stringify({
  network: NETWORK, source: 'GeckoTerminal public API v2, daily OHLCV per pool',
  windowFrom: fromDate, windowTo: toDate, days: DAYS.map(iso),
  priceBasis: "per UTC day, the CLOSE of the asset's own daily OHLCV bar in its deepest indexed pool on chain 4663. A day with no bar is null and is NEVER carried from an adjacent day.",
  fetchedAtIso: new Date().toISOString(),
  assets: out,
}, null, 2)}\n`)
console.log(`\nwrote ${outPath}`)
const fully = out.filter((a) => a.daysMissing.length === 0).length
console.log(`  assets with a bar every day : ${fully}/${out.length}`)
console.log(`  assets with gaps            : ${out.length - fully}`)

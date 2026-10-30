#!/usr/bin/env node
/**
 * day-boundaries - the exact first block of each UTC day in the measured window.
 *
 * escrow-index buckets by INTERPOLATING between timestamp anchors 10,000 blocks
 * apart, which the writeup measured as accurate to about a second at a day
 * boundary. That is good enough for the published totals but it is not the same
 * arithmetic, and a per-coin count rebuilt with a different bucketing would
 * differ from the published one for reasons nobody could later separate from
 * the attribution itself.
 *
 * So the boundaries are BINARY-SEARCHED on real headers - exact to the block -
 * and the resulting daily native totals are checked against the published
 * table. If they reproduce it, the bucketing is not a source of difference.
 */

import { writeFileSync } from 'node:fs'

const RPC = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const RPS = Number(process.env.VENUE_HTTP_RPS ?? '0.8')

let last = 0
async function rpc(method, params) {
  let lastErr
  for (let i = 0; i < 8; i++) {
    const w = last + 1000 / RPS - Date.now()
    if (w > 0) await new Promise((r) => setTimeout(r, w))
    last = Date.now()
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(60_000),
      })
      const j = await res.json()
      if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error))
      return j.result
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
    }
  }
  throw lastErr
}
const hex = (n) => '0x' + BigInt(n).toString(16)

const headers = new Map()
async function tsOf(block) {
  const key = block.toString()
  if (headers.has(key)) return headers.get(key)
  const h = await rpc('eth_getBlockByNumber', [hex(block), false])
  const t = parseInt(h.timestamp, 16)
  headers.set(key, t)
  return t
}

/** Lowest block whose timestamp is >= target. */
async function firstBlockAtOrAfter(targetUnix, low, high) {
  let lo = low
  let hi = high
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const t = await tsOf(mid)
    if (t >= targetUnix) hi = mid
    else lo = mid + 1n
  }
  return lo
}

const FROM = 50419076n
const TO = 56389048n

// The seven complete UTC days the measurement analysed, plus the exclusive end.
const days = []
for (let d = 0; d <= 7; d++) days.push(Date.UTC(2026, 7, 31 + d) / 1000)

const boundaries = []
let low = FROM
for (const dayUnix of days) {
  const b = await firstBlockAtOrAfter(dayUnix, low, TO + 1n)
  const t = b <= TO ? await tsOf(b) : null
  boundaries.push({ dayUnix, iso: new Date(dayUnix * 1000).toISOString(), block: b.toString(), blockTs: t })
  console.log(`${new Date(dayUnix * 1000).toISOString()}  first block ${b}  ts ${t} (${t === null ? '-' : new Date(t * 1000).toISOString()})`)
  low = b
}

writeFileSync(
  'tools/artifacts/day-boundaries.json',
  JSON.stringify({ fromBlock: FROM.toString(), toBlock: TO.toString(), boundaries }, null, 2),
)
console.log('\nwrote tools/artifacts/day-boundaries.json')
console.log(`header reads: ${headers.size}`)

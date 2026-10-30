#!/usr/bin/env node
/**
 * coin-recipients - dump the coin -> creator-leg recipient relation, and the
 * per-coin 7-day creator USD series, so the AGGREGATOR question can be answered
 * without re-scanning the chain.
 *
 * This is attribute-coins.mjs's second pass, extracted and written out per coin.
 * It reuses the SAME joins, the SAME day boundaries, the SAME protocol-leg
 * exclusion and the SAME price book, so its per-coin series is identical to the
 * one the 128-coin count was read from. It reproduces that count as a check and
 * REFUSES to write if it does not - a recipient map derived from a pipeline that
 * disagrees with the verdict's own coin count would be worse than no map.
 *
 *   VENUE_PRICE_USD_ETH=2460.02 VENUE_ASSETS_FILE=assets-7d-head-priced.json \
 *     node tools/artifacts/coin-recipients.mjs
 */

import { createReadStream, readFileSync, writeFileSync, createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'

const A = (p) => `tools/artifacts/${p}`
const NATIVE = '0x0000000000000000000000000000000000000000'
const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044'

const ETH_USD = Number(process.env.VENUE_PRICE_USD_ETH ?? '2460.02')
const ASSETS_FILE = process.env.VENUE_ASSETS_FILE ?? 'assets-7d-head-priced.json'
const OUT = process.env.VENUE_OUT ?? 'coin-recipients.ndjson'
const EXPECT = JSON.parse(readFileSync(A('coins-above-gates-corrected.json'), 'utf8'))

const GATES = [
  { id: 'T1', usdPerDay: 1_000 },
  { id: 'T2', usdPerDay: 2_500 },
  { id: 'T3', usdPerDay: 20_000 },
]

const bounds = JSON.parse(readFileSync(A('day-boundaries.json'), 'utf8'))
const curveToToken = JSON.parse(readFileSync(A('join-curve-to-token.json'), 'utf8')).curveToToken
const poolJoin = JSON.parse(readFileSync(A('join-pool-to-token.json'), 'utf8'))
const poolToToken = poolJoin.poolToToken
const txToPool = JSON.parse(readFileSync(A('join-tx-to-pool.json'), 'utf8')).txToPool
const assetsFile = JSON.parse(readFileSync(A(ASSETS_FILE), 'utf8'))

function poolForHookCredit(tx, logIndex) {
  const sweeps = txToPool[tx]
  if (sweeps === undefined) return undefined
  for (const [li, poolId] of sweeps) if (li > logIndex) return poolId
  return undefined
}

const decimalsOf = new Map()
const priceOf = new Map()
for (const a of assetsFile.assets ?? assetsFile) {
  const addr = (a.address ?? a.asset ?? '').toLowerCase()
  if (!addr) continue
  if (typeof a.decimals === 'number') decimalsOf.set(addr, a.decimals)
  if (typeof a.priceUsd === 'number' && a.priceUsd > 0) priceOf.set(addr, a.priceUsd)
}
decimalsOf.set(NATIVE, 18)
priceOf.set(NATIVE, ETH_USD)

const dayStarts = bounds.boundaries.map((b) => BigInt(b.block))
const dayIso = bounds.boundaries.slice(0, 7).map((b) => b.iso.slice(0, 10))
function dayIndex(block) {
  for (let i = 0; i < 7; i++) if (block >= dayStarts[i] && block < dayStarts[i + 1]) return i
  return -1
}

// The protocol leg, asserted the same way attribute-coins.mjs asserts it: read
// from hook.protocolFeeRecipient(), not inferred. Excluding it is what makes the
// series a CREATOR-leg series - the addressable one.
const PROTOCOL = new Set(EXPECT.protocolRecipients)
if (PROTOCOL.size === 0) throw new Error('no protocol recipients in the expected artifact')

const dense = () => [0, 0, 0, 0, 0, 0, 0]
/** coin -> 7-day creator USD */
const coinDayUsd = new Map()
/** coin -> Set(recipient) on the creator leg */
const coinRecip = new Map()
/** coin -> 'curve' | 'pool' */
const coinPath = new Map()
/** coin -> credit count, and per-recipient credit counts for a value-weighted view */
const coinCredits = new Map()
/** recipient -> Set(coin) on the creator leg */
const recipCoins = new Map()

const rl = createInterface({
  input: createReadStream(A('credits-7d-with-depositor.ndjson')),
  crlfDelay: Infinity,
})
let rows = 0
let unpricedSkipped = 0
for await (const line of rl) {
  if (line.length === 0) continue
  const p = line.split('\t')
  const d = dayIndex(BigInt(p[0]))
  if (d < 0) continue
  const recipient = p[1]
  if (PROTOCOL.has(recipient)) continue
  const asset = p[2]
  const depositor = p[3]

  let coin
  let path
  if (curveToToken[depositor] !== undefined) {
    coin = curveToToken[depositor]
    path = 'curve'
  } else if (depositor === HOOK) {
    const poolId = poolForHookCredit(p[5], Number(p[6]))
    if (poolId !== undefined) {
      coin = poolToToken[poolId]
      path = 'pool'
    }
  }
  if (coin === undefined) continue
  rows++

  const price = priceOf.get(asset)
  const dec = decimalsOf.get(asset)
  if (price === undefined || dec === undefined) {
    unpricedSkipped++
    continue
  }
  const usd = (Number(p[4]) / 10 ** dec) * price

  coinPath.set(coin, path)
  let arr = coinDayUsd.get(coin)
  if (arr === undefined) coinDayUsd.set(coin, (arr = dense()))
  arr[d] += usd
  let s = coinRecip.get(coin)
  if (s === undefined) coinRecip.set(coin, (s = new Map()))
  s.set(recipient, (s.get(recipient) ?? 0) + usd)
  coinCredits.set(coin, (coinCredits.get(coin) ?? 0) + 1)
  let rc = recipCoins.get(recipient)
  if (rc === undefined) recipCoins.set(recipient, (rc = new Set()))
  rc.add(coin)
}

const median7 = (arr) => [...arr].sort((a, b) => a - b)[3]

// --- reproduce the verdict's own coin counts before writing anything --------
const got = []
for (const gate of GATES) {
  let standing = 0
  for (const arr of coinDayUsd.values()) if (median7(arr) >= gate.usdPerDay) standing++
  got.push(standing)
}
const want = EXPECT.gates.map((g) => g.coinsStanding)
const ok = got.every((v, i) => v === want[i])
console.log(`coin-keyed creator credits read : ${rows} (${unpricedSkipped} in an unpriced asset, counted not zeroed)`)
console.log(`standing coins  this pass       : T1 ${got[0]}  T2 ${got[1]}  T3 ${got[2]}`)
console.log(`standing coins  verdict artifact: T1 ${want[0]}  T2 ${want[1]}  T3 ${want[2]}`)
console.log(`reproduces the verdict's counts : ${ok ? 'EXACTLY' : 'NO'}`)
if (!ok) {
  console.error('REFUSING to write. This pass disagrees with the coin count the verdict used.')
  process.exit(2)
}

// Cross-check the standing SET, not just its size.
const t1Want = new Set(EXPECT.gates[0].standingCoins)
const t1Got = new Set()
for (const [coin, arr] of coinDayUsd) if (median7(arr) >= 1000) t1Got.add(coin)
let same = t1Got.size === t1Want.size
for (const c of t1Got) if (!t1Want.has(c)) same = false
console.log(`the T1 standing SET is identical : ${same ? 'YES' : 'NO'}`)
if (!same) {
  console.error('REFUSING to write: same count, different coins.')
  process.exit(2)
}

const out = createWriteStream(A(OUT))
for (const [coin, arr] of coinDayUsd) {
  const recips = [...coinRecip.get(coin).entries()].sort((a, b) => b[1] - a[1])
  out.write(
    [
      coin,
      coinPath.get(coin),
      coinCredits.get(coin),
      median7(arr).toFixed(4),
      arr.reduce((a, b) => a + b, 0).toFixed(4),
      arr.map((v) => v.toFixed(4)).join(','),
      recips.map(([r, v]) => `${r}:${v.toFixed(4)}`).join(','),
    ].join('\t') + '\n',
  )
}
out.end()
await new Promise((r) => out.on('close', r))

// recipient -> coin count, creator leg, for the aggregator arithmetic
const perRecip = [...recipCoins.entries()].map(([r, s]) => [r, s.size]).sort((a, b) => b[1] - a[1])
writeFileSync(
  A('recipient-coin-counts.json'),
  JSON.stringify({ days: dayIso, ethUsd: ETH_USD, assetsFile: ASSETS_FILE, recipients: perRecip.length, perRecip }, null, 0),
)
console.log(`wrote tools/artifacts/${OUT}  (${coinDayUsd.size} coins)`)
console.log(`wrote tools/artifacts/recipient-coin-counts.json  (${perRecip.length} creator-leg recipients)`)

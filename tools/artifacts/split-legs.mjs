#!/usr/bin/env node
/**
 * split-legs - label every hook-path escrow credit as PROTOCOL, BUYBACK or
 * CREATOR by matching its amount against the PoolFeesSwept that produced it.
 *
 * WHY THIS EXISTS. attribute-coins.mjs separates the creator leg from the
 * platform leg with a BREADTH heuristic: a recipient paid by >=1% of all
 * distinct depositors is a platform leg. That heuristic can only ever fire on
 * the CURVE path, where each of 141,653 launches is its own depositor. On the
 * POOL path every credit has the same depositor - the shared meme hook - so a
 * pool-path protocol recipient has a breadth of exactly 1 and is invisible to
 * it. The one platform recipient it found, 0x263ed295, was found through its
 * curve-path credits.
 *
 * VenueV2MemeHook emits
 *   PoolFeesSwept(bytes32 indexed poolId, uint256 protocolAmount,
 *                 uint256 buybackAmount, uint256 creatorAmount,
 *                 uint256 tokensLocked)
 * in the same transaction as the credits it just made, so the leg of each
 * credit is not a guess: it is whichever of those amounts the credit equals.
 * A credit that matches none, or matches ambiguously, is labelled UNRESOLVED
 * and counted as such - never quietly assigned to the creator.
 */
import { createReadStream, readFileSync, writeFileSync, createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'

const A = (p) => `tools/artifacts/${p}`
const NATIVE = '0x0000000000000000000000000000000000000000'
const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044'
const ETH_USD = Number(process.env.VENUE_PRICE_USD_ETH ?? '2460.02')
const ASSETS_FILE = process.env.VENUE_ASSETS_FILE ?? 'assets-7d-head-priced.json'

const bounds = JSON.parse(readFileSync(A('day-boundaries.json'), 'utf8'))
const curveToToken = JSON.parse(readFileSync(A('join-curve-to-token.json'), 'utf8')).curveToToken
const poolToToken = JSON.parse(readFileSync(A('join-pool-to-token.json'), 'utf8')).poolToToken
const txToPool = JSON.parse(readFileSync(A('join-tx-to-pool.json'), 'utf8')).txToPool
const sweeps = JSON.parse(readFileSync(A('sweeps-7d.json'), 'utf8')).sweeps
const assetsFile = JSON.parse(readFileSync(A(ASSETS_FILE), 'utf8'))
const EXPECT = JSON.parse(readFileSync(A('coins-above-gates-corrected.json'), 'utf8'))
const CURVE_PROTOCOL = new Set(EXPECT.protocolRecipients)

/** (poolId, block) -> the sweep(s) settled there. */
const sweepAt = new Map()
for (const s of sweeps) {
  const k = `${s.p}|${s.b}`
  let a = sweepAt.get(k)
  if (a === undefined) sweepAt.set(k, (a = []))
  a.push(s)
}
console.log(`sweeps loaded ${sweeps.length}, distinct (pool,block) keys ${sweepAt.size}`)

function poolForHookCredit(tx, logIndex) {
  const s = txToPool[tx]
  if (s === undefined) return undefined
  for (const [li, poolId] of s) if (li > logIndex) return poolId
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

const dense = () => [0, 0, 0, 0, 0, 0, 0]
/** coin -> 7-day USD of the TRUE creator leg */
const coinCreator = new Map()
/** coin -> Set(recipient) on the true creator leg */
const coinCreatorRecip = new Map()
/** recipient -> USD received on the POOL protocol leg (the platform cut) */
const protocolLegUsd = new Map()
/** recipient -> Set(pool-path coin) it took a protocol cut on */
const protocolLegCoins = new Map()
/** coin -> recipient -> USD of the protocol leg. Which house holds this pool. */
const coinProtocolRecip = new Map()
/** coin -> {protocolUsd, creatorUsd} on the pool path, for the rate */
const coinLegUsd = new Map()

const tally = { protocol: 0, buyback: 0, creator: 0, unresolved: 0, noSweep: 0, curve: 0 }
const tallyUsd = { protocol: 0, buyback: 0, creator: 0, unresolved: 0, curve: 0 }

const rl = createInterface({
  input: createReadStream(A('credits-7d-with-depositor.ndjson')),
  crlfDelay: Infinity,
})
for await (const line of rl) {
  if (line.length === 0) continue
  const p = line.split('\t')
  const blockBig = BigInt(p[0])
  const d = dayIndex(blockBig)
  if (d < 0) continue
  const recipient = p[1]
  const asset = p[2]
  const depositor = p[3]
  const amount = p[4]

  const price = priceOf.get(asset)
  const dec = decimalsOf.get(asset)
  const usd = price !== undefined && dec !== undefined ? (Number(amount) / 10 ** dec) * price : null

  if (depositor === HOOK) {
    const poolId = poolForHookCredit(p[5], Number(p[6]))
    const coin = poolId === undefined ? undefined : poolToToken[poolId]
    if (coin === undefined) continue
    const cands = sweepAt.get(`${poolId}|${Number(p[0])}`)
    if (cands === undefined) {
      tally.noSweep++
      continue
    }
    // Which leg? Exact amount equality against this pool's sweep in this block.
    let leg = null
    let matches = 0
    for (const s of cands) {
      if (s.cr === amount) { leg = 'creator'; matches++ }
      if (s.pr === amount) { leg = leg === 'creator' ? 'ambiguous' : 'protocol'; matches++ }
      if (s.bb === amount && amount !== '0') { leg = leg ? 'ambiguous' : 'buyback'; matches++ }
    }
    if (leg === null || leg === 'ambiguous') {
      tally.unresolved++
      if (usd !== null) tallyUsd.unresolved += usd
      continue
    }
    tally[leg]++
    if (usd !== null) tallyUsd[leg] += usd
    if (leg === 'creator') {
      let arr = coinCreator.get(coin)
      if (arr === undefined) coinCreator.set(coin, (arr = dense()))
      if (usd !== null) arr[d] += usd
      let s = coinCreatorRecip.get(coin)
      if (s === undefined) coinCreatorRecip.set(coin, (s = new Map()))
      if (usd !== null) s.set(recipient, (s.get(recipient) ?? 0) + usd)
      const lg = coinLegUsd.get(coin) ?? { protocolUsd: 0, creatorUsd: 0 }
      if (usd !== null) lg.creatorUsd += usd
      coinLegUsd.set(coin, lg)
    } else if (leg === 'protocol') {
      if (usd !== null) protocolLegUsd.set(recipient, (protocolLegUsd.get(recipient) ?? 0) + usd)
      let s = protocolLegCoins.get(recipient)
      if (s === undefined) protocolLegCoins.set(recipient, (s = new Set()))
      s.add(coin)
      let m2 = coinProtocolRecip.get(coin)
      if (m2 === undefined) coinProtocolRecip.set(coin, (m2 = new Map()))
      if (usd !== null) m2.set(recipient, (m2.get(recipient) ?? 0) + usd)
      const lg = coinLegUsd.get(coin) ?? { protocolUsd: 0, creatorUsd: 0 }
      if (usd !== null) lg.protocolUsd += usd
      coinLegUsd.set(coin, lg)
    }
    continue
  }

  // CURVE path. No per-credit event to match against, so the published rule
  // stands: the known platform recipient is dropped, everything else is the
  // creator. Reported separately so it is never confused with the exact half.
  const coin = curveToToken[depositor]
  if (coin === undefined) continue
  if (CURVE_PROTOCOL.has(recipient)) continue
  tally.curve++
  if (usd !== null) tallyUsd.curve += usd
  let arr = coinCreator.get(coin)
  if (arr === undefined) coinCreator.set(coin, (arr = dense()))
  if (usd !== null) arr[d] += usd
  let s = coinCreatorRecip.get(coin)
  if (s === undefined) coinCreatorRecip.set(coin, (s = new Map()))
  if (usd !== null) s.set(recipient, (s.get(recipient) ?? 0) + usd)
}

console.log('\nLEG LABELLING, hook path (exact amount match against PoolFeesSwept)')
for (const k of ['creator', 'protocol', 'buyback', 'unresolved', 'noSweep']) {
  console.log(`  ${k.padEnd(12)} ${String(tally[k]).padStart(9)} credits   $${(tallyUsd[k] ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
}
console.log(`  curve path   ${String(tally.curve).padStart(9)} credits   $${tallyUsd.curve.toLocaleString('en-US', { maximumFractionDigits: 0 })}  (breadth rule, as published)`)

const median7 = (arr) => [...arr].sort((a, b) => a - b)[3]
const GATES = [
  { id: 'T1', usd: 1_000 },
  { id: 'T2', usd: 2_500 },
  { id: 'T3', usd: 20_000 },
]
console.log('\nCOINS ABOVE EACH GATE, on the TRUE creator leg (trailing-7d median)')
const gateOut = []
for (const g of GATES) {
  const coins = []
  for (const [coin, arr] of coinCreator) if (median7(arr) >= g.usd) coins.push(coin)
  gateOut.push({ id: g.id, usdPerDay: g.usd, standing: coins.length, coins })
  console.log(`  ${g.id}  $${g.usd}/day   ${coins.length} coins`)
}
const prev = EXPECT.gates.map((x) => x.coinsStanding)
console.log(`  previously published on the contaminated leg: T1 ${prev[0]}  T2 ${prev[1]}  T3 ${prev[2]}`)

console.log('\nPOOL-PATH PROTOCOL-LEG RECIPIENTS (the platform cut - NOT addressable creators)')
const prot = [...protocolLegUsd.entries()].sort((a, b) => b[1] - a[1])
for (const [r, usd] of prot.slice(0, 12)) {
  console.log(`  ${r}  $${usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}  over ${protocolLegCoins.get(r).size} coins`)
}
console.log(`  distinct pool-path protocol recipients: ${prot.length}`)

const out = createWriteStream(A('coin-creator-legs.ndjson'))
for (const [coin, arr] of coinCreator) {
  const recips = [...(coinCreatorRecip.get(coin) ?? new Map()).entries()].sort((a, b) => b[1] - a[1])
  const lg = coinLegUsd.get(coin) ?? { protocolUsd: 0, creatorUsd: 0 }
  out.write(
    [
      coin,
      median7(arr).toFixed(4),
      arr.reduce((a, b) => a + b, 0).toFixed(4),
      lg.protocolUsd.toFixed(4),
      lg.creatorUsd.toFixed(4),
      arr.map((v) => v.toFixed(4)).join(','),
      recips.map(([r, v]) => `${r}:${v.toFixed(4)}`).join(','),
      [...(coinProtocolRecip.get(coin) ?? new Map()).entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([r, v]) => `${r}:${v.toFixed(4)}`)
        .join(','),
    ].join('\t') + '\n',
  )
}
out.end()
await new Promise((r) => out.on('close', r))

writeFileSync(
  A('legs-summary.json'),
  JSON.stringify(
    {
      days: dayIso,
      ethUsd: ETH_USD,
      assetsFile: ASSETS_FILE,
      tally,
      tallyUsd,
      gates: gateOut.map((g) => ({ id: g.id, usdPerDay: g.usdPerDay, standing: g.standing, coins: g.coins })),
      previousStanding: { T1: prev[0], T2: prev[1], T3: prev[2] },
      poolProtocolRecipients: prot.map(([r, usd]) => ({ recipient: r, usd, coins: protocolLegCoins.get(r).size })),
    },
    null,
    1,
  ),
)
console.log('\nwrote tools/artifacts/coin-creator-legs.ndjson and legs-summary.json')

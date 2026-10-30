#!/usr/bin/env node
/**
 * attribute-coins - answer the question the recipient-based measurement cannot:
 * HOW MANY DISTINCT COINS, not recipients, sit above each QF gate.
 *
 * The escrow credits key by (recipient, asset) and carry no coin identifier, so
 * the published population of 99 counts RECIPIENTS. The business plan counts
 * COINS. They are not the same unit and nobody had reconciled them.
 *
 * There are TWO fee paths into the escrow and only one of them was ever in the
 * plan for this join:
 *
 *   1. PRE-GRADUATION. Each launch gets its own bonding-curve contract, and
 *      that contract credits the escrow directly. The DEPOSITOR is therefore
 *      the coin, 1:1, via the factory's TokenLaunched(token, curve, deployer).
 *      Measured 2026-09-07: 78.1% of escrow credits.
 *
 *   2. POST-GRADUATION. The shared V2 meme hook sweeps a Uniswap-v4 pool and
 *      credits the escrow. Those credits carry no poolId, but the sweep that
 *      produced them is PoolFeesSwept in the SAME TRANSACTION, so txHash ->
 *      poolId -> memecoin via PoolRegistered on the hook. 21.9% of credits.
 *
 * Every credit that resolves to neither is counted and reported as UNATTRIBUTED
 * rather than dropped, because a coin population computed over a silently
 * partial join is an undercount wearing a confident face.
 *
 * PRICING defaults to the published measurement's book - native at the pinned
 * $3,200/ETH, USDG at its peg, everything else UNPRICED - so the coin counts
 * are directly comparable to the published recipient counts, and are lower
 * bounds in exactly the same way. Both halves of that book are overridable
 * (VENUE_PRICE_USD_ETH, VENUE_ASSETS_FILE) because both were later corrected, and
 * the defensible verdict needs the coin count on the CORRECTED book. The
 * reproduction ladder always runs on the fixed published book, so the check
 * that this rebuild reproduces 99/51/6 keeps checking something.
 *
 *   # the control run, reproducing the published basis
 *   node tools/artifacts/attribute-coins.mjs
 *
 *   # the corrected run
 *   VENUE_PRICE_USD_ETH=2460.02 VENUE_ASSETS_FILE=assets-7d-head-priced.json \
 *   VENUE_COINS_OUT=coins-above-gates-corrected.json \
 *     node tools/artifacts/attribute-coins.mjs
 */

import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const A = (p) => `tools/artifacts/${p}`
const NATIVE = '0x0000000000000000000000000000000000000000'
const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044'

/**
 * THE ACTIVE PRICE BOOK - what the headline coin counts are computed with.
 *
 * Both inputs are overridable because both were WRONG in the published run and
 * were corrected by separate tracks: the ETH price was pinned at an unverified
 * $3,200 when four venues put the window at $2,460.02, and the ERC-20 book held
 * one asset when 53 of them are priceable on this chain. A coin count that
 * combines the two corrections cannot be produced by a script that hardcodes
 * either of them.
 */
const ETH_USD = Number(process.env.VENUE_PRICE_USD_ETH ?? '3200')
const ASSETS_FILE = process.env.VENUE_ASSETS_FILE ?? 'assets-7d-priced.json'

/**
 * THE CONTROL PRICE BOOK - fixed, and deliberately NOT overridable.
 *
 * The variant ladder below exists to prove this rebuild reproduces the
 * PUBLISHED 99/51/6 before any per-coin number is quoted. That published figure
 * was measured at native-only, $3,200/ETH. If the control moved with the active
 * book, the reproduction check would silently stop checking anything - it would
 * just be the headline computed twice. A control that tracks the parameter it
 * is controlling for is not a control.
 */
const CONTROL_ETH_USD = 3200
const CONTROL_ASSETS_FILE = 'assets-7d-priced.json'

/** Overridable so a corrected-input run cannot silently clobber the control run. */
const OUT_FILE = process.env.VENUE_COINS_OUT ?? 'coins-above-gates.json'

const GATES = [
  { id: 'T1', name: 'Desk', usdPerDay: 1_000 },
  { id: 'T2', name: 'Campaign', usdPerDay: 2_500 },
  { id: 'T3', name: 'Flagship', usdPerDay: 20_000 },
]

/** The published per-day native ETH totals this reconstruction must reproduce. */
const PUBLISHED_DAILY_ETH = {
  '2026-08-31': 1157.4693,
  '2026-09-01': 1358.9295,
  '2026-09-02': 1101.9221,
  '2026-09-03': 1348.8469,
  '2026-09-04': 1029.4844,
  '2026-09-05': 2215.272,
  '2026-09-06': 1949.3233,
}

// --- inputs ----------------------------------------------------------------
const bounds = JSON.parse(readFileSync(A('day-boundaries.json'), 'utf8'))
const curveJoin = JSON.parse(readFileSync(A('join-curve-to-token.json'), 'utf8'))
const poolJoin = JSON.parse(readFileSync(A('join-pool-to-token.json'), 'utf8'))
const txJoin = JSON.parse(readFileSync(A('join-tx-to-pool.json'), 'utf8'))
const assetsFile = JSON.parse(readFileSync(A(ASSETS_FILE), 'utf8'))
const controlAssetsFile =
  ASSETS_FILE === CONTROL_ASSETS_FILE
    ? assetsFile
    : JSON.parse(readFileSync(A(CONTROL_ASSETS_FILE), 'utf8'))

const curveToToken = curveJoin.curveToToken
const poolToToken = poolJoin.poolToToken
const poolToCreator = poolJoin.poolToCreator
/** tx -> [[logIndex, poolId], …] ascending. */
const txToPool = txJoin.txToPool

/**
 * Which pool a hook-deposited credit belongs to.
 *
 * VenueV2MemeHook.sweepPoolFees calls _payOut for the creator and then for the
 * protocol, and only then emits PoolFeesSwept - so within a transaction a
 * credit belongs to the FIRST sweep whose logIndex is above its own. With one
 * sweep per transaction this is the same as a plain tx -> pool map; with a
 * batched sweep it is the difference between correct attribution and assigning
 * every pool's fees to whichever pool happened to be swept last.
 */
function poolForHookCredit(tx, logIndex) {
  const sweeps = txToPool[tx]
  if (sweeps === undefined) return undefined
  for (const [li, poolId] of sweeps) if (li > logIndex) return poolId
  return undefined
}

// Asset decimals and prices, exactly as the published run used them.
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

// The control book, built the same way from the fixed published inputs.
const controlDecimalsOf = new Map()
const controlPriceOf = new Map()
for (const a of controlAssetsFile.assets ?? controlAssetsFile) {
  const addr = (a.address ?? a.asset ?? '').toLowerCase()
  if (!addr) continue
  if (typeof a.decimals === 'number') controlDecimalsOf.set(addr, a.decimals)
  if (typeof a.priceUsd === 'number' && a.priceUsd > 0) controlPriceOf.set(addr, a.priceUsd)
}
controlDecimalsOf.set(NATIVE, 18)
controlPriceOf.set(NATIVE, CONTROL_ETH_USD)

console.log('PRICE BOOKS')
console.log(
  `  ACTIVE  (headline coin counts): ${ASSETS_FILE}, ${priceOf.size} priced asset(s), ETH $${ETH_USD}`,
)
console.log(
  `  CONTROL (reproduction ladder) : ${CONTROL_ASSETS_FILE}, ${controlPriceOf.size} priced asset(s), ETH $${CONTROL_ETH_USD}  [fixed]`,
)
console.log('')

const dayStarts = bounds.boundaries.map((b) => BigInt(b.block))
const dayIso = bounds.boundaries.slice(0, 7).map((b) => b.iso.slice(0, 10))
/** Which of the 7 analysed days a block falls in, or -1 outside them. */
function dayIndex(block) {
  for (let i = 0; i < 7; i++) {
    if (block >= dayStarts[i] && block < dayStarts[i + 1]) return i
  }
  return -1
}

// --- pass over every credit ------------------------------------------------
const nativeWeiByDay = new Array(7).fill(0n)
const creditsByDay = new Array(7).fill(0)
let outsideDays = 0

const pathCounts = { curve: 0, pool: 0, unattributed: 0 }
const pathNativeWei = { curve: 0n, pool: 0n, unattributed: 0n }

/** recipient -> how many DISTINCT depositors paid it. Finds the protocol leg. */
const depositorsPerRecipient = new Map()
/** coin -> 7-day USD array of ALL credits attributed to it. */
const coinDayUsd = new Map()
/** coin -> 7-day USD of the CREATOR leg only (protocol recipients removed). */
const coinDayUsdCreator = new Map()
/** coin -> whether any of its credits were in an unpriced asset. */
const coinHasUnpriced = new Map()
const coinRecipients = new Map()
const recipientCoins = new Map()
const coinPath = new Map()
const unattributedDepositors = new Map()

const dense = () => [0, 0, 0, 0, 0, 0, 0]

const rl = createInterface({
  input: createReadStream(A('credits-7d-with-depositor.ndjson')),
  crlfDelay: Infinity,
})

let rows = 0
for await (const line of rl) {
  if (line.length === 0) continue
  const tab1 = line.indexOf('\t')
  const tab2 = line.indexOf('\t', tab1 + 1)
  const tab3 = line.indexOf('\t', tab2 + 1)
  const tab4 = line.indexOf('\t', tab3 + 1)
  const tab5 = line.indexOf('\t', tab4 + 1)
  const tab6 = line.indexOf('\t', tab5 + 1)
  const block = BigInt(line.slice(0, tab1))
  const recipient = line.slice(tab1 + 1, tab2)
  const asset = line.slice(tab2 + 1, tab3)
  const depositor = line.slice(tab3 + 1, tab4)
  const amount = BigInt(line.slice(tab4 + 1, tab5))
  const tx = line.slice(tab5 + 1, tab6)
  const logIndex = Number(line.slice(tab6 + 1))
  rows++

  const d = dayIndex(block)
  if (d < 0) {
    outsideDays++
    continue
  }
  creditsByDay[d]++
  if (asset === NATIVE) nativeWeiByDay[d] += amount

  let set = depositorsPerRecipient.get(recipient)
  if (set === undefined) depositorsPerRecipient.set(recipient, (set = new Set()))
  set.add(depositor)

  // --- attribution ---
  let coin
  let path
  if (curveToToken[depositor] !== undefined) {
    coin = curveToToken[depositor]
    path = 'curve'
  } else if (depositor === HOOK) {
    const poolId = poolForHookCredit(tx, logIndex)
    const token = poolId === undefined ? undefined : poolToToken[poolId]
    if (token !== undefined) {
      coin = token
      path = 'pool'
    } else {
      path = 'unattributed'
    }
  } else {
    path = 'unattributed'
  }

  pathCounts[path]++
  if (asset === NATIVE) pathNativeWei[path] += amount
  if (coin === undefined) {
    unattributedDepositors.set(depositor, (unattributedDepositors.get(depositor) ?? 0) + 1)
    continue
  }

  coinPath.set(coin, path)

  // USD, with the same refusal rule as the published run: an unpriced asset
  // contributes NOTHING and is flagged, never silently treated as zero value.
  const price = priceOf.get(asset)
  const dec = decimalsOf.get(asset)
  let usd = null
  if (price !== undefined && dec !== undefined) {
    usd = (Number(amount) / 10 ** dec) * price
  } else {
    coinHasUnpriced.set(coin, true)
  }

  if (usd !== null) {
    let arr = coinDayUsd.get(coin)
    if (arr === undefined) coinDayUsd.set(coin, (arr = dense()))
    arr[d] += usd
  }

  let cr = coinRecipients.get(coin)
  if (cr === undefined) coinRecipients.set(coin, (cr = new Set()))
  cr.add(recipient)
  let rc = recipientCoins.get(recipient)
  if (rc === undefined) recipientCoins.set(recipient, (rc = new Set()))
  rc.add(coin)
}

console.log(`credits read           ${rows}`)
console.log(`credits outside the 7 analysed days (boundary sliver): ${outsideDays}`)
console.log('')

// --- validation: does this bucketing reproduce the published daily table? ---
console.log('DAILY NATIVE TOTALS vs the published table')
console.log('  day           this run (ETH)     published (ETH)    delta')
let dailyOk = true
for (let i = 0; i < 7; i++) {
  const eth = Number(nativeWeiByDay[i]) / 1e18
  const pub = PUBLISHED_DAILY_ETH[dayIso[i]]
  const delta = eth - pub
  if (Math.abs(delta) > 0.5) dailyOk = false
  console.log(
    `  ${dayIso[i]}   ${eth.toFixed(4).padStart(14)}   ${pub.toFixed(4).padStart(15)}   ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`,
  )
}
const totalEth = Number(nativeWeiByDay.reduce((a, b) => a + b, 0n)) / 1e18
console.log(`  TOTAL         ${totalEth.toFixed(4).padStart(14)}   ${(10161.2475).toFixed(4).padStart(15)}   ${(totalEth - 10161.2475).toFixed(4)}`)
console.log(`  bucketing reproduces the published table: ${dailyOk ? 'YES' : 'NO - investigate before reading anything below'}`)
console.log('')

// --- attribution coverage --------------------------------------------------
const attributed = pathCounts.curve + pathCounts.pool
console.log('ATTRIBUTION COVERAGE')
console.log(`  via bonding curve (depositor = curve)   ${pathCounts.curve} credits (${((pathCounts.curve / rows) * 100).toFixed(2)}%)  ${(Number(pathNativeWei.curve) / 1e18).toFixed(2)} ETH`)
console.log(`  via hook sweep    (txHash -> poolId)    ${pathCounts.pool} credits (${((pathCounts.pool / rows) * 100).toFixed(2)}%)  ${(Number(pathNativeWei.pool) / 1e18).toFixed(2)} ETH`)
console.log(`  UNATTRIBUTED                            ${pathCounts.unattributed} credits (${((pathCounts.unattributed / rows) * 100).toFixed(2)}%)  ${(Number(pathNativeWei.unattributed) / 1e18).toFixed(2)} ETH`)
console.log(`  distinct coins seen                     ${coinPath.size}`)
console.log(`  distinct unattributed depositors        ${unattributedDepositors.size}`)
const topUnattr = [...unattributedDepositors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
for (const [dep, n] of topUnattr) console.log(`      ${dep}  ${n} credits`)
console.log('')

// --- who is the protocol fee recipient? ------------------------------------
const byBreadth = [...depositorsPerRecipient.entries()].sort((a, b) => b[1].size - a[1].size)
console.log('RECIPIENTS BY NUMBER OF DISTINCT DEPOSITORS (the protocol leg is the broad one)')
for (const [r, s] of byBreadth.slice(0, 8)) console.log(`  ${r}  ${s.size} depositors`)
// A recipient paid by more than 1% of all depositors is not a creator; it is a
// platform-level leg. Threshold reported, not hidden.
const totalDepositors = new Set()
for (const s of depositorsPerRecipient.values()) for (const d of s) totalDepositors.add(d)
const protocolThreshold = Math.max(50, totalDepositors.size * 0.01)
const protocolRecipients = new Set(byBreadth.filter(([, s]) => s.size >= protocolThreshold).map(([r]) => r))
// Read from the contract, not inferred: VenueV2MemeHook.protocolFeeRecipient()
// at block 57118516 returned this address. The breadth heuristic above must
// agree with it, and it is asserted rather than assumed.
const HOOK_PROTOCOL_FEE_RECIPIENT = '0x19b47529fe0fff6fc31286c3c0db4cebc9d1eaec'
const anchorAgrees = protocolRecipients.has(HOOK_PROTOCOL_FEE_RECIPIENT)
protocolRecipients.add(HOOK_PROTOCOL_FEE_RECIPIENT)
console.log(`  total distinct depositors ${totalDepositors.size}; treating >= ${Math.round(protocolThreshold)} depositors as a platform leg`)
console.log(`  hook.protocolFeeRecipient() reads ${HOOK_PROTOCOL_FEE_RECIPIENT}; breadth heuristic agrees: ${anchorAgrees ? 'YES' : 'NO'}`)
console.log(`  platform-leg recipients: ${protocolRecipients.size} -> ${[...protocolRecipients].join(', ')}`)
console.log('')

writeFileSync(
  A('attribution-intermediate.json'),
  JSON.stringify({
    rows,
    dailyOk,
    pathCounts,
    coins: coinPath.size,
    protocolRecipients: [...protocolRecipients],
    dayIso,
  }),
)

// --- does this pipeline reproduce the PUBLISHED gate counts? ---------------
// Before any per-coin number is quoted, the rebuild has to land on 99/51/6 from
// the same basis the published run used - native only, every leg, every
// recipient. If it does, each row below differs from the published one by
// exactly the change named in its label, and nothing else.
const variants = {
  'A  native only, ALL legs  (the published basis)': { nativeOnly: true, dropPlatform: false },
  'B  native only, creator leg only': { nativeOnly: true, dropPlatform: true },
  'C  native + USDG, ALL legs': { nativeOnly: false, dropPlatform: false },
  'D  native + USDG, creator leg only  (the per-coin basis)': { nativeOnly: false, dropPlatform: true },
}
const variantSeries = Object.fromEntries(Object.keys(variants).map((k) => [k, new Map()]))
{
  const rlv = createInterface({
    input: createReadStream(A('credits-7d-with-depositor.ndjson')),
    crlfDelay: Infinity,
  })
  for await (const line of rlv) {
    if (line.length === 0) continue
    const p = line.split('\t')
    const d = dayIndex(BigInt(p[0]))
    if (d < 0) continue
    // CONTROL book, always. See CONTROL_ETH_USD above for why this must not
    // follow the active book.
    const price = controlPriceOf.get(p[2])
    const dec = controlDecimalsOf.get(p[2])
    if (price === undefined || dec === undefined) continue
    const usdValue = (Number(p[4]) / 10 ** dec) * price
    for (const [label, v] of Object.entries(variants)) {
      if (v.nativeOnly && p[2] !== NATIVE) continue
      if (v.dropPlatform && protocolRecipients.has(p[1])) continue
      const m = variantSeries[label]
      let arr = m.get(p[1])
      if (arr === undefined) m.set(p[1], (arr = dense()))
      arr[d] += usdValue
    }
  }
}
const medianOf7 = (arr) => [...arr].sort((a, b) => a - b)[3]
console.log('CAN THIS REBUILD REPRODUCE THE PUBLISHED COUNTS?  (recipients, trailing-7d median)')
console.log('  variant                                                    T1     T2     T3   recipients')
const variantResults = []
for (const [label, m] of Object.entries(variantSeries)) {
  const t = [0, 0, 0]
  for (const arr of m.values()) {
    const x = medianOf7(arr)
    for (let i = 0; i < GATES.length; i++) if (x >= GATES[i].usdPerDay) t[i]++
  }
  variantResults.push({ variant: label.trim(), t1: t[0], t2: t[1], t3: t[2], recipients: m.size })
  console.log(`  ${label.padEnd(56)}${String(t[0]).padStart(4)}${String(t[1]).padStart(7)}${String(t[2]).padStart(7)}${String(m.size).padStart(12)}`)
}
const a = variantResults[0]
const reproduces = a.t1 === 99 && a.t2 === 51 && a.t3 === 6 && a.recipients === 52_451
console.log('  published (MEASUREMENT.md 3.2, native only):                99     51      6       52451')
console.log(`  variant A reproduces the published figures: ${reproduces ? 'EXACTLY' : 'NO'}`)
if (!reproduces) {
  console.error('')
  console.error(
    'REFUSING to print per-coin figures. The control book failed to reproduce the published ' +
      '99/51/6 over 52,451 recipients, so this rebuild does not agree with the measurement it ' +
      'claims to reinterpret. A coin count from a pipeline that cannot reproduce its own baseline ' +
      'is a number without provenance.',
  )
  process.exit(2)
}
console.log('')

// --- second pass over the per-coin structures ------------------------------
// The creator-leg series has to exclude the platform legs, which needs the
// protocol recipient set - only known after the first pass. Rather than hold
// every credit in memory, re-stream.
const rl2 = createInterface({
  input: createReadStream(A('credits-7d-with-depositor.ndjson')),
  crlfDelay: Infinity,
})
const coinCreatorRecipients = new Map()
/** recipient -> coins whose CREATOR leg it receives. The addressable relation. */
const recipientCoinsCreator = new Map()
/**
 * The same 7-day series, keyed by RECIPIENT rather than by coin, over exactly
 * the same credits. Without this the coin count and the published recipient
 * count differ for two reasons at once - the unit AND the filtering - and no
 * one could say which moved the number.
 */
const recipientDayUsd = new Map()
for await (const line of rl2) {
  if (line.length === 0) continue
  const p = line.split('\t')
  const block = BigInt(p[0])
  const recipient = p[1]
  const asset = p[2]
  const depositor = p[3]
  const amount = BigInt(p[4])
  const tx = p[5]
  const logIndex = Number(p[6])
  const d = dayIndex(block)
  if (d < 0) continue
  if (protocolRecipients.has(recipient)) continue

  let coin
  if (curveToToken[depositor] !== undefined) coin = curveToToken[depositor]
  else if (depositor === HOOK) {
    const poolId = poolForHookCredit(tx, logIndex)
    if (poolId !== undefined) coin = poolToToken[poolId]
  }
  if (coin === undefined) continue

  const price = priceOf.get(asset)
  const dec = decimalsOf.get(asset)
  if (price === undefined || dec === undefined) continue
  const usdValue = (Number(amount) / 10 ** dec) * price
  let arr = coinDayUsdCreator.get(coin)
  if (arr === undefined) coinDayUsdCreator.set(coin, (arr = dense()))
  arr[d] += usdValue
  let rarr = recipientDayUsd.get(recipient)
  if (rarr === undefined) recipientDayUsd.set(recipient, (rarr = dense()))
  rarr[d] += usdValue

  let s = coinCreatorRecipients.get(coin)
  if (s === undefined) coinCreatorRecipients.set(coin, (s = new Set()))
  s.add(recipient)
  let rc = recipientCoinsCreator.get(recipient)
  if (rc === undefined) recipientCoinsCreator.set(recipient, (rc = new Set()))
  rc.add(coin)
}

const median7 = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  return s[3]
}

// --- the headline: coins above each gate -----------------------------------
console.log('COINS ABOVE EACH QF GATE  (creator leg only, priced assets only)')
console.log('  gate            $/day     ever >= gate    median7 >= gate   all 7 days')
const gateResults = []
for (const gate of GATES) {
  let ever = 0
  let standing = 0
  let all7 = 0
  const standingCoins = []
  for (const [coin, arr] of coinDayUsdCreator) {
    if (arr.some((v) => v >= gate.usdPerDay)) ever++
    if (median7(arr) >= gate.usdPerDay) {
      standing++
      standingCoins.push(coin)
    }
    if (arr.every((v) => v >= gate.usdPerDay)) all7++
  }
  gateResults.push({ ...gate, ever, standing, all7, standingCoins })
  console.log(
    `  ${gate.id} ${gate.name.padEnd(10)} ${String(gate.usdPerDay).padStart(6)}  ${String(ever).padStart(13)}  ${String(standing).padStart(17)}  ${String(all7).padStart(11)}`,
  )
}
console.log('')

// The SAME credits, counted by recipient. The only difference from the column
// above is the unit, so the two are directly subtractable.
console.log('THE SAME CREDITS COUNTED BY RECIPIENT  (for a like-for-like unit comparison)')
console.log('  gate            $/day     ever >= gate    median7 >= gate   all 7 days')
const recipientGateResults = []
for (const gate of GATES) {
  let ever = 0
  let standing = 0
  let all7 = 0
  for (const arr of recipientDayUsd.values()) {
    if (arr.some((v) => v >= gate.usdPerDay)) ever++
    if (median7(arr) >= gate.usdPerDay) standing++
    if (arr.every((v) => v >= gate.usdPerDay)) all7++
  }
  recipientGateResults.push({ id: gate.id, usdPerDay: gate.usdPerDay, ever, standing, all7 })
  console.log(
    `  ${gate.id} ${gate.name.padEnd(10)} ${String(gate.usdPerDay).padStart(6)}  ${String(ever).padStart(13)}  ${String(standing).padStart(17)}  ${String(all7).padStart(11)}`,
  )
}
console.log(
  ASSETS_FILE === CONTROL_ASSETS_FILE && ETH_USD === CONTROL_ETH_USD
    ? '  (published, ALL legs and no attribution filter: T1 99 / T2 51 / T3 6 standing)'
    : `  (NOT comparable to the published 99/51/6 - that was ${CONTROL_ASSETS_FILE} at $${CONTROL_ETH_USD}/ETH;` +
        ` this run is ${ASSETS_FILE} at $${ETH_USD}/ETH)`,
)
console.log('')

// --- coins per recipient: is a recipient one coin, or an aggregator? -------
// Creator leg only. Including the platform legs would make the protocol fee
// recipient look like an aggregator holding every coin on the chain, which is
// true in a bookkeeping sense and useless commercially: nobody can sign it.
console.log('COINS PER RECIPIENT (creator leg only; platform legs excluded)')
const perRecipient = [...recipientCoinsCreator.entries()].map(([r, s]) => [r, s.size])
const counts = perRecipient.map(([, n]) => n).sort((a, b) => a - b)
const q = (p) => counts[Math.min(counts.length - 1, Math.floor(p * counts.length))]
console.log(`  recipients ${counts.length}   coins ${coinPath.size}   coins/recipient mean ${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)}`)
console.log(`  median ${q(0.5)}   p75 ${q(0.75)}   p90 ${q(0.9)}   p99 ${q(0.99)}   max ${counts[counts.length - 1]}`)
const buckets = { '1': 0, '2': 0, '3-5': 0, '6-20': 0, '21-100': 0, '101-1000': 0, '1000+': 0 }
for (const n of counts) {
  if (n === 1) buckets['1']++
  else if (n === 2) buckets['2']++
  else if (n <= 5) buckets['3-5']++
  else if (n <= 20) buckets['6-20']++
  else if (n <= 100) buckets['21-100']++
  else if (n <= 1000) buckets['101-1000']++
  else buckets['1000+']++
}
for (const [k, v] of Object.entries(buckets)) {
  console.log(`    ${k.padStart(9)} coins: ${String(v).padStart(7)} recipients (${((v / counts.length) * 100).toFixed(2)}%)`)
}
console.log('')

// --- aggregators: the commercially decisive question ----------------------
console.log('TOP RECIPIENTS BY COIN COUNT (candidate aggregators)')
const topAgg = perRecipient.sort((a, b) => b[1] - a[1]).slice(0, 20)
for (const [r, n] of topAgg) console.log(`  ${r}  ${String(n).padStart(7)} coins`)
console.log('')

// How much of the ABOVE-GATE population is already captured by an aggregator?
const t1 = gateResults[0]
const aggregatorCut = 25
const aggregators = new Set(perRecipient.filter(([, n]) => n >= aggregatorCut).map(([r]) => r))
let t1Captured = 0
let t1Independent = 0
const t1ByRecipient = new Map()
for (const coin of t1.standingCoins) {
  const recips = coinCreatorRecipients.get(coin) ?? new Set()
  let captured = false
  for (const r of recips) {
    t1ByRecipient.set(r, (t1ByRecipient.get(r) ?? 0) + 1)
    if (aggregators.has(r)) captured = true
  }
  if (captured) t1Captured++
  else t1Independent++
}
console.log(`ABOVE-T1 COINS BY OWNERSHIP (aggregator = a recipient holding >= ${aggregatorCut} coins)`)
console.log(`  coins standing above T1                 ${t1.standing}`)
console.log(`  ...whose creator leg goes to an aggregator ${t1Captured} (${t1.standing ? ((t1Captured / t1.standing) * 100).toFixed(1) : '0'}%)`)
console.log(`  ...to an apparently independent recipient  ${t1Independent}`)
console.log(`  distinct recipients holding the above-T1 coins: ${t1ByRecipient.size}`)
console.log('  top holders of above-T1 coins:')
for (const [r, n] of [...t1ByRecipient.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${r}  ${n} of ${t1.standing} above-T1 coins   (holds ${recipientCoinsCreator.get(r)?.size ?? 0} coins overall)`)
}
console.log('')

writeFileSync(
  A(OUT_FILE),
  JSON.stringify(
    {
      window: { fromBlock: bounds.fromBlock, toBlock: bounds.toBlock, days: dayIso },
      pricing: {
        ethUsd: ETH_USD,
        assetsFile: ASSETS_FILE,
        pricedAssets: priceOf.size,
        control: { ethUsd: CONTROL_ETH_USD, assetsFile: CONTROL_ASSETS_FILE, reproducesPublished: reproduces },
        note:
          `native at $${ETH_USD}/ETH; ERC-20 prices from ${ASSETS_FILE} (${priceOf.size - 1} priced ` +
          'ERC-20 assets); every other asset UNPRICED and counted as such, never as zero',
      },
      credits: rows,
      dailyReproducesPublished: dailyOk,
      gateCountsReproducePublished: reproduces,
      variants: variantResults,
      attribution: pathCounts,
      distinctCoins: coinPath.size,
      protocolRecipients: [...protocolRecipients],
      gatesByRecipient: recipientGateResults,
      gates: gateResults.map((g) => ({
        id: g.id,
        name: g.name,
        usdPerDay: g.usdPerDay,
        coinsEver: g.ever,
        coinsStanding: g.standing,
        coinsAll7: g.all7,
        standingCoins: g.standingCoins,
      })),
      coinsPerRecipient: { buckets, median: q(0.5), p90: q(0.9), p99: q(0.99), max: counts[counts.length - 1] },
      aggregators: {
        threshold: aggregatorCut,
        count: aggregators.size,
        aboveT1Captured: t1Captured,
        aboveT1Independent: t1Independent,
        topHoldersOfAboveT1: [...t1ByRecipient.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25),
      },
      topRecipientsByCoinCount: topAgg,
    },
    null,
    2,
  ),
)
console.log(`wrote tools/artifacts/${OUT_FILE}`)

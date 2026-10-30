/**
 * Follow-up to probe-usdg-pool.mjs. That probe established chain 4663 carries
 * both UniswapV2-shaped and UniswapV3-shaped pools. This one asks the FACTORIES
 * directly whether a WETH/USDG pool exists, and if so reads its price and depth.
 *
 * Deterministic: getPair / getPool are pure lookups, so a zero address is a
 * definitive "no such pool", not a scan that might have missed it.
 *
 *   node tools/artifacts/probe-usdg-pool2.mjs
 */

const RPC = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
const ZERO = '0x0000000000000000000000000000000000000000'

// One known pool of each shape, from the previous probe's log scan.
const V2_SAMPLE = '0xc08a839237cd690a51ca46ce5fa6f433c40c7d13'
const V3_SAMPLE = '0x00614cae2a49a76d46812533b4a8df239cae4d68'

const SEL = {
  factory: '0xc45a0155',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  getPair: '0xe6a43905', // getPair(address,address)
  getPool: '0x1698ee82', // getPool(address,address,uint24)
  getReserves: '0x0902f1ac',
  slot0: '0x3850c7bd',
  liquidity: '0x1a686502',
  fee: '0xddca3f43',
  balanceOf: '0x70a08231',
  symbol: '0x95d89b41',
}

let id = 0
let calls = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function rpc(method, params) {
  await sleep(1200)
  calls++
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  const j = await res.json()
  return j.error ? { error: j.error } : { result: j.result }
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest'])
const pad = (a) => '0'.repeat(24) + a.replace(/^0x/, '').toLowerCase()
const word = (hex, i) => '0x' + hex.replace(/^0x/, '').slice(i * 64, (i + 1) * 64)
const addrFrom = (h) => (h && h.length >= 66 ? '0x' + h.slice(26, 66) : null)

console.log('WETH/USDG POOL LOOKUP, chain 4663')
console.log(`  WETH ${WETH}   USDG ${USDG}\n`)

// --- resolve the factories from a live pool of each shape ------------------
const v2f = await call(V2_SAMPLE, SEL.factory)
const v3f = await call(V3_SAMPLE, SEL.factory)
const v2Factory = v2f.error ? null : addrFrom(v2f.result)
const v3Factory = v3f.error ? null : addrFrom(v3f.result)
console.log(`  V2-shaped factory (from ${V2_SAMPLE}): ${v2Factory ?? 'UNREADABLE'}`)
console.log(`  V3-shaped factory (from ${V3_SAMPLE}): ${v3Factory ?? 'UNREADABLE'}`)

// A pool's own token pair, for sanity.
for (const [label, p] of [['V2 sample', V2_SAMPLE], ['V3 sample', V3_SAMPLE]]) {
  const t0 = await call(p, SEL.token0)
  const t1 = await call(p, SEL.token1)
  console.log(`  ${label} pair: ${addrFrom(t0.result)} / ${addrFrom(t1.result)}`)
}

const found = []

// --- V2: getPair(WETH, USDG) ------------------------------------------------
if (v2Factory && v2Factory !== ZERO) {
  console.log(`\n  V2 getPair(WETH, USDG) on ${v2Factory}:`)
  const r = await call(v2Factory, SEL.getPair + pad(WETH) + pad(USDG))
  const pair = r.error ? null : addrFrom(r.result)
  if (!pair || pair === ZERO) {
    console.log('    0x0 - NO V2 WETH/USDG PAIR EXISTS')
  } else {
    console.log(`    ${pair}`)
    found.push(['v2', pair])
  }
}

// --- V3: getPool(WETH, USDG, fee) over the standard fee tiers ---------------
if (v3Factory && v3Factory !== ZERO) {
  console.log(`\n  V3 getPool(WETH, USDG, fee) on ${v3Factory}:`)
  for (const fee of [100, 500, 3000, 10000]) {
    const feeHex = fee.toString(16).padStart(64, '0')
    const r = await call(v3Factory, SEL.getPool + pad(WETH) + pad(USDG) + feeHex)
    const pool = r.error ? null : addrFrom(r.result)
    console.log(`    fee ${String(fee).padStart(5)}: ${!pool || pool === ZERO ? '0x0 - none' : pool}`)
    if (pool && pool !== ZERO) found.push([`v3/${fee}`, pool])
  }
}

// --- price and depth of anything found -------------------------------------
if (found.length === 0) {
  console.log('\n  RESULT: NO WETH/USDG POOL EXISTS ON EITHER FACTORY.')
} else {
  console.log('\n  PRICE AND DEPTH OF EACH POOL FOUND')
  for (const [kind, pool] of found) {
    const t0r = await call(pool, SEL.token0)
    const t0 = addrFrom(t0r.result)
    const wethIs0 = t0 === WETH
    // Depth: read the two ERC-20 balances the pool actually holds. This works
    // for both shapes and does not depend on getting the tick math right.
    const wb = await call(WETH, SEL.balanceOf + pad(pool))
    const ub = await call(USDG, SEL.balanceOf + pad(pool))
    const wethBal = wb.result && wb.result !== '0x' ? BigInt(wb.result) : 0n
    const usdgBal = ub.result && ub.result !== '0x' ? BigInt(ub.result) : 0n
    const wethUnits = Number(wethBal / 10n ** 12n) / 1e6
    const usdgUnits = Number(usdgBal) / 1e6
    console.log(`\n    ${kind}  ${pool}`)
    console.log(`      token0 = ${t0}  (WETH is token${wethIs0 ? '0' : '1'})`)
    console.log(`      holds  ${wethUnits.toFixed(4)} WETH and ${usdgUnits.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDG`)
    if (wethUnits > 0) {
      console.log(`      balance-ratio implied price: $${(usdgUnits / wethUnits).toFixed(2)} per WETH  (a V2 spot price; for a V3 pool this is NOT the marginal price)`)
    }
    if (kind.startsWith('v3')) {
      const s0 = await call(pool, SEL.slot0)
      const liq = await call(pool, SEL.liquidity)
      if (!s0.error && s0.result && s0.result !== '0x') {
        const sqrtPriceX96 = BigInt(word(s0.result, 0))
        if (sqrtPriceX96 > 0n) {
          // price of token0 in token1, adjusted for the 18/6 decimal gap.
          const q = Number(sqrtPriceX96) / 2 ** 96
          const raw = q * q // token1 per token0, in minor units
          const price = wethIs0 ? raw * 10 ** (18 - 6) : (1 / raw) * 10 ** (18 - 6)
          console.log(`      slot0 sqrtPriceX96 = ${sqrtPriceX96}`)
          console.log(`      MARGINAL PRICE FROM slot0: $${price.toFixed(2)} per WETH`)
        }
      }
      if (!liq.error && liq.result && liq.result !== '0x') {
        console.log(`      in-range liquidity = ${BigInt(liq.result)}`)
      }
    }
  }
}

console.log(`\n  rpc calls used: ${calls}`)

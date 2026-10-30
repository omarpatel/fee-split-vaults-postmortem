/**
 * Does chain 4663 carry a WETH/USDG (or native-ETH/USDG) pool that could serve
 * as a SELF-CONSISTENT, on-chain ETH price oracle for this toolkit?
 *
 * Reconnaissance only. Reads nothing but public view functions and logs, writes
 * nothing, and reports what it finds rather than what it hoped to find. A pool
 * that is not found is reported as NOT FOUND, never as a zero price.
 *
 *   node tools/artifacts/probe-usdg-pool.mjs
 */

const RPC = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'.toLowerCase()

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
const V2_SYNC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

const SEL = {
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  getReserves: '0x0902f1ac',
  slot0: '0x3850c7bd',
  factory: '0xc45a0155',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  balanceOf: '0x70a08231',
}

let id = 0
let calls = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rpc(method, params) {
  // VENUE_HTTP_RPS is 0.8 on this endpoint; pace conservatively and stay well
  // inside it. A throttled probe that lies is worse than a slow one.
  await sleep(1200)
  calls++
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  const j = await res.json()
  if (j.error) return { error: j.error }
  return { result: j.result }
}

const pad = (a) => '0'.repeat(24) + a.replace(/^0x/, '').toLowerCase()
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest'])
const addrFrom = (hex) => (hex && hex.length >= 66 ? '0x' + hex.slice(26, 66) : null)

function decodeString(hex) {
  if (!hex || hex === '0x') return null
  const b = hex.replace(/^0x/, '')
  // Try ABI dynamic string first, then bytes32.
  if (b.length >= 128) {
    const len = parseInt(b.slice(64, 128), 16)
    if (Number.isFinite(len) && len > 0 && len <= 64) {
      const bytes = b.slice(128, 128 + len * 2)
      const s = Buffer.from(bytes, 'hex').toString('utf8')
      if (/^[\x20-\x7e]+$/.test(s)) return s
    }
  }
  const s = Buffer.from(b.slice(0, 64), 'hex').toString('utf8').replace(/\0+$/, '')
  return /^[\x20-\x7e]+$/.test(s) && s.length > 0 ? s : null
}

console.log('PROBE: is there an on-chain WETH/USDG or ETH/USDG pool on chain 4663?')
console.log(`  endpoint ${RPC}`)
console.log(`  USDG ${USDG}`)
console.log(`  WETH ${WETH}  (config/protocol.ts VENUE.contracts.weth)`)
console.log('')

const chainId = await rpc('eth_chainId', [])
const head = await rpc('eth_blockNumber', [])
console.log(`  chainId  : ${chainId.result} (${parseInt(chainId.result, 16)})`)
console.log(`  head     : ${parseInt(head.result, 16)}`)

// --- 1. Are these actually contracts, and what do they say they are? --------
for (const [name, addr] of [['USDG', USDG], ['WETH', WETH]]) {
  const code = await rpc('eth_getCode', [addr, 'latest'])
  const sym = await call(addr, SEL.symbol)
  const dec = await call(addr, SEL.decimals)
  console.log(
    `  ${name.padEnd(5)}: code ${code.result === '0x' ? 'ABSENT (not a contract)' : `${(code.result.length - 2) / 2} bytes`}` +
      `  symbol=${JSON.stringify(decodeString(sym.result))}` +
      `  decimals=${dec.result && dec.result !== '0x' ? parseInt(dec.result, 16) : 'unreadable'}`,
  )
}

// --- 2. Look for any DEX pool at all, by its canonical swap topics ----------
const headNum = parseInt(head.result, 16)
const SPAN = 2000 // ~3.4 minutes of chain at 0.101s blocks
const from = '0x' + (headNum - SPAN).toString(16)
const to = '0x' + headNum.toString(16)
console.log(`\n  scanning blocks ${headNum - SPAN}..${headNum} (${SPAN} blocks, ~${((SPAN * 0.101) / 60).toFixed(1)} min of chain)`)

for (const [label, topic] of [['UniswapV2 Swap', V2_SWAP], ['UniswapV2 Sync', V2_SYNC], ['UniswapV3 Swap', V3_SWAP]]) {
  const r = await rpc('eth_getLogs', [{ fromBlock: from, toBlock: to, topics: [topic] }])
  if (r.error) {
    console.log(`    ${label.padEnd(16)}: RPC ERROR ${r.error.message}`)
    continue
  }
  const addrs = new Set(r.result.map((l) => l.address.toLowerCase()))
  console.log(`    ${label.padEnd(16)}: ${r.result.length} logs from ${addrs.size} distinct contracts`)
  if (addrs.size > 0) console.log(`      e.g. ${[...addrs].slice(0, 5).join(', ')}`)
}

// --- 3. Who moves USDG? Any pool holding it will show up as a counterparty --
const usdgLogs = await rpc('eth_getLogs', [{ fromBlock: from, toBlock: to, address: USDG, topics: [TRANSFER] }])
if (usdgLogs.error) {
  console.log(`\n  USDG Transfer scan: RPC ERROR ${usdgLogs.error.message}`)
} else {
  const freq = new Map()
  for (const l of usdgLogs.result) {
    for (const t of [l.topics[1], l.topics[2]]) {
      const a = addrFrom(t)
      if (!a || a === '0x0000000000000000000000000000000000000000') continue
      freq.set(a, (freq.get(a) ?? 0) + 1)
    }
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  console.log(`\n  USDG Transfer logs in span: ${usdgLogs.result.length}, distinct counterparties: ${freq.size}`)
  console.log('  top USDG counterparties, and whether each looks like a two-token pool:')
  for (const [addr, n] of top) {
    const code = await rpc('eth_getCode', [addr, 'latest'])
    if (code.result === '0x') {
      console.log(`    ${addr}  x${String(n).padStart(5)}  EOA (no code)`)
      continue
    }
    const t0 = await call(addr, SEL.token0)
    const t1 = await call(addr, SEL.token1)
    const a0 = t0.error ? null : addrFrom(t0.result)
    const a1 = t1.error ? null : addrFrom(t1.result)
    if (!a0 || !a1) {
      const wethBal = await call(WETH, SEL.balanceOf + pad(addr))
      const wb = wethBal.result && wethBal.result !== '0x' ? BigInt(wethBal.result) : 0n
      console.log(
        `    ${addr}  x${String(n).padStart(5)}  contract, no token0()/token1()  ` +
          `WETH balance ${(Number(wb / 10n ** 12n) / 1e6).toFixed(4)}`,
      )
      continue
    }
    const isPair = [a0, a1].includes(USDG) && [a0, a1].some((a) => a === WETH)
    console.log(
      `    ${addr}  x${String(n).padStart(5)}  POOL token0=${a0} token1=${a1}` + (isPair ? '   <<< WETH/USDG PAIR' : ''),
    )
  }
}

console.log(`\n  rpc calls used: ${calls}`)

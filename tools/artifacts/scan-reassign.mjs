import { eventTopic as eventTopic0 } from '../lib/abi.ts'
const url = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let id = 0
async function rpc(m, p) {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: m, params: p }), signal: AbortSignal.timeout(120000) })
    if (r.status === 429) { await sleep(2000 * (a + 1)); continue }
    const j = await r.json()
    if (j.error) return { err: j.error.message }
    return { ok: j.result }
  }
  return { err: 'exhausted' }
}
const CANDS = [
  'CreatorFeeRecipientUpdated(bytes32,address,address)',
  'CreatorFeeRecipientUpdated(bytes32,address)',
  'CreatorFeeRecipientUpdated(address,address,address)',
  'CreatorFeeRecipientUpdated(address,address)',
  'CreatorFeeRecipientUpdated(bytes32,address,address,address)',
]
for (const s of CANDS) console.log(`${eventTopic0(s)}  ${s}`)
const head = BigInt((await rpc('eth_blockNumber', [])).ok)
// V2 deployed 2026-08-04; chain does ~0.101s blocks. Scan generously from well before.
const START = 40000000n
const SPAN = 2000000n
console.log(`\nscanning ${START} .. ${head} for each candidate topic0`)
for (const s of CANDS) {
  const t0 = eventTopic0(s)
  let total = 0
  const found = []
  for (let b = START; b <= head; b += SPAN) {
    const to = b + SPAN - 1n > head ? head : b + SPAN - 1n
    const r = await rpc('eth_getLogs', [{ address: HOOK, topics: [t0], fromBlock: '0x' + b.toString(16), toBlock: '0x' + to.toString(16) }])
    if (r.err) { console.log(`  [${b}..${to}] ERROR ${r.err.slice(0, 80)}`); continue }
    total += r.ok.length
    for (const l of r.ok) found.push(l)
    await sleep(300)
  }
  console.log(`${t0}  ${s.padEnd(58)} logs=${total}`)
  if (found.length) console.log('   sample:', JSON.stringify(found[0]).slice(0, 400))
}

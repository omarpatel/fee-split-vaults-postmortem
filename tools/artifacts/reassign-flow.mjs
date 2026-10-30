import { eventTopic } from '../lib/abi.ts'
import { writeFileSync } from 'node:fs'
const url = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let id = 0
async function rpc(m, p) {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: m, params: p }), signal: AbortSignal.timeout(120000) })
    if (r.status === 429) { await sleep(2000 * (a + 1)); continue }
    const j = await r.json(); if (j.error) return { err: j.error.message }; return { ok: j.result }
  }
  return { err: 'exhausted' }
}
async function batch(reqs) {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqs), signal: AbortSignal.timeout(120000) })
    if (r.status === 429) { await sleep(2000 * (a + 1)); continue }
    return await r.json()
  }
  throw new Error('exhausted')
}
const T0 = eventTopic('CreatorFeeRecipientUpdated(bytes32,address,address)')
const head = BigInt((await rpc('eth_blockNumber', [])).ok)
const events = []
for (let b = 40000000n; b <= head; b += 2000000n) {
  const to = b + 1999999n > head ? head : b + 1999999n
  const r = await rpc('eth_getLogs', [{ address: HOOK, topics: [T0], fromBlock: '0x' + b.toString(16), toBlock: '0x' + to.toString(16) }])
  if (r.err) { console.error(`ERR ${b}: ${r.err}`); continue }
  for (const l of r.ok) events.push({ pool: l.topics[1], old: '0x' + l.topics[2].slice(26), neu: '0x' + l.topics[3].slice(26), block: Number(BigInt(l.blockNumber)) })
  await sleep(250)
}
console.log(`CreatorFeeRecipientUpdated events: ${events.length}`)
const addrs = [...new Set(events.flatMap((e) => [e.old, e.neu]))]
console.log(`distinct addresses involved: ${addrs.length}`)
const code = new Map()
for (let i = 0; i < addrs.length; i += 10) {
  const s = addrs.slice(i, i + 10)
  const reqs = s.map((a) => ({ jsonrpc: '2.0', id: ++id, method: 'eth_getCode', params: [a, 'latest'] }))
  const j = await batch(reqs)
  const by = new Map(j.map((x) => [x.id, x]))
  for (let k = 0; k < s.length; k++) code.set(s[k], by.get(reqs[k].id).result)
  await sleep(300)
}
const BEACON = '15efa92a82566a360fdd3b82d81254f57d39db95'
function cls(a) {
  const c = code.get(a) ?? '0x'
  if (c === '0x') return 'EOA'
  const hex = c.slice(2)
  if (hex.startsWith('ef0100') && hex.length / 2 === 23) return 'EOA_7702'
  if (hex.includes(BEACON)) return 'VENUE_DISTRIBUTOR'
  return 'CONTRACT'
}
const flow = {}
for (const e of events) { const k = `${cls(e.old)} -> ${cls(e.neu)}`; flow[k] = (flow[k] ?? 0) + 1 }
console.log('\nREASSIGNMENT FLOW (whole chain life):')
for (const [k, n] of Object.entries(flow).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`)
const away = events.filter((e) => cls(e.old) === 'VENUE_DISTRIBUTOR')
console.log(`\nmoves AWAY from a Venue-distributor: ${away.length}`)
for (const e of away.slice(0, 10)) console.log(`   pool ${e.pool.slice(0, 12)}… ${e.old} -> ${e.neu} (${cls(e.neu)}) block ${e.block}`)
writeFileSync('tools/artifacts/reassign-flow.json', JSON.stringify({ events, flow, classes: Object.fromEntries(addrs.map((a) => [a, cls(a)])) }, null, 1))
console.log('\nwrote tools/artifacts/reassign-flow.json')

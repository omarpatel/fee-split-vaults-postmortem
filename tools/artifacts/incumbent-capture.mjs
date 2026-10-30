#!/usr/bin/env node
/**
 * incumbent-capture - the AUTHORITATIVE answer to "who holds each gate-clearing
 * coin's creator fee recipiency, right now".
 *
 * The 7-day artifact's `dom` is the dominant recipient OBSERVED in escrow
 * credits over the window. That is a historical attribution and it can be stale
 * the moment a dev re-points. The live truth lives in the hook's own
 * `launches(bytes32 poolId)` record, whose fields are (verified by decoding
 * three known pools against their independently-known creators):
 *
 *   [2] memecoin  [3] quoteToken  [4] creatorFeeRecipient (LIVE)
 *   [5] creator (original deployer)  [6] protocolFeeRecipient (PER-POOL)
 *   [7] creatorTaxBps  [8] protocolFeeShareBps  [9] buybackBurnBps
 *   [10] hookFeeBps  [11] maxInternalPriceImpactBps
 *
 * So this reads the chain, not the artifact, for the commercial question, and
 * uses the artifact only for WHICH coins clear the gate and HOW MUCH they earn.
 *
 * Classification of the live recipient is by code, not by guess: an EIP-7702
 * designator is 23 bytes on an address that is still a signable EOA; a beacon
 * proxy over the incumbent's implementation is a coin already committed.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const RPC = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044'
const A = (p) => `tools/artifacts/${p}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let id = 1

async function batch(reqs) {
  for (let a = 0; ; a++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reqs), signal: AbortSignal.timeout(120000) })
    if (r.status === 429) { const w = Math.min(30000, 1000 * 2 ** (a + 1)); process.stderr.write(`429 backoff ${w}ms\n`); await sleep(w); continue }
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  }
}

const rows = JSON.parse(readFileSync(A('t1-final-rows.json'), 'utf8'))
const poolToToken = JSON.parse(readFileSync(A('join-pool-to-token.json'), 'utf8')).poolToToken
const tokenToPools = new Map()
for (const [pool, token] of Object.entries(poolToToken)) {
  const t = token.toLowerCase()
  if (!tokenToPools.has(t)) tokenToPools.set(t, [])
  tokenToPools.get(t).push(pool)
}
console.log(`T1 coins ${rows.length}; pool->token entries ${Object.keys(poolToToken).length}`)

// --- read launches() for every pool of every T1 coin --------------------------
const jobs = []
for (const r of rows) for (const p of tokenToPools.get(r.coin) ?? []) jobs.push({ coin: r.coin, pool: p })
console.log(`pools to read: ${jobs.length}`)
const launch = new Map()
for (let i = 0; i < jobs.length; i += 10) {
  const s = jobs.slice(i, i + 10)
  const reqs = s.map((j) => ({ jsonrpc: '2.0', id: id++, method: 'eth_call', params: [{ to: HOOK, data: '0xad091230' + j.pool.slice(2) }, 'latest'] }))
  const res = await batch(reqs)
  const by = new Map(res.map((x) => [x.id, x]))
  for (let k = 0; k < s.length; k++) {
    const out = by.get(reqs[k].id)
    if (out?.error || !out?.result || out.result === '0x') continue
    const w = (n) => out.result.slice(2 + n * 64, 2 + (n + 1) * 64)
    const addr = (n) => '0x' + w(n).slice(24)
    launch.set(s[k].pool, {
      coin: s[k].coin, registered: BigInt('0x' + w(0)) === 1n, buyback: BigInt('0x' + w(1)) === 1n,
      memecoin: addr(2), quote: addr(3), creatorRecipient: addr(4), creator: addr(5),
      protocolRecipient: addr(6), creatorTaxBps: Number(BigInt('0x' + w(7))),
      protocolFeeShareBps: Number(BigInt('0x' + w(8))), buybackBurnBps: Number(BigInt('0x' + w(9))),
      hookFeeBps: Number(BigInt('0x' + w(10))),
    })
  }
  process.stderr.write(`\rlaunches ${launch.size}/${jobs.length}`)
  await sleep(300)
}
process.stderr.write('\n')

// --- classify every live recipient by CODE ------------------------------------
const addrs = [...new Set([...launch.values()].flatMap((l) => [l.creatorRecipient, l.protocolRecipient, l.creator]))]
const code = new Map()
for (let i = 0; i < addrs.length; i += 10) {
  const s = addrs.slice(i, i + 10)
  const reqs = s.map((a) => ({ jsonrpc: '2.0', id: id++, method: 'eth_getCode', params: [a, 'latest'] }))
  const res = await batch(reqs)
  const by = new Map(res.map((x) => [x.id, x]))
  for (let k = 0; k < s.length; k++) code.set(s[k], by.get(reqs[k].id)?.result ?? '0x')
  process.stderr.write(`\rcode ${code.size}/${addrs.length}`)
  await sleep(300)
}
process.stderr.write('\n')

const BEACON = '15efa92a82566a360fdd3b82d81254f57d39db95'
const CLONE = '363d3d373d3d3d363d73'
function classify(a) {
  const c = code.get(a) ?? '0x'
  if (c === '0x') return { cls: 'EOA', impl: null }
  const hex = c.slice(2)
  if (hex.startsWith('ef0100') && hex.length / 2 === 23) return { cls: 'EOA_7702', impl: '0x' + hex.slice(6, 46) }
  if (hex.includes(BEACON)) return { cls: 'INCUMBENT_DISTRIBUTOR', impl: '0x53c2eae568c4095c6972817f5fcb6141b723d920' }
  if (hex.startsWith(CLONE)) return { cls: 'CLONE_1167', impl: '0x' + hex.slice(20, 60) }
  return { cls: 'OTHER_CONTRACT', impl: null }
}

const byCoin = new Map()
for (const l of launch.values()) {
  const cur = byCoin.get(l.coin)
  if (cur === undefined) byCoin.set(l.coin, l)
}
const usd = new Map(rows.map((r) => [r.coin, r]))
const out = []
for (const [coin, l] of byCoin) {
  const c = classify(l.creatorRecipient)
  const r = usd.get(coin)
  out.push({ coin, ...l, cls: c.cls, impl: c.impl,
    protocolIsIncumbent: l.protocolRecipient.toLowerCase() === '0x3a3e6be1e8be67a4e2e7e2e815a66ba03a27f5d4',
    median7: r?.median7 ?? null, cr7: r?.cr ?? null, pr7: r?.pr ?? null })
}
const missing = rows.filter((r) => !byCoin.has(r.coin))
console.log(`\nT1 coins with a live launches() record: ${out.length}; without: ${missing.length}`)

const tally = {}
for (const o of out) tally[o.cls] = (tally[o.cls] ?? 0) + 1
console.log('\nLIVE CREATOR-FEE RECIPIENT CLASS, T1 coins')
for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`)
const protIncumbent = out.filter((o) => o.protocolIsIncumbent).length
console.log(`\nT1 coins whose PER-POOL protocol fee recipient is the incumbent: ${protIncumbent}`)
const taxes = {}
for (const o of out) taxes[o.creatorTaxBps] = (taxes[o.creatorTaxBps] ?? 0) + 1
console.log('\ncreatorTaxBps distribution:', JSON.stringify(taxes))
console.log('hookFeeBps set:', JSON.stringify([...new Set(out.map((o) => o.hookFeeBps))]))
console.log('protocolFeeShareBps set:', JSON.stringify([...new Set(out.map((o) => o.protocolFeeShareBps))]))
writeFileSync(A('incumbent-capture.json'), JSON.stringify({ readAtIso: new Date().toISOString(), tally, protIncumbent, rows: out, missing: missing.map((m) => m.coin) }, null, 1))
console.log('\nwrote tools/artifacts/incumbent-capture.json')

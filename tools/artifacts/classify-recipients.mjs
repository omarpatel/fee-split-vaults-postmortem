#!/usr/bin/env node
/**
 * classify-recipients - for a list of addresses, fetch runtime code and say what
 * each one IS, from the bytecode itself.
 *
 * The commercial question is "can this coin be signed?", and the answer turns on
 * a distinction that a naive `code.length > 0` gets WRONG in both directions:
 *
 *   - An EIP-7702 delegation designator is 23 bytes of code on an address that
 *     is still a private-key EOA. `isContract` says true; the dev is signable.
 *   - An EIP-1167 / beacon proxy is 45-321 bytes that do nothing but delegate.
 *     What matters is the IMPLEMENTATION behind it, not the proxy.
 *
 * So this resolves each address to (class, implementation) and leaves anything
 * it cannot resolve labelled UNRESOLVED rather than bucketed with a guess.
 *
 *   node tools/artifacts/classify-recipients.mjs <addrs.json> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const RPC = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const BATCH = Number(process.env.VENUE_RPC_BATCH ?? '10')
let nextId = 1

async function batchCall(reqs) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reqs),
    })
    if (r.status === 429) {
      const wait = Math.min(30_000, 1_000 * 2 ** (attempt + 1))
      process.stderr.write(`429, backing off ${wait}ms\n`)
      await new Promise((res) => setTimeout(res, wait))
      continue
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return await r.json()
  }
}

async function getCodes(addrs) {
  const out = new Map()
  for (let i = 0; i < addrs.length; i += BATCH) {
    const slice = addrs.slice(i, i + BATCH)
    const reqs = slice.map((a) => ({ jsonrpc: '2.0', id: nextId++, method: 'eth_getCode', params: [a, 'latest'] }))
    const j = await batchCall(reqs)
    const byId = new Map(j.map((x) => [x.id, x]))
    for (let k = 0; k < slice.length; k++) {
      const resp = byId.get(reqs[k].id)
      if (resp?.error) throw new Error(`getCode ${slice[k]}: ${JSON.stringify(resp.error)}`)
      out.set(slice[k], resp.result)
    }
    process.stderr.write(`\rcode ${out.size}/${addrs.length}`)
    await new Promise((res) => setTimeout(res, 300))
  }
  process.stderr.write('\n')
  return out
}

/** eth_call one selector against many addresses, batched. */
async function callMany(addrs, selector) {
  const out = new Map()
  for (let i = 0; i < addrs.length; i += BATCH) {
    const slice = addrs.slice(i, i + BATCH)
    const reqs = slice.map((a) => ({
      jsonrpc: '2.0', id: nextId++, method: 'eth_call', params: [{ to: a, data: selector }, 'latest'],
    }))
    const j = await batchCall(reqs)
    const byId = new Map(j.map((x) => [x.id, x]))
    for (let k = 0; k < slice.length; k++) {
      const resp = byId.get(reqs[k].id)
      if (resp?.error || !resp?.result || resp.result === '0x') continue
      if (resp.result.length !== 66) continue
      out.set(slice[k], '0x' + resp.result.slice(26))
    }
    await new Promise((res) => setTimeout(res, 300))
  }
  return out
}

const SEL = {
  implementation: '0x5c60da1b',
  masterCopy: '0xa619486e',
  distributorFactory: '0xb04b2ed6',
  beacon: '0x59659e90',
  owner: '0x8da5cb5b',
  escrow: '0xe2fdcc17',
}

const addrs = [...new Set(JSON.parse(readFileSync(process.argv[2], 'utf8')).map((a) => a.toLowerCase()))]
const codes = await getCodes(addrs)

const CLONE_PREFIX = '363d3d373d3d3d363d73'
const rec = {}
const needsCall = []
for (const a of addrs) {
  const code = codes.get(a)
  const hex = code === '0x' ? '' : code.slice(2)
  const size = hex.length / 2
  if (size === 0) {
    rec[a] = { class: 'EOA', codeSize: 0 }
    continue
  }
  if (hex.startsWith('ef0100') && size === 23) {
    rec[a] = { class: 'EOA_7702', codeSize: size, delegate: '0x' + hex.slice(6, 46) }
    continue
  }
  if (hex.startsWith(CLONE_PREFIX)) {
    const impl = '0x' + hex.slice(20, 60)
    const argsHex = hex.slice(20 + 40 + 30) // past the 45-byte clone body
    rec[a] = { class: 'CLONE_1167', codeSize: size, implementation: impl, immutableArgs: argsHex }
    continue
  }
  // A beacon proxy hardcodes its beacon as a PUSH32 immutable. Find any 20-byte
  // address-shaped word in the code and confirm it by CALLING implementation().
  rec[a] = { class: 'PROXY_OR_CONTRACT', codeSize: size }
  needsCall.push(a)
}

// Resolve the remainder by call. implementation() on a beacon-proxy reverts (the
// proxy delegates), so we read the beacon out of the code and call THAT.
const beaconCandidates = new Map()
for (const a of needsCall) {
  const hex = codes.get(a).slice(2)
  const found = new Set()
  for (const m of hex.matchAll(/000000000000000000000000([0-9a-f]{40})/g)) {
    if (m[1] !== '0'.repeat(40)) found.add('0x' + m[1])
  }
  beaconCandidates.set(a, [...found])
}
const allCandidates = [...new Set([...beaconCandidates.values()].flat())]
const candImpl = await callMany(allCandidates, SEL.implementation)
const candMaster = await callMany(needsCall, SEL.masterCopy)
const selfDistFactory = await callMany(needsCall, SEL.distributorFactory)
const selfEscrow = await callMany(needsCall, SEL.escrow)

for (const a of needsCall) {
  const r = rec[a]
  if (selfDistFactory.has(a)) {
    r.class = 'VENUE_DISTRIBUTOR'
    r.distributorFactory = selfDistFactory.get(a)
  }
  if (selfEscrow.has(a)) r.escrow = selfEscrow.get(a)
  const beacons = beaconCandidates.get(a).filter((c) => candImpl.has(c))
  if (beacons.length > 0) {
    r.beacon = beacons[0]
    r.implementation = candImpl.get(beacons[0])
    if (r.class === 'PROXY_OR_CONTRACT') r.class = 'BEACON_PROXY'
  }
  if (candMaster.has(a)) {
    r.class = 'SAFE_PROXY'
    r.implementation = candMaster.get(a)
  }
}

// Resolve clone implementations' identity too.
const cloneImpls = [...new Set(Object.values(rec).filter((r) => r.implementation).map((r) => r.implementation))]
const implFactory = await callMany(cloneImpls, SEL.distributorFactory)
const implOwner = await callMany(cloneImpls, SEL.owner)

const summary = {}
for (const [a, r] of Object.entries(rec)) {
  const key = `${r.class}:${r.implementation ?? r.delegate ?? '-'}`
  summary[key] = (summary[key] ?? 0) + 1
}
console.log('\nRECIPIENT CLASSES')
for (const [k, n] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
  const impl = k.split(':')[1]
  const extra = implFactory.has(impl) ? `  distributorFactory=${implFactory.get(impl)}` : implOwner.has(impl) ? `  owner=${implOwner.get(impl)}` : ''
  console.log(`  ${String(n).padStart(4)}  ${k}${extra}`)
}
writeFileSync(process.argv[3], JSON.stringify({ rec, summary, implFactory: [...implFactory], implOwner: [...implOwner] }, null, 1))
console.log(`wrote ${process.argv[3]}`)

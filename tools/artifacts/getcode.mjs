#!/usr/bin/env node
/**
 * getcode - eth_getCode over a list of addresses, batched JSON-RPC.
 *
 * The EOA/contract distinction is the whole question in item 3: an EOA recipient
 * is a dev who can be signed; a contract recipient is a coin whose fee routing
 * is already committed to somebody's product. So this reads code, it does not
 * infer from behaviour.
 *
 *   node tools/artifacts/getcode.mjs <in.json | comma list> <out.json>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const RPC = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const BATCH = Number(process.env.VENUE_RPC_BATCH ?? '10')
const arg = process.argv[2]
const outPath = process.argv[3]
const addrs = existsSync(arg)
  ? JSON.parse(readFileSync(arg, 'utf8'))
  : arg.split(',').map((s) => s.trim()).filter(Boolean)

const uniq = [...new Set(addrs.map((a) => a.toLowerCase()))]
const result = {}
let id = 1
for (let i = 0; i < uniq.length; i += BATCH) {
  const slice = uniq.slice(i, i + BATCH)
  const body = slice.map((a) => ({ jsonrpc: '2.0', id: id++, method: 'eth_getCode', params: [a, 'latest'] }))
  let attempt = 0
  for (;;) {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (r.status === 429) {
      attempt++
      const wait = Math.min(30_000, 1_000 * 2 ** attempt)
      process.stderr.write(`429, backing off ${wait}ms\n`)
      await new Promise((res) => setTimeout(res, wait))
      continue
    }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`)
    const j = await r.json()
    const byId = new Map(j.map((x) => [x.id, x]))
    for (let k = 0; k < slice.length; k++) {
      const resp = byId.get(body[k].id)
      if (resp?.error) throw new Error(`rpc error for ${slice[k]}: ${JSON.stringify(resp.error)}`)
      const code = resp.result
      result[slice[k]] = { isContract: code !== undefined && code !== '0x', codeSize: code === '0x' ? 0 : (code.length - 2) / 2 }
    }
    break
  }
  process.stderr.write(`\r${Object.keys(result).length}/${uniq.length}`)
  await new Promise((res) => setTimeout(res, 350))
}
process.stderr.write('\n')
const contracts = Object.entries(result).filter(([, v]) => v.isContract)
console.log(`addresses ${uniq.length}   contracts ${contracts.length}   EOAs ${uniq.length - contracts.length}`)
writeFileSync(outPath, JSON.stringify(result, null, 0))
console.log(`wrote ${outPath}`)

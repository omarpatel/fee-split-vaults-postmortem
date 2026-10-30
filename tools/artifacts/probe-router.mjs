#!/usr/bin/env node
/**
 * probe-router - identify the "incumbent aggregator" by CALLING it, not by
 * guessing from a code size.
 *
 * Every fact below is an eth_call return or an eth_getCode, quoted raw. Where a
 * call reverts that is reported as a revert, never as a zero.
 */
import { keccak_256 } from './keccak.mjs'

const RPC = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
let id = 1
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
  })
  const j = await r.json()
  return j
}
const sel = (sig) => '0x' + Buffer.from(keccak_256(Buffer.from(sig, 'utf8'))).toString('hex').slice(0, 8)

async function call(to, sig, argsHex = '') {
  const j = await rpc('eth_call', [{ to, data: sel(sig) + argsHex }, 'latest'])
  if (j.error) return { revert: j.error.message ?? JSON.stringify(j.error) }
  if (j.result === '0x') return { empty: true }
  return { ok: j.result }
}
const asAddr = (r) => (r.ok && r.ok.length >= 66 ? '0x' + r.ok.slice(26, 66) : null)
const asNum = (r) => (r.ok ? BigInt(r.ok.slice(0, 66)) : null)

const GETTERS = [
  'escrow()', 'memeHook()', 'launchFactory()', 'curve()', 'quoteToken()',
  'buybackVault()', 'launchLocker()', 'distributorFactory()', 'poolManager()',
  'epochCount()', 'CLAIM_WINDOW()', 'unallocatedQuote()',
  'owner()', 'implementation()', 'token()', 'memecoin()', 'creator()',
  'feeBps()', 'name()', 'version()', 'beacon()', 'admin()',
]

const targets = process.argv.slice(2)
for (const t of targets) {
  const code = (await rpc('eth_getCode', [t, 'latest'])).result
  console.log(`\n=== ${t}   codeBytes=${code === '0x' ? 0 : (code.length - 2) / 2}`)
  for (const g of GETTERS) {
    const r = await call(t, g)
    if (r.revert || r.empty) continue
    const a = asAddr(r)
    const looksAddr = a && /^0x0{0,24}[0-9a-f]{16,40}$/.test(a) && r.ok.length === 66
    console.log(`  ${g.padEnd(22)} ${looksAddr ? a : r.ok.slice(0, 80)}${r.ok.length > 80 ? '…' : ''}${looksAddr ? '' : `   (uint ${asNum(r)})`}`)
    await new Promise((res) => setTimeout(res, 120))
  }
}

/**
 * Who controls the V2 contracts, and is that the same address as the
 * "unidentified aggregator" the 7-day verdict named its largest single risk?
 *
 * Read-only eth_call at `latest`. The node keeps only ~10 minutes of historical
 * state (measured: 6,182 blocks), so this is a CURRENT reading, not a
 * deployment-time one.
 */
import { functionSelector } from '../lib/abi.ts'
const url = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let id = 0
async function rpc(method, params) {
  for (let a = 0; a < 8; a++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(60000) })
    if (r.status === 429) { await sleep(2000 * (a + 1)); continue }
    const j = await r.json()
    if (j.error) return { err: j.error.message }
    return { ok: j.result }
  }
  return { err: 'exhausted' }
}
const sel = (sig) => functionSelector(sig)
const C = {
  'V2 Factory': '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  'V2 Meme Hook': '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
  'V2 Buyback Vault': '0x42df2a798f82289E177311362e8f5ccC45c1219c',
  'V2 Fee Escrow': '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
  'same-block deploy A': '0xce38c38a030935d024f4dd9bc3d896717eacbae8',
  'same-block deploy B': '0xd43dbfc407f194f23b97008a6372f36763ab9328',
}
const SIGS = ['owner()', 'treasury()', 'protocolFeeRecipient()', 'feeRecipient()', 'defaultFeeRecipient()', 'defaultRecipient()', 'escrow()', 'feeEscrow()', 'hook()', 'factory()', 'buybackVault()', 'pendingOwner()', 'admin()']
const AGG = '0x3a3e6be1e8be67a4e2e7e2e815a66ba03a27f5d4'
const PROTO = '0x263ed295'
const out = {}
console.log(`aggregator ${AGG}`)
const code = (await rpc('eth_getCode', [AGG, 'latest'])).ok
console.log(`  eth_getCode -> ${code === '0x' ? 'EOA (no code)' : `${(code.length - 2) / 2} bytes of code`}`)
for (const [name, addr] of Object.entries(C)) {
  const hits = []
  for (const s of SIGS) {
    const r = await rpc('eth_call', [{ to: addr, data: sel(s) }, 'latest'])
    if (r.ok && r.ok.length === 66) {
      const a = `0x${r.ok.slice(26)}`
      if (/^0x0{40}$/.test(a)) continue
      const tag = a.toLowerCase() === AGG ? '   <<< THE AGGREGATOR / DEPLOYER' : a.toLowerCase().startsWith(PROTO) ? '   <<< protocol fee recipient' : ''
      hits.push({ sig: s, value: a, tag })
    }
    await sleep(120)
  }
  out[name] = { address: addr, getters: hits }
  console.log(`\n${name}  ${addr}`)
  if (hits.length === 0) console.log('    (no standard getter answered)')
  for (const h of hits) console.log(`    ${h.sig.padEnd(24)} -> ${h.value}${h.tag}`)
}
import { writeFileSync } from 'node:fs'
writeFileSync('tools/artifacts/full/owner-probe.json', `${JSON.stringify({ aggregator: AGG, aggregatorCode: code, contracts: out, readAtIso: new Date().toISOString() }, null, 2)}\n`)

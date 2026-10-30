import { functionSelector } from '../lib/abi.ts'
const url = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let id = 0
async function rpc(method, params) {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(60000) })
    if (r.status === 429) { await sleep(2000 * (a + 1)); continue }
    const j = await r.json()
    if (j.error) return { err: j.error.message }
    return { ok: j.result }
  }
  return { err: 'exhausted' }
}
const SIGS = ['distributorFactory()','escrow()','quoteToken()','memeHook()','launchFactory()','curve()',
  'buybackVault()','poolManager()','launchLocker()','epochCount()','CLAIM_WINDOW()','unallocatedQuote()',
  'owner()','token()','memecoin()','creator()','implementation()','asset()','stakingToken()','rewardToken()']
const IMPL_SLOT='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ADMIN_SLOT='0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'
const targets = process.argv.slice(2)
for (const t of targets) {
  const code = (await rpc('eth_getCode',[t,'latest'])).ok
  console.log(`\n=== ${t}  code=${code==='0x'?0:(code.length-2)/2} bytes`)
  const impl = (await rpc('eth_getStorageAt',[t,IMPL_SLOT,'latest'])).ok
  const adm  = (await rpc('eth_getStorageAt',[t,ADMIN_SLOT,'latest'])).ok
  if (impl && !/^0x0+$/.test(impl)) console.log(`  [1967 impl slot]      0x${impl.slice(26)}`)
  if (adm  && !/^0x0+$/.test(adm))  console.log(`  [1967 admin slot]     0x${adm.slice(26)}`)
  for (const s of SIGS) {
    const r = await rpc('eth_call',[{to:t,data:functionSelector(s)},'latest'])
    if (!r.ok || r.ok==='0x') continue
    const w = r.ok.slice(0,66)
    const asAddr = '0x'+w.slice(26)
    const n = BigInt(w)
    const isAddr = /^0x0{24}[0-9a-f]{40}$/.test(w) && n !== 0n
    console.log(`  ${s.padEnd(22)} ${isAddr?asAddr:n.toString()}${r.ok.length>66?'  (+more)':''}`)
    await sleep(100)
  }
}

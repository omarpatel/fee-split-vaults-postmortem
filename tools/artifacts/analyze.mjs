import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('tools/artifacts/escrow-1d-erc20.json','utf8'))
const r = j.result
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'

const byAsset = new Map()
for (const rec of r.recipients) {
  for (const [asset, amt] of Object.entries(rec.totalByAssetMinor ?? {})) {
    const a = asset.toLowerCase()
    const cur = byAsset.get(a) ?? { minor: 0n, holders: 0 }
    cur.minor += BigInt(amt); cur.holders += 1
    byAsset.set(a, cur)
  }
}
console.log('distinct assets:', byAsset.size)
console.log('WETH present as a credit asset?', byAsset.has(WETH) ? 'YES' : 'NO')
if (byAsset.has(WETH)) {
  const w = byAsset.get(WETH)
  console.log('  WETH total minor:', w.minor.toString(), '| recipients:', w.holders)
  console.log('  WETH as ether:', Number(w.minor) / 1e18)
}
console.log('')
console.log('Top 12 assets by recipient count:')
const rows = [...byAsset.entries()].sort((a,b)=>b[1].holders-a[1].holders).slice(0,12)
for (const [a, v] of rows) {
  const dec = r.assetDecimals?.[a] ?? r.assetDecimals?.[a.toLowerCase()]
  const sym = r.assetSymbols?.[a] ?? r.assetSymbols?.[a.toLowerCase()] ?? '?'
  const human = dec != null ? (Number(v.minor) / 10 ** Number(dec)).toExponential(3) : 'dec?'
  console.log(`  ${a} ${String(sym).padEnd(10)} recipients=${String(v.holders).padStart(5)} total=${human}`)
}
console.log('')
const counts = r.recipients.map(x => Object.keys(x.totalByAssetMinor ?? {}).length)
console.log('recipients:', r.recipients.length)
console.log('  with 1 asset:', counts.filter(c=>c===1).length)
console.log('  with >1 asset:', counts.filter(c=>c>1).length)
const act = r.recipients.map(x=>x.activeDays)
console.log('  active 1 day:', act.filter(a=>a===1).length, '| active 2 days:', act.filter(a=>a===2).length)

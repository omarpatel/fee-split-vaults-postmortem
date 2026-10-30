import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('tools/artifacts/escrow-2d-native.json','utf8'))
const r = j.result
console.log('days sample:', JSON.stringify(r.recipients[0].days).slice(0,400))
console.log('')
const ETH_USD = 3200
// Every native Credited is ETH (18 dec). The tool keyed by depositor, not asset,
// so sum across all keys per day.
function dayTotals(rec) {
  const out = new Map()
  const d = rec.days
  if (Array.isArray(d)) {
    for (const e of d) {
      const day = e.day ?? e.dayUnix ?? e.date
      let sum = 0n
      const by = e.byAssetMinor ?? e.byAsset ?? null
      if (by) for (const v of Object.values(by)) sum += BigInt(v)
      else if (e.minor != null) sum = BigInt(e.minor)
      out.set(day, (out.get(day) ?? 0n) + sum)
    }
  }
  return out
}
const t0 = dayTotals(r.recipients[0])
console.log('parsed day buckets for sample:', [...t0.entries()].map(([k,v])=>`${k}=${Number(v)/1e18}`).join('  '))

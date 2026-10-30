import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('tools/artifacts/escrow-2d-native.json','utf8'))
const r = j.result
const ETH_USD = 3200

const perDay = new Map()   // dayUnix -> Map(recipient -> wei)
for (const rec of r.recipients) {
  for (const e of rec.days ?? []) {
    let sum = 0n
    for (const v of Object.values(e.byAssetMinor ?? {})) sum += BigInt(v)
    if (!perDay.has(e.dayUnix)) perDay.set(e.dayUnix, new Map())
    perDay.get(e.dayUnix).set(rec.recipient, sum)
  }
}
const days = [...perDay.keys()].sort()
console.log('Days observed (last is PARTIAL, excluded from gate counts):')
for (const d of days) {
  const m = perDay.get(d)
  let tot = 0n
  for (const v of m.values()) tot += v
  const usd = Number(tot) / 1e18 * ETH_USD
  console.log(`  ${new Date(d*1000).toISOString().slice(0,10)}  recipients=${String(m.size).padStart(6)}  totalETH=${(Number(tot)/1e18).toFixed(1).padStart(9)}  ~$${(usd/1e6).toFixed(2)}M`)
}
const complete = days.slice(0, -1)
console.log('')
console.log(`Gate counts over ${complete.length} COMPLETE day(s), ETH @ $${ETH_USD}:`)
const GATES = [[1000,'T1 $1,000/day'],[2500,'T2 $2,500/day'],[20000,'T3 $20,000/day']]
for (const [gate, label] of GATES) {
  const everCounts = new Set(), allDayCounts = new Map()
  for (const d of complete) {
    for (const [who, wei] of perDay.get(d)) {
      const usd = Number(wei) / 1e18 * ETH_USD
      if (usd >= gate) { everCounts.add(who); allDayCounts.set(who, (allDayCounts.get(who) ?? 0) + 1) }
    }
  }
  const everyDay = [...allDayCounts.values()].filter(c => c === complete.length).length
  console.log(`  ${label.padEnd(16)} ever >= gate: ${String(everCounts.size).padStart(5)}   >= gate on ALL ${complete.length} days: ${everyDay}`)
}
console.log('')
const d0 = perDay.get(complete[0])
const sorted = [...d0.entries()].map(([w,v]) => [w, Number(v)/1e18*ETH_USD]).sort((a,b)=>b[1]-a[1])
console.log(`Distribution on ${new Date(complete[0]*1000).toISOString().slice(0,10)} (${sorted.length} recipients):`)
for (const p of [0,4,9,49,99,499,999]) if (p < sorted.length) console.log(`  rank ${String(p+1).padStart(5)}: $${sorted[p][1].toFixed(2)}/day`)
const median = sorted[Math.floor(sorted.length/2)]
console.log(`  median      : $${median[1].toFixed(4)}/day`)
console.log(`  above $1000 : ${sorted.filter(x=>x[1]>=1000).length}`)
console.log(`  above $100  : ${sorted.filter(x=>x[1]>=100).length}`)
console.log(`  above $10   : ${sorted.filter(x=>x[1]>=10).length}`)

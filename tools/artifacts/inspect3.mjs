import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('tools/artifacts/escrow-2d-native.json','utf8'))
const r = j.result
const rec = r.recipients[0]
console.log('recipient field names:', Object.keys(rec).join(', '))
const daily = rec.dailyByAssetMinor ?? rec.daily ?? rec.dailyMinor ?? null
console.log('has daily series?', daily ? 'YES -> ' + JSON.stringify(daily).slice(0,300) : 'NO')
console.log('window days:', r.windowDays, '| start', new Date(r.windowStartDayUnix*1000).toISOString().slice(0,10), '-> end', new Date(r.windowEndDayUnix*1000).toISOString().slice(0,10))
console.log('recipients:', r.recipients.length, '| credits:', r.totalCredits)

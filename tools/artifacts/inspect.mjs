import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('tools/artifacts/escrow-1d-erc20.json', 'utf8'))
console.log('top-level keys:', Object.keys(j).join(', '))
const r = j.result ?? j
console.log('result keys:', Object.keys(r).join(', '))
for (const k of Object.keys(r)) {
  const v = r[k]
  if (Array.isArray(v)) console.log(`  ${k}: array[${v.length}]`, v.length ? '| sample: ' + JSON.stringify(v[0]).slice(0,300) : '')
  else if (v && typeof v === 'object') console.log(`  ${k}: object{${Object.keys(v).slice(0,8).join(',')}}`)
  else console.log(`  ${k}:`, v)
}

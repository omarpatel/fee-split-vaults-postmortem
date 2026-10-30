import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('tools/artifacts/escrow-2d-native.json','utf8'))
const r = j.result
console.log('unpricedAssets:', JSON.stringify(r.unpricedAssets))
console.log('priceUsdByAsset:', JSON.stringify(r.priceUsdByAsset))
console.log('assetDecimals:', JSON.stringify(r.assetDecimals))
console.log('assetSymbols:', JSON.stringify(r.assetSymbols))
console.log('recipients:', r.recipients.length, '| totalCredits:', r.totalCredits)
console.log('sample recipient:', JSON.stringify(r.recipients[0]).slice(0,400))

#!/usr/bin/env node
/**
 * extract-depositors-from-cache - recover the DEPOSITOR side of the 7-day
 * measurement without re-reading the chain.
 *
 * escrow-index projects credits to (recipient, asset, day) and discards the
 * depositor, which is exactly the field per-coin attribution needs: for the
 * pre-graduation fee path the depositor IS the coin's bonding curve, 1:1 with
 * the token via the factory's TokenLaunched. The raw eth_getLogs results are
 * still on disk under tools/.cache, so the whole window can be re-projected
 * offline.
 *
 * COMPLETENESS IS CHECKED, NOT ASSUMED. A cache is allowed to be partial - an
 * evicted chunk would silently shorten the window and produce a confident
 * undercount, which is the same class of defect as the checkpoint bug that
 * reported zero credits as a success. The reconstructed credit count is
 * compared against the published 1,312,335 and the run FAILS if they differ.
 */

import { readdir, readFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CACHE = process.env.VENUE_CACHE_DIR ?? fileURLToPath(new URL('../.cache', import.meta.url))
const ESCROW = '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e'
const CREDITED = '0x4e45da441832cf53bdaa69235704fc0575e68210f459ee1562911024b12967d5'
const CREDITED_TOKEN = '0x5d104c62f50449fadfe6f4013c8f36588d32737f94b5ac9b83ddad33b3e1ffdf'

const FROM = 50419076n
const TO = 56389048n
/** The published figure this reconstruction must reproduce exactly. */
const EXPECTED_CREDITS = 1_312_335
const EXPECTED_RECIPIENTS = 117_951

const addrOf = (t) => '0x' + t.slice(26).toLowerCase()

const dirs = await readdir(CACHE)
let files = 0
let entries = 0

// Dedupe key is (block, txHash, logIndex): overlapping windows from earlier
// 1-day and 2-day runs share cache entries with the 7-day run.
const seen = new Set()
const credits = [] // packed rows, kept small: 1.3M of them

let scanned = 0
for (const d of dirs) {
  let names
  try {
    names = await readdir(join(CACHE, d))
  } catch {
    continue
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    files++
    let raw
    try {
      raw = await readFile(join(CACHE, d, name), 'utf8')
    } catch {
      continue
    }
    if (!raw.includes(ESCROW)) continue
    let entry
    try {
      entry = JSON.parse(raw)
    } catch {
      continue
    }
    if (entry.schemaVersion !== 'logscan-1' || !Array.isArray(entry.value)) continue
    entries++
    for (const log of entry.value) {
      if ((log.address ?? '').toLowerCase() !== ESCROW) continue
      const t0 = (log.topics?.[0] ?? '').toLowerCase()
      const isToken = t0 === CREDITED_TOKEN
      if (!isToken && t0 !== CREDITED) continue
      // blockNumber is serialised as a tagged bigint by lib/json.ts
      const bn = BigInt(typeof log.blockNumber === 'object' ? log.blockNumber.$bigint : log.blockNumber)
      if (bn < FROM || bn > TO) continue
      const key = `${log.transactionHash}:${log.logIndex}`
      if (seen.has(key)) continue
      seen.add(key)
      credits.push({
        b: Number(bn),
        r: addrOf(log.topics[1]),
        a: isToken ? addrOf(log.topics[2]) : '0x0000000000000000000000000000000000000000',
        d: addrOf(isToken ? log.topics[3] : log.topics[2]),
        v: BigInt(log.data).toString(),
        t: log.transactionHash,
        // Needed to attribute a BATCHED hook sweep: the hook emits its escrow
        // credits before PoolFeesSwept, so within a transaction the credits
        // belong to the next sweep at a higher logIndex, not to the last one.
        i: Number(log.logIndex),
      })
      scanned++
    }
  }
  process.stderr.write(`  dir ${d}: files ${files} escrowEntries ${entries} credits ${scanned}\r`)
}
process.stderr.write('\n')

console.log(`cache files read      ${files}`)
console.log(`escrow log entries    ${entries}`)
console.log(`credits in window     ${credits.length}`)

const recipients = new Set(credits.map((c) => c.r))
const depositors = new Set(credits.map((c) => c.d))
const assets = new Set(credits.map((c) => c.a))
console.log(`distinct recipients   ${recipients.size}`)
console.log(`distinct depositors   ${depositors.size}`)
console.log(`distinct assets       ${assets.size}`)

// --- the completeness gate -------------------------------------------------
const creditsOk = credits.length === EXPECTED_CREDITS
const recipientsOk = recipients.size === EXPECTED_RECIPIENTS
console.log('')
console.log(`RECONSTRUCTION CHECK  credits ${credits.length} vs published ${EXPECTED_CREDITS}: ${creditsOk ? 'EXACT' : 'MISMATCH'}`)
console.log(`RECONSTRUCTION CHECK  recipients ${recipients.size} vs published ${EXPECTED_RECIPIENTS}: ${recipientsOk ? 'EXACT' : 'MISMATCH'}`)
if (!creditsOk || !recipientsOk) {
  console.error('')
  console.error('REFUSING to emit an attribution input from an incomplete reconstruction.')
  console.error('A short cache would produce a confident UNDERCOUNT of coins above each gate,')
  console.error('which is worse than no answer. Re-run the escrow scan to repopulate the cache.')
  process.exit(3)
}

const out = process.env.OUT ?? 'tools/artifacts/credits-7d-with-depositor.ndjson'
const chunks = []
for (const c of credits) chunks.push(`${c.b}\t${c.r}\t${c.a}\t${c.d}\t${c.v}\t${c.t}\t${c.i}\n`)
writeFileSync(out, chunks.join(''))
console.log(`\nwrote ${out}  (${credits.length} rows: block, recipient, asset, depositor, amount, txHash, logIndex)`)

writeFileSync(
  (process.env.OUT ?? 'tools/artifacts/credits-7d-with-depositor.ndjson').replace(/\.ndjson$/, '-depositors.json'),
  JSON.stringify([...depositors], null, 0),
)

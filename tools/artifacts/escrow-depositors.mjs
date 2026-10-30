#!/usr/bin/env node
/**
 * escrow-depositors - WHO actually pays into the fee escrow?
 *
 * The per-coin attribution plan assumed a single fee path: the V2 meme hook
 * sweeps a pool and credits the escrow, so PoolFeesSwept -> poolId -> token
 * recovers the coin. A one-block sample of the escrow shows the depositor on
 * Credited is NOT the hook, so that assumption needs testing before any join is
 * built on it.
 *
 * This tallies the indexed `depositor` topic across both credit events over a
 * window. If one address dominates, the hook story is wrong but the join is
 * still easy. If thousands of distinct depositors appear, each is probably a
 * per-token contract and the depositor IS the coin identifier - which would
 * make per-coin attribution possible without any pool join at all.
 *
 * Usage: node tools/artifacts/escrow-depositors.mjs <blocks-back> [chunk]
 */

const RPC = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const RPS = Number(process.env.VENUE_HTTP_RPS ?? '0.8')
const ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e'
const CREDITED = '0x4e45da441832cf53bdaa69235704fc0575e68210f459ee1562911024b12967d5'
const CREDITED_TOKEN = '0x5d104c62f50449fadfe6f4013c8f36588d32737f94b5ac9b83ddad33b3e1ffdf'

let lastCall = 0
async function throttle() {
  const wait = lastCall + 1000 / RPS - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastCall = Date.now()
}

async function rpc(method, params, tries = 6) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    await throttle()
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(90_000),
      })
      const j = await res.json()
      if (j.error) {
        const msg = JSON.stringify(j.error)
        if (/exceeds limit|timed out|too large/i.test(msg)) throw Object.assign(new Error(msg), { fatal: true })
        throw new Error(msg)
      }
      return j.result
    } catch (e) {
      if (e.fatal) throw e
      lastErr = e
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
    }
  }
  throw lastErr
}

const hex = (n) => '0x' + BigInt(n).toString(16)
const addrOf = (topic) => '0x' + topic.slice(26).toLowerCase()

async function getLogs(from, to, chunk) {
  const out = []
  let cursor = from
  while (cursor <= to) {
    let span = BigInt(chunk)
    for (;;) {
      const end = cursor + span - 1n > to ? to : cursor + span - 1n
      try {
        const logs = await rpc('eth_getLogs', [
          { address: ESCROW, fromBlock: hex(cursor), toBlock: hex(end), topics: [[CREDITED, CREDITED_TOKEN]] },
        ])
        out.push(...logs)
        process.stderr.write(`  ${cursor}-${end}: ${logs.length} (running ${out.length})\n`)
        cursor = end + 1n
        break
      } catch (e) {
        if (span <= 25n) throw new Error(`irreducible at ${cursor}: ${e.message}`)
        span /= 2n
        process.stderr.write(`  narrowing to ${span} (${e.message.slice(0, 70)})\n`)
      }
    }
  }
  return out
}

const blocksBack = BigInt(process.argv[2] ?? '20000')
const chunk = Number(process.argv[3] ?? '5000')

const latest = BigInt(await rpc('eth_blockNumber', []))
const to = latest - 20n
const from = to - blocksBack + 1n
console.log(`escrow ${ESCROW}`)
console.log(`window ${from}..${to} (${blocksBack} blocks)`)

const logs = await getLogs(from, to, chunk)
console.log(`credits ${logs.length}`)

const byDepositor = new Map()
const byRecipient = new Set()
let native = 0
for (const log of logs) {
  const isToken = log.topics[0].toLowerCase() === CREDITED_TOKEN
  const recipient = addrOf(log.topics[1])
  const depositor = addrOf(isToken ? log.topics[3] : log.topics[2])
  const asset = isToken ? addrOf(log.topics[2]) : '0x0000000000000000000000000000000000000000'
  if (!isToken) native++
  byRecipient.add(recipient)
  let e = byDepositor.get(depositor)
  if (!e) {
    e = { depositor, credits: 0, native: 0, token: 0, recipients: new Set(), assets: new Set(), nativeWei: 0n }
    byDepositor.set(depositor, e)
  }
  e.credits++
  if (isToken) e.token++
  else {
    e.native++
    e.nativeWei += BigInt(log.data)
  }
  e.recipients.add(recipient)
  e.assets.add(asset)
}

console.log(`  native ${native}   token ${logs.length - native}`)
console.log(`  distinct recipients ${byRecipient.size}`)
console.log(`  distinct DEPOSITORS ${byDepositor.size}`)
console.log('')

const rows = [...byDepositor.values()].sort((a, b) => b.credits - a.credits)
console.log('top depositors by credit count')
console.log('  depositor                                    credits   native    token  recips  assets   nativeETH')
for (const r of rows.slice(0, 25)) {
  console.log(
    `  ${r.depositor}  ${String(r.credits).padStart(8)} ${String(r.native).padStart(8)} ${String(r.token).padStart(8)} ` +
      `${String(r.recipients.size).padStart(7)} ${String(r.assets.size).padStart(7)}   ${(Number(r.nativeWei) / 1e18).toFixed(6)}`,
  )
}
console.log('')

// Shape of the depositor distribution: is it one address or a per-token swarm?
const counts = rows.map((r) => r.credits)
const total = counts.reduce((a, b) => a + b, 0)
let acc = 0
const sharesAt = {}
for (const k of [1, 5, 10, 50, 100, 500]) {
  acc = counts.slice(0, k).reduce((a, b) => a + b, 0)
  sharesAt[k] = total > 0 ? acc / total : 0
}
console.log('concentration of credits by depositor')
for (const [k, v] of Object.entries(sharesAt)) console.log(`  top ${k.padStart(3)}: ${(v * 100).toFixed(2)}%`)
console.log(`  depositors with exactly 1 credit: ${rows.filter((r) => r.credits === 1).length}`)
console.log(`  depositors serving exactly 1 recipient: ${rows.filter((r) => r.recipients.size === 1).length}`)

if (process.env.OUT) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    process.env.OUT,
    JSON.stringify(
      {
        escrow: ESCROW,
        fromBlock: from.toString(),
        toBlock: to.toString(),
        credits: logs.length,
        nativeCredits: native,
        distinctRecipients: byRecipient.size,
        distinctDepositors: byDepositor.size,
        depositors: rows.map((r) => ({
          depositor: r.depositor,
          credits: r.credits,
          native: r.native,
          token: r.token,
          recipients: r.recipients.size,
          assets: r.assets.size,
          nativeWei: r.nativeWei.toString(),
          recipientList: r.recipients.size <= 5 ? [...r.recipients] : undefined,
        })),
      },
      null,
      2,
    ),
  )
  console.log(`wrote ${process.env.OUT}`)
}

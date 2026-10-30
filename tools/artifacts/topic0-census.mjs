#!/usr/bin/env node
/**
 * topic0-census - what does a contract ACTUALLY emit?
 *
 * The escrow's two credit events were established this way rather than assumed,
 * and the exercise paid for itself: one of the four originally-inferred
 * signatures (CurveBuy) turned out not to exist on this chain at all. The
 * PoolFeesSwept and TokenLaunched defaults shipped in pool-fees-index.ts are
 * INFERRED from a Phase 0 note and have never been checked against a log.
 *
 * This asks the chain directly: pull every log an address emitted over a window
 * with NO topic filter, and tally by topic0 with the shape that constrains the
 * signature - topic count (= indexed params + 1) and data word count
 * (= non-indexed static params). A candidate signature that does not match both
 * is refuted without needing the source.
 *
 * Usage:
 *   node tools/artifacts/topic0-census.mjs <address> <blocks-back> [chunk]
 */

const RPC = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const RPS = Number(process.env.VENUE_HTTP_RPS ?? '0.8')

let lastCall = 0
async function throttle() {
  const minGap = 1000 / RPS
  const wait = lastCall + minGap - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastCall = Date.now()
}

async function rpc(method, params, tries = 6) {
  let lastErr
  for (let attempt = 0; attempt < tries; attempt++) {
    await throttle()
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(60_000),
      })
      const j = await res.json()
      if (j.error) {
        const msg = JSON.stringify(j.error)
        // Server-side query limits are the caller's problem, not a retry case.
        if (/exceeds limit|timed out|too large/i.test(msg)) throw Object.assign(new Error(msg), { fatal: true })
        throw new Error(msg)
      }
      return j.result
    } catch (e) {
      if (e.fatal) throw e
      lastErr = e
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  throw lastErr
}

const hex = (n) => '0x' + BigInt(n).toString(16)

/** Pull logs over [from,to], halving on any server-side limit. */
async function getLogs(address, from, to, chunk, onProgress) {
  const out = []
  let cursor = from
  while (cursor <= to) {
    let span = BigInt(chunk)
    for (;;) {
      const end = cursor + span - 1n > to ? to : cursor + span - 1n
      try {
        const logs = await rpc('eth_getLogs', [
          { address, fromBlock: hex(cursor), toBlock: hex(end) },
        ])
        out.push(...logs)
        onProgress?.(cursor, end, logs.length, out.length)
        cursor = end + 1n
        break
      } catch (e) {
        if (span <= 25n) throw new Error(`irreducible failure at ${cursor}: ${e.message}`)
        span = span / 2n
        process.stderr.write(`  narrowing to ${span} blocks (${e.message.slice(0, 80)})\n`)
      }
    }
  }
  return out
}

const [address, blocksBackArg, chunkArg] = process.argv.slice(2)
if (!address) {
  console.error('usage: topic0-census.mjs <address> <blocks-back> [chunk]')
  process.exit(2)
}
const blocksBack = BigInt(blocksBackArg ?? '2000')
const chunk = Number(chunkArg ?? '1000')

const latestHex = await rpc('eth_blockNumber', [])
const latest = BigInt(latestHex)
const to = latest - 20n // stay clear of any reorg-y tip
const from = to - blocksBack + 1n

console.log(`address   ${address}`)
console.log(`window    ${from} .. ${to}  (${blocksBack} blocks, chunk ${chunk})`)

const logs = await getLogs(address, from, to, chunk, (a, b, n, total) =>
  process.stderr.write(`  ${a}-${b}: ${n} logs (running ${total})\n`),
)

console.log(`logs      ${logs.length}  (${(Number(logs.length) / Number(blocksBack)).toFixed(3)} logs/block)`)
console.log('')

const byTopic0 = new Map()
for (const log of logs) {
  const t0 = (log.topics?.[0] ?? '<anonymous>').toLowerCase()
  const dataBytes = (log.data ?? '0x').length / 2 - 1
  const key = t0
  let e = byTopic0.get(key)
  if (!e) {
    e = { topic0: t0, count: 0, topicCounts: new Map(), dataWords: new Map(), sample: null, blocks: new Set() }
    byTopic0.set(key, e)
  }
  e.count++
  e.topicCounts.set(log.topics.length, (e.topicCounts.get(log.topics.length) ?? 0) + 1)
  const words = dataBytes / 32
  e.dataWords.set(words, (e.dataWords.get(words) ?? 0) + 1)
  e.blocks.add(log.blockNumber)
  if (!e.sample) e.sample = log
}

const rows = [...byTopic0.values()].sort((a, b) => b.count - a.count)
const fmtMap = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join(' ')

console.log('topic0 census, most frequent first')
console.log('')
for (const r of rows) {
  console.log(`${r.topic0}`)
  console.log(`   count ${r.count}   topics ${fmtMap(r.topicCounts)}   dataWords ${fmtMap(r.dataWords)}   blocks ${r.blocks.size}`)
  console.log(`   sample tx ${r.sample.transactionHash} block ${BigInt(r.sample.blockNumber)}`)
  for (let i = 1; i < r.sample.topics.length; i++) console.log(`     topic${i} ${r.sample.topics[i]}`)
  const d = r.sample.data.slice(2)
  for (let i = 0; i * 64 < d.length; i++) {
    const w = d.slice(i * 64, i * 64 + 64)
    console.log(`     data${i}  0x${w}   = ${BigInt('0x' + w).toString()}`)
  }
  console.log('')
}

if (process.env.CENSUS_OUT) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    process.env.CENSUS_OUT,
    JSON.stringify(
      {
        address,
        fromBlock: from.toString(),
        toBlock: to.toString(),
        logs: logs.length,
        topics: rows.map((r) => ({
          topic0: r.topic0,
          count: r.count,
          topicCounts: Object.fromEntries(r.topicCounts),
          dataWords: Object.fromEntries(r.dataWords),
          distinctBlocks: r.blocks.size,
          sample: r.sample,
        })),
      },
      null,
      2,
    ),
  )
  console.log(`wrote ${process.env.CENSUS_OUT}`)
}

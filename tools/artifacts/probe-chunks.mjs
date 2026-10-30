#!/usr/bin/env node
/**
 * probe-chunks - measure the usable eth_getLogs span for the JOIN queries.
 *
 * VENUE_LOG_CHUNK_BLOCKS=10000 was measured against the ESCROW, which is dense.
 * The join queries are topic-filtered and far sparser, so the binding limit is
 * different and has to be measured rather than inherited: on this endpoint the
 * QUERY TIMEOUT binds before the 10,000-result cap, and it is load-dependent.
 *
 * Also binary-searches the first block each contract emitted, so a full-history
 * scan does not pay for 27M empty blocks.
 */

const RPC = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const RPS = Number(process.env.VENUE_HTTP_RPS ?? '0.8')

let last = 0
async function throttle() {
  const w = last + 1000 / RPS - Date.now()
  if (w > 0) await new Promise((r) => setTimeout(r, w))
  last = Date.now()
}
/**
 * Throttling alone is not enough: the endpoint returns "Too Many Requests"
 * under contention regardless of the client's own pacing, and a probe that dies
 * on one of those reports a chunk size as unusable when it was only unlucky.
 * Transport-level refusals retry; a genuine query limit is returned to the
 * caller, because that is the thing being measured.
 */
async function rpc(method, params, timeoutMs = 90_000) {
  let lastErr
  for (let attempt = 0; attempt < 6; attempt++) {
    await throttle()
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const j = await res.json()
      if (j.error) {
        const msg = j.error.message ?? JSON.stringify(j.error)
        if (/exceeds limit|timed out|too large|range/i.test(msg)) {
          throw Object.assign(new Error(msg), { queryLimit: true })
        }
        throw new Error(msg)
      }
      return j.result
    } catch (e) {
      if (e.queryLimit) throw e
      lastErr = e
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
  throw lastErr
}
const hex = (n) => '0x' + BigInt(n).toString(16)

const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044'
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'
const T_POOL_REGISTERED = '0x01bf263a1db1652580721573296e1a1fa70b3d4c87f61d02a69c4e1109d2d573'
const T_POOL_FEES_SWEPT = '0x2f3c43579b9064b6f28edcf41608f3815792d274a56afe024359703cb4ea9b30'
const T_TOKEN_LAUNCHED = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607'

const latest = BigInt(await rpc('eth_blockNumber', []))
console.log(`latest ${latest}`)

/** First block at or after `low` that the contract emitted anything in. */
async function firstEmitBlock(address, topic0, low, high) {
  // Expanding probe from the low end, then bisect.
  let lo = low
  let hi = high
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const logs = await rpc('eth_getLogs', [
      { address, topics: [topic0], fromBlock: hex(lo), toBlock: hex(mid) },
    ]).catch((e) => {
      if (/exceeds limit/.test(e.message)) return ['CAPPED']
      throw e
    })
    if (logs.length > 0) hi = mid
    else lo = mid + 1n
  }
  return lo
}

for (const [label, address, topic0] of [
  ['PoolRegistered@hook', HOOK, T_POOL_REGISTERED],
  ['TokenLaunched@factory', FACTORY, T_TOKEN_LAUNCHED],
]) {
  const b = await firstEmitBlock(address, topic0, 1n, latest)
  const hdr = await rpc('eth_getBlockByNumber', [hex(b), false])
  console.log(`${label}: first emit block ${b}  ${new Date(parseInt(hdr.timestamp, 16) * 1000).toISOString()}`)
}

console.log('')
console.log('chunk probes (4 trials each, from a recent window)')
for (const [label, address, topic0, spans] of [
  ['PoolRegistered@hook', HOOK, T_POOL_REGISTERED, [500_000, 1_000_000, 2_000_000, 4_000_000]],
  ['TokenLaunched@factory', FACTORY, T_TOKEN_LAUNCHED, [50_000, 100_000, 200_000, 400_000]],
  ['PoolFeesSwept@hook', HOOK, T_POOL_FEES_SWEPT, [25_000, 50_000, 100_000, 200_000]],
]) {
  console.log(`\n${label}`)
  for (const span of spans) {
    let ok = 0
    let logs = 0
    let err = ''
    let ms = 0
    for (let t = 0; t < 3; t++) {
      const to = latest - 100n - BigInt(t) * BigInt(span)
      const from = to - BigInt(span) + 1n
      const t0 = Date.now()
      try {
        const r = await rpc('eth_getLogs', [
          { address, topics: [topic0], fromBlock: hex(from), toBlock: hex(to) },
        ])
        ok++
        logs = Math.max(logs, r.length)
        ms = Math.max(ms, Date.now() - t0)
      } catch (e) {
        err = e.message.slice(0, 60)
      }
    }
    console.log(`  ${String(span).padStart(9)} blocks: ${ok}/3 served  maxLogs ${String(logs).padStart(6)}  maxMs ${String(ms).padStart(6)}  ${err}`)
  }
}

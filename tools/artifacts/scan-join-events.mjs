#!/usr/bin/env node
/**
 * scan-join-events - pull the three VERIFIED events the per-coin join needs.
 *
 * All three signatures are confirmed against Sourcify-verified source on chain
 * 4663 and observed in a topic0 census, not inferred:
 *
 *   TokenLaunched(address indexed token, address indexed curve,
 *                 address indexed deployer, address pairToken,
 *                 uint256 launchConfigId, uint256 graduationThreshold)
 *       on the V2 factory. curve -> token, and the curve is the escrow
 *       depositor for the pre-graduation fee path.
 *
 *   PoolRegistered(bytes32 indexed poolId, address memecoin,
 *                  address quoteToken, address creator)
 *       on the V2 meme hook. poolId -> memecoin, for the post-graduation path.
 *
 *   PoolFeesSwept(bytes32 indexed poolId, uint256 protocolAmount,
 *                 uint256 buybackAmount, uint256 creatorAmount,
 *                 uint256 tokensLocked)
 *       on the hook. Its TRANSACTION carries the escrow credits the hook makes
 *       in the same call, so txHash joins a hook-path credit to a poolId.
 *
 * Chunk sizes are the MEASURED ones from probe-chunks.mjs, not the escrow's
 * 10,000: these queries are far sparser and the endpoint serves them wider.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs'

const RPC = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const RPS = Number(process.env.VENUE_HTTP_RPS ?? '0.8')

const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044'
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'
const T_TOKEN_LAUNCHED = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607'
const T_POOL_REGISTERED = '0x01bf263a1db1652580721573296e1a1fa70b3d4c87f61d02a69c4e1109d2d573'
const T_POOL_FEES_SWEPT = '0x2f3c43579b9064b6f28edcf41608f3815792d274a56afe024359703cb4ea9b30'

const WINDOW_FROM = 50419076n
const WINDOW_TO = 56389048n

let last = 0
async function throttle() {
  const w = last + 1000 / RPS - Date.now()
  if (w > 0) await new Promise((r) => setTimeout(r, w))
  last = Date.now()
}
async function rpc(method, params) {
  let lastErr
  for (let i = 0; i < 8; i++) {
    await throttle()
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(120_000),
      })
      const j = await res.json()
      if (j.error) {
        const msg = j.error.message ?? JSON.stringify(j.error)
        if (/exceeds limit|timed out|too large/i.test(msg)) throw Object.assign(new Error(msg), { queryLimit: true })
        throw new Error(msg)
      }
      return j.result
    } catch (e) {
      if (e.queryLimit) throw e
      lastErr = e
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)))
    }
  }
  throw lastErr
}
const hex = (n) => '0x' + BigInt(n).toString(16)
const addrOf = (t) => '0x' + t.slice(26).toLowerCase()

/**
 * Halving recovery, same discipline as lib/logscan.ts: a server-side limit is
 * an ERROR on this endpoint, never a short result set, so narrowing on failure
 * cannot silently drop logs.
 */
async function scan(address, topic0, from, to, chunk, onBatch, label) {
  let cursor = from
  let total = 0
  const t0 = Date.now()
  // The usable span is LOAD-DEPENDENT on this endpoint, not a fixed threshold,
  // so it is carried across chunks rather than reset. Resetting made every
  // chunk re-pay two doomed requests before finding the width that works,
  // tripling the scan. It grows back slowly after a run of successes so a
  // temporary contention spike does not pin it low for the whole scan.
  let span = BigInt(chunk)
  let streak = 0
  while (cursor <= to) {
    for (;;) {
      const end = cursor + span - 1n > to ? to : cursor + span - 1n
      try {
        const logs = await rpc('eth_getLogs', [
          { address, topics: [topic0], fromBlock: hex(cursor), toBlock: hex(end) },
        ])
        if (logs.length >= 10_000) {
          // At the cap the result may be exactly complete or exactly truncated
          // and there is no way to tell from here. Narrow rather than guess.
          if (span <= 25n) throw new Error('at result cap with an irreducible span')
          span /= 2n
          streak = 0
          process.stderr.write(`  ${label}: ${logs.length} logs hits the cap, narrowing to ${span}\n`)
          continue
        }
        onBatch(logs)
        total += logs.length
        const pct = Number(((end - from) * 100n) / (to - from))
        process.stderr.write(`  ${label} ${cursor}-${end}: +${logs.length} = ${total} span ${span} (${pct}%, ${((Date.now() - t0) / 1000).toFixed(0)}s)\r`)
        cursor = end + 1n
        if (++streak >= 20 && span < BigInt(chunk)) {
          span *= 2n
          streak = 0
          process.stderr.write(`\n  ${label}: 20 clean chunks, widening to ${span}\n`)
        }
        break
      } catch (e) {
        if (span <= 25n) throw new Error(`${label} irreducible failure at ${cursor}: ${e.message}`)
        span /= 2n
        streak = 0
        process.stderr.write(`\n  ${label}: narrowing to ${span} (${e.message.slice(0, 60)})\n`)
      }
    }
  }
  process.stderr.write('\n')
  return total
}

const latest = BigInt(await rpc('eth_blockNumber', []))
const which = process.argv[2] ?? 'all'

// --- TokenLaunched: curve -> token ----------------------------------------
if (which === 'all' || which === 'launched') {
  const first = 27_027_321n // measured by probe-chunks.mjs
  const curveToToken = Object.create(null)
  const deployerOf = Object.create(null)
  let dupes = 0
  const n = await scan(FACTORY, T_TOKEN_LAUNCHED, first, latest, 150_000, (logs) => {
    for (const l of logs) {
      const token = addrOf(l.topics[1])
      const curve = addrOf(l.topics[2])
      if (curveToToken[curve] !== undefined && curveToToken[curve] !== token) dupes++
      curveToToken[curve] = token
      deployerOf[token] = addrOf(l.topics[3])
    }
  }, 'TokenLaunched')
  console.log(`TokenLaunched logs ${n}  distinct curves ${Object.keys(curveToToken).length}  distinct tokens ${Object.keys(deployerOf).length}  curve collisions ${dupes}`)
  writeFileSync('tools/artifacts/join-curve-to-token.json', JSON.stringify({ firstBlock: first.toString(), toBlock: latest.toString(), logs: n, curveCollisions: dupes, curveToToken, deployerOf }))
}

// --- PoolRegistered: poolId -> memecoin ------------------------------------
if (which === 'all' || which === 'registered') {
  const first = 27_828_161n
  const poolToToken = Object.create(null)
  const poolToCreator = Object.create(null)
  const poolToQuote = Object.create(null)
  const n = await scan(HOOK, T_POOL_REGISTERED, first, latest, 2_000_000, (logs) => {
    for (const l of logs) {
      const poolId = l.topics[1].toLowerCase()
      const d = l.data.slice(2)
      poolToToken[poolId] = '0x' + d.slice(24, 64).toLowerCase()
      poolToQuote[poolId] = '0x' + d.slice(88, 128).toLowerCase()
      poolToCreator[poolId] = '0x' + d.slice(152, 192).toLowerCase()
    }
  }, 'PoolRegistered')
  console.log(`PoolRegistered logs ${n}  distinct pools ${Object.keys(poolToToken).length}`)
  writeFileSync('tools/artifacts/join-pool-to-token.json', JSON.stringify({ firstBlock: first.toString(), toBlock: latest.toString(), logs: n, poolToToken, poolToCreator, poolToQuote }))
}

// --- PoolFeesSwept over the measurement window: txHash -> poolId ------------
if (which === 'all' || which === 'swept') {
  // Keyed by tx as a LIST, not a single poolId: one transaction may sweep
  // several pools, and the hook emits each pool's escrow credits BEFORE its
  // PoolFeesSwept, so a credit belongs to the next sweep above its logIndex.
  // Collapsing to one poolId per tx would misattribute every batched sweep.
  const txToPool = Object.create(null)
  const sweeps = []
  const n = await scan(HOOK, T_POOL_FEES_SWEPT, WINDOW_FROM, WINDOW_TO, 25_000, (logs) => {
    for (const l of logs) {
      const poolId = l.topics[1].toLowerCase()
      const tx = l.transactionHash.toLowerCase()
      const li = parseInt(l.logIndex, 16)
      if (txToPool[tx] === undefined) txToPool[tx] = []
      txToPool[tx].push([li, poolId])
      const d = l.data.slice(2)
      sweeps.push({
        p: poolId,
        b: parseInt(l.blockNumber, 16),
        pr: BigInt('0x' + d.slice(0, 64)).toString(),
        bb: BigInt('0x' + d.slice(64, 128)).toString(),
        cr: BigInt('0x' + d.slice(128, 192)).toString(),
        tl: BigInt('0x' + d.slice(192, 256)).toString(),
      })
    }
  }, 'PoolFeesSwept')
  const pools = new Set(sweeps.map((s) => s.p))
  const txs = Object.keys(txToPool)
  const batched = txs.filter((t) => txToPool[t].length > 1).length
  for (const t of txs) txToPool[t].sort((a, b) => a[0] - b[0])
  console.log(`PoolFeesSwept logs ${n}  distinct pools swept in window ${pools.size}  distinct txs ${txs.length}`)
  console.log(`transactions carrying MORE THAN ONE sweep: ${batched} (${((batched / txs.length) * 100).toFixed(2)}%) - these need logIndex ordering, not a tx->pool map`)
  writeFileSync('tools/artifacts/join-tx-to-pool.json', JSON.stringify({ fromBlock: WINDOW_FROM.toString(), toBlock: WINDOW_TO.toString(), logs: n, txToPool }))
  writeFileSync('tools/artifacts/sweeps-7d.json', JSON.stringify({ fromBlock: WINDOW_FROM.toString(), toBlock: WINDOW_TO.toString(), sweeps }))
}

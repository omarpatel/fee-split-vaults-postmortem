/**
 * Live proof that a killed scan resumes to a BYTE-IDENTICAL result.
 *
 * Run as:  node tools/artifacts/live-resume-check.mjs scan <checkpointDir> <outFile>
 *          node tools/artifacts/live-resume-check.mjs drive
 *
 * `drive` runs the scan three times against the live chain:
 *   A  uninterrupted, its own checkpoint dir;
 *   B1 the same scan in a second dir, SIGKILLed partway through - a real
 *      process kill, not a caught exception, so the partial-append path on
 *      resume is exercised for real;
 *   B2 the same scan again in B1's dir, which resumes from the checkpoint.
 * It then compares the serialised logs of A and B2. The cache is disabled
 * throughout so every chunk is a real request and the comparison is between
 * two independent reads of the chain.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CheckpointStore } from '../lib/checkpoint.ts'
import { buildHttpClient } from '../lib/http.ts'
import { stringifyJson } from '../lib/json.ts'
import { formatScanProgress, scanLogs } from '../lib/logscan.ts'
import { HttpChainReader } from '../lib/rpc.ts'

const SELF = fileURLToPath(import.meta.url)
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '')
const ESCROW = '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e'
const TOPIC_TOKEN = '0x5d104c62f50449fadfe6f4013c8f36588d32737f94b5ac9b83ddad33b3e1ffdf'
const CHUNK = 5_000
const CHUNKS = 20

async function scan(checkpointDir, outFile, fromBlockArg, toBlockArg) {
  const http = buildHttpClient({
    requestsPerSecond: Number(process.env.VENUE_HTTP_RPS ?? 1.5),
    maxRetries: 5,
    timeoutMs: 30_000,
    adaptive: { minRequestsPerSecond: 0.2 },
  })
  const reader = new HttpChainReader(http, [process.env.VENUE_RPC_URL], 10)
  // The range is PINNED by the driver and passed in. Recomputing it per child
  // from the chain head silently gives each run a different window - which is
  // exactly what made the first attempt at this check report a false mismatch.
  const toBlock = BigInt(toBlockArg)
  const fromBlock = BigInt(fromBlockArg)

  const identity = {
    chainId: 4663,
    address: ESCROW,
    topics: [TOPIC_TOKEN],
    fromBlock,
    toBlock,
    chunkBlocks: CHUNK,
  }
  const { store, resumedFrom } = await CheckpointStore.open(checkpointDir, identity)
  if (resumedFrom) {
    process.stderr.write(
      `RESUMING from ${resumedFrom.chunksCompleted} chunks / ${resumedFrom.logCount} logs\n`,
    )
  }
  const logs = await scanLogs(reader, {
    address: ESCROW,
    topics: [TOPIC_TOKEN],
    fromBlock,
    toBlock,
    chunkBlocks: CHUNK,
    checkpoint: store,
    batchSize: 2,
    // No cache on purpose: every chunk is a real read of the chain, so A and B2
    // are two independent measurements, not one measurement replayed.
    onScanProgress: (p) => process.stderr.write(`${formatScanProgress(p, 'credits')}\n`),
  })
  const serialized = stringifyJson(logs, 'string', 0)
  writeFileSync(
    outFile,
    JSON.stringify({
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      logs: logs.length,
      sha256: createHash('sha256').update(serialized).digest('hex'),
    }),
    'utf8',
  )
  process.stderr.write(`DONE ${logs.length} logs -> ${outFile}\n`)
}

function runChild(checkpointDir, outFile, range, killAfterMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, 'scan', checkpointDir, outFile, range.from, range.to], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    })
    let timer
    if (killAfterMs !== undefined) {
      timer = setTimeout(() => {
        process.stderr.write(`\n--- SIGKILL after ${killAfterMs}ms ---\n`)
        child.kill('SIGKILL')
      }, killAfterMs)
    }
    child.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

const mode = process.argv[2]
if (mode === 'scan') {
  await scan(process.argv[3], process.argv[4], process.argv[5], process.argv[6])
} else {
  const dirA = `${ROOT}/tools/.checkpoints-livecheck-a`
  const dirB = `${ROOT}/tools/.checkpoints-livecheck-b`
  for (const d of [dirA, dirB]) rmSync(d, { recursive: true, force: true })

  // Pin the window ONCE, well behind the head so it is already final, and give
  // every child the same numbers.
  const head = await fetch(process.env.VENUE_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  })
    .then((r) => r.json())
    .then((j) => BigInt(j.result))
  const to = head - 200_000n
  const range = { from: (to - BigInt(CHUNK * CHUNKS) + 1n).toString(), to: to.toString() }
  process.stderr.write(`pinned range ${range.from} .. ${range.to}\n`)

  process.stderr.write('=== RUN A: uninterrupted ===\n')
  await runChild(dirA, `${ROOT}/tools/artifacts/live-resume-a.json`, range)

  process.stderr.write('\n=== RUN B1: killed midway ===\n')
  const killed = await runChild(dirB, `${ROOT}/tools/artifacts/live-resume-b.json`, range, 7_000)
  process.stderr.write(`B1 exited code=${killed.code} signal=${killed.signal}\n`)

  process.stderr.write('\n=== RUN B2: resume ===\n')
  await runChild(dirB, `${ROOT}/tools/artifacts/live-resume-b.json`, range)

  const a = JSON.parse(readFileSync(`${ROOT}/tools/artifacts/live-resume-a.json`, 'utf8'))
  const b = JSON.parse(readFileSync(`${ROOT}/tools/artifacts/live-resume-b.json`, 'utf8'))
  process.stderr.write('\n=== RESULT ===\n')
  console.log('range          ', a.fromBlock, '..', a.toBlock)
  console.log('A  logs/sha256 ', a.logs, a.sha256)
  console.log('B2 logs/sha256 ', b.logs, b.sha256)
  console.log(
    a.sha256 === b.sha256 && a.logs === b.logs
      ? 'IDENTICAL: a killed-and-resumed scan matched the uninterrupted one byte for byte.'
      : 'MISMATCH',
  )
  process.exitCode = a.sha256 === b.sha256 ? 0 : 1
}

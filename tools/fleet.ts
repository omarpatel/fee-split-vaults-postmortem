/**
 * RUN THE FLEET.
 *
 *   npm run fleet                        one tick of every fixture coin
 *   npm run fleet -- --ticks 3           three consecutive windows
 *   npm run fleet -- --coins coin_alpha  one coin
 *   npm run fleet -- --watch             keep ticking on each coin's own cadence
 *   npm run fleet -- --dry-run           scripted model, nothing persisted
 *   npm run fleet -- --json              one JSON record per tick, for piping
 *
 * This is the same code path the ops scheduler runs. The scheduler adds the
 * durable parts - the lease, the run store, the dead letter queue, the freeze
 * gate - and this CLI adds none of them, which is exactly why it is useful:
 * what you see here is the agent teams and nothing else.
 *
 * WHAT IT PRINTS. Per coin, per tick: which parts of the team ran, what the
 * reader's census said, what the planner proposed, what was suppressed and why,
 * every refusal with its phase and machine code, what was published, and what
 * the tick cost. A tick that refused everything prints MORE than a tick that
 * worked, because the refusals are the product.
 *
 * IT NEVER PRETENDS. When no model credential resolves, the banner says so, the
 * word FAKE is on the provenance line of every tick, and the scripted client
 * cannot propose a purchase at all - so nothing you see here can move money.
 */

import { readFileSync } from 'node:fs'
import { runKey as makeRunKey } from '../ops/lib/ids.js'
import { connectPg } from '../ops/lib/pg.js'
import { PgDriver } from '../ops/migrations/driver.js'
import { staggeredIntervalDue } from '../ops/scheduler/triggers.js'
import { FLEET } from '../ops/scheduler/config.js'
import { SqlAgentRunStore, bootstrapFleet, type BootstrappedFleet } from '@fee-split-vaults/fleet'
import type { AgentRunRecord } from '@fee-split-vaults/orchestrator'

interface Options {
  ticks: number
  watch: boolean
  intervalSeconds: number
  dryRun: boolean
  coins: string[]
  json: boolean
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    ticks: 1,
    watch: false,
    intervalSeconds: 30,
    dryRun: false,
    coins: [],
    json: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    switch (arg) {
      case '--once':
        options.watch = false
        break
      case '--watch':
        options.watch = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--json':
        options.json = true
        break
      case '--ticks':
        options.ticks = Math.max(1, Number.parseInt(next ?? '1', 10))
        i += 1
        break
      case '--interval':
        options.intervalSeconds = Math.max(1, Number.parseInt(next ?? '30', 10))
        i += 1
        break
      case '--coins':
        options.coins = (next ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)
        i += 1
        break
      case '--help':
      case '-h':
        process.stdout.write(HELP)
        process.exit(0)
      // eslint-disable-next-line no-fallthrough
      default:
        if (arg !== undefined && arg.startsWith('--')) {
          process.stderr.write(`unknown flag ${arg}\n${HELP}`)
          process.exit(2)
        }
    }
  }
  return options
}

const HELP = `
run the fleet: every coin's agent team, on the schedule the coin asks for

  --once            one pass over the due coins (default)
  --ticks N         N consecutive windows per coin, advancing the clock
  --watch           keep running, waking each coin when it says it is due
  --interval N      seconds between polls in --watch (default 30)
  --dry-run         scripted model client, and nothing is persisted
  --coins a,b       only these coin refs
  --json            one JSON run record per line instead of the report
`

const WINDOW_SECONDS = 1_800

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const startedAt = Math.floor(Date.now() / 1000)

  // THE DATABASE, when there is one and this is not a dry run. A dry run
  // persists nothing and is refused anything real, so it never opens the
  // connection at all - there is no path by which a dry run reaches a table.
  // With one, every durable store in bootstrapFleet is Postgres and the
  // fixture fleet is replaced by whatever FLEET_COINS_SOURCE names.
  const databaseUrl = process.env.DATABASE_URL?.trim()
  const connection =
    options.dryRun || databaseUrl === undefined || databaseUrl.length === 0 ? undefined : await connectPg(databaseUrl)
  const driver = connection === undefined ? undefined : new PgDriver(connection.client)
  if (connection !== undefined) {
    const close = (): void => {
      void connection.close()
    }
    process.once('beforeExit', close)
    process.once('SIGINT', close)
  }

  const boot = await bootstrapFleet({
    nowUnix: startedAt,
    dryRun: options.dryRun,
    // This is a CLI: it HAS a filesystem, so it supplies the reader that lets
    // FLEET_COINS_FILE name a real coin directory. bootstrapFleet takes it as an
    // injection rather than importing node:fs itself, so that starting a fleet
    // stays testable without touching a disk.
    readFile: (path: string) => readFileSync(path, 'utf8'),
    // With a database the run records go where the scheduler's go, so a tick
    // here and a tick there under the same run key are the same run.
    ...(driver === undefined ? {} : { driver, store: new SqlAgentRunStore(driver) }),
  })

  // SELECT BEFORE ANNOUNCING. The header names the coins this run will actually
  // tick, not everything the directory holds: a header listing three coins over
  // output that ticks one is the line a reader will believe.
  const selected = selectCoins(boot, options.coins)
  if (selected.length === 0) {
    process.stderr.write(`no coins matched --coins ${options.coins.join(',')}\n`)
    process.exitCode = 2
    return
  }

  if (!options.json) {
    process.stdout.write(`${boot.banner}\n`)
    if (options.dryRun) {
      process.stdout.write('DRY RUN: the scripted client is forced and no run record is persisted.\n')
    }
    const held = boot.directory.size
    const filtered = selected.length < held ? ` of ${held} in the directory` : ''
    process.stdout.write(`fleet: ${selected.length} coin(s)${filtered}: ${selected.join(', ')}\n\n`)
  }

  // THE CHAIN, BEFORE ANY TICK ASKS IT ANYTHING.
  //
  // A live chain read model answers only about windows its cursor has actually
  // reached, and refuses with CoverageGapError about anything else. That is the
  // point of it - "I have not looked there" must never come back as "nothing
  // happened there" - but it means SOMETHING has to move the cursor, and the
  // only honest something is a real scan. This is it: incremental, forward-only
  // from wherever the cursor already sits, bounded per pass, and printed so the
  // block range is visible rather than implied.
  if (options.watch) {
    await watch(boot, selected, options)
    return
  }

  // Each pass advances by one window, so `--ticks 3` is three consecutive
  // windows rather than three ticks of the same one. A coin's second tick is
  // where the cadence, the cost meter and the divergence baseline start to
  // matter, and a CLI that could only ever show the first tick would hide them.
  for (let pass = 0; pass < options.ticks; pass += 1) {
    const atUnix = startedAt + pass * WINDOW_SECONDS
    // ONCE PER PASS, not once per run. A pass asks about a later window, and
    // a cursor that stopped moving after the first pass would answer the
    // second one from blocks it read before that window existed. The scan is
    // incremental, so a second pass costs only the blocks the chain added.
    await syncChain(boot, atUnix, options)
    for (const coinRef of selected) {
      await tickAndReport(boot, coinRef, atUnix, options)
    }
  }
}

/**
 * Advance every tracked vault's cursor, and say exactly how far it got.
 *
 * WHAT IS PRINTED IS WHAT HAPPENED. `stillBehind` is reported rather than
 * hidden, because a vault that ran out of range budget has NOT caught up, and a
 * fleet that ticked it anyway would be answering questions about blocks it
 * never read. The rate limit is real - this chain answers about 0.8 requests a
 * second and a ten-call batch spends ten slots - so a pass that stops short is
 * the normal case on a cold cursor, not an error.
 */
async function syncChain(
  boot: BootstrappedFleet,
  nowUnix: number,
  options: Options,
): Promise<void> {
  const chain = boot.chain
  if (chain === undefined) return
  const started = Date.now()
  try {
    const result = await chain.sync(nowUnix)
    if (options.json) return
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    process.stdout.write(
      `chain     finalized #${String(result.finalized.number)}  ` +
        `ts=${String(result.finalized.timestampUnix)}  (${elapsed}s)\n`,
    )
    for (const vault of result.vaults) {
      const coin = chain.vaults.find((v) => v.vault.toLowerCase() === vault.vault.toLowerCase())
      process.stdout.write(
        `          ${coin?.coinRef ?? vault.vault}  ` +
          `blocks ${String(vault.fromBlock)}..${String(vault.toBlock)}  ` +
          `ranges ${String(vault.rangesScanned)}  claims ${String(vault.newClaims)}  ` +
          `allocations ${String(vault.newAllocations)}  ` +
          `${vault.caughtUp ? 'caught up' : 'STILL BEHIND'}\n`,
      )
    }
    if (result.stillBehind.length > 0) {
      process.stdout.write(
        `          ${String(result.stillBehind.length)} vault(s) short of the head; their ` +
          'windows will refuse with a coverage gap rather than answer from blocks nobody read\n',
      )
    }
    process.stdout.write('\n')
  } catch (error) {
    // A scan that fails is NOT a fleet that ticks anyway. Every read after this
    // would be answered from a cursor that did not move, which is the one thing
    // the read model exists to refuse.
    const detail = error instanceof Error ? error.message : String(error)
    process.stdout.write(
      `chain     SCAN FAILED: ${detail}\n` +
        '          refusing to tick: a tick now would answer from blocks this run never read\n',
    )
    process.exit(1)
  }
}

function selectCoins(boot: BootstrappedFleet, filter: readonly string[]): string[] {
  const all = boot.directory.refs()
  if (filter.length === 0) return all
  return all.filter((ref) => filter.includes(ref))
}

/**
 * One coin, one tick, reported.
 *
 * The run key is built with the SAME function the scheduler uses, from the same
 * staggered grid, so a tick here and a tick there for the same coin in the same
 * period are the same run - which is what makes running this against a shared
 * store safe rather than a way to double-tick a coin.
 */
async function tickAndReport(
  boot: BootstrappedFleet,
  coinRef: string,
  atUnix: number,
  options: Options,
): Promise<void> {
  const period = staggeredIntervalDue(atUnix, coinRef, undefined, FLEET.evaluateEverySeconds).period
  const key = makeRunKey('fleet.tick', coinRef, period)

  try {
    const summary = await boot.fleet.tick({ coinRef, nowUnix: atUnix, runKey: key })
    const record = await boot.store.latest(summary.vault)
    if (options.json) {
      process.stdout.write(`${JSON.stringify(toJson(record, summary.replayed))}\n`)
      return
    }
    process.stdout.write(report(coinRef, record, summary.replayed, boot))
  } catch (error) {
    // A throw here is the tick failing to RUN, which is a different thing from
    // the tick refusing to act - and it is printed differently for that reason.
    process.stdout.write(`${coinRef}: TICK FAILED: ${error instanceof Error ? error.message : String(error)}\n\n`)
    process.exitCode = 1
  }
}

async function watch(boot: BootstrappedFleet, selected: readonly string[], options: Options): Promise<void> {
  process.stdout.write(`watching ${String(selected.length)} coin(s); poll every ${String(options.intervalSeconds)}s\n\n`)
  let stopping = false
  process.once('SIGINT', () => {
    stopping = true
    process.stdout.write('\nstopping after the current pass\n')
  })

  while (!stopping) {
    const nowUnix = Math.floor(Date.now() / 1000)
    // The chain moves between polls, so the cursor has to as well.
    await syncChain(boot, nowUnix, options)
    const due = await boot.fleet.dueCoins(nowUnix)
    for (const coin of due) {
      if (!selected.includes(coin.coinRef)) continue
      await tickAndReport(boot, coin.coinRef, nowUnix, options)
      if (stopping) break
    }
    if (stopping) break
    await new Promise((resolve) => setTimeout(resolve, options.intervalSeconds * 1_000))
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function toJson(record: AgentRunRecord | undefined, replayed: boolean): unknown {
  if (record === undefined) return { error: 'no run record was written' }
  return {
    ...record,
    replayed,
    // A bigint does not survive JSON.stringify, and silently dropping the cost
    // of a run is not an option in a record whose point is accounting.
    cost: { ...record.cost, microUsd: record.cost.microUsd.toString() },
  }
}

function report(
  coinRef: string,
  record: AgentRunRecord | undefined,
  replayed: boolean,
  boot: BootstrappedFleet,
): string {
  if (record === undefined) return `${coinRef}: no run record was written\n\n`
  const out: string[] = []
  const at = new Date(record.atUnix * 1_000).toISOString().replace('.000Z', 'Z')
  out.push(
    `${coinRef}  ${record.tier}  vault ${short(record.vault)}  ${at}` +
      (replayed ? '  [REPLAYED: this run key had already ticked]' : ''),
  )

  // What ran. Named as the team, because that is the product claim being made.
  const ran: string[] = []
  ran.push(record.ranChainPoll ? 'indexer=polled' : 'indexer=held')
  ran.push(record.ranCognition ? 'reader+planner=ran' : 'reader+planner=idle')
  ran.push(record.spends.length > 0 ? `broker=${String(record.spends.length)}` : 'broker=idle')
  ran.push(record.publishes.length > 0 ? `publisher=${String(record.publishes.length)}` : 'publisher=idle')
  out.push(`  team      ${ran.join('  ')}`)

  const digest = record.digest
  if (digest === undefined) {
    out.push(`  window    no digest this tick${record.skipped === undefined ? '' : ` (${record.skipped})`}`)
  } else {
    out.push(
      `  window    ${digest.windowId}  admitted ${String(digest.admittedMessageCount)}` +
        `  dropped ${String(digest.droppedMessageCount)}  authors ${String(digest.distinctAuthorCount)}` +
        `  reader refusals ${String(digest.readerRefusals)}`,
    )
    const topics = digest.topicCounts.map((t) => `${t.code}=${String(t.count)}`).join(' ')
    out.push(`  census    ${topics.length === 0 ? '(no topics)' : topics}  signals ${digest.signals.join(',') || '(none)'}`)
  }

  if (record.freeze !== undefined) {
    out.push(`  FREEZE    ${record.freeze.level}: ${record.freeze.reason}`)
  }

  if (record.proposals.length === 0) {
    out.push('  proposed  nothing')
  } else {
    for (const proposal of record.proposals) out.push(`  proposed  ${describeProposal(proposal)}`)
  }
  for (const entry of record.suppressed) {
    out.push(`  SUPPRESSED ${describeProposal(entry.proposal)} :: ${entry.reason}`)
  }
  for (const violation of record.violations) {
    out.push(`  VIOLATION ${violation.toolName}.${violation.field}: ${violation.message}`)
  }

  // THE REFUSALS. Printed even when there are none, because "no refusals" is
  // itself a fact a dev is entitled to see rather than an absence they have to
  // infer from a missing line.
  if (record.refusals.length === 0) {
    out.push('  refusals  none')
  } else {
    for (const refusal of record.refusals) {
      out.push(`  REFUSED   ${refusal.phase}: ${refusal.code} - ${refusal.detail}`)
    }
  }

  for (const spend of record.spends) {
    out.push(
      `  spend     ${spend.skuId ?? '(sku unknown)'} ${spend.status}` +
        `${spend.failedGate === undefined ? '' : ` failed_gate=${spend.failedGate}`} ${spend.code}: ${spend.detail}`,
    )
  }
  for (const attempt of record.publishes) {
    out.push(
      `  published ${attempt.channel} ${attempt.intent} ${attempt.published ? 'sent' : `rejected: ${attempt.rejectedReason ?? 'unknown'}`}`,
    )
  }

  const faked = boot.substitutions.names()
  out.push(
    `  cost      ${String(record.cost.microUsd)} micro-USD  degrade ${record.cost.degradeLevel}` +
      `  model ${record.modelProvenance.toUpperCase()}` +
      `  in ${String(record.cost.usage.inputTokens)}/out ${String(record.cost.usage.outputTokens)} tokens`,
  )
  out.push(`  next due  ${new Date(record.nextDueUnix * 1_000).toISOString().replace('.000Z', 'Z')}`)
  if (faked.length > 0) out.push(`  faked     ${faked.join(', ')}`)
  out.push('')
  return `${out.join('\n')}\n`
}

function describeProposal(proposal: AgentRunRecord['proposals'][number]): string {
  switch (proposal.kind) {
    case 'post':
      return `post ${proposal.intent} on ${proposal.channel} about ${proposal.topic} (${String(proposal.bodyChars)} chars, ${String(proposal.linkRefCount)} link ref(s))`
    case 'purchase':
      return `purchase ${proposal.skuId} x${String(proposal.quantity)} :: ${proposal.rationale}`
    case 'escalation':
      return `escalation ${proposal.reason} :: ${proposal.note}`
    case 'no_action':
      return `no action :: ${proposal.reason}`
  }
}

function short(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 8)}...${address.slice(-4)}`
}

main().catch((error: unknown) => {
  process.stderr.write(`fleet failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})

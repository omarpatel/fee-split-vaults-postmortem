/**
 * demo - watch the product work, one subsystem at a time.
 *
 * WHY THIS EXISTS. packages/desk, broker, publisher, screening, runtime and
 * orchestrator have thorough test suites and, until this file, no runnable entry
 * point. That means the most important claims in the whole project could only be
 * ASSERTED - the desk refuses money questions, the airlock has no field for a
 * destination, the spend gate names the rule that stopped it, disclosure cannot
 * be truncated away, no screening stage can clear a prior stage's hit, the dev
 * keeps 100% in every state but one. A claim nobody can watch is a claim.
 *
 * EVERY SUBCOMMAND SHOWS A REFUSAL. That is not balance for its own sake: the
 * refusals ARE the product. An agency that answers every question and buys every
 * SKU is a different and much worse business, and the only honest way to show
 * which one this is, is to watch it decline in exactly the format in which it
 * accepts.
 *
 * NOTHING HERE TOUCHES ANYTHING REAL. No network request is made by any
 * subcommand, at any time, under any flag. No key is loaded, no chain is read,
 * no client exists, no vendor is paid. Where the real product calls a model,
 * this calls a scripted stand-in - and several of those stand-ins are HOSTILE,
 * because the point of most scenes is what the code around the model does when
 * the model misbehaves.
 *
 * Usage:
 *   node tools/demo.ts --help
 *   node tools/demo.ts broker
 *   node tools/demo.ts all --out demo.json
 */

import { runAirlockDemo } from './lib/demo/airlock.ts'
import { runBrokerDemo } from './lib/demo/broker.ts'
import { runDeskDemo } from './lib/demo/desk.ts'
import { runPublisherDemo } from './lib/demo/publisher.ts'
import { runScreeningDemo } from './lib/demo/screening.ts'
import { runVaultDemo } from './lib/demo/vault.ts'
import { renderDemo, type DemoResult } from './lib/demo/render.ts'
import {
  CliError,
  getBool,
  getList,
  getNumber,
  getString,
  isEntrypoint,
  parseArgs,
  renderHelp,
  type CommandSpec,
  type OptionSpec,
  type ParsedValues,
} from './lib/cli.ts'
import { banner, heading, table } from './lib/format.ts'
import { emit, emitDryRun, type Report } from './lib/report.ts'

const SCHEMA_VERSION = 'demo-1'

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

interface Subcommand {
  name: string
  summary: string
  detail: string
  /** What --dry-run prints. Static, because the scenes are built at run time. */
  plan: string[]
  options?: OptionSpec[]
  run: (values: ParsedValues) => Promise<DemoResult>
}

const FILTER_OPTION: OptionSpec = {
  name: 'only',
  type: 'string[]',
  placeholder: '<scene-id,...>',
  describe:
    'Render only these scene ids (see the ids in --json). Useful when walking someone through one property.',
}

const SUBCOMMANDS: Subcommand[] = [
  {
    name: 'desk',
    summary: 'T0 and T1 answer, refuse, and admit what they have not verified.',
    detail: `
      Eight messages arrive in one coin's group. The desk answers two from
      block-pinned chain reads with the provenance of every figure attached,
      REFUSES four money questions - a price prediction, buy/sell advice, "wen
      moon", and an answer a hostile model turned into advice - and twice says
      "I have not verified that" and hands back a way to check it independently.

      Three scenes run against a HOSTILE model script: one that gives advice, one
      that invents a holder count for a field it was never shown, one that writes
      its own disclosure. The desk produces a safe answer with any of them
      installed, because the controls are the code either side of the model.
    `,
    plan: [
      'build a FactSheet from a fake chain reader, deliberately WITHOUT a holder index',
      'answer /ca at T0 with no model in the loop at all',
      'answer a natural-language question at T1 and resolve every figure to a cited fact',
      'refuse a price prediction, buy/sell advice and "wen moon" before any model call',
      'answer /holders with the field\'s own self-check instructions',
      'discard a hostile model\'s invented holder count on the grounding check',
      'refuse a hostile model\'s advice on the output classifier',
    ],
    options: [FILTER_OPTION],
    run: () => runDeskDemo(),
  },
  {
    name: 'airlock',
    summary: 'A hostile corpus in, a Digest out, and a flood that costs nothing.',
    detail: `
      Six hostile shapes - a bare address, a URL, a handle, unicode confusables,
      an address split across two messages, and a direct instruction to the agent
      - are assembled into one corpus and read. What crosses to the planning
      plane is a Digest: counts, sixteen closed topic codes, nine closed signal
      codes and scrubbed gists, with no field capable of naming a destination.

      Then three hostile READERS try to get a payload out anyway - in the gists,
      in an invented field, and encoded in the topic counters - and all three are
      refused. Finally a 500,000-message flood is shown to produce a reader turn
      of identical length and identical token count to a 500-message window.
    `,
    plan: [
      'assemble a hostile corpus and print the exact text the reader is handed',
      'read it with a well-behaved scripted model and print the whole Digest',
      'try to smuggle an address, a link, a handle and an amount out in the gists',
      'try to add a field to the emission schema',
      'try to encode a payload in the topic counters',
      'assemble 500 and then --flood messages and compare the reader turns',
    ],
    options: [
      FILTER_OPTION,
      {
        name: 'flood',
        type: 'number',
        default: 500_000,
        placeholder: '<n>',
        describe:
          'Messages in the flood scene. Larger is slower to ASSEMBLE and costs exactly the same to READ, which is the point.',
      },
    ],
    run: (values) => {
      const flood = getNumber(values, 'flood', 500_000)
      if (!Number.isSafeInteger(flood) || flood < 1) {
        throw new CliError('--flood must be a positive integer.')
      }
      if (flood > 5_000_000) {
        throw new CliError(
          `--flood ${String(flood)} would spend minutes of CPU assembling a corpus to prove a point 500,000 already proves. Pick something smaller.`,
        )
      }
      return runAirlockDemo({ flood })
    },
  },
  {
    name: 'broker',
    summary: 'Ten spend proposals through the deterministic gate chain.',
    detail: `
      One client, one catalog, one chain of eighteen gates in fixed order. The
      first proposal is approved; the next nine each break exactly ONE thing -
      solvency, the commitment rule, the rolling cap, the lifetime cap, the
      qualification floor, the payee allowlist, the related-party cap, the rate
      limit, and the human-approval threshold - and the report names the gate
      that caught it and prints the arithmetic it used.

      No model runs anywhere in this package. Given the same inputs the chain
      returns the same decision forever, which is what lets a disputed spend be
      replayed and re-adjudicated by someone who does not trust the operator.
    `,
    plan: [
      'sign and verify a policy token for the vault',
      'resolve a ledger, counters and a catalog into integer cents',
      'run the eighteen-gate chain ten times, breaking one thing each time',
      'print each gate\'s verdict up to and including the one that stopped the chain',
    ],
    options: [FILTER_OPTION],
    run: () => runBrokerDemo(),
  },
  {
    name: 'publisher',
    summary: 'Disclosure injected by code, and a post taken down when it goes missing.',
    detail: `
      Six posts. Three go out: one plain, one after its model-authored disclosure
      and forged receipts link were deleted and replaced with the canonical
      block, and one truncated to fit the channel with the disclosure untouched.
      Two are refused outright - a body naming an address that is not this coin's,
      and a body mentioning another client on the same book. The sixth is
      published, edited by someone with account access, and deleted for it.
    `,
    plan: [
      'publish an operational post and show the canonical disclosure appended by code',
      'publish a post whose model wrote its own disclosure, and show what was stripped',
      'refuse a post carrying an unallowlisted address',
      'refuse a post cross-promoting another client',
      'truncate an over-long body and prove every disclosure token survived',
      'tamper with a published post and watch the read-back check delete it',
    ],
    options: [FILTER_OPTION],
    run: () => runPublisherDemo(),
  },
  {
    name: 'screening',
    summary: 'Four stages, union of flags, and no stage clearing a prior stage.',
    detail: `
      Five subjects through all four stages. One clears and reaches paid media.
      One is RESTRICTED by a third-party mark and a logo match and stays
      RESTRICTED even though the model stage says it is clean and a human
      approves the creative. One is BLOCKED at the first stage and never reaches
      the model at all - then renames itself to something harmless and is blocked
      again, because blocks follow the token. One has its model stage fail, and
      the outage becomes a flag rather than a pass.
    `,
    plan: [
      'screen a clean coin through lexicon, trademark, sanctions, perceptual, adjudication and human review',
      'screen a coin carrying a mark and a logo, with an adjudicator that returns "clean"',
      'screen a coin exploiting a tragedy and watch stage 3 be skipped entirely',
      're-screen the same token under harmless metadata',
      'screen with an adjudicator that throws',
    ],
    options: [FILTER_OPTION],
    run: () => runScreeningDemo(),
  },
  {
    name: 'vault',
    summary: 'Consent to termination, against the compiled contract where it can be.',
    detail: `
      The CREATE2 address, the consent salt and the money-moving ABI signatures
      are COMPUTED from contracts/out/CoinVault.sol. The lifecycle arithmetic is
      NARRATED from a model of CoinVault._splitOf, and every function the
      narration names is checked against the compiled ABI - a missing one prints
      as MISSING and the run reports itself incomplete rather than telling a
      story. The executable proof of the same behaviour is:

        forge test --root contracts
    `,
    plan: [
      'read contracts/out/CoinVault.sol/CoinVault.json',
      'compute the consent salt, the init code hash and the predicted vault address',
      'compute the address the SAME dev would get at a different take rate',
      'check every narrated function against the compiled ABI',
      'walk UNBOUND -> BOUND -> PENDING -> ACTIVE -> settle -> POISONED / TERMINATED',
    ],
    options: [FILTER_OPTION],
    run: () => Promise.resolve(runVaultDemo()),
  },
]

const ALL_NAMES = SUBCOMMANDS.map((s) => s.name)

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function topLevelHelp(): string {
  const lines: string[] = []
  lines.push('demo - run each subsystem against realistic fixtures and print what happened.')
  lines.push('')
  lines.push('USAGE')
  lines.push('  node tools/demo.ts <subcommand> [options]')
  lines.push('')
  lines.push('WHAT THIS SETTLES')
  lines.push('  packages/desk, broker, publisher, screening and runtime have thorough tests and')
  lines.push('  no runnable entry point, so their most important claims could only be asserted.')
  lines.push('  Each subcommand below exercises one of them and prints what it did - including,')
  lines.push('  in every case, what it REFUSED to do, because the refusals are the product.')
  lines.push('')
  lines.push('  No subcommand makes a network request, loads a key, reads a chain, or touches a')
  lines.push('  client or a vendor. Model calls are scripted stand-ins, several of them hostile.')
  lines.push('')
  lines.push('SUBCOMMANDS')
  const width = Math.max(...ALL_NAMES.map((n) => n.length), 3)
  for (const sub of SUBCOMMANDS) {
    lines.push(`  ${sub.name.padEnd(width)}  ${sub.summary}`)
  }
  lines.push(`  ${'all'.padEnd(width)}  Every subcommand above, in order.`)
  lines.push('')
  lines.push('OPTIONS')
  lines.push('  Every subcommand takes --json, --out <file>, --dry-run, --only <scene-id,...>')
  lines.push('  and -v. Run `node tools/demo.ts <subcommand> --help` for the full list.')
  lines.push('')
  lines.push('EXAMPLES')
  lines.push('  node tools/demo.ts broker')
  lines.push('  node tools/demo.ts desk --only desk.refusal.wen_moon')
  lines.push('  node tools/demo.ts airlock --flood 50000')
  lines.push('  node tools/demo.ts all --json --out demo.json')
  return lines.join('\n')
}

function specFor(sub: Subcommand): CommandSpec {
  return {
    name: `demo ${sub.name}`,
    summary: sub.summary,
    detail: sub.detail,
    usage: `node tools/demo.ts ${sub.name} [options]`,
    options: sub.options ?? [],
  }
}

const ALL_SPEC: CommandSpec = {
  name: 'demo all',
  summary: 'Every subcommand, in order.',
  detail: `
    Runs desk, airlock, broker, publisher, screening and vault back to back
    against the same client. Long: about a thousand lines. --json emits one
    document carrying every scene from every subsystem.
  `,
  usage: 'node tools/demo.ts all [options]',
  options: [
    FILTER_OPTION,
    {
      name: 'flood',
      type: 'number',
      default: 500_000,
      placeholder: '<n>',
      describe: 'Messages in the airlock flood scene.',
    },
  ],
}

// ---------------------------------------------------------------------------
// Scene filtering
// ---------------------------------------------------------------------------

/** Apply --only, recomputing the counts so the summary cannot lie. */
function filterScenes(result: DemoResult, only: readonly string[]): DemoResult {
  if (only.length === 0) return result
  const wanted = new Set(only)
  const scenes = result.scenes.filter((s) => wanted.has(s.id))
  return {
    ...result,
    scenes,
    counts: {
      total: scenes.length,
      ok: scenes.filter((s) => s.verdict.kind === 'ok').length,
      refused: scenes.filter((s) => s.verdict.kind === 'refused').length,
      gap: scenes.filter((s) => s.verdict.kind === 'gap').length,
    },
  }
}

function assertFilterMatched(results: readonly DemoResult[], only: readonly string[], all: readonly DemoResult[]): void {
  if (only.length === 0) return
  const matched = new Set(results.flatMap((r) => r.scenes.map((s) => s.id)))
  const missing = only.filter((id) => !matched.has(id))
  if (missing.length === 0) return
  const available = all.flatMap((r) => r.scenes.map((s) => s.id))
  throw new CliError(
    `--only matched nothing for ${missing.join(', ')}. Available scene ids:\n  ${available.join('\n  ')}`,
  )
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface DemoReportResult {
  subsystems: DemoResult[]
  totals: { scenes: number; ok: number; refused: number; gap: number }
}

const STANDING_WARNINGS = [
  'This is a DEMONSTRATION against fixtures, not a measurement. No subcommand makes a network request, loads a key, reads a chain, or touches a real client or vendor. Every address, coin, vendor and amount below is invented.',
  'Where the real product calls a model, this calls a scripted stand-in - and several of those stand-ins are deliberately HOSTILE. What each scene demonstrates is the behaviour of the CODE around the model, which is where every control in this system actually lives.',
]

const METHOD_LIMITS = [
  'The fixtures are realistic but invented. Nothing here measures the chain: for the measurement that drives the STOP verdict see tools/reprice.ts and tools/artifacts/VERDICT.md.',
  '`demo vault` computes addresses and ABI facts from the compiled contract and NARRATES the ledger arithmetic from a model of CoinVault._splitOf. The executable proof is `forge test --root contracts`.',
]

function renderReport(report: Report<DemoReportResult>): string {
  const parts = report.result.subsystems.map((r) => renderDemo(r))
  if (report.result.subsystems.length > 1) {
    const totals = report.result.totals
    parts.push(heading('Across every subsystem'))
    parts.push(
      table(report.result.subsystems, [
        { header: 'subsystem', value: (r) => r.subsystem },
        { header: 'scenes', value: (r) => String(r.counts.total), align: 'right' },
        { header: 'carried out', value: (r) => String(r.counts.ok), align: 'right' },
        { header: 'REFUSED', value: (r) => String(r.counts.refused), align: 'right' },
        { header: 'not verified', value: (r) => String(r.counts.gap), align: 'right' },
      ]),
    )
    parts.push('')
    parts.push(
      banner([
        `${String(totals.scenes)} scenes across ${String(report.result.subsystems.length)} subsystems.`,
        `${String(totals.refused)} of them are the product REFUSING to do something, and ${String(totals.gap)} are it`,
        'saying it has not verified something. That ratio is not an accident and it is not a',
        'limitation: it is the whole difference between this agency and the one a memecoin',
        'operator would otherwise hire.',
      ]),
    )
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(subs: Subcommand[], spec: CommandSpec, values: ParsedValues): Promise<void> {
  const json = getBool(values, 'json')
  const outPath = getString(values, 'out')
  const only = getList(values, 'only')

  if (getBool(values, 'dry-run')) {
    emitDryRun(
      {
        tool: spec.name,
        config: {
          subsystems: subs.map((s) => s.name),
          only: only.length === 0 ? '(all scenes)' : only,
          flood: values.flood ?? '(n/a)',
          network: 'none, ever',
        },
        steps: subs.flatMap((sub) =>
          sub.plan.map((description) => ({ description: `${sub.name}: ${description}` })),
        ),
        estimatedRequestsTotal: 0,
        notes: [
          'This tool performs NO network I/O under any flag, so --dry-run differs from a real run only in that it prints the plan instead of executing it.',
          '`demo vault` reads contracts/out/CoinVault.sol/CoinVault.json from disk. That is the only file any subcommand opens.',
        ],
      },
      json,
    )
    return
  }

  const produced: DemoResult[] = []
  for (const sub of subs) produced.push(await sub.run(values))

  const filtered = produced.map((r) => filterScenes(r, only)).filter((r) => r.scenes.length > 0)
  assertFilterMatched(filtered, only, produced)

  const subsystems = filtered
  const totals = subsystems.reduce(
    (acc, r) => ({
      scenes: acc.scenes + r.counts.total,
      ok: acc.ok + r.counts.ok,
      refused: acc.refused + r.counts.refused,
      gap: acc.gap + r.counts.gap,
    }),
    { scenes: 0, ok: 0, refused: 0, gap: 0 },
  )

  const incompleteReasons = subsystems.flatMap((r) =>
    r.incompleteReasons.map((reason) => `${r.subsystem}: ${reason}`),
  )

  const report: Report<DemoReportResult> = {
    meta: {
      tool: spec.name,
      schemaVersion: SCHEMA_VERSION,
      generatedAtUnix: Math.floor(Date.now() / 1000),
      config: {
        subsystems: subsystems.map((r) => r.subsystem),
        only: only.length === 0 ? null : only,
        ...(values.flood === undefined ? {} : { flood: values.flood }),
      },
      io: { httpRequests: 0, cacheHits: 0, cacheMisses: 0 },
      warnings: [...STANDING_WARNINGS],
      methodLimits: [...METHOD_LIMITS],
      measurementComplete: incompleteReasons.length === 0,
      ...(incompleteReasons.length === 0 ? {} : { incompleteReasons }),
    },
    result: { subsystems, totals },
  }

  await emit(report, { json, outPath, human: renderReport })
}

/**
 * Dispatch. The subcommand is the first non-flag token; everything after it is
 * parsed by that subcommand's own spec, so an unknown flag is still a hard error
 * rather than a silent no-op.
 */
export async function runDemoCli(argv: readonly string[]): Promise<void> {
  const first = argv[0]

  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    process.stdout.write(`${topLevelHelp()}\n`)
    return
  }
  if (first.startsWith('-')) {
    process.stderr.write(
      `demo: expected a subcommand before any flag. Try one of: ${[...ALL_NAMES, 'all'].join(', ')}\n`,
    )
    process.exitCode = 2
    return
  }

  const rest = argv.slice(1)
  const isAll = first === 'all'
  const sub = SUBCOMMANDS.find((s) => s.name === first)
  if (!isAll && sub === undefined) {
    process.stderr.write(
      `demo: unknown subcommand "${first}". Try one of: ${[...ALL_NAMES, 'all'].join(', ')}\n`,
    )
    process.exitCode = 2
    return
  }

  const spec = isAll ? ALL_SPEC : specFor(sub!)
  const subs = isAll ? SUBCOMMANDS : [sub!]

  let values: ParsedValues
  try {
    values = parseArgs(spec, rest)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }
  if (values.help === true) {
    process.stdout.write(`${renderHelp(spec)}\n`)
    return
  }

  try {
    await main(subs, spec, values)
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${spec.name}: ${error.message}\n`)
      process.exitCode = error.exitCode
      return
    }
    // A missing artifact, an unreadable file: an operating condition, not a bug.
    if (error instanceof Error && typeof (error as { code?: unknown }).code === 'string') {
      process.stderr.write(`${spec.name}: ${error.message}\n`)
      process.exitCode = 1
      return
    }
    process.stderr.write(
      `${spec.name}: ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}\n`,
    )
    process.exitCode = 1
  }
}

/** Exported for tests, which drive the dispatcher rather than the process. */
export const DEMO_SUBCOMMANDS = SUBCOMMANDS
export { topLevelHelp, filterScenes }

if (isEntrypoint(import.meta.url)) {
  await runDemoCli(process.argv.slice(2))
}

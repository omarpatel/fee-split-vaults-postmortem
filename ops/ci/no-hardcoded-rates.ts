/**
 * THE HARDCODED-CREATOR-RATE GATE.
 *
 * The creator's net BRANCHES on one per-token setting:
 *
 *     buyback OFF -> 0.70% of volume
 *     buyback ON  -> 0.35% of volume
 *
 * Anything that assumes a single rate is wrong for half the book, and it is
 * wrong in the direction that overstates what a client will earn - the exact
 * error that turns a projection into a misrepresentation. config/protocol.ts
 * exposes creatorNetBps(buybackEnabled, creatorTaxBps) and every consumer must
 * call it. This script fails the build if any other file carries the rate as a
 * literal.
 *
 * HOW IT AVOIDS BEING NOISE. Comments are stripped before scanning, because
 * prose explaining the branch is the opposite of the problem. Three of the four
 * rules additionally require a fee context on the line, so `0.7` as a
 * reliability score or `35` as a percentage of something else does not fire.
 * The one rule with no context requirement - a bare 0.007 or 0.0035 - needs
 * none: those two numbers ARE the rate, in decimal, and there is no innocent
 * reason for either to appear in this repository.
 *
 * Usage:
 *   node ops/ci/no-hardcoded-rates.js [--root <dir>] [--json] [--include-markdown]
 *
 * Exit codes: 0 clean, 1 violations found, 2 the scanner could not run.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { collectFiles, languageFor, lines, matchesGlob, readTextFile, stripComments } from './scan.js'
import { RATE_ALLOWLIST, isAllowed } from './rates-allowlist.js'

export interface RateRule {
  id: string
  description: string
  /** Global, sticky-free: the scanner resets lastIndex per line itself. */
  pattern: RegExp
  /** When set, the line must also match this for the rule to fire. */
  requiresContext?: RegExp
  /**
   * 'production' skips tests and fixture data. Use it for a rule whose subject
   * is legitimately arbitrary in a fixture: a vault's operatorBps is frozen at
   * whatever it was signed at, so a test that constructs a vault at 1,000 bps
   * is modelling a real client, not restating the published rate. In SOURCE the
   * same literal is a second source of truth and is always wrong.
   */
  appliesTo?: 'all' | 'production'
}

/**
 * Paths a 'production' rule does not look at. Fixture builders are included:
 * demo and test data legitimately carry per-vault economics.
 */
export const NON_PRODUCTION_GLOBS = [
  '**/__tests__/**',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/fixtures/**',
  'contracts/test/**',
  'tools/__tests__/**',
] as const

export function isProductionPath(path: string, matches = matchesGlob): boolean {
  return !NON_PRODUCTION_GLOBS.some((glob) => matches(path, glob))
}

/**
 * Words that make a number on the same line a RATE rather than a coincidence.
 * Kept narrow on purpose: a broad list would fire on every line containing the
 * word "fee", and a gate that cries wolf is a gate someone adds a blanket
 * allowlist entry for.
 */
export const FEE_CONTEXT =
  /creator|of\s+volume|hook\s*fee|net\s*bps|fee\s*rate|rate\s*of\s*volume|royalt|creator_?fee|creator_?rate/i

/**
 * A line that names BOTH branches is describing the branch, not assuming one.
 *
 * "0.70% off, 0.35% on" is the correct disclosure and the exact opposite of the
 * failure this gate exists to catch, which is a single rate treated as universal.
 * Skipping those lines is what keeps the rule from firing on the documentation
 * that tells everyone the rule exists.
 *
 * Only applies to the context-gated rules. A bare 0.007 next to a bare 0.0035 is
 * still two hardcoded rates.
 */
const BUYBACK_OFF_BRANCH = new RegExp(String.raw`(?<![\w.\\])(?:0?\.70?|70)\s*%`)
const BUYBACK_ON_BRANCH = new RegExp(String.raw`(?<![\w.\\])(?:0?\.350?|35)\s*%`)

export function namesBothBranches(line: string): boolean {
  return BUYBACK_OFF_BRANCH.test(line) && BUYBACK_ON_BRANCH.test(line)
}

/**
 * How many lines either side of the hit count as "the same disclosure".
 *
 * A single line is the right window for code. It is the WRONG window for prose,
 * and prose is what this gate now scans in legal/: `legal/MSA.md` states the
 * branch correctly, as two consecutive bullets —
 *
 *     - if the Dev's token has **buyback disabled**, the creator's net is **0.70% of volume**;
 *     - if the Dev's token has **buyback enabled**, the creator's net is **0.35% of volume**, ...
 *
 * — which is exactly the disclosure the rule wants and which a per-line check
 * reads as two separate hardcoded rates. Widening to a small neighbourhood
 * implements the rule's stated intent rather than relaxing it: a document that
 * names only ONE branch anywhere near the hit still fires.
 */
export const BRANCH_WINDOW_LINES = 2

export function namesBothBranchesNearby(
  lines: readonly string[],
  index: number,
  window = BRANCH_WINDOW_LINES,
): boolean {
  const from = Math.max(0, index - window)
  const to = Math.min(lines.length - 1, index + window)
  let off = false
  let on = false
  for (let i = from; i <= to; i += 1) {
    const line = lines[i] ?? ''
    if (BUYBACK_OFF_BRANCH.test(line)) off = true
    if (BUYBACK_ON_BRANCH.test(line)) on = true
  }
  return off && on
}

/**
 * Markdown that is ALWAYS scanned, whatever --include-markdown says.
 *
 * Markdown is opt-in because docs/ and README.md are prose explaining the
 * branch, and a gate that fires on its own documentation gets a blanket
 * allowlist entry within a week. `legal/` is not that kind of prose. It is the
 * BINDING DOCUMENT: the MSA and the pilot agreement state the commercial terms
 * to a counterparty, and `legal/TERMS-HASH.json` puts their hash in every vault
 * address. A stale rate in a .ts file is a bug; a stale rate in the MSA is a
 * term the Dev actually agreed to.
 *
 * This was a real hole. `node ops/ci/no-hardcoded-rates.js` is how CI invokes
 * the gate, with no flags, so before this every commercial term in legal/ was
 * invisible to it — verified by planting `gateQfPerDay: 250` in legal/MSA.md and
 * watching the gate report clean.
 */
export const ALWAYS_SCANNED_MARKDOWN_PREFIXES = ['legal/'] as const

export function isAlwaysScannedMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith('.md') && ALWAYS_SCANNED_MARKDOWN_PREFIXES.some((p) => path.startsWith(p))
}

/**
 * Generated measurement output the gate must not read.
 *
 * `tools/artifacts/*.json` is gitignored: a 229 MB escrow document and the JSON
 * reports beside it. CI never sees them, but anyone who has actually run the
 * tools does, so the gate returned different answers on a developer's machine
 * than in CI — `tools/artifacts/reprice-7d.json` reported a
 * `qualification-floor-literal` for the tool's own printed output, quoting the
 * floor correctly. A gate whose result depends on what you happen to have run
 * locally is not a gate.
 *
 * The caches (`tools/.cache`, `tools/.checkpoints`) are excluded one level up,
 * in scan.ts's DEFAULT_EXCLUDED_DIRS, so every scanner gets the same treatment.
 * Only `tools/artifacts` needs naming here: it is output, not a cache.
 *
 * NO TRAILING SLASH: collectFiles matches `relPath === prefix` or
 * `relPath.startsWith(prefix + '/')`, so 'tools/artifacts/' would never match
 * anything.
 */
export const GENERATED_PATH_PREFIXES = ['tools/artifacts'] as const

export const RATE_RULES: readonly RateRule[] = [
  {
    id: 'creator-rate-decimal',
    description:
      'A bare 0.007 / 0.0035 literal. These two numbers are the creator rate expressed as a fraction of ' +
      'volume; there is no other reason for either to appear.',
    // 0.007, .007, 0.0070, 0.00700, 0.0035, .0035, 0.00350 ...
    // The backslash in the lookbehind matters: `0\.007` inside a regex literal
    // is a pattern that DETECTS the rate (a test doing exactly this job), not
    // an occurrence of it.
    pattern: new RegExp(String.raw`(?<![\w.\\])0?\.00(?:70*|350*)(?![\d])`, 'g'),
  },
  {
    id: 'creator-bps-literal',
    description:
      'A creator-rate bps identifier assigned a literal. creatorNetBps is a FUNCTION; a variable of that ' +
      'name holding 70 or 35 is the branch collapsed into a constant.',
    pattern: /\b(?:creator_?net_?bps|creator_?rate_?bps|creator_?fee_?bps)\b\s*[:=]\s*(?:70|35|700|350)\b/gi,
  },
  {
    id: 'creator-rate-percent',
    description: 'A 0.70% / 0.35% / 70% / 35% literal on a line that is talking about the creator fee rate.',
    pattern: new RegExp(String.raw`(?<![\d.\\])(?:0?\.(?:70?|350?)|70|35)\s*%`, 'g'),
    requiresContext: FEE_CONTEXT,
  },
  {
    id: 'creator-rate-decimal-in-fee-context',
    description: 'A bare 0.70 / 0.7 / 0.35 on a line that is talking about the creator fee rate.',
    pattern: new RegExp(String.raw`(?<![\w.\\])0?\.(?:70?|350?)(?![\d%])`, 'g'),
    requiresContext: FEE_CONTEXT,
  },

  // -------------------------------------------------------------------------
  // The published commercial terms.
  //
  // The four rules above cover the CREATOR rate, which is the protocol's number
  // and branches per token. The four below cover OUR numbers - the operator
  // fee, the budget dial, the tier gates and the qualification floor - which
  // config/protocol.ts owns and which nothing else may restate.
  //
  // They exist because of what the September repricing found: operatorBps moved
  // 1000 -> 500 and TIERS.T1.gateQfPerDay moved 250 -> 1000, and the gate that
  // was supposed to stop a commercial term being written down twice reported
  // clean over every file that had written one down. It only ever looked for
  // the creator rate.
  // -------------------------------------------------------------------------

  {
    id: 'published-terms-literal',
    description:
      'A source file assigning operatorBps, budgetBps, budgetBpsDefault or budgetBpsMax a numeric literal. ' +
      'config/protocol.ts owns the published values; read TERMS.* instead. (Tests and fixtures are exempt: ' +
      "a vault's rate is frozen in its salt, so a fixture at any rate is modelling a real client.)",
    // A literal ZERO is exempt for the same reason a zero gate is: "no fee",
    // "no dial" and "not charging" are arguments, not remembered numbers.
    pattern: /\b(?:operator_?bps|budget_?bps(?:_?default|_?max)?)\b\s*[:=]\s*(?!0\b)[0-9][0-9_]*\b/gi,
    appliesTo: 'production',
  },
  {
    id: 'tier-gate-literal',
    description:
      'A tier QF gate written as a literal. Gates live in TIERS[tier].gateQfPerDay and they move: the T1 ' +
      'gate went from 250 to 1,000 USD/day on measurement. A zero gate is allowed, because "no gate" is a ' +
      'real argument and not a remembered number.',
    pattern: /\bgate_?qf_?per_?day\b\s*[:=]\s*(?!0\b)[0-9][0-9_]*\b/gi,
  },
  {
    id: 'qualification-floor-literal',
    description:
      'The qualification floor restated as a literal on a line that is about the floor. It is ' +
      'QUALIFICATION_FLOOR_MONTHLY_USD in config/protocol.ts, and it stopped coinciding with the T1 gate ' +
      'when that gate moved - so anything that remembers the two as one number is now wrong.',
    pattern: /(?<![\w.\\])1[_,]?500(?![\d])/g,
    requiresContext: /qualification|floor/i,
  },
  {
    id: 'dial-as-decimal',
    description:
      'A bare fraction on a line about the budget dial or the procurement slice - the shape a bps ' +
      'parameter takes when someone writes it as a float (0.2 for 2,000 bps). It is TERMS.budgetBpsDefault, ' +
      "or better the coin's own budgetBps, divided by 10,000. A page that computes a client's procurement " +
      'slice from a hardcoded dial tells every dev the default’s number no matter where their dial is set.',
    pattern: new RegExp(String.raw`(?<![\w.\\])0?\.[0-9]+(?![\d%])`, 'g'),
    requiresContext: /dial|procurement|budget/i,
    appliesTo: 'production',
  },
  {
    id: 'shared-window-literal',
    description:
      'The price-staleness window written down outside the module that owns it. money.ts exports ' +
      'PRICE_MAX_AGE_SECONDS; a caller that defaults to 900 or 15 * 60 keeps accepting prices the rest of ' +
      'the broker has already declared too old, and settlement is where a stale price actually moves money.',
    pattern: /\b(?:price_?max_?age_?seconds)\b\s*(?:\?\?|[:=])\s*(?:900\b|15\s*\*\s*60\b)/gi,
    appliesTo: 'production',
  },
]

/** Extensions scanned by default. Markdown is prose and is opt-in via a flag. */
export const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sol', '.sql', '.json', '.yml', '.yaml']

export interface Violation {
  path: string
  line: number
  column: number
  ruleId: string
  excerpt: string
}

export interface ScanReport {
  filesScanned: number
  violations: Violation[]
  /** Allowlist entries that matched nothing. Reported, not fatal. */
  unusedAllowlistPatterns: string[]
  /** Suppressions that fired, so an audit can see what was excused. */
  suppressed: Array<{ path: string; line: number; ruleId: string; reason: string }>
}

const PRAGMA = /no-hardcoded-rates:\s*allow\s+([a-z-]+)\s*[-–—:]\s*(.{10,})/i

export interface ScanOptions {
  root: string
  extensions?: readonly string[]
  includeMarkdown?: boolean
  rules?: readonly RateRule[]
}

export function scanForHardcodedRates(options: ScanOptions): ScanReport {
  const rules = options.rules ?? RATE_RULES
  const extensions = [...(options.extensions ?? DEFAULT_EXTENSIONS), ...(options.includeMarkdown ? ['.md'] : [])]
  // `.md` is collected either way, then filtered: always-scanned prefixes stay,
  // the rest stay only under --include-markdown.
  const collected = collectFiles({
    root: options.root,
    extensions: extensions.includes('.md') ? extensions : [...extensions, '.md'],
    excludedPaths: GENERATED_PATH_PREFIXES,
  })
  const files = collected.filter((file) => {
    if (!file.path.toLowerCase().endsWith('.md')) return true
    return options.includeMarkdown === true || isAlwaysScannedMarkdown(file.path)
  })

  const violations: Violation[] = []
  const suppressed: ScanReport['suppressed'] = []
  const usedPatterns = new Set<string>()

  for (const file of files) {
    let source: string
    try {
      source = readTextFile(file.absolutePath)
    } catch {
      continue
    }
    const stripped = stripComments(source, languageFor(file.path))
    const codeLines = lines(stripped)
    const rawLines = lines(source)

    for (const rule of rules) {
      if (rule.appliesTo === 'production' && !isProductionPath(file.path)) continue
      const allowEntry = isAllowed(file.path, rule.id, matchesGlob)
      if (allowEntry) {
        usedPatterns.add(allowEntry.path)
        continue
      }

      for (let index = 0; index < codeLines.length; index += 1) {
        const codeLine = codeLines[index] ?? ''
        if (codeLine.trim().length === 0) continue
        if (rule.requiresContext) {
          if (!rule.requiresContext.test(codeLine)) continue
          // Prose states the branch across consecutive bullets, so the "names
          // both branches" exemption looks at a small neighbourhood, not one line.
          if (namesBothBranchesNearby(codeLines, index)) continue
        }

        const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
        let match: RegExpExecArray | null
        while ((match = pattern.exec(codeLine)) !== null) {
          if (match[0].length === 0) break
          const pragma = findPragma(rawLines, index, rule.id)
          if (pragma) {
            suppressed.push({ path: file.path, line: index + 1, ruleId: rule.id, reason: pragma })
            break
          }
          violations.push({
            path: file.path,
            line: index + 1,
            column: match.index + 1,
            ruleId: rule.id,
            excerpt: (rawLines[index] ?? '').trim().slice(0, 160),
          })
        }
      }
    }
  }

  // "Stale" means the pattern matches nothing that exists, not merely nothing
  // in this run's extension filter - an entry for a markdown file is not stale
  // just because markdown was not scanned.
  const unusedAllowlistPatterns = RATE_ALLOWLIST.map((e) => e.path).filter(
    (pattern) =>
      !usedPatterns.has(pattern) &&
      !files.some((f) => matchesGlob(f.path, pattern)) &&
      !existsSync(join(options.root, pattern)),
  )

  return {
    filesScanned: files.length,
    violations: violations.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line),
    unusedAllowlistPatterns,
    suppressed,
  }
}

/**
 * An inline suppression on the offending line or the line above it. The pragma
 * must name the rule and carry a reason of at least ten characters, so a blanket
 * `// eslint-disable`-shaped shrug does not silence it.
 */
function findPragma(rawLines: readonly string[], index: number, ruleId: string): string | undefined {
  for (const candidate of [rawLines[index], rawLines[index - 1]]) {
    if (candidate === undefined) continue
    const match = PRAGMA.exec(candidate)
    if (match && match[1]?.toLowerCase() === ruleId.toLowerCase() && match[2]) {
      return match[2].trim()
    }
  }
  return undefined
}

export function formatReport(report: ScanReport): string {
  const out: string[] = []
  if (report.violations.length === 0) {
    out.push(`no-hardcoded-rates: clean (${report.filesScanned} files scanned)`)
  } else {
    out.push(`no-hardcoded-rates: ${report.violations.length} violation(s) in ${report.filesScanned} files scanned`)
    out.push('')
    for (const violation of report.violations) {
      const rule = RATE_RULES.find((r) => r.id === violation.ruleId)
      out.push(`  ${violation.path}:${violation.line}:${violation.column}  [${violation.ruleId}]`)
      out.push(`    ${violation.excerpt}`)
      if (rule) out.push(`    -> ${rule.description}`)
      out.push('')
    }
    out.push('The creator rate branches on buybackEnabled. Call creatorNetBps(buybackEnabled, creatorTaxBps)')
    out.push('from config/protocol.ts instead of writing the number down.')
    out.push('')
    out.push('If the literal is genuinely not a rate, add an entry with a reason to ops/ci/rates-allowlist.ts,')
    out.push('or annotate the line: // no-hardcoded-rates: allow <rule-id> - <why this is not a rate>')
  }
  for (const item of report.suppressed) {
    out.push(`  suppressed ${item.path}:${item.line} [${item.ruleId}] - ${item.reason}`)
  }
  for (const pattern of report.unusedAllowlistPatterns) {
    out.push(`  note: allowlist pattern matched no files and may be stale: ${pattern}`)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function repoRootFromHere(): string {
  // ops/ci/no-hardcoded-rates.{ts,js} -> ops/ci -> ops -> repo root.
  // The same two levels from source and from output, because ops compiles in
  // place; see the comment in ops/tsconfig.json.
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..')
}

export function runCli(argv: readonly string[]): number {
  const rootFlag = argv.indexOf('--root')
  const root = rootFlag === -1 ? repoRootFromHere() : resolve(argv[rootFlag + 1] ?? '.')
  const report = scanForHardcodedRates({ root, includeMarkdown: argv.includes('--include-markdown') })
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatReport(report)}\n`)
  }
  return report.violations.length === 0 ? 0 : 1
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (invokedDirectly) {
  try {
    process.exitCode = runCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`no-hardcoded-rates: scanner failed: ${String(error)}\n`)
    process.exitCode = 2
  }
}

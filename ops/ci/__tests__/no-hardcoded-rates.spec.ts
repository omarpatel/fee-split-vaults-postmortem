/**
 * The gate's own tests.
 *
 * A lint rule nobody has watched fail is a lint rule that does not work. Every
 * rule here gets a positive control (it fires on the thing it is for) and a
 * negative control (it does not fire on the thing it would be annoying about).
 *
 * Fixtures are written to a temporary directory rather than committed, so the
 * repository never contains a file whose purpose is to violate its own gate.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RATE_RULES, namesBothBranches, scanForHardcodedRates } from '../no-hardcoded-rates.js'
import { globToRegExp, matchesGlob, stripComments } from '../scan.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rates-gate-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(relativePath: string, content: string): void {
  const absolute = join(root, relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf8')
}

function scan(): ReturnType<typeof scanForHardcodedRates> {
  return scanForHardcodedRates({ root })
}

describe('creator-rate-decimal', () => {
  it('fires on a bare 0.007 in production code', () => {
    write('src/fees.ts', 'export const RATE = 0.007\n')
    const report = scan()
    expect(report.violations.map((v) => v.ruleId)).toEqual(['creator-rate-decimal'])
    expect(report.violations[0]?.line).toBe(1)
  })

  it('fires on the buyback-on branch too', () => {
    write('src/fees.ts', 'const rate = .0035;\n')
    expect(scan().violations.map((v) => v.ruleId)).toEqual(['creator-rate-decimal'])
  })

  it('does not fire on a number that merely contains those digits', () => {
    write('src/misc.ts', 'const version = 10.0070\nconst ratio = 0.00701\nconst other = 0.0036\n')
    expect(scan().violations).toEqual([])
  })

  it('does not fire inside a comment, because prose explaining the branch is the point', () => {
    write('src/fees.ts', '// the creator gets 0.007 of volume when buyback is off\nexport const X = 1\n')
    expect(scan().violations).toEqual([])
  })

  it('still fires when the literal follows a URL on the same line', () => {
    // A naive comment stripper treats the // in https:// as a line comment and
    // goes blind for the rest of the line. This is that regression.
    write('src/fees.ts', 'const src = "https://example.com/x"; const rate = 0.007;\n')
    expect(scan().violations.map((v) => v.ruleId)).toEqual(['creator-rate-decimal'])
  })
})

describe('creator-rate-percent', () => {
  it('fires on a single-branch percentage in a fee context', () => {
    write('src/copy.ts', 'export const creatorRateCopy = "0.70%"\n')
    expect(scan().violations.map((v) => v.ruleId)).toEqual(['creator-rate-percent'])
  })

  it('does not fire when the line names BOTH branches', () => {
    write('src/copy.ts', 'export const note = "creator rate: 0.70% with buyback off, 0.35% on"\n')
    expect(scan().violations).toEqual([])
  })

  it('does not fire on a percentage with no fee context', () => {
    write('src/ui.ts', 'const width = "70%"\nconst opacity = "35%"\n')
    expect(scan().violations).toEqual([])
  })
})

describe('creator-bps-literal', () => {
  it('fires when a creator-rate bps identifier is assigned a constant', () => {
    write('src/fees.ts', 'const creatorNetBps = 70\n')
    expect(scan().violations.map((v) => v.ruleId)).toContain('creator-bps-literal')
  })

  it('does not fire on a call to the real function', () => {
    write('src/fees.ts', 'const bps = creatorNetBps(vault.buybackEnabled, vault.creatorTaxBps)\n')
    expect(scan().violations).toEqual([])
  })
})

describe('creator-rate-decimal-in-fee-context', () => {
  it('fires on a bare fraction beside the word creator', () => {
    write('src/fees.ts', 'const creatorShare = 0.7\n')
    expect(scan().violations.map((v) => v.ruleId)).toContain('creator-rate-decimal-in-fee-context')
  })

  it('leaves an unrelated 0.7 alone', () => {
    write('src/vendor.ts', 'const reliabilityScore = 0.7\n')
    expect(scan().violations).toEqual([])
  })
})

/**
 * The published-terms rules, tested against the ACTUAL lines that survived the
 * September repricing with the old gate reporting clean. Each positive control
 * below is a real defect this gate did not catch at the time; if one of these
 * stops firing, the gate has gone back to covering the creator rate only.
 */
describe('published-terms-literal', () => {
  it('fires on the pre-repricing rate and dial in a local harness', () => {
    // ops/scheduler/run-local.ts seeded a vault at the old published numbers.
    write('ops/scheduler/run-local.ts', 'ports.vaults.add({ budgetBps: 2000, operatorBps: 1000 })\n')
    expect(scan().violations.map((v) => v.ruleId)).toContain('published-terms-literal')
  })

  it('fires on the new value too, because the problem is the second copy', () => {
    write('src/consent.ts', 'const operatorBps = 500\n')
    expect(scan().violations.map((v) => v.ruleId)).toContain('published-terms-literal')
  })

  it('leaves a read from config alone', () => {
    write('src/consent.ts', 'const operatorBps = TERMS.operatorBps\n')
    expect(scan().violations).toEqual([])
  })

  it('allows zero, which means "not charging" rather than a remembered number', () => {
    write('src/pilot.ts', 'const vault = { budgetBps: 0, operatorBps: 0 }\n')
    expect(scan().violations).toEqual([])
  })

  it("does not fire in a test, where a vault's frozen rate is legitimately arbitrary", () => {
    // A vault's operatorBps is in its CREATE2 salt: a fixture at 1,000 bps is
    // modelling a client signed before the reprice, not restating the default.
    write('packages/broker/src/__tests__/fixtures.ts', 'export const consent = { operatorBps: 1_000 }\n')
    expect(scan().violations).toEqual([])
  })
})

describe('tier-gate-literal', () => {
  it('fires on a QF gate written as a number, in source or in a test', () => {
    write('src/tiers.ts', 'const gate = { gateQfPerDay: 250 }\n')
    write('src/__tests__/tiers.spec.ts', 'analyseGate(doc, { gateQfPerDay: 1000 })\n')
    expect(scan().violations.map((v) => v.ruleId)).toEqual(['tier-gate-literal', 'tier-gate-literal'])
  })

  it('allows a zero gate, which is an argument and not a remembered number', () => {
    write('src/__tests__/qf.spec.ts', 'computeQf(rows, { gateQfPerDay: 0 })\n')
    expect(scan().violations).toEqual([])
  })

  it('leaves TIERS[tier].gateQfPerDay alone', () => {
    write('src/tiers.ts', 'const gate = TIERS.T1.gateQfPerDay\n')
    expect(scan().violations).toEqual([])
  })
})

describe('qualification-floor-literal', () => {
  it('fires when the floor is restated beside the word floor', () => {
    write('src/tiers.ts', 'const qualificationFloor = 1_500\n')
    expect(scan().violations.map((v) => v.ruleId)).toContain('qualification-floor-literal')
  })

  it('does not fire on an unrelated 1500', () => {
    write('src/schedule.ts', 'const jitterSeconds = 1500\n')
    expect(scan().violations).toEqual([])
  })
})

describe('dial-as-decimal', () => {
  it('fires on the dial written as a float in a component', () => {
    // apps/web/src/components/TierPanel.tsx computed a coin's monthly slice as
    // qfPerDayUsd * 0.2 * 30, in a ternary whose branches were both 0.2.
    write(
      'apps/web/src/components/TierPanel.tsx',
      'const monthlyBudgetUsd = (input.qfPerDayUsd * (tier === "T0" ? 0.2 : 0.2)) * 30\n',
    )
    expect(scan().violations.map((v) => v.ruleId)).toContain('dial-as-decimal')
  })

  it('leaves the bps-over-10000 form alone', () => {
    write('apps/web/src/domain/tier.ts', 'const monthlyBudgetUsd = qf * (budgetBps / 10_000) * 30\n')
    expect(scan().violations).toEqual([])
  })

  it('does not fire on a fraction with nothing to do with the dial', () => {
    write('src/sampling.ts', 'const sampleRate = 0.25\n')
    expect(scan().violations).toEqual([])
  })
})

describe('shared-window-literal', () => {
  it('fires when a caller defaults the price window instead of importing it', () => {
    // packages/broker/src/disbursement.ts did exactly this, and no test caught
    // it because every test passed the window explicitly.
    write('packages/broker/src/disbursement.ts', 'const maxAge = args.priceMaxAgeSeconds ?? 15 * 60\n')
    expect(scan().violations.map((v) => v.ruleId)).toContain('shared-window-literal')
  })

  it('leaves the import from the owning module alone', () => {
    write('packages/broker/src/disbursement.ts', 'const maxAge = args.priceMaxAgeSeconds ?? PRICE_MAX_AGE_SECONDS\n')
    expect(scan().violations).toEqual([])
  })
})

describe('suppression', () => {
  it('honours a path allowlist entry', () => {
    // config/protocol.ts is the definition and is allowlisted for every rule.
    write('config/protocol.ts', 'export const RATE = 0.007\n')
    expect(scan().violations).toEqual([])
  })

  it('honours an inline pragma that names the rule and gives a reason', () => {
    write(
      'src/fees.ts',
      '// no-hardcoded-rates: allow creator-rate-decimal - historical fixture from the Phase 0 measurement\n' +
        'const observed = 0.007\n',
    )
    const report = scan()
    expect(report.violations).toEqual([])
    expect(report.suppressed).toHaveLength(1)
    expect(report.suppressed[0]?.reason).toContain('Phase 0')
  })

  it('rejects a pragma with no reason', () => {
    write('src/fees.ts', '// no-hardcoded-rates: allow creator-rate-decimal - short\nconst observed = 0.007\n')
    expect(scan().violations).toHaveLength(1)
  })

  it('rejects a pragma that names a different rule', () => {
    write('src/fees.ts', '// no-hardcoded-rates: allow creator-rate-percent - wrong rule for this line\nconst r = 0.007\n')
    expect(scan().violations).toHaveLength(1)
  })

  it('does not let a test allowlist excuse a bare decimal', () => {
    // The percent rules are relaxed inside tests; the bare-decimal rule is not,
    // so a hardcoded rate cannot hide in a spec file.
    write('src/__tests__/fees.spec.ts', 'expect(rate).toBe(0.007)\n')
    expect(scan().violations.map((v) => v.ruleId)).toEqual(['creator-rate-decimal'])
  })

  it('does relax the percent rule inside tests', () => {
    write('src/__tests__/fees.spec.ts', "it('is 0.70% of volume for the creator', () => {})\n")
    expect(scan().violations).toEqual([])
  })
})

describe('scanning surface', () => {
  it('skips build output and vendored code', () => {
    write('dist/fees.js', 'const rate = 0.007\n')
    write('node_modules/pkg/index.js', 'const rate = 0.007\n')
    write('contracts/lib/forge-std/x.sol', 'uint256 r = 0.007e18;\n')
    expect(scan().violations).toEqual([])
  })

  it('does not scan markdown by default and does when asked', () => {
    write('docs/notes.md', 'The creator rate is 0.007 of volume.\n')
    expect(scan().violations).toEqual([])
    const withMarkdown = scanForHardcodedRates({ root, includeMarkdown: true })
    expect(withMarkdown.violations.map((v) => v.ruleId)).toEqual(['creator-rate-decimal'])
  })

  it('scans SQL and Solidity', () => {
    write('db/x.sql', "INSERT INTO rate VALUES ('x', 0.007);\n")
    write('contracts/src/X.sol', 'uint256 constant RATE = 0.0035 ether;\n')
    expect(scan().violations).toHaveLength(2)
  })

  /**
   * legal/ is the BINDING document. Before this, `node ops/ci/no-hardcoded-rates.js`
   * — exactly how CI invokes the gate, with no flags — never looked at it, so a
   * stale tier gate or operator fee in the MSA was invisible. Verified by
   * planting `gateQfPerDay: 250` in the real legal/MSA.md and watching the gate
   * report clean.
   */
  it('ALWAYS scans legal/ markdown, with no --include-markdown needed', () => {
    write('legal/MSA.md', 'The T1 gate is gateQfPerDay: 250 per day.\n')
    expect(scan().violations.map((v) => v.ruleId)).toEqual(['tier-gate-literal'])
  })

  it('still leaves other markdown opt-in, so docs/ prose does not flood the gate', () => {
    write('docs/ARCHITECTURE.md', 'The T1 gate is gateQfPerDay: 250 per day.\n')
    write('README.md', 'The T1 gate is gateQfPerDay: 250 per day.\n')
    expect(scan().violations).toEqual([])
  })

  /**
   * The gate must return the same answer in CI and on a machine that has run
   * the measurement tools. tools/artifacts holds gitignored JSON output whose
   * own text quotes the floor correctly, and tools/.cache held 5,550 cached RPC
   * responses — 91% of everything the gate scanned.
   */
  it('ignores generated measurement output and the tool caches', () => {
    write('tools/artifacts/reprice-7d.json', '{"detail":"above the $1500.00 floor"}\n')
    write('tools/.cache/response.json', '{"rate":0.007}\n')
    write('tools/.checkpoints/scan/state.json', '{"rate":0.007}\n')
    expect(scan().violations).toEqual([])
  })

  it('but still scans the tools SOURCE beside them', () => {
    write('tools/thing.ts', 'const rate = 0.007\n')
    expect(scan().violations.map((v) => v.path)).toEqual(['tools/thing.ts'])
  })
})

describe('the both-branches exemption spans adjacent lines', () => {
  /**
   * A per-line check is right for code and wrong for prose. legal/MSA.md states
   * the branch as two consecutive bullets, which a per-line rule reads as two
   * separate hardcoded rates.
   */
  it('does not fire when the branch is disclosed across adjacent lines', () => {
    write(
      'legal/MSA.md',
      [
        "- if the Dev's token has **buyback disabled**, the creator's net is **0.70% of volume**;",
        "- if the Dev's token has **buyback enabled**, the creator's net is **0.35% of volume**.",
        '',
      ].join('\n'),
    )
    expect(scan().violations).toEqual([])
  })

  it('STILL fires when only one branch is named anywhere nearby', () => {
    write('legal/MSA.md', "The creator's net is **0.70% of volume**.\n")
    expect(scan().violations.map((v) => v.ruleId)).toEqual(['creator-rate-percent'])
  })

  it('does not reach across a distant part of the document', () => {
    write(
      'legal/MSA.md',
      ["The creator's net is **0.70% of volume**.", '', '', '', '', 'Elsewhere: 0.35% of volume.', ''].join('\n'),
    )
    expect(scan().violations.map((v) => v.ruleId)).toContain('creator-rate-percent')
  })
})

describe('helpers', () => {
  it('every rule has a distinct id and a description', () => {
    const ids = RATE_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const rule of RATE_RULES) expect(rule.description.length).toBeGreaterThan(20)
  })

  it('namesBothBranches recognises the disclosure shape and not a single rate', () => {
    expect(namesBothBranches('0.70% off, 0.35% on')).toBe(true)
    expect(namesBothBranches('70% and 35%')).toBe(true)
    expect(namesBothBranches('just 0.70%')).toBe(false)
  })

  it('stripComments keeps strings and blanks comments without moving line numbers', () => {
    const source = 'const a = "http://x//y" // gone\nconst b = 2\n'
    const stripped = stripComments(source, 'c-like')
    expect(stripped.split('\n')).toHaveLength(3)
    expect(stripped).toContain('"http://x//y"')
    expect(stripped).not.toContain('gone')
  })

  it('globToRegExp handles ** across segments and * within one', () => {
    expect(matchesGlob('packages/core/src/__tests__/a.spec.ts', '**/__tests__/**')).toBe(true)
    expect(matchesGlob('a.spec.ts', '**/*.spec.ts')).toBe(true)
    expect(matchesGlob('packages/core/a.spec.ts', '**/*.spec.ts')).toBe(true)
    expect(matchesGlob('packages/core/src/a.ts', 'packages/*/src/a.ts')).toBe(true)
    expect(matchesGlob('packages/core/deep/src/a.ts', 'packages/*/src/a.ts')).toBe(false)
    expect(globToRegExp('config/protocol.ts').test('config/protocol.ts')).toBe(true)
    expect(globToRegExp('config/protocol.ts').test('xconfig/protocol.ts')).toBe(false)
  })
})

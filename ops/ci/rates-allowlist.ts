/**
 * The allowlist for the hardcoded-creator-rate gate.
 *
 * Every entry needs a REASON, and the reason has to say why the literal is not a
 * second source of truth for the rate. "It's fine" is not a reason. The two
 * legitimate shapes are:
 *
 *   - the definition itself (config/protocol.ts), and the scanner that has to
 *     contain the patterns it looks for;
 *   - a test that pins an EXPECTED OUTPUT of creatorNetBps(). A test asserting
 *     that the branch produces 0.70% off and 0.35% on is the test that would
 *     catch someone hardcoding it, so forbidding the literal there would delete
 *     the check that makes this gate meaningful.
 *
 * What is NOT a legitimate shape: production code computing a rate from a
 * literal, anywhere, for any reason, including "just for the display string".
 */

export interface RateAllowlistEntry {
  /** Repo-relative path or glob. `*` within a segment, `**` across segments. */
  path: string
  /** Rule ids this entry excuses. Omit to excuse every rule for the path. */
  ruleIds?: readonly string[]
  reason: string
}

export const RATE_ALLOWLIST: readonly RateAllowlistEntry[] = [
  {
    path: 'config/protocol.ts',
    reason: 'The definition. creatorNetBps() derives the rate here and every other file calls it.',
  },
  {
    path: 'ops/ci/no-hardcoded-rates.ts',
    reason: 'The scanner itself. It must contain the literals it searches for.',
  },
  {
    path: 'ops/ci/rates-allowlist.ts',
    reason: 'This file. The reasons above quote the rates in order to be legible.',
  },
  {
    path: 'ops/README.md',
    reason:
      'Documents the gate, so it necessarily contains an example of each rule’s trigger. Only reachable ' +
      'with --include-markdown; markdown is not scanned by default.',
  },
  {
    path: 'ops/ci/__tests__/**',
    reason: 'Fixtures for the scanner’s own tests deliberately contain violating literals.',
  },
  {
    path: '**/__tests__/**',
    ruleIds: ['creator-rate-percent', 'creator-rate-decimal-in-fee-context'],
    reason:
      'A test may pin the EXPECTED OUTPUT of creatorNetBps() - that assertion is what catches a hardcoded ' +
      'rate in production code, so it must be allowed to name a branch. The bare-decimal rule still applies ' +
      'here, so a test cannot smuggle in a computed 0.007.',
  },
  {
    path: '**/*.spec.ts',
    ruleIds: ['creator-rate-percent', 'creator-rate-decimal-in-fee-context'],
    reason: 'Same as above, for spec files that sit beside their source rather than in a __tests__ directory.',
  },
  {
    path: 'packages/broker/src/money.ts',
    ruleIds: ['shared-window-literal'],
    reason:
      'The definition. money.ts is the module that OWNS the price-staleness window and exports ' +
      'PRICE_MAX_AGE_SECONDS; the rule exists to stop every other file restating it.',
  },
  {
    path: 'contracts/test/**',
    ruleIds: ['creator-rate-percent'],
    reason:
      'Solidity assertion messages describe splits in percentage terms ("dev keeps 70% at a 20% dial"). The ' +
      'numbers being asserted are integers in the test body, not a rate literal.',
  },
]

export function findAllowlistEntries(path: string, matches: (path: string, pattern: string) => boolean): RateAllowlistEntry[] {
  return RATE_ALLOWLIST.filter((entry) => matches(path, entry.path))
}

export function isAllowed(
  path: string,
  ruleId: string,
  matches: (path: string, pattern: string) => boolean,
): RateAllowlistEntry | undefined {
  return RATE_ALLOWLIST.find(
    (entry) => matches(path, entry.path) && (entry.ruleIds === undefined || entry.ruleIds.includes(ruleId)),
  )
}

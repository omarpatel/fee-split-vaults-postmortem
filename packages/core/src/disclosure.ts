/**
 * IS THE OPERATOR NAMED? One definition, imported everywhere.
 *
 * WHY THIS FILE EXISTS. `config/protocol.ts` ships
 * `DISCLOSURE.operatorName = 'SET_ME_BEFORE_LAUNCH'`, and four independent
 * places had to decide whether that was a real name before letting anything
 * reach the public. They each wrote their own rule, and the four rules did not
 * agree:
 *
 *   apps/api/src/config.ts        /^set_me|^change_?me|^tbd$|^todo$/i
 *   packages/publisher/publisher  [/^set_me/i, /^change_?me/i, /^tbd$/i, /^todo$/i]
 *   packages/pilot/src/notice.ts  /SET_ME|TODO|PLACEHOLDER/i   (unanchored)
 *   packages/desk/src/answer.ts   operatorName === DISCLOSURE.operatorName
 *
 * All four caught the one shipped sentinel, which is why nothing looked wrong.
 * The desk's was broken in BOTH directions anyway:
 *
 *   - It let every other placeholder through. `disclosureFooter({operatorName:
 *     'TBD'})` returned "AI-operated - TBD" and published it. So did 'TODO',
 *     'CHANGEME' and 'set_me_now'. The other three guards refuse all of those.
 *
 *   - It would have broken AT LAUNCH. The check is equality against the
 *     compiled constant, not a test of placeholder-ness. `.env.example` and
 *     `docs/OPERATIONS.md` both document editing `config/protocol.ts` to the
 *     real name as a supported path. Take it, and `DISCLOSURE.operatorName`
 *     becomes 'Acme Ops Ltd' — at which point every desk caller passing the
 *     operator's own name (which is exactly what `apps/api` resolves it to)
 *     trips `options.operatorName === DISCLOSURE.operatorName` and the desk
 *     refuses to emit anything at all. A guard that fires only once the
 *     placeholder is FIXED is worse than no guard.
 *
 * So: one predicate, four call sites, and a coherence check that fails the
 * build on a fifth local copy. Rules of this file follow destinations.ts:
 *
 *   1. Defined here exactly once and imported.
 *   2. WIDEN rather than narrow on ambiguity. A false positive refuses to
 *      publish and someone fixes a config line. A false negative publishes a
 *      legally-required disclosure that names nobody, under three regimes
 *      (FTC Endorsement Guides, EU AI Act Art. 50, CA SB 1001) that each
 *      require the disclosure to be IN the communication.
 *   3. Anchored or whole-word, so a real name is not rejected for containing a
 *      substring. `/TODO/i` — the pilot's rule — rejects "Todos Ltd".
 */

/**
 * Shapes that are not a name.
 *
 * Deliberately NOT included: `example`. `packages/desk/src/__tests__/
 * fixtures.ts` uses 'Example Ops Ltd' as a valid operator throughout the desk
 * suite, and "Example" is a plausible enough trading name that rejecting it
 * would be a rule about this repository's fixtures rather than about reality.
 * If that changes, change the fixture first.
 */
export const PLACEHOLDER_OPERATOR_NAME_PATTERNS: readonly RegExp[] = [
  // NOT `\b` after "me". `_` is a word character, so `/^set[-_ ]?me\b/` does
  // NOT match 'SET_ME_BEFORE_LAUNCH' — the one string this whole file exists to
  // catch. The lookahead is "not continued by a letter or digit", which stops
  // at '_', '-', ' ' and end-of-string while still admitting 'Setmeal'.
  /^set[-_ ]?me(?![a-z0-9])/i,
  /^change[-_ ]?me(?![a-z0-9])/i,
  /^tb[ad]$/i,
  /^todo$/i,
  /\bplaceholder\b/i,
  /^your[-_ ]/i,
  /^(?:n\/a|na|none|null|undefined|unset|unknown)$/i,
  /^x{3,}$/i,
]

/** The shortest string that could be a legal entity name. */
export const MIN_OPERATOR_NAME_LENGTH = 2

/**
 * True when `name` is absent, too short, or one of the placeholder shapes.
 *
 * Whitespace is trimmed first: '  ' and '\tSET_ME_BEFORE_LAUNCH\n' are both
 * placeholders, and a name that is only whitespace names nobody just as much as
 * an empty one does.
 */
export function isPlaceholderOperatorName(name: string | undefined | null): boolean {
  if (name === undefined || name === null) return true
  const trimmed = name.trim()
  if (trimmed.length < MIN_OPERATOR_NAME_LENGTH) return true
  return PLACEHOLDER_OPERATOR_NAME_PATTERNS.some((pattern) => pattern.test(trimmed))
}

/**
 * The trimmed operator name, or a thrown error carrying `context`.
 *
 * Callers pass their own error constructor so each surface keeps its own error
 * type (ConfigError, PublisherConfigError, DeskConfigError, DisclosureError)
 * and its own catch sites, while the PREDICATE stays single-sourced. The
 * message deliberately quotes the offending value: "operatorName is still a
 * placeholder" with no value in it sends the reader looking in the wrong file.
 */
export function requireOperatorName(
  name: string | undefined | null,
  makeError: (message: string) => Error,
): string {
  if (isPlaceholderOperatorName(name)) {
    throw makeError(
      `operatorName is unset or still a placeholder (${JSON.stringify(name ?? null)}); ` +
        `disclosure would name nobody. Set VENUE_OPERATOR_NAME, or set DISCLOSURE.operatorName ` +
        `in config/protocol.ts, before anything is published.`,
    )
  }
  return (name as string).trim()
}

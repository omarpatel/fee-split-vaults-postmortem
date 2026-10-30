/**
 * DESTINATION SHAPES. One definition, imported everywhere.
 *
 * WHY THIS FILE EXISTS. Before it, four independent copies of "what an address
 * looks like" lived in packages/core/src/airlock.ts (twice), in
 * packages/publisher/src/links.ts, and in packages/desk/src/t1/grounding.ts.
 * Every copy was written `0x[a-fA-F0-9]{n,}` with a `g` flag and no `i` flag, so
 * the hex BODY was case-insensitive by character class while the two-character
 * PREFIX was a case-sensitive literal. `0X…` is the same address to a human, to
 * a block explorer and to every wallet, and it was invisible to all four walls
 * at once. Four copies of a rule is one rule with four chances to be wrong, and
 * they were all wrong in the same way.
 *
 * RULES OF THIS FILE.
 *   1. A destination shape is defined here exactly once and imported. A local
 *      re-declaration anywhere else is a defect; tools/check-coherence.mjs fails
 *      the build on one.
 *   2. Every rule widens rather than narrows on ambiguity. A false positive
 *      refuses a post; a false negative publishes an attacker's address under
 *      the operator's own disclosure.
 *   3. Nothing here is "the defense". The defense is that the planner has no
 *      tool that accepts a payee. This is the layer that fails loudly when
 *      someone widens a schema and forgets why it was narrow.
 *
 * NOT DEFINED HERE: the anchored `^0x[a-fA-F0-9]{40}$` validators in the broker
 * and the API. Those are canonical-FORM checks - they answer "is this exactly a
 * well-formed address?" and must stay strict, because a `0X`-prefixed string is
 * something we refuse to accept as an address, not something we normalise.
 */

/**
 * Characters that render as nothing, or that reorder rendering, and are
 * therefore the standard carrier for a hidden payload. This class is the union
 * of everything any plane in this repository used to strip separately:
 *
 *   - C0 controls, DEL, and the whole C1 block (U+0080-U+009F, which includes
 *     NEL U+0085 - absent from the publisher's old class, which is how a plain
 *     lowercase `0x` address could be split and still defeat the address wall)
 *   - soft hyphen, combining grapheme joiner, Arabic letter mark
 *   - Hangul fillers and the Khmer/Mongolian invisible modifiers
 *   - zero-width space / non-joiner / joiner and the bidi marks
 *   - LINE SEPARATOR U+2028 and PARAGRAPH SEPARATOR U+2029
 *   - the bidi overrides U+202A-U+202E and NARROW NO-BREAK SPACE U+202F
 *   - word joiner, invisible operators, bidi isolates
 *   - variation selectors, BOM, halfwidth Hangul filler, interlinear annotation
 *   - the Unicode Tag block, which encodes arbitrary ASCII invisibly
 *
 * DELIBERATELY ABSENT: U+00A0 and the U+2000-U+200A / U+205F / U+3000 space
 * separators. Those render as a visible gap, so splitting an address with one
 * produces copy a holder can see is broken rather than a hidden payload. They
 * are folded to an ordinary space by `foldSpaces` instead of being deleted,
 * because deleting them would silently join words in legitimate copy.
 *
 * Built from escapes rather than literals: a literal invisible character in
 * source is a character nobody can review.
 */
const INVISIBLE_SOURCE =
  '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F' +
  '\\u00AD\\u034F\\u061C' +
  '\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180E' +
  '\\u200B-\\u200F' +
  '\\u2028\\u2029' +
  '\\u202A-\\u202F' +
  '\\u2060-\\u2064\\u2066-\\u206F' +
  '\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF9-\\uFFFB' +
  '\\u{E0000}-\\u{E007F}'

const INVISIBLE = new RegExp(`[${INVISIBLE_SOURCE}]`, 'gu')

/** Space separators that are real spaces. Folded, never deleted. See above. */
const SPACE_SEPARATORS = new RegExp('[\u00A0\u1680\u2000-\u200A\u205F\u3000]', 'gu')

/** Delete every invisible/format character. The one definition; import it. */
export function stripInvisible(raw: string): string {
  return raw.replace(INVISIBLE, '')
}

/** Fold visible-but-exotic space separators onto U+0020. */
export function foldSpaces(raw: string): string {
  return raw.replace(SPACE_SEPARATORS, ' ')
}

/**
 * The form every destination rule below is evaluated against.
 *
 * THE STRIP RUNS ON BOTH SIDES OF NFKC, and that is not belt-and-braces - it is
 * required. NFKC maps several format characters onto ORDINARY SPACES: U+202F
 * NARROW NO-BREAK SPACE is the one that was demonstrated, and it folds to U+0020
 * before a later strip can ever see it. Strip only after NFKC and an address
 * split by U+202F arrives as "0x1a2 B3c…" - broken into fragments no address
 * rule matches. Strip only before NFKC and a fullwidth payload survives. Both,
 * in this order, and neither trick works.
 */
export function foldForDetection(raw: string): string {
  return foldSpaces(stripInvisible(stripInvisible(raw).normalize('NFKC')))
}

/**
 * EVM-shaped hex. Three shapes, because an address is 40 hex characters and the
 * `0x` in front of it is a display convention, not part of the value:
 *
 *   1. a `0x`/`0X` prefixed run of 4+ hex characters - fragments included, since
 *      eight five-character fragments reassemble into an address;
 *   2. a bare 40-character hex run (an address with the convention dropped);
 *   3. a bare 64-character hex run (a tx hash, a pool id, a private key).
 *
 * The bare forms use hex lookarounds rather than `\b`, because every hex
 * character is a word character and `\b` would not fire inside a longer run. The
 * lookbehind also excludes `x`/`X` so a prefixed address is reported once, by
 * rule 1, rather than twice.
 */
const ADDRESS_PREFIXED_SOURCE = '0[xX][0-9a-fA-F]{4,}'
const ADDRESS_BARE_40_SOURCE = '(?<![0-9a-fA-FxX])[0-9a-fA-F]{40}(?![0-9a-fA-F])'
const ADDRESS_BARE_64_SOURCE = '(?<![0-9a-fA-FxX])[0-9a-fA-F]{64}(?![0-9a-fA-F])'

export const ADDRESS_LIKE_SOURCE = [
  ADDRESS_PREFIXED_SOURCE,
  ADDRESS_BARE_64_SOURCE,
  ADDRESS_BARE_40_SOURCE,
].join('|')

/** Solana-style and other long base58 payloads. */
export const BASE58_LIKE_SOURCE = '\\b[1-9A-HJ-NP-Za-km-z]{28,}\\b'

/**
 * Naming-service names. These are NOT websites: a wallet RESOLVES venuevault.eth
 * to an address, so this is a payment destination in the exact sense the airlock
 * says the Digest has no field capable of holding. There is no allowlist
 * exception - the desk has no legitimate reason to name a resolvable name.
 *
 * The label is required to be three characters or more so that a version
 * wildcard ("22.x") or a phone number ("1.888…") is not read as a name.
 *
 * `.x` is deliberately omitted despite being a real Unstoppable Domains TLD:
 * "release-1.x" and "node 22.x" are ordinary prose and the false-positive rate
 * is not worth the one extra registry.
 */
const NAMING_SERVICE_TLDS =
  'eth|crypto|nft|wallet|bitcoin|dao|blockchain|888|zil|sol|bnb|arb|base|lens|tez|near|avax|ftm'

export const NAMING_SERVICE_SOURCE = `\\b[a-z0-9][a-z0-9-]{1,}[a-z0-9]\\.(?:${NAMING_SERVICE_TLDS})\\b`

/**
 * A host, detected by SHAPE rather than by a TLD list.
 *
 * The control this replaces was an allowlist gated by a deny-list: a span of
 * text only became a link candidate if its TLD appeared in a finite list, so a
 * host on any other TLD was never handed to the allowlist at all. Nineteen of
 * twenty-one TLDs tested walked straight through, `.top`, `.click`, `.icu`,
 * `.cfd` and `.sbs` among them - the five most abused TLDs in crypto phishing.
 *
 * So: anything with a dot between two label-shaped runs and an alphabetic final
 * label is a candidate, and the allowlist decides. The final label must be
 * alphabetic and at least two characters, which is what keeps decimals ("3.5"),
 * version strings ("v1.2.3") and the ordinary abbreviations ("e.g.", "a.m.",
 * "U.S.A.") out - in each of those the final label is a digit or one letter.
 */
export const HOST_LIKE_SOURCE =
  '\\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\\.[a-z]{2,24}\\b'

/**
 * Dotted tokens that are shaped like a host and are not one. Kept deliberately
 * short: whitelisting a handful of prose forms is sound, whitelisting thirty
 * TLDs is the control this file exists to remove.
 */
const NON_HOST_TOKENS = new Set(['node.js', 'next.js', 'nuxt.js', 'vue.js', 'react.js', 'three.js'])

/**
 * Contact identifiers.
 *
 * The old rule matched the `@` SIGIL and required a non-word character before
 * it, so it blocked the decoration and not the identifier: "dm
 * vnx_support_desk on telegram" and "write me@vnx_support_desk" both walked
 * past it. Impersonated-support-DM is the single most common memecoin drain
 * funnel, so both forms are refused now:
 *
 *   1. `@name` anywhere, whatever precedes it;
 *   2. a bare underscored identifier, which is what a platform handle looks like
 *      once the sigil is dropped and which has no place in outbound copy.
 */
export const HANDLE_SIGIL_SOURCE = '@[A-Za-z0-9_]{2,}'
export const HANDLE_IDENTIFIER_SOURCE = '\\b[A-Za-z0-9]{1,}(?:_[A-Za-z0-9]{1,}){1,}\\b'

/** Invite shapes that are destinations regardless of how the host is spelled. */
export const INVITE_SOURCE = '\\b(?:t\\.me|discord\\.gg|telegram\\.me)\\b'

/** Explicit URLs. */
export const URL_SOURCE = '\\b(?:https?:\\/\\/|www\\.)'

/** Dot-obfuscation: "evil [dot] com", "evil(.)com", "evil {dot} com", "evil dot com". */
export const OBFUSCATED_HOST_SOURCE =
  '\\b[a-z0-9-]{2,}\\s*(?:\\[\\s*(?:\\.|dot)\\s*\\]|\\(\\s*(?:\\.|dot)\\s*\\)|\\{\\s*(?:\\.|dot)\\s*\\}|\\s+dot\\s+)\\s*[a-z]{2,}\\b'

/** Anything that reads as an amount of money or a multiple of one. */
export const AMOUNT_LIKE: ReadonlyArray<readonly [RegExp, string]> = [
  [/[$€£¥₿]\s*\d/u, 'currency amount'],
  [/\d\s*(?:%|x\b)/iu, 'multiplier or percentage'],
  [
    /\b\d[\d.,]*\s*(?:eth|weth|usd|usdc|usdg|usdt|sol|btc|bnb|k|m|bn|million|billion)\b/iu,
    'denominated amount',
  ],
  [/\b(?:eth|weth|usd|usdc|usdg|usdt|sol|btc)\s*\d/iu, 'denominated amount'],
  [/\d{4,}/u, 'long digit run'],
]

/**
 * Everything that names a destination, in one ordered list. The order is the
 * order the reason codes are reported in, so it is reproducible for a given
 * input.
 */
export const DESTINATION_LIKE: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(ADDRESS_LIKE_SOURCE, 'u'), 'address-like token'],
  [new RegExp(URL_SOURCE, 'iu'), 'url'],
  [new RegExp(BASE58_LIKE_SOURCE, 'u'), 'base58-like token'],
  [new RegExp(NAMING_SERVICE_SOURCE, 'iu'), 'naming-service destination'],
  [new RegExp(INVITE_SOURCE, 'iu'), 'invite link'],
  [new RegExp(HANDLE_SIGIL_SOURCE, 'u'), 'social handle'],
  [new RegExp(HANDLE_IDENTIFIER_SOURCE, 'u'), 'contact identifier'],
  [new RegExp(OBFUSCATED_HOST_SOURCE, 'iu'), 'obfuscated host'],
]

function matchAll(text: string, source: string, flags: string): string[] {
  return text.match(new RegExp(source, `g${flags}`)) ?? []
}

/** Every address-shaped token in `text`, on the detection fold. */
export function addressLikeTokens(text: string): string[] {
  return matchAll(foldForDetection(text), ADDRESS_LIKE_SOURCE, 'u')
}

/** Every naming-service name in `text`. */
export function namingServiceTokens(text: string): string[] {
  return matchAll(foldForDetection(text), NAMING_SERVICE_SOURCE, 'iu')
}

/** Every host-shaped token in `text`, minus the prose forms that are not hosts. */
export function hostLikeTokens(text: string): string[] {
  return matchAll(foldForDetection(text), HOST_LIKE_SOURCE, 'iu').filter(
    (t) => !NON_HOST_TOKENS.has(t.toLowerCase()),
  )
}

/**
 * True when `text` names a DESTINATION - somewhere a human or a wallet could
 * send money or attention. Amounts are deliberately excluded: an amount is
 * scrubbed to a marker, a destination is dropped whole.
 */
export function carriesDestination(text: string): boolean {
  const folded = foldForDetection(text)
  if (DESTINATION_LIKE.some(([pattern]) => pattern.test(folded))) return true
  return containsHostLike(folded)
}

/** True when `text` carries a host-shaped token that is not a known prose form. */
export function containsHostLike(text: string): boolean {
  return hostLikeTokens(text).length > 0
}

/** Every contact identifier in `text`: `@name` and bare underscored handles. */
export function handleTokens(text: string): string[] {
  const folded = foldForDetection(text)
  return [
    ...matchAll(folded, HANDLE_SIGIL_SOURCE, 'u'),
    ...matchAll(folded, HANDLE_IDENTIFIER_SOURCE, 'u'),
  ]
}

/**
 * Compare two address spellings. `0X…`, `0x…` and the prefix-free form are the
 * same destination, so the allowlist has to say so too - otherwise the fix to
 * the matcher would just move the bypass into the comparison.
 */
export function normalizeAddressToken(value: string): string {
  return value.trim().replace(/^0[xX]/, '').toLowerCase()
}

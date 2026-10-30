/**
 * The narrative intake, mirrored.
 *
 * At onboarding a dev may name up to four documents (the launch post, the
 * site) that the operator derives the coin's summary from, and an X handle.
 * apps/api refuses a source it would never fetch: anything but a plain https
 * URL on a public, dotted hostname, with no credentials, port, IP literal or
 * punycode. The checks here are the same checks so the form can say "this one
 * will be refused, and why" before the request leaves the browser, and so the
 * fixture backend refuses what the real one would.
 *
 * Nothing here fetches anything. The URLs are stored, unfetched, until an
 * operator asks for the derivation.
 */

export const MAX_NARRATIVE_SOURCES = 4
const MAX_SOURCE_URL_CHARS = 2_048

const IP_HOST = /^(?:\d{1,3}\.){3}\d{1,3}$/
/** An X handle as the dev typed it, optional leading '@'. */
const X_HANDLE = /^@?[A-Za-z0-9_]{1,15}$/

export type NarrativeSourceProblem =
  | 'url_length'
  | 'url_whitespace'
  | 'unparseable_url'
  | 'insecure_scheme'
  | 'url_carries_credentials'
  | 'url_has_explicit_port'
  | 'ip_literal_host'
  | 'punycode_host'
  | 'host_not_public'

/** Why the API would refuse this source URL, or null when it would not. */
export function narrativeSourceProblem(raw: string): NarrativeSourceProblem | null {
  if (raw.length === 0 || raw.length > MAX_SOURCE_URL_CHARS) return 'url_length'
  if (/[\s\u0000-\u001f]/.test(raw)) return 'url_whitespace'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'unparseable_url'
  }
  if (url.protocol !== 'https:') return 'insecure_scheme'
  if (url.username !== '' || url.password !== '') return 'url_carries_credentials'
  if (url.port !== '') return 'url_has_explicit_port'
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (IP_HOST.test(host) || host.startsWith('[')) return 'ip_literal_host'
  if (host.includes('xn--')) return 'punycode_host'
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return 'host_not_public'
  return null
}

/** The sentence the form shows next to a refused source. */
export function describeNarrativeSourceProblem(problem: NarrativeSourceProblem): string {
  switch (problem) {
    case 'url_length':
      return 'Too long to be a link we would fetch.'
    case 'url_whitespace':
      return 'Contains whitespace; paste the address on its own.'
    case 'unparseable_url':
      return 'Not a full address. Start with https://.'
    case 'insecure_scheme':
      return 'Only https:// links are accepted.'
    case 'url_carries_credentials':
      return 'Links must not carry a username or password.'
    case 'url_has_explicit_port':
      return 'Links must not name a port.'
    case 'ip_literal_host':
      return 'Links must use a hostname, not an IP address.'
    case 'punycode_host':
      return 'Internationalised (xn--) hostnames are not accepted.'
    case 'host_not_public':
      return 'The hostname has to be a public, dotted domain.'
  }
}

/**
 * The sources as the API would store them: trimmed, blanks dropped, duplicates
 * collapsed. Validity is the caller's question; this only normalises.
 */
export function normalizeNarrativeSources(inputs: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const input of inputs) {
    const url = input.trim()
    if (url.length > 0) seen.add(url)
  }
  return [...seen]
}

/**
 * The handle the API stores, without the '@', or null when the API would
 * refuse it. An empty input is null too: the field is optional.
 */
export function normalizeXHandle(input: string): string | null {
  const handle = input.trim()
  if (!X_HANDLE.test(handle)) return null
  return handle.replace(/^@/, '')
}

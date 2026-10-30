/**
 * Fetches one narrative source document the dev named at onboarding.
 *
 * THE DOCUMENT IS UNTRUSTED. It is attacker-authored web content, and the only
 * thing that leaves this module is its visible text plus a content hash. The
 * text goes to the READER plane (no tools) for summarisation and is never
 * shown to the planner; the hash goes on the approved NarrativeProfile for
 * audit. Nothing here interprets the page.
 *
 * WHAT IS REFUSED, AND WHY.
 *
 *   - Anything but a plain https URL on a public, ASCII hostname. The rules
 *     are the publisher's link rules: no userinfo (`https://a.com@evil.tld`
 *     is a link to evil.tld), no explicit port, no IP literal, no punycode.
 *     A hostname without a dot is not a public web page either; refusing it
 *     also refuses `https://localhost` and every single-label intranet name.
 *   - Redirects to anywhere those rules would refuse. Each hop is re-checked.
 *   - Content that is not HTML or plain text. A PDF or an image is not a
 *     narrative source we can summarise.
 *   - x.com / twitter.com status URLs WITHOUT an operator bearer token. X does
 *     not serve tweet text to an unauthenticated fetch, and the alternative -
 *     scraping a rendered page - is both fragile and against terms. With a
 *     token the tweet is read through GET /2/tweets/:id, which returns exactly
 *     the text field and nothing else.
 *
 * THE BYTE CAP TRUNCATES RATHER THAN REFUSES. A long page is still a page; the
 * reader has its own per-source character cap downstream. The sha256 is over
 * the bytes actually consumed, so what is hashed is what was summarised.
 */

import { createHash } from 'node:crypto'

export type NarrativeFetchErrorCode =
  | 'bad_url'
  | 'unreachable'
  | 'http_status'
  | 'too_many_redirects'
  | 'unsupported_content'
  | 'empty_document'
  | 'x_token_missing'
  | 'malformed_response'

export class NarrativeFetchError extends Error {
  constructor(
    message: string,
    readonly code: NarrativeFetchErrorCode,
    override readonly cause?: unknown,
  ) {
    super(`narrative fetch: ${message}`)
    this.name = 'NarrativeFetchError'
  }
}

export interface NarrativeSource {
  /** The URL as validated, after redirects. */
  readonly url: string
  readonly kind: 'page' | 'tweet'
  /** Visible text only: no markup, no scripts, entities decoded, whitespace collapsed. */
  readonly text: string
  /** sha256 hex of the bytes consumed (the capped document, or the tweet API body). */
  readonly sha256: string
  /** Bytes consumed. Equal to maxBytes when the document was truncated. */
  readonly bytes: number
}

export interface FetchNarrativeOptions {
  fetch: typeof fetch
  /** Bytes read from the body before the read stops. The document is truncated, not refused. */
  maxBytes: number
  timeoutMs: number
  /**
   * Operator bearer token for GET /2/tweets/:id. Absent means x.com status
   * URLs are refused with `x_token_missing`; they are never scraped.
   */
  xBearerToken?: string
  /** Overridable for tests. Defaults to https://api.x.com. */
  xApiBaseUrl?: string
}

const IP_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/
const X_HOSTS: Readonly<Record<string, true>> = {
  'x.com': true,
  'www.x.com': true,
  'twitter.com': true,
  'www.twitter.com': true,
  'mobile.twitter.com': true,
}
const X_STATUS_PATH = /^\/[A-Za-z0-9_]{1,15}\/status(?:es)?\/(\d{1,25})(?:\/|$)/
const MAX_REDIRECTS = 3
const X_API_BASE = 'https://api.x.com'

/**
 * The reason a candidate source URL is refused, or null when it is acceptable.
 * Shared by the onboarding intake (which stores the URL) and the fetch (which
 * dereferences it), so the two cannot disagree about what a source may be.
 */
export function narrativeSourceUrlProblem(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2_048) return 'url_length'
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

export async function fetchNarrativeSource(
  rawUrl: string,
  options: FetchNarrativeOptions,
): Promise<NarrativeSource> {
  const problem = narrativeSourceUrlProblem(rawUrl)
  if (problem !== null) throw new NarrativeFetchError(`refused source url (${problem})`, 'bad_url')
  if (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new NarrativeFetchError('maxBytes must be a positive integer', 'bad_url')
  }

  const url = new URL(rawUrl)
  const statusMatch =
    X_HOSTS[url.hostname.toLowerCase()] === true ? X_STATUS_PATH.exec(url.pathname) : null
  if (statusMatch !== null) return fetchTweet(url, statusMatch[1]!, options)
  return fetchPage(url, options)
}

async function fetchTweet(
  url: URL,
  tweetId: string,
  options: FetchNarrativeOptions,
): Promise<NarrativeSource> {
  if (options.xBearerToken === undefined || options.xBearerToken.length === 0) {
    throw new NarrativeFetchError(
      'an x.com status can only be read through the X API; no bearer token was configured and pages are never scraped',
      'x_token_missing',
    )
  }
  const endpoint = `${(options.xApiBaseUrl ?? X_API_BASE).replace(/\/$/, '')}/2/tweets/${tweetId}?tweet.fields=text`
  const response = await request(endpoint, options, {
    authorization: `Bearer ${options.xBearerToken}`,
    accept: 'application/json',
  })
  if (!response.ok) {
    throw new NarrativeFetchError(`X API answered ${String(response.status)}`, 'http_status')
  }
  const body = await readCapped(response, options.maxBytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(body.bytes.toString('utf8'))
  } catch (error) {
    throw new NarrativeFetchError('X API body is not JSON', 'malformed_response', error)
  }
  const data = (parsed as { data?: { text?: unknown } } | null)?.data
  if (typeof data?.text !== 'string') {
    throw new NarrativeFetchError('X API body has no data.text', 'malformed_response')
  }
  const text = collapseWhitespace(decodeEntities(data.text))
  if (text.length === 0) throw new NarrativeFetchError('tweet has no text', 'empty_document')
  return {
    url: url.toString(),
    kind: 'tweet',
    text,
    sha256: createHash('sha256').update(body.bytes).digest('hex'),
    bytes: body.bytes.length,
  }
}

async function fetchPage(start: URL, options: FetchNarrativeOptions): Promise<NarrativeSource> {
  let url = start
  let response: Response | undefined
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    response = await request(url.toString(), options, {
      accept: 'text/html, application/xhtml+xml, text/plain;q=0.9',
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    if (location === null) throw new NarrativeFetchError('redirect without a location', 'malformed_response')
    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      throw new NarrativeFetchError('redirect to an unparseable location', 'bad_url')
    }
    const problem = narrativeSourceUrlProblem(next.toString())
    if (problem !== null) throw new NarrativeFetchError(`redirect refused (${problem})`, 'bad_url')
    url = next
    response = undefined
  }
  if (response === undefined) {
    throw new NarrativeFetchError(`more than ${String(MAX_REDIRECTS)} redirects`, 'too_many_redirects')
  }
  if (!response.ok) {
    throw new NarrativeFetchError(`source answered ${String(response.status)}`, 'http_status')
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  const mime = contentType.split(';')[0]!.trim()
  const isHtml = mime === 'text/html' || mime === 'application/xhtml+xml'
  const isText = mime === 'text/plain'
  if (!isHtml && !isText) {
    throw new NarrativeFetchError(`content-type ${mime || '(none)'} is not text`, 'unsupported_content')
  }

  const body = await readCapped(response, options.maxBytes)
  const raw = body.bytes.toString('utf8')
  const text = isHtml ? htmlToText(raw) : collapseWhitespace(raw)
  if (text.length === 0) throw new NarrativeFetchError('document has no visible text', 'empty_document')
  return {
    url: url.toString(),
    kind: 'page',
    text,
    sha256: createHash('sha256').update(body.bytes).digest('hex'),
    bytes: body.bytes.length,
  }
}

async function request(
  url: string,
  options: FetchNarrativeOptions,
  headers: Record<string, string>,
): Promise<Response> {
  try {
    return await options.fetch(url, {
      method: 'GET',
      headers: { 'user-agent': 'fee-split-vaults-narrative/1', ...headers },
      // Followed by hand above so every hop is re-validated.
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (error) {
    throw new NarrativeFetchError('source unreachable', 'unreachable', error)
  }
}

/** Reads at most `maxBytes` of the body, then stops. Never buffers the rest. */
async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Buffer }> {
  const stream = response.body
  if (stream === null) return { bytes: Buffer.alloc(0) }
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const room = maxBytes - size
      const chunk = value.byteLength > room ? value.subarray(0, room) : value
      chunks.push(Buffer.from(chunk))
      size += chunk.byteLength
    }
  } catch (error) {
    throw new NarrativeFetchError('body read failed', 'unreachable', error)
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return { bytes: Buffer.concat(chunks, size) }
}

// ---------------------------------------------------------------------------
// HTML to visible text. Not a parser: the goal is the words a reader would see,
// with anything executable or presentational removed before it can be quoted.
// ---------------------------------------------------------------------------

const DROP_ELEMENTS = /<(script|style|noscript|template|svg|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const COMMENTS = /<!--[\s\S]*?-->/g
const BLOCK_TAGS =
  /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|section|article|header|footer|blockquote|pre|hr|nav|aside|main|figure|figcaption|dd|dt|dl|table|title)\b[^>]*>/gi
const ANY_TAG = /<[^>]+>/g

function htmlToText(html: string): string {
  const withoutDropped = html.replace(COMMENTS, ' ').replace(DROP_ELEMENTS, ' ')
  const withBreaks = withoutDropped.replace(BLOCK_TAGS, '\n')
  const stripped = withBreaks.replace(ANY_TAG, ' ')
  return collapseWhitespace(decodeEntities(stripped))
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const codePoint = Number.parseInt(body.slice(2), 16)
      return codePointToString(codePoint) ?? whole
    }
    if (body.startsWith('#')) {
      const codePoint = Number.parseInt(body.slice(1), 10)
      return codePointToString(codePoint) ?? whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

function codePointToString(codePoint: number): string | undefined {
  if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return undefined
  // Control characters and surrogates decode to nothing rather than to noise.
  if (codePoint < 0x20 && codePoint !== 0x0a && codePoint !== 0x09) return ''
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return ''
  return String.fromCodePoint(codePoint)
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f\v\u00a0]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

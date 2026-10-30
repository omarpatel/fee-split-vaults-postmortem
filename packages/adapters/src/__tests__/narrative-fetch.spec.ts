import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  NarrativeFetchError,
  fetchNarrativeSource,
  narrativeSourceUrlProblem,
} from '../narrative/fetch.js'

type Route = { status?: number; headers?: Record<string, string>; body: string | Uint8Array }

function fakeFetch(routes: Record<string, Route>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    seen.push(url)
    const route = routes[url]
    if (route === undefined) return new Response('nope', { status: 404 })
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...route.headers },
    })
  }) as typeof fetch
}

const OPTS = { maxBytes: 256_000, timeoutMs: 5_000 }

async function failure(promise: Promise<unknown>): Promise<NarrativeFetchError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof NarrativeFetchError) return error
    throw error
  }
  throw new Error('expected a NarrativeFetchError')
}

describe('narrativeSourceUrlProblem', () => {
  it.each([
    ['http://alpha.example/', 'insecure_scheme'],
    ['https://user@alpha.example/', 'url_carries_credentials'],
    ['https://alpha.example:8443/', 'url_has_explicit_port'],
    ['https://93.184.216.34/', 'ip_literal_host'],
    ['https://xn--80ak6aa92e.com/', 'punycode_host'],
    ['https://localhost/', 'host_not_public'],
    ['not a url', 'url_whitespace'],
    ['ftp', 'unparseable_url'],
  ])('refuses %s (%s)', (url, reason) => {
    expect(narrativeSourceUrlProblem(url)).toBe(reason)
  })

  it('accepts a plain https URL on a public host', () => {
    expect(narrativeSourceUrlProblem('https://alpha.example/launch?ref=1#top')).toBeNull()
  })
})

describe('fetchNarrativeSource', () => {
  it('strips scripts, styles and markup, decodes entities and hashes the bytes', async () => {
    const html =
      '<html><head><title>Alpha</title><style>p{color:red}</style></head>' +
      '<body><script>window.location="https://evil.tld"</script>' +
      '<h1>Alpha &amp; friends</h1><p>A   community&nbsp;coin.<br>Built for &#x66;un.</p>' +
      '<!-- hidden 0xdeadbeef --><noscript>enable js</noscript></body></html>'
    const fetch = fakeFetch({ 'https://alpha.example/': { body: html } })
    const source = await fetchNarrativeSource('https://alpha.example/', { ...OPTS, fetch })

    expect(source.kind).toBe('page')
    expect(source.text).toBe('Alpha\nAlpha & friends\nA community coin.\nBuilt for fun.')
    expect(source.text).not.toContain('evil.tld')
    expect(source.text).not.toContain('color:red')
    expect(source.text).not.toContain('deadbeef')
    expect(source.sha256).toBe(createHash('sha256').update(html, 'utf8').digest('hex'))
  })

  it('caps the bytes it reads and hashes exactly what it consumed', async () => {
    const body = `<p>${'a'.repeat(50_000)}</p>`
    const fetch = fakeFetch({ 'https://alpha.example/big': { body } })
    const source = await fetchNarrativeSource('https://alpha.example/big', { ...OPTS, maxBytes: 1_000, fetch })

    expect(source.bytes).toBe(1_000)
    expect(source.text.length).toBeLessThanOrEqual(1_000)
    expect(source.sha256).toBe(createHash('sha256').update(body.slice(0, 1_000), 'utf8').digest('hex'))
  })

  it('follows a redirect only to a host the rules accept', async () => {
    const seen: string[] = []
    const fetch = fakeFetch(
      {
        'https://alpha.example/': { status: 302, headers: { location: 'https://www.alpha.example/' }, body: '' },
        'https://www.alpha.example/': { body: '<p>home</p>' },
        'https://beta.example/': { status: 301, headers: { location: 'http://beta.example/' }, body: '' },
      },
      seen,
    )
    const ok = await fetchNarrativeSource('https://alpha.example/', { ...OPTS, fetch })
    expect(ok.url).toBe('https://www.alpha.example/')
    expect(ok.text).toBe('home')

    const refused = await failure(fetchNarrativeSource('https://beta.example/', { ...OPTS, fetch }))
    expect(refused.code).toBe('bad_url')
    expect(seen).not.toContain('http://beta.example/')
  })

  it('refuses a document that is not text', async () => {
    const fetch = fakeFetch({
      'https://alpha.example/a.pdf': { headers: { 'content-type': 'application/pdf' }, body: '%PDF' },
    })
    const error = await failure(fetchNarrativeSource('https://alpha.example/a.pdf', { ...OPTS, fetch }))
    expect(error.code).toBe('unsupported_content')
  })

  it('refuses an x.com status without a bearer token and never fetches the page', async () => {
    const seen: string[] = []
    const fetch = fakeFetch({}, seen)
    const error = await failure(
      fetchNarrativeSource('https://x.com/alpha_coin/status/1234567890', { ...OPTS, fetch }),
    )
    expect(error.code).toBe('x_token_missing')
    expect(seen).toEqual([])
  })

  it('reads an x.com status through the API when a token is present', async () => {
    const seen: string[] = []
    const apiBody = JSON.stringify({ data: { id: '1234567890', text: 'gm &amp; welcome to alpha' } })
    const fetch = fakeFetch(
      {
        'https://api.test/2/tweets/1234567890?tweet.fields=text': {
          headers: { 'content-type': 'application/json' },
          body: apiBody,
        },
      },
      seen,
    )
    const source = await fetchNarrativeSource('https://twitter.com/alpha_coin/status/1234567890', {
      ...OPTS,
      fetch,
      xBearerToken: 'tok',
      xApiBaseUrl: 'https://api.test',
    })
    expect(source.kind).toBe('tweet')
    expect(source.text).toBe('gm & welcome to alpha')
    expect(source.sha256).toBe(createHash('sha256').update(apiBody, 'utf8').digest('hex'))
    expect(seen).toEqual(['https://api.test/2/tweets/1234567890?tweet.fields=text'])
  })

  it('refuses a document with no visible text', async () => {
    const fetch = fakeFetch({ 'https://alpha.example/': { body: '<script>x()</script><style></style>' } })
    const error = await failure(fetchNarrativeSource('https://alpha.example/', { ...OPTS, fetch }))
    expect(error.code).toBe('empty_document')
  })
})

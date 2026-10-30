import { imageAssetId, type ImageAsset } from '@fee-split-vaults/core'
import { describe, expect, it } from 'vitest'
import { createFakeImageAssetSource } from '../channels/fakes.js'
import { ChannelTransportError } from '../channels/types.js'
import { createXOAuth2Client, XOAuthError } from '../channels/x-oauth.js'
import { createXAdapter, createXHttpTransport, TOKEN_REFRESH_MARGIN_SECONDS } from '../channels/x.js'
import { InMemoryAccountCredentialStore, type XCredentials } from '../credentials.js'

const NOW = 1_757_000_000
const SHA = 'ab'.repeat(32)
const ASSET: ImageAsset = {
  id: imageAssetId('vnx', 'card', SHA),
  coinRef: 'vnx',
  kind: 'card',
  mime: 'image/png',
  width: 1200,
  height: 675,
  sha256: SHA,
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
}

interface Call {
  url: string
  method: string
  authorization: string | undefined
  body: unknown
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Records every request and answers from a route table keyed by `${method} ${path}`. */
function fetchStub(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    const headers = init?.headers as Record<string, string> | undefined
    let body: unknown = init?.body
    if (body instanceof FormData) {
      const entries: Record<string, unknown> = {}
      for (const [key, value] of body.entries()) {
        entries[key] = value instanceof Blob ? { size: value.size, type: value.type } : value
      }
      body = entries
    } else if (typeof body === 'string' && headers?.['content-type'] === 'application/json') {
      body = JSON.parse(body)
    } else if (body instanceof URLSearchParams) {
      body = Object.fromEntries(body.entries())
    }
    const call: Call = { url, method, authorization: headers?.authorization, body }
    calls.push(call)
    const route = routes[`${method} ${path}`]
    if (route === undefined) return jsonResponse(404, { title: 'not found' })
    return route(call)
  }
  return { calls, fetchImpl }
}

function transport(options: {
  creds: XCredentials | null
  routes?: Record<string, (call: Call) => Response>
  refresh?: (token: string) => Promise<XCredentials>
}) {
  const store = new InMemoryAccountCredentialStore(options.creds === null ? [] : [['acct-1', options.creds]])
  const stub = fetchStub(options.routes ?? {})
  const refreshed: string[] = []
  const x = createXHttpTransport({
    credentials: store,
    oauth: {
      refresh:
        options.refresh ??
        (async (token) => {
          refreshed.push(token)
          return { accessToken: 'fresh', refreshToken: 'r2', expiresAtUnix: NOW + 7200, scopes: ['tweet.write'] }
        }),
    },
    labelProbe: { observe: async () => ({ labeled: true, observedAtUnix: NOW }) },
    fetchImpl: stub.fetchImpl,
    baseUrl: 'https://api.test/2',
    nowUnix: () => NOW,
  })
  return { x, store, stub, refreshed }
}

const TWEET_OK = () => jsonResponse(201, { data: { id: '9001', text: 'x' } })

describe('X credentials', () => {
  it('uses a live token as-is', async () => {
    const t = transport({
      creds: { accessToken: 'live', refreshToken: 'r1', expiresAtUnix: NOW + 3600, scopes: [] },
      routes: { 'POST /2/tweets': TWEET_OK },
    })
    await t.x.createPost({ accountId: 'acct-1', text: 'hello' })
    expect(t.stub.calls[0]?.authorization).toBe('Bearer live')
    expect(t.refreshed).toHaveLength(0)
  })

  it('refreshes inside the expiry margin, posts with the new token, and persists it', async () => {
    const t = transport({
      creds: { accessToken: 'stale', refreshToken: 'r1', expiresAtUnix: NOW + TOKEN_REFRESH_MARGIN_SECONDS - 1, scopes: [] },
      routes: { 'POST /2/tweets': TWEET_OK },
    })
    await t.x.createPost({ accountId: 'acct-1', text: 'hello' })
    expect(t.refreshed).toEqual(['r1'])
    expect(t.stub.calls[0]?.authorization).toBe('Bearer fresh')
    expect(await t.store.get('acct-1')).toMatchObject({ accessToken: 'fresh', refreshToken: 'r2' })
  })

  it('refuses with credential_missing when the account has no credentials', async () => {
    const t = transport({ creds: null })
    await expect(t.x.createPost({ accountId: 'acct-1', text: 'hello' })).rejects.toMatchObject({
      name: 'ChannelTransportError',
      code: 'credential_missing',
    })
    expect(t.stub.calls).toHaveLength(0)
  })

  it('refuses an expired credential that cannot be refreshed rather than sending it', async () => {
    const t = transport({
      creds: { accessToken: 'stale', refreshToken: null, expiresAtUnix: NOW - 1, scopes: [] },
    })
    await expect(t.x.createPost({ accountId: 'acct-1', text: 'hello' })).rejects.toMatchObject({
      code: 'credential_expired',
    })
    expect(t.stub.calls).toHaveLength(0)
  })

  it('keeps the old credential when the refresh fails', async () => {
    const t = transport({
      creds: { accessToken: 'stale', refreshToken: 'r1', expiresAtUnix: NOW - 1, scopes: [] },
      refresh: async () => {
        throw new XOAuthError('nope', 'rejected')
      },
    })
    await expect(t.x.createPost({ accountId: 'acct-1', text: 'hello' })).rejects.toMatchObject({
      code: 'credential_refresh_failed',
    })
    expect((await t.store.get('acct-1'))?.accessToken).toBe('stale')
    expect(t.stub.calls).toHaveLength(0)
  })
})

describe('X media upload', () => {
  it('uploads every image before the tweet and attaches the returned ids', async () => {
    const t = transport({
      creds: { accessToken: 'live', refreshToken: null, expiresAtUnix: NOW + 3600, scopes: [] },
      routes: {
        'POST /2/media/upload': () => jsonResponse(200, { data: { id: 'm-77', media_key: '3_m-77' } }),
        'POST /2/tweets': TWEET_OK,
      },
    })
    const adapter = createXAdapter({
      channel: 'x_operator',
      transport: t.x,
      images: createFakeImageAssetSource([ASSET]),
      nowUnix: () => NOW,
    })

    const published = await adapter.publish({ accountId: 'acct-1', text: 'hello', imageRefs: [ASSET.id] })

    expect(published.externalId).toBe('acct-1:9001')
    expect(t.stub.calls.map((c) => new URL(c.url).pathname)).toEqual(['/2/media/upload', '/2/tweets'])
    expect(t.stub.calls[0]?.body).toEqual({
      media: { size: ASSET.bytes.byteLength, type: 'image/png' },
      media_category: 'tweet_image',
    })
    expect(t.stub.calls[1]?.body).toEqual({ text: 'hello', media: { media_ids: ['m-77'] } })
  })

  it('refuses an unknown asset id without touching the network', async () => {
    const t = transport({
      creds: { accessToken: 'live', refreshToken: null, expiresAtUnix: NOW + 3600, scopes: [] },
      routes: { 'POST /2/tweets': TWEET_OK },
    })
    const adapter = createXAdapter({
      channel: 'x_operator',
      transport: t.x,
      images: createFakeImageAssetSource([]),
    })
    await expect(adapter.publish({ accountId: 'acct-1', text: 'hello', imageRefs: [ASSET.id] })).rejects.toMatchObject({
      code: 'image_asset_missing',
    })
    expect(t.stub.calls).toHaveLength(0)
  })

  it('does not tweet when the upload response carries no media id', async () => {
    const t = transport({
      creds: { accessToken: 'live', refreshToken: null, expiresAtUnix: NOW + 3600, scopes: [] },
      routes: {
        'POST /2/media/upload': () => jsonResponse(200, { data: { media_key: 'only-a-key' } }),
        'POST /2/tweets': TWEET_OK,
      },
    })
    const adapter = createXAdapter({
      channel: 'x_operator',
      transport: t.x,
      images: createFakeImageAssetSource([ASSET]),
    })
    await expect(adapter.publish({ accountId: 'acct-1', text: 'hello', imageRefs: [ASSET.id] })).rejects.toBeInstanceOf(
      ChannelTransportError,
    )
    expect(t.stub.calls.map((c) => new URL(c.url).pathname)).toEqual(['/2/media/upload'])
  })
})

describe('X OAuth2 client', () => {
  const tokenOk = () =>
    jsonResponse(200, {
      token_type: 'bearer',
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 7200,
      scope: 'tweet.read tweet.write offline.access',
    })

  it('builds a PKCE authorize url', () => {
    const client = createXOAuth2Client({ clientId: 'cid', redirectUri: 'https://ops.example/cb' })
    const url = new URL(client.authorizeUrl('st', 'chal', ['tweet.read', 'offline.access']))
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: 'https://ops.example/cb',
      scope: 'tweet.read offline.access',
      state: 'st',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
    })
  })

  it('exchanges a code as a confidential client with basic auth and computes the expiry', async () => {
    const stub = fetchStub({ 'POST /2/oauth2/token': tokenOk })
    const client = createXOAuth2Client({
      clientId: 'cid',
      clientSecret: 'sec',
      redirectUri: 'https://ops.example/cb',
      fetch: stub.fetchImpl,
      baseUrl: 'https://api.test',
      nowUnix: () => NOW,
    })
    const creds = await client.exchange('code-1', 'verifier-1')
    expect(creds).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtUnix: NOW + 7200,
      scopes: ['tweet.read', 'tweet.write', 'offline.access'],
    })
    const call = stub.calls[0]
    expect(call?.authorization).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`)
    expect(call?.body).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://ops.example/cb',
      code_verifier: 'verifier-1',
    })
  })

  it('sends client_id in the body as a public client', async () => {
    const stub = fetchStub({ 'POST /2/oauth2/token': tokenOk })
    const client = createXOAuth2Client({
      clientId: 'cid',
      redirectUri: 'https://ops.example/cb',
      fetch: stub.fetchImpl,
      baseUrl: 'https://api.test',
    })
    await client.refresh('rt-0')
    expect(stub.calls[0]?.authorization).toBeUndefined()
    expect(stub.calls[0]?.body).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt-0', client_id: 'cid' })
  })

  it('treats a token response without an expiry as malformed', async () => {
    const stub = fetchStub({ 'POST /2/oauth2/token': () => jsonResponse(200, { access_token: 'at' }) })
    const client = createXOAuth2Client({
      clientId: 'cid',
      redirectUri: 'https://ops.example/cb',
      fetch: stub.fetchImpl,
      baseUrl: 'https://api.test',
    })
    await expect(client.refresh('rt-0')).rejects.toMatchObject({ code: 'malformed_response' })
  })
})

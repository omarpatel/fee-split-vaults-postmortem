/**
 * Account health: the classification of what X answers about an account, the
 * probe that never throws, the verdict the publisher applies, and the
 * publisher refusing at channel_suspended on a non-ok or stale row.
 */

import { describe, expect, it } from 'vitest'
import { createAutoApprovalGate } from '../approval.js'
import { createFakeChannelSet } from '../channels/fakes.js'
import { ChannelTransportError } from '../channels/types.js'
import { classifyXAccountResponse, createXHttpTransport, probeXAccount } from '../channels/x.js'
import { InMemoryAccountCredentialStore } from '../credentials.js'
import {
  channelHealthVerdict,
  HEALTH_DETAIL_MAX_CHARS,
  HEALTH_MAX_AGE_SECONDS,
  InMemoryChannelHealthStore,
  type ChannelHealthRecord,
} from '../health.js'
import { createInMemoryEventLog } from '../log.js'
import { createPublisher } from '../publisher.js'
import { createInMemoryAccountRegistry, createInMemoryPostRegistry } from '../registry.js'
import { createFixedClock, createManualScheduler } from '../scheduler.js'
import type { AccountBinding } from '../types.js'

const NOW = 1_757_000_000
const VAULT = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'
const BINDINGS: AccountBinding[] = [
  { accountId: 'tg-chat-1', channel: 'telegram', coinRef: 'vnx', vault: VAULT, token: TOKEN, ticker: 'VNX', delegated: false },
  { accountId: '100200300', channel: 'x_operator', coinRef: 'vnx', vault: VAULT, token: TOKEN, ticker: 'VNX', delegated: false },
]

describe('classifyXAccountResponse', () => {
  it.each([
    ['200 is ok', 200, { data: { id: '1', username: 'x' } }, 'ok'],
    ['401 is unauthorized', 401, { title: 'Unauthorized', type: 'about:blank', status: 401 }, 'unauthorized'],
    [
      '403 problem detail naming a suspension',
      403,
      { title: 'Forbidden', detail: 'Your account is suspended and is not permitted to access this feature.', type: 'about:blank', status: 403 },
      'suspended',
    ],
    [
      '403 problem detail naming a lock',
      403,
      { title: 'Forbidden', detail: 'The user account is temporarily locked. Please log in via the web or mobile app to unlock it.', type: 'about:blank', status: 403 },
      'locked',
    ],
    ['403 with v1.1 code 64', 403, { errors: [{ code: 64, message: 'Your account is suspended and is not permitted to access this feature.' }] }, 'suspended'],
    ['403 with v1.1 code 326', 403, { errors: [{ code: 326, message: 'To protect our users from spam and other malicious activity, this account is temporarily locked.' }] }, 'locked'],
    ['403 that names neither state is unauthorized, not a verdict', 403, { title: 'Client Forbidden', type: 'https://api.twitter.com/2/problems/client-forbidden', detail: 'missing users.read' }, 'unauthorized'],
    ['429 is unreachable: X said nothing about the account', 429, { title: 'Too Many Requests' }, 'unreachable'],
    ['503 is unreachable', 503, null, 'unreachable'],
  ])('%s', (_name, status, body, expected) => {
    expect(classifyXAccountResponse(status, body).status).toBe(expected)
  })

  it('keeps the raw problem type and detail, bounded', () => {
    const long = 'x'.repeat(1000)
    const verdict = classifyXAccountResponse(403, { type: 'https://api.twitter.com/2/problems/client-forbidden', detail: `suspended ${long}` })
    expect(verdict.status).toBe('suspended')
    expect(verdict.detail.startsWith('403 https://api.twitter.com/2/problems/client-forbidden | suspended')).toBe(true)
    expect(verdict.detail.length).toBeLessThanOrEqual(HEALTH_DETAIL_MAX_CHARS)
  })
})

describe('probeXAccount', () => {
  function http(creds: 'live' | 'none' | 'expired', respond: () => Promise<Response>) {
    const store = new InMemoryAccountCredentialStore(
      creds === 'none' ? [] : [['100200300', { accessToken: 'tok', refreshToken: null, expiresAtUnix: creds === 'live' ? NOW + 3600 : NOW - 1, scopes: [] }]],
    )
    const calls: string[] = []
    return {
      calls,
      x: createXHttpTransport({
        credentials: store,
        oauth: { refresh: async () => { throw new Error('unused') } },
        labelProbe: { observe: async () => ({ labeled: true, observedAtUnix: NOW }) },
        fetchImpl: async (input) => { calls.push(String(input)); return respond() },
        baseUrl: 'https://api.test/2',
        nowUnix: () => NOW,
      }),
    }
  }

  it('asks GET /2/users/me under the account token and stamps the observation', async () => {
    const t = http('live', async () => new Response(JSON.stringify({ data: { id: '100200300' } }), { status: 200 }))
    expect(await probeXAccount(t.x, '100200300', () => NOW)).toEqual({ status: 'ok', observedAtUnix: NOW, detail: '200 users/me' })
    expect(t.calls).toEqual(['https://api.test/2/users/me?user.fields=protected'])
  })

  it('is unauthorized, not a throw, when there is no usable credential', async () => {
    const missing = http('none', async () => new Response('', { status: 200 }))
    expect((await probeXAccount(missing.x, '100200300', () => NOW))).toMatchObject({ status: 'unauthorized', detail: expect.stringContaining('credential_missing') })
    const expired = http('expired', async () => new Response('', { status: 200 }))
    expect((await probeXAccount(expired.x, '100200300', () => NOW))).toMatchObject({ status: 'unauthorized', detail: expect.stringContaining('credential_expired') })
    expect(missing.calls).toHaveLength(0)
    expect(expired.calls).toHaveLength(0)
  })

  it('is unreachable when the network fails or the transport throws anything else', async () => {
    const down = http('live', async () => { throw new Error('ECONNRESET') })
    expect((await probeXAccount(down.x, '100200300', () => NOW)).status).toBe('unreachable')
    const other = { probeAccount: async () => { throw new ChannelTransportError('boom', 'x_operator') } }
    expect((await probeXAccount(other, '100200300', () => NOW)).status).toBe('unreachable')
  })
})

describe('channelHealthVerdict', () => {
  const ok: ChannelHealthRecord = { channel: 'x_operator', accountId: '100200300', status: 'ok', observedAtUnix: NOW, detail: '200' }

  it('passes a fresh ok and refuses everything else', () => {
    expect(channelHealthVerdict(ok, NOW + 1)).toEqual({ ok: true })
    expect(channelHealthVerdict(ok, NOW + HEALTH_MAX_AGE_SECONDS - 1)).toEqual({ ok: true })
    expect(channelHealthVerdict(ok, NOW + HEALTH_MAX_AGE_SECONDS)).toMatchObject({ ok: false, reason: 'health_stale' })
    expect(channelHealthVerdict(ok, NOW - 1)).toMatchObject({ ok: false, reason: 'health_stale' })
    expect(channelHealthVerdict(null, NOW)).toMatchObject({ ok: false, reason: 'health_unobserved' })
    expect(channelHealthVerdict({ ...ok, status: 'suspended', detail: '403 suspended' }, NOW)).toEqual({ ok: false, reason: 'channel_suspended', detail: '403 suspended' })
    expect(channelHealthVerdict({ ...ok, status: 'locked' }, NOW)).toMatchObject({ reason: 'channel_locked' })
    expect(channelHealthVerdict({ ...ok, status: 'unauthorized' }, NOW)).toMatchObject({ reason: 'channel_unauthorized' })
  })
})

describe('the publisher refuses at channel_suspended', () => {
  function harness(seed: readonly ChannelHealthRecord[]) {
    const clock = createFixedClock(NOW)
    const nowUnix = () => clock.nowUnix()
    const channels = createFakeChannelSet({ operatorName: 'Venue Desk', nowUnix })
    const health = new InMemoryChannelHealthStore(seed)
    const log = createInMemoryEventLog()
    const publisher = createPublisher({
      policy: { operatorName: 'Venue Desk', receiptsBaseUrl: 'https://receipts.example.com', allowedLinkHosts: [], allowedRouterAddresses: [], maxAccountLabelAgeSeconds: 86_400 },
      adapters: channels.adapters,
      accounts: createInMemoryAccountRegistry(BINDINGS, [{ vault: VAULT, token: TOKEN, ticker: 'VNX' }]),
      posts: createInMemoryPostRegistry(),
      health,
      log,
      approvals: createAutoApprovalGate('reviewer', nowUnix),
      scheduler: createManualScheduler(clock),
      clock,
    })
    const publish = (channel: 'x_operator' | 'telegram', accountId: string) =>
      publisher.publish({ request: { vault: VAULT, channel, body: 'The pinned message was refreshed this morning.', isPromotional: false, links: [] }, accountId })
    return { clock, channels, health, log, publish }
  }

  const fresh: ChannelHealthRecord = { channel: 'x_operator', accountId: '100200300', status: 'ok', observedAtUnix: NOW - 3600, detail: '200' }

  it('posts from an account with a fresh ok', async () => {
    const h = harness([fresh])
    expect((await h.publish('x_operator', '100200300')).published).toBe(true)
  })

  it('refuses a suspended account before the body is read, and logs the refusal', async () => {
    const h = harness([{ ...fresh, status: 'suspended', detail: '403 about:blank | Your account is suspended' }])
    expect(await h.publish('x_operator', '100200300')).toEqual({ published: false, rejectedReason: 'channel_suspended:channel_suspended' })
    expect(h.channels.x.created).toHaveLength(0)
    expect(h.log.refusals()).toMatchObject([{ stage: 'channel_suspended', reason: 'channel_suspended', detail: '403 about:blank | Your account is suspended' }])
  })

  it('refuses when the last ok is older than the bound, and when nothing has probed the account', async () => {
    const stale = harness([fresh])
    stale.clock.advance(HEALTH_MAX_AGE_SECONDS)
    expect((await stale.publish('x_operator', '100200300')).rejectedReason).toBe('channel_suspended:health_stale')
    const never = harness([])
    expect((await never.publish('x_operator', '100200300')).rejectedReason).toBe('channel_suspended:health_unobserved')
  })

  it('reads the newest row: a later ok reopens the account, a later suspension closes it', async () => {
    const h = harness([{ ...fresh, status: 'suspended' }])
    await h.health.put({ ...fresh, observedAtUnix: NOW })
    expect((await h.publish('x_operator', '100200300')).published).toBe(true)
    await h.health.put({ ...fresh, status: 'locked', observedAtUnix: NOW })
    expect((await h.publish('x_operator', '100200300')).rejectedReason).toBe('channel_suspended:channel_locked')
  })

  it('does not gate channels nothing probes', async () => {
    const h = harness([])
    expect((await h.publish('telegram', 'tg-chat-1')).published).toBe(true)
  })
})

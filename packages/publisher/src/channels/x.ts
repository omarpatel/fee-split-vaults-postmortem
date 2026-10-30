import type { ImageAsset, ImageAssetSource } from '@fee-split-vaults/core'
import type { AccountCredentialStore } from '../credentials.js'
import { boundHealthDetail, type ChannelHealthProbe, type ChannelHealthStatus } from '../health.js'
import { containsToken } from '../text.js'
import type { Channel } from '../types.js'
import {
  ChannelTransportError,
  X_LIMITS,
  type AccountDisclosureCheck,
  type AccountDisclosureRequirement,
  type AdapterPublishInput,
  type ChannelAdapter,
  type FetchedPost,
  type PublishedPost,
} from './types.js'
import type { XOAuth2Client } from './x-oauth.js'

/**
 * X, in two shapes.
 *
 *   x_operator          - our own account, our own credentials.
 *   x_client_delegated  - the dev's account, posted to under delegated OAuth.
 *
 * The delegated case is the dangerous one. The dev owns that account: they can
 * edit the bio, remove the automated-account label, or hand the credentials to
 * someone else, all without telling us and all after we onboarded them. So the
 * account's disclosure is verified PROGRAMMATICALLY BEFORE EVERY POST, and the
 * result is never cached between posts.
 *
 * The automated-account label is a platform UI affordance and is not exposed as
 * an API field. The transport therefore reports it as `boolean | null`, and null
 * - "we could not tell" - is treated exactly like absent. See label.ts for the
 * attestation-backed probe.
 *
 * Credentials come from an AccountCredentialStore and are refreshed in place
 * when within a minute of expiry. No credential, or an expired one with no
 * refresh token, is a typed refusal - never a retry with a stale token.
 *
 * Media goes through POST /2/media/upload (multipart, media_category
 * tweet_image) and the returned id is attached to POST /2/tweets. The bytes come
 * from the ImageAssetSource by asset id; the model only ever named the id.
 *
 * PROFILE MUTATION IS DELIBERATELY ABSENT. X API v2 has no endpoint to update a
 * user's description, avatar or banner (that was v1.1 account/update_profile*,
 * now retired). Banner and avatar PNGs rendered by the creative package are
 * therefore handed to the operator through the control-plane API and uploaded
 * by hand when the account is created.
 */

export interface XProfile {
  accountId: string
  username: string
  /** Bio text. Must carry the AI-operation tag and the operator name. */
  description: string
  /** Platform automated-account label. Null means unobserved, which fails closed. */
  automatedLabel: boolean | null
  /** When the label was actually observed. Staleness fails closed. */
  labelObservedAtUnix: number
}

export interface XTransport {
  createPost(req: {
    accountId: string
    text: string
    mediaIds?: readonly string[]
    inReplyToId?: string
  }): Promise<{ id: string; url?: string }>
  /** Uploads one image and returns the platform media id to attach to a post. */
  uploadMedia(req: { accountId: string; asset: ImageAsset }): Promise<{ mediaId: string }>
  getPost(req: { accountId: string; postId: string }): Promise<{ id: string; text: string; url?: string } | null>
  deletePost(req: { accountId: string; postId: string }): Promise<void>
  getProfile(accountId: string): Promise<XProfile>
  /**
   * The account's own standing, from GET /2/users/me under its token. Throws
   * the same credential and network errors as every other call; the verdict
   * on an HTTP answer is classifyXAccountResponse's.
   */
  probeAccount(accountId: string): Promise<ChannelHealthProbe>
}

/**
 * Observes the automated-account label for a posting account. The v2 API does
 * not carry it, so the shipped implementation is an operator attestation with
 * an expiry (label.ts). Any doubt returns labeled=false.
 */
export interface AutomatedLabelProbe {
  observe(accountId: string): Promise<{ labeled: boolean; observedAtUnix: number }>
}

/** Refresh when the token has less than this long to live. */
export const TOKEN_REFRESH_MARGIN_SECONDS = 60

/**
 * The verdict on what GET /2/users/me answered. Pure, so the table of X's
 * error shapes is testable without a transport.
 *
 * X answers a suspended or locked account with 403 and an RFC 7807 problem
 * whose `detail` says so in words ("Your account is suspended and is not
 * permitted to access this feature", "The user account is temporarily
 * locked"); older paths answer with a v1.1 `errors[]` list where code 64 is
 * suspended and 326 is locked. Both are read. The raw `type` and `detail` are
 * kept in the probe's detail for the runbook. A 403 that names neither state
 * is a token that cannot read its own account (missing users.read, or an app
 * X has restricted), which is `unauthorized` like a 401: not a verdict on the
 * account, but not a licence to post either. 429 and 5xx are `unreachable`:
 * X did not say anything about the account.
 */
export function classifyXAccountResponse(status: number, body: unknown): { status: ChannelHealthStatus; detail: string } {
  if (status === 200) return { status: 'ok', detail: '200 users/me' }
  const problem = problemText(body)
  const detail = boundHealthDetail(`${String(status)} ${problem.summary}`.trim())
  if (status === 401) return { status: 'unauthorized', detail }
  if (status === 403) {
    if (problem.codes.includes(64) || /suspend/i.test(problem.summary)) return { status: 'suspended', detail }
    if (problem.codes.includes(326) || /locked/i.test(problem.summary)) return { status: 'locked', detail }
    return { status: 'unauthorized', detail }
  }
  return { status: 'unreachable', detail }
}

/** The text and the v1.1-style codes an X error body carries, whichever shape it took. */
function problemText(body: unknown): { summary: string; codes: number[] } {
  if (typeof body !== 'object' || body === null) return { summary: '', codes: [] }
  const o = body as Record<string, unknown>
  const parts: string[] = []
  const codes: number[] = []
  for (const field of ['type', 'title', 'detail', 'error', 'error_description'] as const) {
    if (typeof o[field] === 'string') parts.push(o[field])
  }
  if (Array.isArray(o.errors)) {
    for (const entry of o.errors as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      if (typeof e.code === 'number') codes.push(e.code)
      if (typeof e.message === 'string') parts.push(e.message)
      if (typeof e.detail === 'string') parts.push(e.detail)
    }
  }
  return { summary: parts.join(' | '), codes }
}

/**
 * Probe one account and never throw: a credential the transport refused is
 * `unauthorized` (nothing can be posted with it either), and anything else
 * the transport threw - the network, a body that was not JSON - is
 * `unreachable`.
 */
export async function probeXAccount(
  transport: Pick<XTransport, 'probeAccount'>,
  accountId: string,
  nowUnix: () => number = () => Math.floor(Date.now() / 1000),
): Promise<ChannelHealthProbe> {
  try {
    return await transport.probeAccount(accountId)
  } catch (error: unknown) {
    const code = error instanceof ChannelTransportError ? error.code : undefined
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'credential_missing' || code === 'credential_expired' || code === 'credential_refresh_failed') {
      return { status: 'unauthorized', observedAtUnix: nowUnix(), detail: boundHealthDetail(`${code}: ${message}`) }
    }
    return { status: 'unreachable', observedAtUnix: nowUnix(), detail: boundHealthDetail(message) }
  }
}

export interface XHttpOptions {
  credentials: AccountCredentialStore
  oauth: Pick<XOAuth2Client, 'refresh'>
  labelProbe: AutomatedLabelProbe
  fetchImpl?: typeof fetch
  baseUrl?: string
  nowUnix?: () => number
  /** Only used to label transport errors. */
  channelLabel?: Extract<Channel, 'x_operator' | 'x_client_delegated'>
}

export function createXHttpTransport(options: XHttpOptions): XTransport {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const base = options.baseUrl ?? 'https://api.x.com/2'
  const channel: Channel = options.channelLabel ?? 'x_operator'
  const now = options.nowUnix ?? (() => Math.floor(Date.now() / 1000))

  async function accessTokenFor(accountId: string): Promise<string> {
    const stored = await options.credentials.get(accountId)
    if (stored === null) {
      throw new ChannelTransportError(`no credentials for ${accountId}`, channel, undefined, 'credential_missing')
    }
    if (stored.expiresAtUnix - TOKEN_REFRESH_MARGIN_SECONDS >= now()) return stored.accessToken
    if (stored.refreshToken === null) {
      throw new ChannelTransportError(
        `credentials for ${accountId} expired and carry no refresh token`,
        channel,
        undefined,
        'credential_expired',
      )
    }
    let refreshed
    try {
      refreshed = await options.oauth.refresh(stored.refreshToken)
    } catch (cause) {
      throw new ChannelTransportError(`refresh for ${accountId} failed`, channel, cause, 'credential_refresh_failed')
    }
    await options.credentials.put(accountId, refreshed)
    return refreshed.accessToken
  }

  async function send(accountId: string, path: string, init: RequestInit): Promise<Response> {
    const token = await accessTokenFor(accountId)
    try {
      return await doFetch(`${base}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
      })
    } catch (cause) {
      throw new ChannelTransportError(`${path} unreachable`, channel, cause)
    }
  }

  async function call<T>(
    accountId: string,
    path: string,
    init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown },
  ): Promise<T | null> {
    const response = await send(accountId, path, {
      method: init.method,
      ...(init.body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
    })
    if (response.status === 404) return null
    if (!response.ok) {
      throw new ChannelTransportError(`${path} failed: ${response.status}`, channel)
    }
    return (await response.json()) as T
  }

  return {
    async createPost(req) {
      const payload: Record<string, unknown> = { text: req.text }
      if (req.inReplyToId !== undefined) payload.reply = { in_reply_to_tweet_id: req.inReplyToId }
      if (req.mediaIds !== undefined && req.mediaIds.length > 0) {
        payload.media = { media_ids: [...req.mediaIds] }
      }
      const result = await call<{ data: { id: string } }>(req.accountId, '/tweets', {
        method: 'POST',
        body: payload,
      })
      if (result === null) throw new ChannelTransportError('createPost returned no id', channel)
      return { id: result.data.id }
    },

    async uploadMedia(req) {
      const form = new FormData()
      form.append('media', new Blob([req.asset.bytes], { type: req.asset.mime }), `${req.asset.kind}.png`)
      form.append('media_category', 'tweet_image')
      // FormData sets its own multipart content-type with the boundary.
      const response = await send(req.accountId, '/media/upload', { method: 'POST', body: form })
      if (!response.ok) {
        throw new ChannelTransportError(`/media/upload failed: ${response.status}`, channel)
      }
      const result = (await response.json().catch(() => null)) as { data?: { id?: unknown } } | null
      const mediaId = result?.data?.id
      if (typeof mediaId !== 'string' || mediaId.length === 0) {
        throw new ChannelTransportError('/media/upload returned no media id', channel)
      }
      return { mediaId }
    },

    async getPost(req) {
      const result = await call<{ data?: { id: string; text: string } }>(
        req.accountId,
        `/tweets/${encodeURIComponent(req.postId)}?tweet.fields=text`,
        { method: 'GET' },
      )
      if (result === null || result.data === undefined) return null
      return { id: result.data.id, text: result.data.text }
    },

    async deletePost(req) {
      await call<{ data: { deleted: boolean } }>(
        req.accountId,
        `/tweets/${encodeURIComponent(req.postId)}`,
        { method: 'DELETE' },
      )
    },

    async getProfile(accountId) {
      const result = await call<{ data?: { id: string; username: string; description?: string } }>(
        accountId,
        `/users/${encodeURIComponent(accountId)}?user.fields=description,username`,
        { method: 'GET' },
      )
      if (result === null || result.data === undefined) {
        throw new ChannelTransportError(`profile ${accountId} not readable`, channel)
      }
      const probe = await options.labelProbe
        .observe(accountId)
        .catch(() => ({ labeled: false, observedAtUnix: now() }))
      return {
        accountId: result.data.id,
        username: result.data.username,
        description: result.data.description ?? '',
        automatedLabel: probe.labeled,
        labelObservedAtUnix: probe.observedAtUnix,
      }
    },

    async probeAccount(accountId) {
      const response = await send(accountId, '/users/me?user.fields=protected', { method: 'GET' })
      const body: unknown = await response.json().catch(() => null)
      return { ...classifyXAccountResponse(response.status, body), observedAtUnix: now() }
    },
  }
}

export interface XAdapterOptions {
  channel: Extract<Channel, 'x_operator' | 'x_client_delegated'>
  transport: XTransport
  /** Resolves the asset ids the publisher allowlisted into bytes to upload. */
  images: ImageAssetSource
  nowUnix?: () => number
}

/** externalId carries the posting account, because read-back needs its token. */
function encodeId(accountId: string, postId: string): string {
  return `${accountId}:${postId}`
}

function decodeId(externalId: string, channel: Channel): { accountId: string; postId: string } {
  const separator = externalId.lastIndexOf(':')
  if (separator <= 0 || separator === externalId.length - 1) {
    throw new ChannelTransportError(`malformed external id "${externalId}"`, channel)
  }
  return { accountId: externalId.slice(0, separator), postId: externalId.slice(separator + 1) }
}

export function createXAdapter(options: XAdapterOptions): ChannelAdapter {
  const now = options.nowUnix ?? (() => Math.floor(Date.now() / 1000))

  return {
    channel: options.channel,
    limits: X_LIMITS,

    async publish(input: AdapterPublishInput): Promise<PublishedPost> {
      // Every upload completes before the tweet is attempted, so a missing or
      // unuploadable asset refuses the whole post rather than posting bare.
      const mediaIds: string[] = []
      for (const id of input.imageRefs ?? []) {
        const asset = await options.images.get(id)
        if (asset === null) {
          throw new ChannelTransportError(`image asset ${id} not found`, options.channel, undefined, 'image_asset_missing')
        }
        const uploaded = await options.transport.uploadMedia({ accountId: input.accountId, asset })
        mediaIds.push(uploaded.mediaId)
      }
      const created = await options.transport.createPost({
        accountId: input.accountId,
        text: input.text,
        ...(mediaIds.length === 0 ? {} : { mediaIds }),
        ...(input.inReplyToId === undefined ? {} : { inReplyToId: input.inReplyToId }),
      })
      return {
        externalId: encodeId(input.accountId, created.id),
        ...(created.url === undefined ? {} : { url: created.url }),
        publishedAtUnix: now(),
      }
    },

    async fetchPost(externalId: string): Promise<FetchedPost | null> {
      const post = await options.transport.getPost(decodeId(externalId, options.channel))
      if (post === null) return null
      return {
        externalId,
        text: post.text,
        ...(post.url === undefined ? {} : { url: post.url }),
      }
    },

    async deletePost(externalId: string): Promise<void> {
      await options.transport.deletePost(decodeId(externalId, options.channel))
    },

    async verifyAccountDisclosure(
      accountId: string,
      requirement: AccountDisclosureRequirement,
    ): Promise<AccountDisclosureCheck> {
      const profile = await options.transport.getProfile(accountId)
      const automatedLabel = profile.automatedLabel === true
      const bioHasOperator = containsToken(profile.description, requirement.operatorName)
      const bioHasAiTag = containsToken(profile.description, requirement.aiOperationTag)
      const ageSeconds = requirement.nowUnix - profile.labelObservedAtUnix
      const fresh = ageSeconds >= 0 && ageSeconds <= requirement.maxLabelAgeSeconds

      const problems: string[] = []
      if (!automatedLabel) problems.push('automated_label_absent')
      if (!fresh) problems.push(`label_observation_stale:${ageSeconds}s`)
      if (!bioHasOperator) problems.push('bio_missing_operator_name')
      if (!bioHasAiTag) problems.push('bio_missing_ai_tag')

      return {
        ok: problems.length === 0,
        automatedLabel,
        labelObservedAtUnix: profile.labelObservedAtUnix,
        bioHasOperator,
        bioHasAiTag,
        ...(problems.length === 0 ? {} : { detail: problems.join(',') }),
      }
    },
  }
}

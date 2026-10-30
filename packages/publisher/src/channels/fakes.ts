import type { ImageAsset, ImageAssetSource, ImageRef } from '@fee-split-vaults/core'
import { DISCLOSURE } from '../../../../config/protocol.js'
import type { ChannelHealthStatus } from '../health.js'
import type { Channel } from '../types.js'
import { createSiteAdapter, type SitePage, type SiteStore } from './site.js'
import { createTelegramAdapter, type TelegramTransport } from './telegram.js'
import { ChannelTransportError, type ChannelAdapter } from './types.js'
import { createXAdapter, type XProfile, type XTransport } from './x.js'

/**
 * In-memory transports. They exist so the adversarial cases - a post whose text
 * is edited after publication, a post that vanishes, a bio the dev quietly
 * rewrote - can be exercised without a network.
 */

/** Fixed asset set. `get` returns null for anything not seeded, which is the refusal path. */
export function createFakeImageAssetSource(assets: readonly ImageAsset[] = []): ImageAssetSource {
  const byId = new Map(assets.map((asset) => [asset.id, asset] as const))
  return {
    async get(id) {
      return byId.get(id) ?? null
    },
    async list(coinRef) {
      const refs: ImageRef[] = []
      for (const asset of byId.values()) {
        if (asset.coinRef === coinRef) refs.push({ id: asset.id, kind: asset.kind })
      }
      return refs
    },
  }
}

export interface FakeTelegramTransport extends TelegramTransport {
  readonly sent: Array<{
    chatId: string
    messageId: number
    text: string
    replyToMessageId?: number
    /** Set when the message went out as sendPhoto. */
    photoBytes?: number
  }>
  readonly deleted: string[]
  /** Simulate an edit that removes the disclosure. */
  tamper(externalId: string, text: string): void
  /** Simulate the post being removed out from under us. */
  vanish(externalId: string): void
  setUnreachable(unreachable: boolean): void
}

export function createFakeTelegramTransport(): FakeTelegramTransport {
  const store = new Map<string, string>()
  const sent: FakeTelegramTransport['sent'] = []
  const deleted: string[] = []
  let nextId = 1000
  let unreachable = false

  const guard = (): void => {
    if (unreachable) throw new ChannelTransportError('network down', 'telegram')
  }

  return {
    sent,
    deleted,
    tamper(externalId, text) {
      if (store.has(externalId)) store.set(externalId, text)
    },
    vanish(externalId) {
      store.delete(externalId)
    },
    setUnreachable(value) {
      unreachable = value
    },
    async sendMessage(req) {
      guard()
      const messageId = nextId++
      store.set(`${req.chatId}:${messageId}`, req.text)
      sent.push({
        chatId: req.chatId,
        messageId,
        text: req.text,
        ...(req.replyToMessageId === undefined ? {} : { replyToMessageId: req.replyToMessageId }),
      })
      return { messageId }
    },
    async sendPhoto(req) {
      guard()
      const messageId = nextId++
      store.set(`${req.chatId}:${messageId}`, req.caption)
      sent.push({
        chatId: req.chatId,
        messageId,
        text: req.caption,
        photoBytes: req.photo.byteLength,
        ...(req.replyToMessageId === undefined ? {} : { replyToMessageId: req.replyToMessageId }),
      })
      return { messageId }
    },
    async forwardMessage(req) {
      guard()
      const text = store.get(`${req.fromChatId}:${req.messageId}`)
      if (text === undefined) {
        throw new ChannelTransportError('message to forward is gone', 'telegram')
      }
      const messageId = nextId++
      store.set(`${req.toChatId}:${messageId}`, text)
      return { messageId, text }
    },
    async deleteMessage(req) {
      guard()
      const key = `${req.chatId}:${req.messageId}`
      store.delete(key)
      deleted.push(key)
    },
  }
}

export interface FakeXTransport extends XTransport {
  readonly created: Array<{
    accountId: string
    postId: string
    text: string
    inReplyToId?: string
    mediaIds?: readonly string[]
  }>
  /** Every media upload, in call order; the ids are what createPost must carry. */
  readonly uploaded: Array<{ accountId: string; assetId: string; mediaId: string }>
  readonly deleted: string[]
  setProfile(accountId: string, profile: Partial<XProfile>): void
  /** What the next probeAccount answers for the account. Unset accounts are ok. */
  setHealth(accountId: string, status: ChannelHealthStatus): void
  tamper(postId: string, text: string): void
  vanish(postId: string): void
  setUnreachable(unreachable: boolean): void
}

export interface FakeXOptions {
  operatorName: string
  nowUnix?: () => number
}

export function createFakeXTransport(options: FakeXOptions): FakeXTransport {
  const now = options.nowUnix ?? (() => Math.floor(Date.now() / 1000))
  const posts = new Map<string, { accountId: string; text: string }>()
  const profiles = new Map<string, XProfile>()
  const health = new Map<string, ChannelHealthStatus>()
  const created: FakeXTransport['created'] = []
  const uploaded: FakeXTransport['uploaded'] = []
  const deleted: string[] = []
  let nextId = 5000
  let unreachable = false

  const guard = (): void => {
    if (unreachable) throw new ChannelTransportError('network down', 'x_operator')
  }

  const defaultProfile = (accountId: string): XProfile => ({
    accountId,
    username: accountId,
    description: `${DISCLOSURE.aiOperationTag} by ${options.operatorName}. Operational updates only.`,
    automatedLabel: true,
    labelObservedAtUnix: now(),
  })

  return {
    created,
    uploaded,
    deleted,
    setProfile(accountId, profile) {
      profiles.set(accountId, { ...defaultProfile(accountId), ...profile })
    },
    setHealth(accountId, status) {
      health.set(accountId, status)
    },
    tamper(postId, text) {
      const existing = posts.get(postId)
      if (existing !== undefined) posts.set(postId, { ...existing, text })
    },
    vanish(postId) {
      posts.delete(postId)
    },
    setUnreachable(value) {
      unreachable = value
    },
    async createPost(req) {
      guard()
      for (const mediaId of req.mediaIds ?? []) {
        if (!uploaded.some((u) => u.mediaId === mediaId && u.accountId === req.accountId)) {
          throw new ChannelTransportError(`media ${mediaId} was never uploaded by ${req.accountId}`, 'x_operator')
        }
      }
      const postId = String(nextId++)
      posts.set(postId, { accountId: req.accountId, text: req.text })
      created.push({
        accountId: req.accountId,
        postId,
        text: req.text,
        ...(req.inReplyToId === undefined ? {} : { inReplyToId: req.inReplyToId }),
        ...(req.mediaIds === undefined ? {} : { mediaIds: [...req.mediaIds] }),
      })
      return { id: postId }
    },
    async uploadMedia(req) {
      guard()
      const mediaId = `media-${nextId++}`
      uploaded.push({ accountId: req.accountId, assetId: req.asset.id, mediaId })
      return { mediaId }
    },
    async getPost(req) {
      guard()
      const post = posts.get(req.postId)
      if (post === undefined) return null
      return { id: req.postId, text: post.text }
    },
    async deletePost(req) {
      guard()
      posts.delete(req.postId)
      deleted.push(req.postId)
    },
    async getProfile(accountId) {
      guard()
      return profiles.get(accountId) ?? defaultProfile(accountId)
    },
    async probeAccount(accountId) {
      guard()
      const status = health.get(accountId) ?? 'ok'
      return { status, observedAtUnix: now(), detail: `fake ${status}` }
    },
  }
}

export interface FakeSiteStore extends SiteStore {
  readonly pages: Map<string, SitePage>
  readonly deleted: string[]
  tamper(id: string, text: string): void
  vanish(id: string): void
}

export function createFakeSiteStore(baseUrl = 'https://ops.example.com'): FakeSiteStore {
  const pages = new Map<string, SitePage>()
  const deleted: string[] = []
  let nextId = 1

  return {
    pages,
    deleted,
    tamper(id, text) {
      const page = pages.get(id)
      if (page !== undefined) pages.set(id, { ...page, text })
    },
    vanish(id) {
      pages.delete(id)
    },
    async putPage(req) {
      const id = `page-${nextId++}`
      const url = `${baseUrl}/${req.section}/${id}`
      pages.set(id, { id, url, text: req.text })
      return { id, url }
    },
    async getPage(id) {
      return pages.get(id) ?? null
    },
    async removePage(id) {
      pages.delete(id)
      deleted.push(id)
    },
  }
}

export interface FakeChannelSet {
  adapters: Record<Channel, ChannelAdapter>
  telegram: FakeTelegramTransport
  x: FakeXTransport
  site: FakeSiteStore
}

export function createFakeChannelSet(options: {
  operatorName: string
  nowUnix?: () => number
  auditChatId?: string
  /** Defaults to an empty source, so any imageRef is refused. */
  images?: ImageAssetSource
}): FakeChannelSet {
  const telegram = createFakeTelegramTransport()
  const x = createFakeXTransport({
    operatorName: options.operatorName,
    ...(options.nowUnix === undefined ? {} : { nowUnix: options.nowUnix }),
  })
  const site = createFakeSiteStore()
  const images = options.images ?? createFakeImageAssetSource()
  const nowOpt = options.nowUnix === undefined ? {} : { nowUnix: options.nowUnix }

  return {
    telegram,
    x,
    site,
    adapters: {
      telegram: createTelegramAdapter({
        transport: telegram,
        images,
        auditChatId: options.auditChatId ?? 'audit-chat',
        ...nowOpt,
      }),
      x_operator: createXAdapter({ channel: 'x_operator', transport: x, images, ...nowOpt }),
      x_client_delegated: createXAdapter({
        channel: 'x_client_delegated',
        transport: x,
        images,
        ...nowOpt,
      }),
      site: createSiteAdapter({ store: site, ...nowOpt }),
    },
  }
}

import {
  ChannelTransportError,
  SITE_LIMITS,
  type AdapterPublishInput,
  type ChannelAdapter,
  type FetchedPost,
  type PublishedPost,
} from './types.js'

/**
 * The operator's own site.
 *
 * Nothing here is special-cased for being ours. The same disclosure block goes
 * into the same visible body, because "it is on our own site" is not a defence
 * to an undisclosed endorsement - and the receipts page a disclosure links to is
 * itself a separate page, which the FTC guides do not accept as a cure.
 */

export interface SitePage {
  id: string
  url: string
  text: string
}

export interface SiteStore {
  putPage(req: { section: string; text: string; correlationId?: string }): Promise<{ id: string; url: string }>
  getPage(id: string): Promise<SitePage | null>
  removePage(id: string): Promise<void>
}

export interface SiteHttpOptions {
  /** Base of the operator's content API, e.g. https://ops.example.com/api. */
  endpoint: string
  apiToken: string
  fetchImpl?: typeof fetch
}

export function createSiteHttpStore(options: SiteHttpOptions): SiteStore {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const base = options.endpoint.replace(/\/+$/, '')

  async function call<T>(
    path: string,
    init: { method: 'GET' | 'PUT' | 'DELETE'; body?: unknown },
  ): Promise<T | null> {
    let response: Response
    try {
      response = await doFetch(`${base}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${options.apiToken}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
    } catch (cause) {
      throw new ChannelTransportError(`${path} unreachable`, 'site', cause)
    }
    if (response.status === 404) return null
    if (!response.ok) {
      throw new ChannelTransportError(`${path} failed: ${response.status}`, 'site')
    }
    if (response.status === 204) return null
    return (await response.json()) as T
  }

  return {
    async putPage(req) {
      const result = await call<{ id: string; url: string }>('/pages', {
        method: 'PUT',
        body: {
          section: req.section,
          text: req.text,
          ...(req.correlationId === undefined ? {} : { correlation_id: req.correlationId }),
        },
      })
      if (result === null) throw new ChannelTransportError('putPage returned no page', 'site')
      return result
    },
    async getPage(id) {
      return await call<SitePage>(`/pages/${encodeURIComponent(id)}`, { method: 'GET' })
    },
    async removePage(id) {
      await call<never>(`/pages/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
  }
}

export interface SiteAdapterOptions {
  store: SiteStore
  nowUnix?: () => number
}

export function createSiteAdapter(options: SiteAdapterOptions): ChannelAdapter {
  const now = options.nowUnix ?? (() => Math.floor(Date.now() / 1000))

  return {
    channel: 'site',
    limits: SITE_LIMITS,

    async publish(input: AdapterPublishInput): Promise<PublishedPost> {
      // imageRefs are ignored on purpose: the site page store takes text only.
      // The publisher has already allowlisted the ids; there is nothing to
      // upload and refusing would block a text page that is otherwise fine.
      const page = await options.store.putPage({
        section: input.accountId,
        text: input.text,
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      })
      return { externalId: page.id, url: page.url, publishedAtUnix: now() }
    },

    async fetchPost(externalId: string): Promise<FetchedPost | null> {
      const page = await options.store.getPage(externalId)
      if (page === null) return null
      return { externalId: page.id, text: page.text, url: page.url }
    },

    async deletePost(externalId: string): Promise<void> {
      await options.store.removePage(externalId)
    },
  }
}

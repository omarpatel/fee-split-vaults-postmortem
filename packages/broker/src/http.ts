/**
 * The only outbound-network shape this package knows about.
 *
 * Every external dependency (the policy service, evidence providers) is
 * expressed against this interface so that the deterministic core can be tested
 * with an in-memory implementation and so that no transport library leaks into
 * the gate chain.
 */

export interface HttpResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

export interface HttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers?: Record<string, string>
  body?: string
  timeoutMs: number
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>

/**
 * Real client over the platform fetch. Times out rather than hanging: a hung
 * policy fetch and a failed policy fetch must be the same event, because both
 * mean NO SPEND.
 */
export function createFetchHttpClient(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): HttpClient {
  return async (request) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), request.timeoutMs)
    try {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      })
      return {
        ok: response.ok,
        status: response.status,
        text: () => response.text(),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface StubbedRoute {
  status: number
  body: string
}

/** In-memory client for tests. Unrouted URLs fail, they do not 200 with junk. */
export function createFakeHttpClient(
  routes: Map<string, StubbedRoute | (() => StubbedRoute | Promise<StubbedRoute>)>,
): HttpClient {
  return async (request) => {
    const route = routes.get(request.url)
    if (route === undefined) {
      throw new Error(`fake http: no route for ${request.method} ${request.url}`)
    }
    const resolved = typeof route === 'function' ? await route() : route
    return {
      ok: resolved.status >= 200 && resolved.status < 300,
      status: resolved.status,
      text: async () => resolved.body,
    }
  }
}

/**
 * The narrowest HTTP surface this package needs, plus a fake.
 *
 * External dependencies get a typed interface and an in-memory implementation
 * so that every test runs offline and deterministically. Nothing in this
 * package calls `fetch` directly; the one place a real socket is opened is
 * `nodeFetchClient`, and it is only ever constructed by a script.
 */
import { CatalogError } from './errors.js'

export interface HttpRequest {
  url: string
  timeoutMs?: number
  headers?: Record<string, string>
}

export interface HttpResponse {
  ok: boolean
  status: number
  /** Body as text. Callers parse; this layer never guesses a content type. */
  text: string
  /** Lowercased header names. `last-modified` is how a list dates itself. */
  headers?: Record<string, string>
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>

/** Real network. Only a script may construct this. */
export function nodeFetchClient(): HttpClient {
  return async ({ url, timeoutMs = 30_000, headers }) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal, headers })
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value
      })
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
        headers: responseHeaders,
      }
    } catch (error) {
      throw new CatalogError(
        'screening_data',
        'fetch_failed',
        `GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Deterministic fake. Unregistered URLs 404 rather than throwing, so a test
 *  can exercise the fail-closed path without stubbing an exception. */
export class FakeHttpClient {
  readonly requests: HttpRequest[] = []
  readonly #responses = new Map<string, HttpResponse>()

  constructor(seed: Readonly<Record<string, string>> = {}) {
    for (const [url, text] of Object.entries(seed)) {
      this.on(url, text)
    }
  }

  on(url: string, text: string, status = 200, headers: Record<string, string> = {}): this {
    this.#responses.set(url, { ok: status >= 200 && status < 300, status, text, headers })
    return this
  }

  onStatus(url: string, status: number, text = ''): this {
    this.#responses.set(url, { ok: status >= 200 && status < 300, status, text })
    return this
  }

  get client(): HttpClient {
    return async (request) => {
      this.requests.push(request)
      return this.#responses.get(request.url) ?? { ok: false, status: 404, text: '' }
    }
  }
}

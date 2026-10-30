/**
 * The one outbound HTTP surface these tools use.
 *
 * Narrow interface + in-memory fake, per the repo's external-dependency rule.
 * Tests never touch the network; they drive FakeHttpClient with recorded
 * fixtures, so a red test means our parsing broke, not that an endpoint moved.
 *
 * Rate limiting is a hard token bucket rather than a sleep between calls,
 * because GeckoTerminal's free tier is a per-minute quota and a burst of
 * parallel per-token pool lookups will otherwise trip it halfway through an
 * enumeration and leave a partial market count that looks complete.
 */

export interface HttpRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** Label used in progress logs and in the dry-run request budget. */
  label?: string
  /**
   * Rate-limit slots this request consumes. Default 1.
   *
   * A JSON-RPC batch of 10 is ONE HTTP request but ten units of work, and the
   * endpoint bills it that way. Pacing a batch of 10 as if it were a single
   * call is how a scan runs at ten times the configured rate, sails along for
   * four minutes and then gets hard-throttled - which is exactly what a live
   * run did before this existed. `requestsPerSecond` therefore means
   * SUB-REQUESTS per second, batched or not.
   */
  weight?: number
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>
  /** Total requests actually issued. Reported in every tool's meta block. */
  readonly requestCount: number
}

export class HttpError extends Error {
  readonly status: number
  readonly bodySnippet: string

  constructor(message: string, status: number, bodySnippet: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.bodySnippet = bodySnippet
  }
}

export class FetchHttpClient implements HttpClient {
  #count = 0
  readonly #defaultTimeoutMs: number

  constructor(defaultTimeoutMs = 30_000) {
    this.#defaultTimeoutMs = defaultTimeoutMs
  }

  get requestCount(): number {
    return this.#count
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.#count++
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? this.#defaultTimeoutMs)
    try {
      const response = await fetch(req.url, {
        method: req.method ?? 'GET',
        ...(req.headers ? { headers: req.headers } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
        signal: controller.signal,
      })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      return { status: response.status, headers, body: await response.text() }
    } finally {
      clearTimeout(timeout)
    }
  }
}

/**
 * Adaptive rate control.
 *
 * Retrying a 429 at the SAME rate is how a scan that is 5% too fast spends an
 * hour retrying instead of finishing: every chunk pays the backoff, and the
 * endpoint never gets a chance to serve at a rate it likes. So a throttle
 * lowers the sustained rate, and a run of clean responses raises it back
 * towards the ceiling the operator configured - never above it.
 */
export interface AdaptiveRateOptions {
  /** Rate is never lowered below this, or the scan simply stops finishing. */
  minRequestsPerSecond: number
  /** Multiplier applied to the rate on a throttle. < 1. */
  backoffFactor?: number
  /** Multiplier applied after a clean run. > 1. */
  recoverFactor?: number
  /**
   * Consecutive non-throttled responses before the rate steps back up.
   *
   * Kept SMALL on purpose. With batching, one "request" can be a minute of
   * wall clock at a throttled rate, so a recovery threshold of 25 would take
   * most of an hour to step up once - the rate would effectively never come
   * back and a scan would crawl at the floor long after the endpoint recovered.
   */
  recoverAfterSuccesses?: number
  onRateChange?: (requestsPerSecond: number, reason: string) => void
}

export interface RateLimitOptions {
  requestsPerSecond: number
  maxRetries: number
  /** Base delay for exponential backoff, milliseconds. */
  baseBackoffMs?: number
  maxBackoffMs?: number
  /** Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  random?: () => number
  onRetry?: (attempt: number, delayMs: number, reason: string) => void
  /** Absent means a fixed rate, which is the old behaviour. */
  adaptive?: AdaptiveRateOptions
}

/** Statuses that mean "you are going too fast", as opposed to "I broke". */
const THROTTLE_STATUS = new Set([429, 503])

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524])

/**
 * Token-bucket rate limiter + retry with full-jitter exponential backoff.
 * Honours Retry-After when the server sends one, because guessing shorter than
 * the server's own answer is how a soft rate limit becomes a hard ban.
 */
export class RateLimitedHttpClient implements HttpClient {
  #count = 0
  #nextSlotAt = 0
  #currentRps: number
  #cleanRun = 0
  #throttles = 0
  readonly #ceilingRps: number
  readonly #sleep: (ms: number) => Promise<void>
  readonly #now: () => number
  readonly #random: () => number
  /** Serialises slot reservation so parallel callers cannot claim the same slot. */
  #queue: Promise<void> = Promise.resolve()
  readonly #inner: HttpClient
  readonly #options: RateLimitOptions

  constructor(inner: HttpClient, options: RateLimitOptions) {
    if (options.requestsPerSecond <= 0) throw new Error('requestsPerSecond must be > 0')
    if (options.adaptive && options.adaptive.minRequestsPerSecond <= 0) {
      throw new Error('adaptive.minRequestsPerSecond must be > 0')
    }
    this.#inner = inner
    this.#options = options
    this.#ceilingRps = options.requestsPerSecond
    this.#currentRps = options.requestsPerSecond
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.#now = options.now ?? (() => Date.now())
    this.#random = options.random ?? Math.random
  }

  get requestCount(): number {
    return this.#count
  }

  /** The rate actually in force. Reported in run meta so a slow run explains itself. */
  get currentRequestsPerSecond(): number {
    return this.#currentRps
  }

  /** How many times the endpoint said "slow down". */
  get throttleCount(): number {
    return this.#throttles
  }

  #onThrottle(reason: string): void {
    this.#throttles++
    const adaptive = this.#options.adaptive
    if (adaptive === undefined) return
    this.#cleanRun = 0
    const next = Math.max(
      adaptive.minRequestsPerSecond,
      this.#currentRps * (adaptive.backoffFactor ?? 0.6),
    )
    if (next !== this.#currentRps) {
      this.#currentRps = next
      adaptive.onRateChange?.(next, `throttled (${reason})`)
    }
  }

  #onClean(): void {
    const adaptive = this.#options.adaptive
    if (adaptive === undefined) return
    this.#cleanRun++
    if (this.#cleanRun < (adaptive.recoverAfterSuccesses ?? 5)) return
    this.#cleanRun = 0
    // The operator's configured rate is a CEILING, not a target to exceed: it
    // was measured, and a recovery loop that climbed past it would rediscover
    // the 429 wall on every run.
    const next = Math.min(this.#ceilingRps, this.#currentRps * (adaptive.recoverFactor ?? 1.3))
    if (next !== this.#currentRps) {
      this.#currentRps = next
      adaptive.onRateChange?.(next, 'recovered')
    }
  }

  async #acquireSlot(weight: number): Promise<void> {
    const wait = this.#queue.then(async () => {
      const now = this.#now()
      const slot = Math.max(now, this.#nextSlotAt)
      this.#nextSlotAt = slot + (1000 / this.#currentRps) * weight
      const delay = slot - now
      if (delay > 0) await this.#sleep(delay)
    })
    this.#queue = wait.then(
      () => undefined,
      () => undefined,
    )
    await wait
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const maxAttempts = this.#options.maxRetries + 1
    const weight = Math.max(1, req.weight ?? 1)
    let lastReason = 'no attempt made'
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.#acquireSlot(weight)
      this.#count++
      let response: HttpResponse | undefined
      try {
        response = await this.#inner.request(req)
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error)
      }

      if (response !== undefined && !RETRYABLE_STATUS.has(response.status)) {
        this.#onClean()
        return response
      }
      if (response !== undefined) {
        lastReason = `HTTP ${response.status}`
        if (THROTTLE_STATUS.has(response.status)) this.#onThrottle(lastReason)
      }
      if (attempt === maxAttempts) break

      const retryAfterMs = parseRetryAfter(response?.headers['retry-after'])
      const base = this.#options.baseBackoffMs ?? 500
      const max = this.#options.maxBackoffMs ?? 30_000
      const exponential = Math.min(max, base * 2 ** (attempt - 1))
      const jittered = Math.floor(exponential * (0.5 + this.#random() * 0.5))
      const delay = Math.max(retryAfterMs ?? 0, jittered)
      this.#options.onRetry?.(attempt, delay, lastReason)
      await this.#sleep(delay)
    }
    throw new HttpError(
      `${req.label ?? req.url}: giving up after ${maxAttempts} attempts (${lastReason})`,
      0,
      '',
    )
  }
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

export interface FakeRoute {
  /** Matched against the full URL as a substring, or a predicate for finer control. */
  match: string | ((req: HttpRequest) => boolean)
  /** A single response, or a queue consumed one per matching request. */
  respond: HttpResponse | HttpResponse[] | ((req: HttpRequest) => HttpResponse)
}

/** In-memory HttpClient for tests and for --dry-run request accounting. */
export class FakeHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = []
  readonly routes: FakeRoute[]
  #count = 0

  constructor(routes: FakeRoute[] = []) {
    this.routes = routes
  }

  get requestCount(): number {
    return this.#count
  }

  addRoute(route: FakeRoute): this {
    this.routes.push(route)
    return this
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.#count++
    this.requests.push(req)
    for (const route of this.routes) {
      const hit =
        typeof route.match === 'string' ? req.url.includes(route.match) : route.match(req)
      if (!hit) continue
      if (typeof route.respond === 'function') return route.respond(req)
      if (Array.isArray(route.respond)) {
        const next = route.respond.shift()
        if (next === undefined) break
        return next
      }
      return route.respond
    }
    return { status: 404, headers: {}, body: `FakeHttpClient: no route for ${req.url}` }
  }
}

export function jsonResponse(value: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  }
}

export function buildHttpClient(options: {
  requestsPerSecond: number
  maxRetries: number
  timeoutMs: number
  onRetry?: (attempt: number, delayMs: number, reason: string) => void
  /** Absent means a fixed rate. Long scans should pass one. */
  adaptive?: AdaptiveRateOptions
}): RateLimitedHttpClient {
  return new RateLimitedHttpClient(new FetchHttpClient(options.timeoutMs), {
    requestsPerSecond: options.requestsPerSecond,
    maxRetries: options.maxRetries,
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    ...(options.adaptive ? { adaptive: options.adaptive } : {}),
  })
}

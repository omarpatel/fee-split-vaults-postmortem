/**
 * A router, not a framework.
 *
 * Everything a framework would give us here is something we would then have to
 * audit: body parsers that coerce types, middleware that mutates the request,
 * error handlers that leak a stack trace to a client. This is ~120 lines, it
 * has no dependencies, and the route table is readable in one screen - which is
 * the actual requirement, because the route map IS the attack surface.
 *
 * THE INBOUND RULE. Every handler receives an already-parsed JSON value and is
 * expected to validate it. There is no automatic coercion anywhere: a string
 * that should be a number stays a string and the handler refuses it.
 */

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

/**
 * Who the server authenticated before the handler ran. Absent when the router
 * is driven directly (tests) or the path is public. A dev handler MUST check
 * for `kind: 'dev'` itself; the server only proves the bearer, it does not
 * decide what a dev may read.
 */
export type Principal =
  | { kind: 'operator' }
  | { kind: 'dev'; address: string; sessionId: string }

export interface RequestContext {
  method: Method
  path: string
  params: Readonly<Record<string, string>>
  query: Readonly<Record<string, string>>
  /** Parsed JSON body, or undefined. NEVER coerced. */
  body: unknown
  headers: Readonly<Record<string, string>>
  principal?: Principal
}

export interface Response {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export type Handler = (ctx: RequestContext) => Promise<Response> | Response

export interface Route {
  method: Method
  /** `/vaults/:vault/receipts`. Segments starting with ':' bind a param. */
  pattern: string
  handler: Handler
  /** One line, for the printed route map. */
  summary: string
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (code: string, message: string): HttpError =>
  new HttpError(400, code, message)
export const notFound = (code: string, message: string): HttpError =>
  new HttpError(404, code, message)
export const conflict = (code: string, message: string): HttpError =>
  new HttpError(409, code, message)
export const unauthorized = (code: string, message: string): HttpError =>
  new HttpError(401, code, message)
/**
 * A dependency this process needs is not wired.
 *
 * Distinct from 500 on purpose: 500 says we broke, 503 says we refuse to answer
 * because the thing that knows the answer is absent. A route that returned an
 * empty or zeroed body here would be inventing a state.
 */
export const serviceUnavailable = (code: string, message: string): HttpError =>
  new HttpError(503, code, message)

interface CompiledRoute extends Route {
  segments: string[]
}

export class Router {
  readonly #routes: CompiledRoute[] = []

  add(route: Route): this {
    this.#routes.push({ ...route, segments: route.pattern.split('/').filter((s) => s.length > 0) })
    return this
  }

  get routes(): readonly Route[] {
    return this.#routes
  }

  /** The printed route map. `npm start` writes this to stdout on boot. */
  describe(): string {
    const width = Math.max(...this.#routes.map((r) => r.method.length + r.pattern.length + 1))
    return this.#routes
      .map((r) => `${`${r.method} ${r.pattern}`.padEnd(width)}  ${r.summary}`)
      .join('\n')
  }

  match(
    method: Method,
    path: string,
  ): { route: Route; params: Record<string, string> } | undefined {
    const parts = path.split('/').filter((s) => s.length > 0)
    for (const route of this.#routes) {
      if (route.method !== method) continue
      if (route.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let ok = true
      for (const [i, segment] of route.segments.entries()) {
        const actual = parts[i]
        if (actual === undefined) {
          ok = false
          break
        }
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(actual)
          continue
        }
        if (segment !== actual) {
          ok = false
          break
        }
      }
      if (ok) return { route, params }
    }
    return undefined
  }

  async handle(ctx: Omit<RequestContext, 'params'>): Promise<Response> {
    const matched = this.match(ctx.method, ctx.path)
    if (matched === undefined) {
      return { status: 404, body: { error: 'no_such_route', message: 'no such route' } }
    }
    try {
      return await matched.route.handler({ ...ctx, params: matched.params })
    } catch (error) {
      return toErrorResponse(error)
    }
  }
}

/**
 * Errors become a machine code and a short message and nothing else.
 *
 * No stack, no cause chain, no echo of the request body. An error message that
 * quotes back untrusted input is a reflected-content bug, and an error message
 * that carries a stack tells an attacker the shape of the service.
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: error.code, message: error.message } }
  }
  if (error !== null && typeof error === 'object' && 'code' in error && 'message' in error) {
    const code = (error as { code: unknown }).code
    const message = (error as { message: unknown }).message
    if (typeof code === 'string' && typeof message === 'string') {
      return { status: 400, body: { error: code, message } }
    }
  }
  return { status: 500, body: { error: 'internal_error', message: 'internal error' } }
}

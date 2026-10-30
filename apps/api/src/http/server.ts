/**
 * node:http adapter. The router is the interesting part; this just moves bytes.
 *
 * Two properties worth naming: the body is size-capped BEFORE it is parsed (so
 * a large body costs a socket read and nothing else), and every path is
 * classified by an auth policy BEFORE the router sees it: public, dev (a
 * wallet-signed session bearer) or operator (the shared token, compared in
 * constant time). A path the policy does not name is operator-only.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { MAX_BODY_BYTES, parseJsonBody, serialize } from './json.js'
import type { Method, Principal, Router } from './router.js'
import { toErrorResponse } from './router.js'

const METHODS: readonly Method[] = ['GET', 'POST', 'PUT', 'DELETE']

function isMethod(value: string): value is Method {
  return (METHODS as readonly string[]).includes(value)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export type AuthScope = 'public' | 'dev' | 'operator'

/** Answers a dev bearer with the session it names, or undefined for anything else. */
export interface DevSessionVerifier {
  verify(token: string): Promise<{ address: string; sessionId: string } | undefined>
}

export interface ServerOptions {
  router: Router
  /** When set, every operator-scoped route requires `Authorization: Bearer <token>`. Absent: no gate at all (tests). */
  operatorToken?: string
  /** Scope of a path. Default: everything is operator. */
  scopeOf?: (path: string) => AuthScope
  /** Absent: every dev-scoped path answers 503. */
  devSessions?: DevSessionVerifier
}

export type AuthDecision =
  | { ok: true; principal?: Principal }
  | { ok: false; status: number; body: { error: string; message: string } }

function bearerOf(headers: Readonly<Record<string, string>>): string {
  const auth = headers.authorization ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

/**
 * The whole auth decision, pure enough to test without a socket. An operator
 * token that is not configured means the process runs ungated, which is what
 * the tests want and what production refuses at config time.
 */
export async function authorize(
  options: Pick<ServerOptions, 'operatorToken' | 'scopeOf' | 'devSessions'>,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<AuthDecision> {
  const scope = options.scopeOf === undefined ? 'operator' : options.scopeOf(path)
  if (scope === 'public') return { ok: true }
  if (scope === 'dev') {
    if (options.devSessions === undefined) {
      return { ok: false, status: 503, body: { error: 'dev_sessions_unwired', message: 'dev sessions are not configured' } }
    }
    const token = bearerOf(headers)
    const session = token.length === 0 ? undefined : await options.devSessions.verify(token)
    if (session === undefined) {
      return { ok: false, status: 401, body: { error: 'unauthorized', message: 'dev session required' } }
    }
    return { ok: true, principal: { kind: 'dev', address: session.address, sessionId: session.sessionId } }
  }
  if (options.operatorToken === undefined) return { ok: true, principal: { kind: 'operator' } }
  if (!tokenMatches(bearerOf(headers), options.operatorToken)) {
    return { ok: false, status: 401, body: { error: 'unauthorized', message: 'operator token required' } }
  }
  return { ok: true, principal: { kind: 'operator' } }
}

/** Constant time so a token cannot be recovered a byte at a time. */
export function tokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function createApiServer(options: ServerOptions): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const method = (req.method ?? 'GET').toUpperCase()
      const url = new URL(req.url ?? '/', 'http://localhost')

      if (!isMethod(method)) {
        send(res, 405, { error: 'method_not_allowed', message: 'method not allowed' })
        return
      }

      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key.toLowerCase()] = value
      }

      const decision = await authorize(options, url.pathname, headers)
      if (!decision.ok) {
        send(res, decision.status, decision.body)
        return
      }

      let body: unknown
      try {
        body = parseJsonBody(await readBody(req))
      } catch (error) {
        const response = toErrorResponse(error)
        send(res, response.status, response.body)
        return
      }

      const query: Record<string, string> = {}
      for (const [key, value] of url.searchParams) query[key] = value

      const response = await options.router.handle({
        method,
        path: url.pathname,
        query,
        body,
        headers,
        ...(decision.principal === undefined ? {} : { principal: decision.principal }),
      })
      send(res, response.status, response.body, response.headers)
    })().catch(() => {
      send(res, 500, { error: 'internal_error', message: 'internal error' })
    })
  })
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (body instanceof Uint8Array) {
    // Bytes (a rendered PNG) go out as they are; the handler set the type.
    res.writeHead(status, {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    })
    res.end(body)
    return
  }
  let payload: string
  try {
    payload = serialize(body)
  } catch {
    // A bigint reached the serialiser. That is a bug in a handler, and sending
    // a lossy number instead would be a money bug, so the request fails.
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end('{"error":"serialisation_failed","message":"internal error"}')
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(payload)
}

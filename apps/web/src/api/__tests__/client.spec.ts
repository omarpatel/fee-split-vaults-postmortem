import { describe, expect, it } from 'vitest'

import { ApiError, HttpApiClient } from '../client.js'
import type { Session } from '../model.js'

/**
 * Which routes carry a credential.
 *
 * The public routes and the agent routes take NONE: the coin page is an
 * artifact anyone can read and cache, and a bearer on it would make the
 * public page depend on a secret. The dev routes take exactly the session the
 * signature exchange returned. This test pins the boundary from the outside,
 * through the fetch the client makes, so a refactor that started sending the
 * session everywhere - or nowhere - fails here.
 */

const VAULT = `0x${'ab'.repeat(20)}`
const SESSION: Session = { token: 'sess-1', address: `0x${'cd'.repeat(20)}`, expiresAtUnix: 2_000_000_000, vaults: [VAULT] }

function stub(handler: (url: string) => Response) {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, headers: new Headers(init?.headers) })
    return handler(url)
  }
  return { calls, client: new HttpApiClient({ baseUrl: 'https://api.example', fetchImpl }) }
}

describe('HttpApiClient credentials', () => {
  it('sends no bearer on the public coin routes or the agent routes', async () => {
    const { calls, client } = stub(() => Response.json({ agent: null, roles: [] }))
    await client.getCoin(VAULT).catch(() => undefined)
    await client.listReceipts(VAULT).catch(() => undefined)
    await client.getCoinAgent(VAULT).catch(() => undefined)
    await client.getAgentRoles(VAULT).catch(() => undefined)
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.example/v1/coins/${VAULT}`,
      `https://api.example/v1/coins/${VAULT}/receipts`,
      `https://api.example/coins/${VAULT}/agent`,
      `https://api.example/coins/${VAULT}/agent/roles`,
    ])
    for (const call of calls) expect(call.headers.get('authorization')).toBeNull()
  })

  it('sends the dev session as the bearer on every /v1/dev route', async () => {
    const { calls, client } = stub(() => Response.json([]))
    await client.listDevVaults(SESSION)
    await client.listEscalations(SESSION, VAULT)
    await client.buildTerminateTx(SESSION, VAULT).catch(() => undefined)
    for (const call of calls) {
      expect(call.url.startsWith('https://api.example/v1/dev/')).toBe(true)
      expect(call.headers.get('authorization')).toBe('Bearer sess-1')
    }
  })

  it('sends no bearer on the signature exchange itself', async () => {
    const { calls, client } = stub(() => Response.json({ token: 't', address: SESSION.address, expiresAtUnix: 1, vaults: [] }))
    await client.verifySignature(SESSION.address, 'msg', '0xsig')
    expect(calls[0]?.url).toBe('https://api.example/v1/auth/verify')
    expect(calls[0]?.headers.get('authorization')).toBeNull()
  })
})

describe('HttpApiClient refusals', () => {
  it('carries the server code and status on a 404 so the coin page can tell "no such vault" from an outage', async () => {
    const { client } = stub(() => Response.json({ error: 'no_such_vault', message: 'no such vault' }, { status: 404 }))
    const failure = await client.getCoin(VAULT).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(404)
    expect((failure as ApiError).code).toBe('no_such_vault')
  })

  it('still refuses, with a null code, when the body is not JSON', async () => {
    const { client } = stub(() => new Response('<html>502</html>', { status: 502 }))
    const failure = await client.getCoin(VAULT).catch((error: unknown) => error)
    expect((failure as ApiError).status).toBe(502)
    expect((failure as ApiError).code).toBeNull()
    expect((failure as ApiError).message).toBe(`502 from /v1/coins/${VAULT}`)
  })
})

/**
 * The operator CLI against a fake fetch.
 *
 * What is pinned is the wire contract with apps/api: method, path, query,
 * bearer and the exact-key body each subcommand sends, because the API refuses
 * an undeclared field by name and a wrong field name here is a 400 the
 * operator cannot fix from the command line. The non-2xx path is pinned too:
 * the API's own code and message must reach stderr unaltered.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMANDS, runOperatorCli, type OperatorIo } from '../operator.ts'

const TOKEN = 'operator-token-0123456789-0123456789'
const VAULT = '0x1111111111111111111111111111111111111111'
const SIGNER = '0x2222222222222222222222222222222222222222'

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

interface Harness {
  io: OperatorIo
  requests: Captured[]
  stdout: string[]
  stderr: string[]
}

function harness(respond: (req: Captured) => Response = () => Response.json({ ok: true }), env: Record<string, string | undefined> = {}): Harness {
  const requests: Captured[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  const io: OperatorIo = {
    fetch: async (url, init) => {
      const headers = init.headers as Record<string, string>
      const captured: Captured = {
        url,
        method: init.method ?? 'GET',
        headers,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      }
      requests.push(captured)
      return respond(captured)
    },
    env: { VENUE_OPERATOR_API_TOKEN: TOKEN, VENUE_API_BASE_URL: 'http://api.test:9999', ...env },
    stdout: (t) => {
      stdout.push(t)
    },
    stderr: (t) => {
      stderr.push(t)
    },
  }
  return { io, requests, stdout, stderr }
}

/** Runs one command and returns the single request it sent, asserting exit 0. */
async function send(argv: string[], respond?: (req: Captured) => Response): Promise<Captured> {
  const h = harness(respond)
  const code = await runOperatorCli(argv, h.io)
  expect(h.stderr.join('')).toBe('')
  expect(code).toBe(0)
  expect(h.requests).toHaveLength(1)
  return h.requests[0]!
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the wire contract with apps/api', () => {
  it('sends the operator bearer, the base URL from the environment and a JSON accept', async () => {
    const req = await send(['onboarding', 'get', '--id', 'pump-1'])
    expect(req).toMatchObject({
      method: 'GET',
      url: 'http://api.test:9999/onboarding/pump-1',
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
      body: undefined,
    })
    expect(req.headers['content-type']).toBeUndefined()
  })

  it('defaults the base URL to the local API', async () => {
    const h = harness(undefined, { VENUE_API_BASE_URL: undefined })
    expect(await runOperatorCli(['health'], h.io)).toBe(0)
    expect(h.requests[0]!.url).toBe('http://127.0.0.1:8080/health')
  })

  describe('onboarding', () => {
    it('lists, narrowed by state', async () => {
      expect(await send(['onboarding', 'list', '--state', 'pointed'])).toMatchObject({
        method: 'GET',
        url: 'http://api.test:9999/onboarding?state=pointed',
      })
      expect((await send(['onboarding', 'list'])).url).toBe('http://api.test:9999/onboarding')
    })

    it('creates with the exact body keys, omitting every flag not given', async () => {
      const req = await send([
        'onboarding', 'create',
        '--id', 'pump-1', '--coin-ref', 'coin_1', '--token', VAULT, '--name', 'Pump', '--symbol', 'PUMP',
        '--dev-signer', SIGNER, '--dev-payout', SIGNER, '--terms-hash', '0xaa', '--adapter', VAULT, '--nonce', '0xbb',
        '--link', 'https://a.example,https://b.example', '--narrative-source', 'https://c.example',
        '--socials-x', '@pump', '--metadata-mutable', '--budget-bps-max', '500',
      ])
      expect(req.method).toBe('POST')
      expect(req.url).toBe('http://api.test:9999/onboarding')
      expect(req.headers['content-type']).toBe('application/json')
      expect(req.body).toEqual({
        id: 'pump-1',
        coinRef: 'coin_1',
        token: VAULT,
        name: 'Pump',
        symbol: 'PUMP',
        devSigner: SIGNER,
        devPayout: SIGNER,
        termsHash: '0xaa',
        adapter: VAULT,
        nonce: '0xbb',
        links: ['https://a.example', 'https://b.example'],
        metadataMutable: true,
        narrativeSources: ['https://c.example'],
        socials: { x: '@pump' },
        budgetBpsMax: 500,
      })

      const minimal = await send([
        'onboarding', 'create',
        '--id', 'pump-1', '--coin-ref', 'coin_1', '--token', VAULT, '--name', 'Pump', '--symbol', 'PUMP',
        '--dev-signer', SIGNER, '--dev-payout', SIGNER, '--terms-hash', '0xaa', '--adapter', VAULT, '--nonce', '0xbb',
      ])
      expect(Object.keys(minimal.body as object).sort()).toEqual(
        ['adapter', 'coinRef', 'devPayout', 'devSigner', 'id', 'name', 'nonce', 'symbol', 'termsHash', 'token'],
      )
    })

    it('posts each transition to its own path with no body', async () => {
      for (const step of ['diligence', 'deploy', 'pointing', 'acceptance', 'activate']) {
        const req = await send(['onboarding', step, '--id', 'pump 1'])
        expect(req.method).toBe('POST')
        expect(req.url).toBe(`http://api.test:9999/onboarding/pump%201/${step}`)
        expect(req.body).toBeUndefined()
      }
    })

    it('records a signature and a decline with their bodies', async () => {
      expect((await send(['onboarding', 'signature', '--id', 'p', '--signature', '0xsig'])).body).toEqual({ signature: '0xsig' })
      const decline = await send(['onboarding', 'decline', '--id', 'p', '--code', 'operator_declined'])
      expect(decline.url).toBe('http://api.test:9999/onboarding/p/decline')
      expect(decline.body).toEqual({ code: 'operator_declined' })
      expect((await send(['onboarding', 'decline', '--id', 'p', '--code', 'c', '--detail', 'why'])).body).toEqual({ code: 'c', detail: 'why' })
    })
  })

  describe('narrative and creative', () => {
    it('reads, derives and approves', async () => {
      expect(await send(['narrative', 'get', '--id', 'p'])).toMatchObject({ method: 'GET', url: 'http://api.test:9999/onboarding/p/narrative' })
      expect(await send(['narrative', 'derive', '--id', 'p'])).toMatchObject({ method: 'POST', url: 'http://api.test:9999/onboarding/p/narrative/derive', body: undefined })
      expect(await send(['narrative', 'approve', '--id', 'p', '--approved-by', 'alice'])).toMatchObject({
        method: 'POST',
        url: 'http://api.test:9999/onboarding/p/narrative/approve',
        body: { approvedBy: 'alice' },
      })
    })

    it('renders, and downloads a kind as bytes to --out', async () => {
      expect(await send(['creative', 'render', '--id', 'p'])).toMatchObject({ method: 'POST', url: 'http://api.test:9999/onboarding/p/creative/render' })

      const dir = mkdtempSync(join(tmpdir(), 'venue-operator-'))
      dirs.push(dir)
      const out = join(dir, 'banner.png')
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
      const h = harness(() => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }))
      expect(await runOperatorCli(['creative', 'get', '--id', 'p', '--kind', 'banner', '--out', out], h.io)).toBe(0)
      expect(h.requests[0]).toMatchObject({ method: 'GET', url: 'http://api.test:9999/onboarding/p/creative/banner', headers: { accept: 'image/png' } })
      expect(new Uint8Array(readFileSync(out))).toEqual(png)
      expect(JSON.parse(h.stdout.join(''))).toMatchObject({ wrote: out, bytes: 8, contentType: 'image/png' })
    })

    it('refuses creative get without --out rather than printing PNG bytes', async () => {
      const h = harness()
      expect(await runOperatorCli(['creative', 'get', '--id', 'p', '--kind', 'avatar'], h.io)).toBe(2)
      expect(h.stderr.join('')).toMatch(/--out <file> is required/)
      expect(h.requests).toHaveLength(0)
    })
  })

  describe('x accounts', () => {
    it('authorizes via query, binds and attests via body', async () => {
      expect((await send(['x', 'authorize', '--coin-ref', 'coin_1', '--account-id', '42'])).url).toBe(
        'http://api.test:9999/accounts/x/authorize?coinRef=coin_1&accountId=42',
      )
      expect(await send(['x', 'bind', '--account-id', '42', '--coin-ref', 'coin_1', '--ticker', 'PUMP'])).toMatchObject({
        method: 'POST',
        url: 'http://api.test:9999/accounts/x/bind',
        body: { accountId: '42', coinRef: 'coin_1', ticker: 'PUMP' },
      })
      expect(await send(['x', 'attest-label', '--account-id', '42', '--attested-by', 'alice', '--days', '30'])).toMatchObject({
        method: 'POST',
        url: 'http://api.test:9999/accounts/x/attest-label',
        body: { accountId: '42', attestedBy: 'alice', days: 30 },
      })
    })

    it('refuses a fractional day count before sending', async () => {
      const h = harness()
      expect(await runOperatorCli(['x', 'attest-label', '--account-id', '42', '--attested-by', 'a', '--days', '1.5'], h.io)).toBe(2)
      expect(h.stderr.join('')).toMatch(/--days must be an integer/)
      expect(h.requests).toHaveLength(0)
    })
  })

  describe('purchases and invoices', () => {
    it('lists purchases for a vault', async () => {
      expect((await send(['purchases', 'list', '--vault', VAULT])).url).toBe(`http://api.test:9999/purchases?vault=${VAULT}`)
    })

    it('posts an invoice with the amount as a decimal string and the baseline only when given', async () => {
      const argv = [
        'invoices', 'post', '--vault', VAULT, '--vendor-id', 'vendor.1', '--sku-id', 'boost:24h', '--quantity', '2',
        '--amount-usd', '12.50', '--vendor-countersig', '0xabcd', '--issued-at-unix', '1760000000',
      ]
      const req = await send(argv)
      expect(req).toMatchObject({ method: 'POST', url: 'http://api.test:9999/invoices' })
      expect(req.body).toEqual({
        vault: VAULT,
        vendorId: 'vendor.1',
        skuId: 'boost:24h',
        quantity: 2,
        amountUsd: '12.50',
        vendorCountersig: '0xabcd',
        issuedAtUnix: 1760000000,
      })
      const withBaseline = await send([...argv, '--invoice-hash', '0xff', '--baseline-rank', '7'])
      expect(withBaseline.body).toMatchObject({ invoiceHash: '0xff', baseline: { rank: 7 } })
    })

    it('refuses an amount that is not a two-place decimal string', async () => {
      const h = harness()
      const code = await runOperatorCli(
        ['invoices', 'post', '--vault', VAULT, '--vendor-id', 'v', '--sku-id', 's', '--quantity', '1', '--amount-usd', '12.505', '--vendor-countersig', '0x00', '--issued-at-unix', '1'],
        h.io,
      )
      expect(code).toBe(2)
      expect(h.stderr.join('')).toMatch(/--amount-usd must be a decimal string/)
      expect(h.requests).toHaveLength(0)
    })
  })

  describe('kyb, receipts and the report', () => {
    it('attests with attestedAtUnix only when given, and reads by signer', async () => {
      const attest = await send(['kyb', 'attest', '--dev-signer', SIGNER, '--attested-by', 'alice', '--provider-ref', 'sumsub:1', '--expires-at-unix', '1790000000'])
      expect(attest).toMatchObject({ method: 'POST', url: 'http://api.test:9999/diligence/kyb/attest' })
      expect(attest.body).toEqual({ devSigner: SIGNER, attestedBy: 'alice', providerRef: 'sumsub:1', expiresAtUnix: 1790000000 })
      expect((await send(['kyb', 'get', '--dev-signer', SIGNER])).url).toBe(`http://api.test:9999/diligence/kyb/${SIGNER}`)
    })

    it('passes the period as from/to query only when given', async () => {
      expect((await send(['receipts', 'list', '--vault', VAULT])).url).toBe(`http://api.test:9999/vaults/${VAULT}/receipts`)
      expect((await send(['receipts', 'list', '--vault', VAULT, '--from', '100', '--to', '200'])).url).toBe(
        `http://api.test:9999/vaults/${VAULT}/receipts?from=100&to=200`,
      )
      expect((await send(['receipts', 'get', '--vault', VAULT, '--id', 'r-1'])).url).toBe(`http://api.test:9999/vaults/${VAULT}/receipts/r-1`)
      expect((await send(['report', 'get', '--vault', VAULT, '--to', '200'])).url).toBe(`http://api.test:9999/vaults/${VAULT}/report?to=200`)
    })
  })

  describe('consent', () => {
    it('drafts with the optional fields omitted, and verifies with the consent parsed from JSON', async () => {
      const draft = await send(['consent', 'draft', '--dev-signer', SIGNER, '--dev-payout', SIGNER, '--terms-hash', '0xaa', '--adapter', VAULT, '--nonce', '0xbb', '--referrer-bps', '100'])
      expect(draft.body).toEqual({ devSigner: SIGNER, devPayout: SIGNER, termsHash: '0xaa', adapter: VAULT, nonce: '0xbb', referrerBps: 100 })
      const verify = await send(['consent', 'verify', '--consent', '{"devSigner":"0x1"}', '--signature', '0xsig'])
      expect(verify.body).toEqual({ consent: { devSigner: '0x1' }, signature: '0xsig' })
    })
  })
})

describe('exits and output', () => {
  it('exits 1 with the API code and message verbatim on a non-2xx', async () => {
    const h = harness(() => Response.json({ error: 'coin_not_eligible', message: 'an account is bound once the coin has pointed at the vault' }, { status: 409 }))
    expect(await runOperatorCli(['x', 'bind', '--account-id', '42', '--coin-ref', 'c', '--ticker', 'T'], h.io)).toBe(1)
    expect(h.stderr.join('')).toBe('operator x bind: coin_not_eligible: an account is bound once the coin has pointed at the vault\n')
    expect(h.stdout).toHaveLength(0)
  })

  it('falls back to the status and raw text when the failure body is not the API shape', async () => {
    const h = harness(() => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }))
    expect(await runOperatorCli(['routes'], h.io)).toBe(1)
    expect(h.stderr.join('')).toBe('operator routes: http_502: <html>bad gateway</html>\n')
  })

  it('refuses to run a gated command without the token, but health and routes still go', async () => {
    const h = harness(undefined, { VENUE_OPERATOR_API_TOKEN: undefined })
    expect(await runOperatorCli(['onboarding', 'get', '--id', 'p'], h.io)).toBe(2)
    expect(h.stderr.join('')).toMatch(/VENUE_OPERATOR_API_TOKEN is not set/)
    expect(h.requests).toHaveLength(0)

    expect(await runOperatorCli(['onboarding', 'get', '--id', 'p', '--dry-run'], h.io)).toBe(0)
    expect(h.requests).toHaveLength(0)

    expect(await runOperatorCli(['routes'], h.io)).toBe(0)
    expect(h.requests[0]!.headers.authorization).toBeUndefined()
  })

  it('--dry-run prints the request with the token redacted and sends nothing', async () => {
    const h = harness()
    expect(await runOperatorCli(['x', 'attest-label', '--account-id', '42', '--attested-by', 'alice', '--days', '30', '--dry-run'], h.io)).toBe(0)
    expect(h.requests).toHaveLength(0)
    const printed = JSON.parse(h.stdout.join(''))
    expect(printed).toEqual({
      dryRun: true,
      method: 'POST',
      url: 'http://api.test:9999/accounts/x/attest-label',
      headers: { accept: 'application/json', authorization: 'Bearer <redacted>', 'content-type': 'application/json' },
      body: { accountId: '42', attestedBy: 'alice', days: 30 },
    })
    expect(h.stdout.join('')).not.toContain(TOKEN)
  })

  it('pretty-prints the response by default and passes it through raw under --json', async () => {
    const pretty = harness(() => new Response('{"a":{"b":1}}'))
    await runOperatorCli(['health'], pretty.io)
    expect(pretty.stdout.join('')).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n')
    const raw = harness(() => new Response('{"a":{"b":1}}'))
    await runOperatorCli(['health', '--json'], raw.io)
    expect(raw.stdout.join('')).toBe('{"a":{"b":1}}\n')
  })

  it('names the group’s commands when the second word is missing or wrong', async () => {
    const h = harness()
    expect(await runOperatorCli(['onboarding'], h.io)).toBe(2)
    expect(h.stderr.join('')).toMatch(/onboarding takes one of: list, create, get/)
    expect(await runOperatorCli(['onboarding', 'nope'], h.io)).toBe(2)
    expect(await runOperatorCli(['nothing'], h.io)).toBe(2)
    expect(h.stderr.join('')).toMatch(/unknown command "nothing"/)
    expect(h.requests).toHaveLength(0)
  })

  it('covers every operator route in apps/api except the X redirect callback', () => {
    const paths = COMMANDS.map((c) => {
      const values: Record<string, string | number> = { consent: '{}', 'amount-usd': '1.00' }
      for (const o of c.options) values[o.name] ??= o.type === 'number' ? 1 : `${o.name}`
      const req = c.build(values)
      return `${req.method} ${req.path.replace(/\/onboarding\/id/, '/onboarding/:id').replace(/\/vaults\/vault/, '/vaults/:vault')}`
    })
    expect(paths).toEqual([
      'GET /health',
      'GET /routes',
      'POST /consent/draft',
      'POST /consent/verify',
      'GET /onboarding',
      'POST /onboarding',
      'GET /onboarding/:id',
      'POST /onboarding/:id/signature',
      'POST /onboarding/:id/diligence',
      'POST /onboarding/:id/deploy',
      'POST /onboarding/:id/pointing',
      'POST /onboarding/:id/acceptance',
      'POST /onboarding/:id/activate',
      'POST /onboarding/:id/decline',
      'GET /onboarding/:id/narrative',
      'POST /onboarding/:id/narrative/derive',
      'POST /onboarding/:id/narrative/approve',
      'POST /onboarding/:id/creative/render',
      'GET /onboarding/:id/creative/kind',
      'GET /accounts/x/authorize',
      'POST /accounts/x/bind',
      'POST /accounts/x/attest-label',
      'GET /purchases',
      'POST /invoices',
      'POST /diligence/kyb/attest',
      'GET /diligence/kyb/dev-signer',
      'GET /vaults/:vault/receipts',
      'GET /vaults/:vault/receipts/id',
      'GET /vaults/:vault/report',
    ])
  })
})

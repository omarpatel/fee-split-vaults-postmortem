/**
 * The typed API client.
 *
 * `ApiClient` is the narrow interface every page depends on. Two
 * implementations satisfy it: `HttpApiClient` against apps/api, and
 * `FixtureApiClient` in ./fixtures, which is a real in-memory backend rather
 * than a pile of canned responses - it applies the same lag, the same tier
 * gating and the same split arithmetic, so the demo cannot drift into showing
 * something the production path would never produce.
 */

import type * as M from './model.js'
import * as decode from './decode.js'
import { API_ROUTES } from './routes.js'
import type * as W from './wire.js'

export interface ConsentQuoteRequest {
  devSigner: string
  devPayout: string
  /** Zero address on the greenfield path. */
  token: string
  budgetBpsMax: number
  referrer?: string
  /**
   * Up to four documents the operator derives the coin's summary from. Plain
   * https URLs on public hosts; see domain/onboarding.ts for the rule. Stored
   * unfetched, and never shown on the public record: only their count is.
   */
  narrativeSources?: string[]
  /** The dev's claimed handles, without the '@'. For the operator; never public. */
  socials?: { x?: string }
}

export interface ConsentSubmission {
  consent: M.ConsentQuote['consent']
  /** EIP-712 signature over the consent digest. */
  signature: string
}

export interface EscalationAck {
  decision: 'acknowledged' | 'action_taken' | 'dismissed'
  note: string
}

export interface ApiClient {
  // public
  getProtocol(): Promise<M.ProtocolInfo>
  listCoins(): Promise<M.CoinSummary[]>
  getCoin(vault: string): Promise<M.PublicCoin>
  listReceipts(vault: string, cursor?: string | null): Promise<M.ReceiptPage>
  listVendorScorecards(vault: string): Promise<M.VendorScorecard[]>

  /**
   * The coin's agent team.
   *
   * Read-only, and every one of these carries `fakedDependencies`: a page that
   * rendered scripted model output without saying so would be presenting a
   * stand-in as the desk's own work.
   */
  getCoinAgent(vault: string): Promise<M.CoinAgent>
  listAgentRuns(vault: string, cursor?: string | null): Promise<M.AgentRunPage>
  getAgentRoles(vault: string): Promise<M.AgentRoleView[]>

  // wallet auth
  requestChallenge(address: string): Promise<M.AuthChallenge>
  verifySignature(address: string, message: string, signature: string): Promise<M.Session>

  // dev, bearer session
  listDevVaults(session: M.Session): Promise<M.CoinSummary[]>
  getDevVault(session: M.Session, vault: string): Promise<M.DevVaultDetail>
  listWeeklyReports(session: M.Session, vault: string): Promise<M.WeeklyReportView[]>
  listEscalations(session: M.Session, vault: string): Promise<M.Escalation[]>
  ackEscalation(
    session: M.Session,
    vault: string,
    id: string,
    ack: EscalationAck,
  ): Promise<M.Escalation>
  buildDialTx(session: M.Session, vault: string, budgetBps: number): Promise<M.UnsignedTx>
  buildTerminateTx(session: M.Session, vault: string): Promise<M.UnsignedTx>

  // onboarding
  quoteConsent(request: ConsentQuoteRequest): Promise<M.ConsentQuote>
  submitConsent(submission: ConsentSubmission): Promise<M.DeploymentTicket>
  getRetrofitPlan(token: string, vault: string): Promise<M.RetrofitPlan>
}

/**
 * A refused request. `code` is the server's machine code (`no_such_vault`,
 * `feature_unconfigured`, `chain_state_mismatch`, ...) when the body carried
 * one, and null when the refusal had no JSON body at all. Surfaces render the
 * code verbatim: a console that rewrote `illegal_transition` as "something went
 * wrong" would hide the one word the operator needs.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly route: string,
    readonly code: string | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** The shape apps/api emits for every refusal: `{ error: <code>, message }`. */
export async function refusalFrom(response: Response, route: string): Promise<ApiError> {
  let code: string | null = null
  let message = `${response.status} from ${route}`
  try {
    const body: unknown = await response.json()
    if (body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string' && body.error.length > 0) {
      code = body.error
      const detail = 'message' in body ? body.message : undefined
      message = typeof detail === 'string' && detail.length > 0 ? `${code}: ${detail}` : code
    }
  } catch {
    // Not JSON. The status line is all there is to say.
  }
  return new ApiError(message, response.status, route, code)
}

export interface HttpApiClientOptions {
  baseUrl: string
  /** Injected so tests and the fixture harness never touch global fetch. */
  fetchImpl?: typeof fetch
}

export class HttpApiClient implements ApiClient {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch

  constructor(options: HttpApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  async #request<T>(
    route: string,
    init?: { method?: string; body?: unknown; bearer?: string; query?: Record<string, string> },
  ): Promise<T> {
    const url = new URL(`${this.#baseUrl}${route}`, 'http://local.invalid')
    for (const [key, value] of Object.entries(init?.query ?? {})) {
      url.searchParams.set(key, value)
    }
    const target = this.#baseUrl.startsWith('http')
      ? url.toString()
      : `${url.pathname}${url.search}`

    const headers: Record<string, string> = { accept: 'application/json' }
    if (init?.body !== undefined) headers['content-type'] = 'application/json'
    if (init?.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`

    const response = await this.#fetch(target, {
      method: init?.method ?? 'GET',
      headers,
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })

    if (!response.ok) throw await refusalFrom(response, route)
    return (await response.json()) as T
  }

  async getProtocol(): Promise<M.ProtocolInfo> {
    return decode.decodeProtocol(await this.#request<W.ProtocolInfoWire>(API_ROUTES.protocol()))
  }

  async listCoins(): Promise<M.CoinSummary[]> {
    const wire = await this.#request<W.CoinSummaryWire[]>(API_ROUTES.coins())
    return wire.map(decode.decodeCoinSummary)
  }

  async getCoin(vault: string): Promise<M.PublicCoin> {
    return decode.decodePublicCoin(await this.#request<W.PublicCoinWire>(API_ROUTES.coin(vault)))
  }

  async listReceipts(vault: string, cursor?: string | null): Promise<M.ReceiptPage> {
    const wire = await this.#request<W.ReceiptPageWire>(API_ROUTES.coinReceipts(vault), {
      ...(cursor ? { query: { cursor } } : {}),
    })
    return decode.decodeReceiptPage(wire)
  }

  async listVendorScorecards(vault: string): Promise<M.VendorScorecard[]> {
    const wire = await this.#request<W.VendorScorecardWire[]>(API_ROUTES.coinVendors(vault))
    return wire.map(decode.decodeVendor)
  }

  async getCoinAgent(vault: string): Promise<M.CoinAgent> {
    const wire = await this.#request<{ agent: W.CoinAgentWire }>(API_ROUTES.coinAgent(vault))
    return decode.decodeCoinAgent(wire.agent)
  }

  async listAgentRuns(vault: string, cursor?: string | null): Promise<M.AgentRunPage> {
    const wire = await this.#request<W.AgentRunPageWire>(API_ROUTES.coinAgentRuns(vault), {
      ...(cursor ? { query: { cursor } } : {}),
    })
    return decode.decodeAgentRunPage(wire)
  }

  async getAgentRoles(vault: string): Promise<M.AgentRoleView[]> {
    const wire = await this.#request<{ roles: W.AgentRoleWire[] }>(
      API_ROUTES.coinAgentRoles(vault),
    )
    return wire.roles.map((role, i) => decode.decodeAgentRole(role, `roles[${String(i)}]`))
  }

  async requestChallenge(address: string): Promise<M.AuthChallenge> {
    return await this.#request<W.AuthChallengeWire>(API_ROUTES.authNonce(), {
      method: 'POST',
      body: { address },
    })
  }

  async verifySignature(address: string, message: string, signature: string): Promise<M.Session> {
    return await this.#request<W.SessionWire>(API_ROUTES.authVerify(), {
      method: 'POST',
      body: { address, message, signature },
    })
  }

  async listDevVaults(session: M.Session): Promise<M.CoinSummary[]> {
    const wire = await this.#request<W.CoinSummaryWire[]>(API_ROUTES.devVaults(), {
      bearer: session.token,
    })
    return wire.map(decode.decodeCoinSummary)
  }

  async getDevVault(session: M.Session, vault: string): Promise<M.DevVaultDetail> {
    const wire = await this.#request<W.DevVaultDetailWire>(API_ROUTES.devVault(vault), {
      bearer: session.token,
    })
    return decode.decodeDevVaultDetail(wire)
  }

  async listWeeklyReports(session: M.Session, vault: string): Promise<M.WeeklyReportView[]> {
    const wire = await this.#request<W.WeeklyReportWire[]>(API_ROUTES.devReports(vault), {
      bearer: session.token,
    })
    return wire.map(decode.decodeWeeklyReport)
  }

  async listEscalations(session: M.Session, vault: string): Promise<M.Escalation[]> {
    const wire = await this.#request<W.EscalationWire[]>(API_ROUTES.devEscalations(vault), {
      bearer: session.token,
    })
    return wire.map(decode.decodeEscalation)
  }

  async ackEscalation(
    session: M.Session,
    vault: string,
    id: string,
    ack: EscalationAck,
  ): Promise<M.Escalation> {
    const wire = await this.#request<W.EscalationWire>(API_ROUTES.devEscalationAck(vault, id), {
      method: 'POST',
      body: ack,
      bearer: session.token,
    })
    return decode.decodeEscalation(wire)
  }

  async buildDialTx(session: M.Session, vault: string, budgetBps: number): Promise<M.UnsignedTx> {
    const wire = await this.#request<W.UnsignedTxWire>(API_ROUTES.devDialTx(vault), {
      method: 'POST',
      body: { budgetBps },
      bearer: session.token,
    })
    return decode.decodeUnsignedTx(wire)
  }

  async buildTerminateTx(session: M.Session, vault: string): Promise<M.UnsignedTx> {
    const wire = await this.#request<W.UnsignedTxWire>(API_ROUTES.devTerminateTx(vault), {
      bearer: session.token,
    })
    return decode.decodeUnsignedTx(wire)
  }

  async quoteConsent(request: ConsentQuoteRequest): Promise<M.ConsentQuote> {
    const wire = await this.#request<W.ConsentQuoteWire>(API_ROUTES.onboardingQuote(), {
      method: 'POST',
      body: request,
    })
    return decode.decodeConsentQuote(wire)
  }

  async submitConsent(submission: ConsentSubmission): Promise<M.DeploymentTicket> {
    const wire = await this.#request<W.DeploymentTicketWire>(API_ROUTES.onboardingSubmit(), {
      method: 'POST',
      body: submission,
    })
    return { vault: wire.vault, tx: decode.decodeUnsignedTx(wire.tx), submittedAtUnix: wire.submittedAtUnix }
  }

  async getRetrofitPlan(token: string, vault: string): Promise<M.RetrofitPlan> {
    const wire = await this.#request<W.RetrofitPlanWire>(API_ROUTES.onboardingRetrofit(token), {
      query: { vault },
    })
    return decode.decodeRetrofitPlan(wire)
  }
}

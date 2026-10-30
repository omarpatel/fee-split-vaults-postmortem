/**
 * The fixture backend.
 *
 * Implements the same ApiClient interface HttpApiClient implements, so the
 * whole app runs and demos offline against realistic data. It is a backend
 * rather than a stub: it enforces the session, refuses a dial above the vault's
 * frozen ceiling, refuses a dial change on a vault the caller does not control,
 * builds real calldata for every state-changing control, and predicts the vault
 * address with the same CREATE2 arithmetic the contract uses.
 *
 * It does NOT verify real signatures. See wallet/demo-signature.ts for why, and
 * note the explicit error below rather than a silent accept: a fixture that
 * waved through any signature would teach the wrong thing about this flow.
 */

import { consentDigest, consentSalt, predictVaultAddress, type ConsentStruct } from '../../crypto/consent.js'
import { bytesToHex } from '../../crypto/hex.js'
import { keccak256 } from '../../crypto/keccak.js'
import {
  encodeEscrowClaim,
  encodeSetDial,
  encodeTerminate,
  encodeTransferCreatorFeeRecipient,
} from '../../crypto/calldata.js'
import { MAX_NARRATIVE_SOURCES, narrativeSourceProblem, normalizeXHandle } from '../../domain/onboarding.js'
import { isDemoSignature } from '../../wallet/demo-signature.js'
import { VENUE, TERMS } from '../../protocol.js'
import { ApiError, type ApiClient, type ConsentQuoteRequest, type ConsentSubmission, type EscalationAck } from '../client.js'
import type * as M from '../model.js'
import { buildFixtureDataset, type FixtureDataset } from './dataset.js'
import { FixtureOperatorClient } from './operator.js'

const SESSION_TTL_SECONDS = 30 * 60
const CONSENT_TTL_SECONDS = 24 * 3_600
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export interface FixtureApiClientOptions {
  /** Injected so tests can pin time and the lag window is exercisable. */
  now?: () => number
  /** Simulated round-trip, so loading states are real in the demo. */
  latencyMs?: number
}

interface FixtureSession {
  token: string
  address: string
  expiresAtUnix: number
}

export class FixtureApiClient implements ApiClient {
  readonly #now: () => number
  readonly #latencyMs: number
  readonly #dataset: FixtureDataset
  readonly #challenges = new Map<string, M.AuthChallenge>()
  readonly #sessions = new Map<string, FixtureSession>()
  #counter = 0

  /**
   * The operator console's backend, over the same dataset: every member coin
   * on the public directory is an active onboarding here, and the queue in
   * front of it is the part of the product the public pages never show.
   */
  readonly operator: FixtureOperatorClient

  constructor(options: FixtureApiClientOptions = {}) {
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.#latencyMs = options.latencyMs ?? 0
    this.#dataset = buildFixtureDataset(this.#now())
    this.operator = new FixtureOperatorClient({ now: this.#now, latencyMs: this.#latencyMs, dataset: this.#dataset })
  }

  /** The demo needs to offer "sign in as this coin's dev" without a seed phrase. */
  get demoDevAddresses(): Array<{ vault: string; symbol: string; devSigner: string }> {
    return this.#dataset.order.map((vault) => {
      const entry = this.#require(vault)
      return { vault, symbol: entry.summary.symbol, devSigner: entry.devSigner }
    })
  }

  async #settle<T>(value: T): Promise<T> {
    if (this.#latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#latencyMs))
    }
    return value
  }

  #require(vault: string) {
    const entry = this.#dataset.coins.get(vault.toLowerCase())
    if (entry === undefined) throw new ApiError(`no such vault ${vault}`, 404, 'coin')
    return entry
  }

  #authorize(session: M.Session, vault?: string): void {
    const held = this.#sessions.get(session.token)
    if (held === undefined) throw new ApiError('session not found', 401, 'auth')
    if (held.expiresAtUnix <= this.#now()) throw new ApiError('session expired', 401, 'auth')
    if (vault === undefined) return
    const owned = this.#dataset.vaultsByDev.get(held.address.toLowerCase()) ?? []
    if (!owned.includes(vault.toLowerCase())) {
      throw new ApiError('this address does not control that vault', 403, 'auth')
    }
  }

  #nextId(prefix: string): string {
    this.#counter += 1
    return `${prefix}-${this.#counter.toString(36)}-${this.#now().toString(36)}`
  }

  // --- public -------------------------------------------------------------

  async getProtocol(): Promise<M.ProtocolInfo> {
    return this.#settle(this.#dataset.protocol)
  }

  async listCoins(): Promise<M.CoinSummary[]> {
    return this.#settle(this.#dataset.order.map((vault) => this.#require(vault).summary))
  }

  async getCoin(vault: string): Promise<M.PublicCoin> {
    return this.#settle(this.#require(vault).coin)
  }

  async listReceipts(vault: string, cursor?: string | null): Promise<M.ReceiptPage> {
    const all = this.#require(vault).receipts
    const pageSize = 25
    const offset = cursor === null || cursor === undefined ? 0 : Number.parseInt(cursor, 10)
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ApiError('bad cursor', 400, 'receipts')
    }
    const items = all.slice(offset, offset + pageSize)
    const next = offset + pageSize < all.length ? String(offset + pageSize) : null
    return this.#settle({ items, nextCursor: next })
  }

  async listVendorScorecards(vault: string): Promise<M.VendorScorecard[]> {
    return this.#settle(this.#require(vault).vendors)
  }

  async getCoinAgent(vault: string): Promise<M.CoinAgent> {
    return this.#settle(this.#require(vault).agent)
  }

  async listAgentRuns(vault: string, cursor?: string | null): Promise<M.AgentRunPage> {
    const all = this.#require(vault).agentRuns
    const pageSize = 5
    const offset = cursor === null || cursor === undefined ? 0 : Number.parseInt(cursor, 10)
    // Refuses rather than falling back to page one: a paginator that silently
    // restarts loops forever while the caller believes it is advancing.
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ApiError('bad cursor', 400, 'agent_runs')
    }
    const runs = all.slice(offset, offset + pageSize)
    return this.#settle({
      vault: vault.toLowerCase(),
      atUnix: this.#now(),
      runs,
      nextCursor: offset + pageSize < all.length ? String(offset + pageSize) : null,
      fakedDependencies: [...this.#require(vault).agent.fakedDependencies],
    })
  }

  async getAgentRoles(vault: string): Promise<M.AgentRoleView[]> {
    return this.#settle(this.#require(vault).agent.roles)
  }

  // --- auth ---------------------------------------------------------------

  async requestChallenge(address: string): Promise<M.AuthChallenge> {
    const now = this.#now()
    const nonce = bytesToHex(
      keccak256(new TextEncoder().encode(`${address}:${now}:${this.#nextId('nonce')}`)),
    ).slice(0, 34)

    // The message states what signing does and what it does NOT do. A wallet
    // prompt the dev cannot read is how blind-signing habits get built.
    const message = [
      'Sign in to the fee split vaults dashboard.',
      '',
      `Address: ${address}`,
      `Chain: ${VENUE.chainId}`,
      `Nonce: ${nonce}`,
      `Issued: ${new Date(now * 1_000).toISOString()}`,
      '',
      'This signature proves you control this address. It authorises no transfer, no',
      'approval, and no change to any vault. Every control that moves money is a',
      'separate transaction you send yourself.',
    ].join('\n')

    const challenge: M.AuthChallenge = {
      address: address.toLowerCase(),
      nonce,
      message,
      issuedAtUnix: now,
      expiresAtUnix: now + 600,
    }
    this.#challenges.set(challenge.address, challenge)
    return this.#settle(challenge)
  }

  async verifySignature(address: string, message: string, signature: string): Promise<M.Session> {
    const key = address.toLowerCase()
    const challenge = this.#challenges.get(key)
    if (challenge === undefined) throw new ApiError('no challenge issued', 400, 'auth')
    if (challenge.message !== message) throw new ApiError('message does not match', 400, 'auth')
    if (challenge.expiresAtUnix <= this.#now()) throw new ApiError('challenge expired', 400, 'auth')

    if (!isDemoSignature(key, message, signature)) {
      throw new ApiError(
        'The fixture backend cannot verify a real secp256k1 signature. Use the demo wallet, or ' +
          'point VITE_API_BASE_URL at apps/api.',
        401,
        'auth',
      )
    }

    this.#challenges.delete(key)
    const token = this.#nextId('session')
    const expiresAtUnix = this.#now() + SESSION_TTL_SECONDS
    this.#sessions.set(token, { token, address: key, expiresAtUnix })

    return this.#settle({
      token,
      address: key,
      expiresAtUnix,
      vaults: this.#dataset.vaultsByDev.get(key) ?? [],
    })
  }

  // --- dev ----------------------------------------------------------------

  async listDevVaults(session: M.Session): Promise<M.CoinSummary[]> {
    this.#authorize(session)
    const owned = this.#dataset.vaultsByDev.get(session.address.toLowerCase()) ?? []
    return this.#settle(owned.map((vault) => this.#require(vault).summary))
  }

  async getDevVault(session: M.Session, vault: string): Promise<M.DevVaultDetail> {
    this.#authorize(session, vault)
    return this.#settle(this.#require(vault).detail)
  }

  async listWeeklyReports(session: M.Session, vault: string): Promise<M.WeeklyReportView[]> {
    this.#authorize(session, vault)
    return this.#settle(this.#require(vault).reports)
  }

  async listEscalations(session: M.Session, vault: string): Promise<M.Escalation[]> {
    this.#authorize(session, vault)
    return this.#settle(this.#require(vault).escalations)
  }

  async ackEscalation(
    session: M.Session,
    vault: string,
    id: string,
    ack: EscalationAck,
  ): Promise<M.Escalation> {
    this.#authorize(session, vault)
    const entry = this.#require(vault)
    const index = entry.escalations.findIndex((escalation) => escalation.id === id)
    if (index < 0) throw new ApiError('no such escalation', 404, 'escalation')
    const existing = entry.escalations[index]
    if (existing === undefined) throw new ApiError('no such escalation', 404, 'escalation')

    const updated: M.Escalation = {
      ...existing,
      acknowledgedAtUnix: this.#now(),
      resolution: `${ack.decision}: ${ack.note}`.trim(),
    }
    entry.escalations[index] = updated
    return this.#settle(updated)
  }

  async buildDialTx(session: M.Session, vault: string, budgetBps: number): Promise<M.UnsignedTx> {
    this.#authorize(session, vault)
    const entry = this.#require(vault)
    if (!Number.isInteger(budgetBps) || budgetBps < 0) {
      throw new ApiError('dial must be a non-negative integer in bps', 400, 'dial')
    }
    if (budgetBps > entry.coin.budgetBpsMax) {
      throw new ApiError(
        `dial ${budgetBps} exceeds this vault's frozen ceiling of ${entry.coin.budgetBpsMax}`,
        400,
        'dial',
      )
    }

    const lowering = budgetBps < entry.coin.budgetBps
    return this.#settle({
      to: vault,
      data: encodeSetDial(budgetBps),
      value: '0',
      chainId: VENUE.chainId,
      summary: lowering
        ? `Lower the procurement dial to ${budgetBps / 100}%. Takes effect after ` +
          `${TERMS.dialLowerNoticeDays} days' notice; the current setting stands until then.`
        : `Set the procurement dial to ${budgetBps / 100}%. Raising takes effect immediately.`,
    })
  }

  async buildTerminateTx(session: M.Session, vault: string): Promise<M.UnsignedTx> {
    this.#authorize(session, vault)
    return this.#settle({
      to: vault,
      data: encodeTerminate(),
      value: '0',
      chainId: VENUE.chainId,
      summary:
        'End the engagement. Charging stops, the unspent budget is released for refund, the vault ' +
        'becomes a pass-through that sends you 100% of fees, and recipiency is handed back to you. ' +
        'This cannot be refused and does not depend on the operator being reachable.',
    })
  }

  // --- onboarding ---------------------------------------------------------

  async quoteConsent(request: ConsentQuoteRequest): Promise<M.ConsentQuote> {
    const now = this.#now()
    const protocol = this.#dataset.protocol
    if (request.budgetBpsMax > TERMS.budgetBpsMax) {
      throw new ApiError(
        `budget ceiling ${request.budgetBpsMax} exceeds the offered maximum ${TERMS.budgetBpsMax}`,
        400,
        'quote',
      )
    }
    // The same intake rules apps/api applies, so the demo cannot accept a
    // source the real backend would refuse.
    const sources = request.narrativeSources ?? []
    if (sources.length > MAX_NARRATIVE_SOURCES) {
      throw new ApiError(`at most ${MAX_NARRATIVE_SOURCES} narrative sources`, 400, 'quote')
    }
    for (const url of sources) {
      const problem = narrativeSourceProblem(url)
      if (problem !== null) {
        throw new ApiError(`narrativeSources must be plain https URLs on public hosts (${problem})`, 400, 'quote')
      }
    }
    if (request.socials?.x !== undefined && normalizeXHandle(request.socials.x) === null) {
      throw new ApiError('socials.x must be an X handle', 400, 'quote')
    }

    const consent: ConsentStruct = {
      devSigner: request.devSigner.toLowerCase(),
      devPayout: request.devPayout.toLowerCase(),
      token: (request.token || ZERO_ADDRESS).toLowerCase(),
      termsHash: protocol.termsHash,
      operatorBps: protocol.operatorBps,
      budgetBpsMax: request.budgetBpsMax,
      adapter: protocol.adapter,
      referrer: (request.referrer ?? ZERO_ADDRESS).toLowerCase(),
      referrerBps: request.referrer === undefined || request.referrer === ZERO_ADDRESS ? 0 : 1_500,
      expiryUnix: now + CONSENT_TTL_SECONDS,
      nonce: bytesToHex(
        keccak256(new TextEncoder().encode(`${request.devSigner}:${now}:${this.#nextId('nonce')}`)),
      ),
    }

    const deployment = {
      chainId: protocol.chainId,
      factory: protocol.factory,
      vaultDeployer: protocol.vaultDeployer,
      vaultInitCodeHash: protocol.vaultInitCodeHash,
    }

    return this.#settle({
      consent,
      predictedVault: predictVaultAddress(consent, deployment),
      salt: consentSalt(consent),
      digest: consentDigest(consent, protocol.chainId, protocol.factory),
      termsUrl: protocol.termsUrl,
    })
  }

  async submitConsent(submission: ConsentSubmission): Promise<M.DeploymentTicket> {
    const protocol = this.#dataset.protocol
    const deployment = {
      chainId: protocol.chainId,
      factory: protocol.factory,
      vaultDeployer: protocol.vaultDeployer,
      vaultInitCodeHash: protocol.vaultInitCodeHash,
    }
    const vault = predictVaultAddress(submission.consent, deployment)
    if (typeof submission.signature !== 'string' || submission.signature.length < 10) {
      throw new ApiError('a signature is required', 400, 'submit')
    }

    return this.#settle({
      vault,
      tx: {
        to: protocol.factory,
        // The real call is deploy(Consent,bytes), whose ABI encoding has a
        // dynamic tail. The fixture does not pretend to encode it: the flow
        // being demonstrated is consent and prediction, not relay mechanics.
        data: '0x',
        value: '0',
        chainId: protocol.chainId,
        summary: `Deploy the vault at ${vault} on the terms you just signed.`,
      },
      submittedAtUnix: this.#now(),
    })
  }

  async getRetrofitPlan(token: string, vault: string): Promise<M.RetrofitPlan> {
    const entry = [...this.#dataset.coins.values()].find(
      (candidate) => candidate.coin.identity.token.toLowerCase() === token.toLowerCase(),
    )
    const registry = VENUE.contracts.v2FeeEscrow
    const claimable = entry?.detail.claimable ?? []

    return this.#settle({
      token: token.toLowerCase(),
      vault: vault.toLowerCase(),
      transferTx: {
        to: registry,
        data: encodeTransferCreatorFeeRecipient(token, vault),
        value: '0',
        chainId: VENUE.chainId,
        summary: `Point this token's creator fees at ${vault}. Send this LAST.`,
      },
      registry,
      currentRecipient: entry?.detail.devPayout ?? ZERO_ADDRESS,
      strandableCredits: claimable.map((leg) => ({
        asset: leg.asset,
        amountMinor: leg.devMinor,
        usd: leg.usd,
      })),
      claimTxs: claimable.map((leg) => ({
        to: registry,
        data: encodeEscrowClaim(leg.asset.address, leg.devMinor),
        value: '0',
        chainId: VENUE.chainId,
        summary:
          `Claim your credited ${leg.asset.symbol} to zero. The escrow is msg.sender-only: ` +
          'nobody, including us, can claim it for you after recipiency moves.',
      })),
      sweepTx: null,
    })
  }
}

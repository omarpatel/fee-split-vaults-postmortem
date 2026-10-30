/**
 * Client fraud diligence: a HARD onboarding gate, evaluated as a conjunction.
 *
 * WHY THIS IS NOT A SCREENING STAGE. Content screening is a union of flags with
 * three verdicts. This is different: every check must pass, and an unknown is a
 * failure. There is no RESTRICTED tier for "probably not a rug".
 *
 * WHY IT IS ABSOLUTE. "Facilitate the sale of fraudulent products" is not cured
 * by disclosure, by a receipts page, or by taking a smaller cut. One rug client
 * ends the model runtime for every client at once - the account is gone, the
 * channels are gone, and every honest coin on the book loses its desk the same
 * afternoon. The correct posture is to lose the marginal client.
 *
 * THE ANTI-SNIPE TRAP. Venue V2 applies a ~99% tax at t=0 that decays over about
 * three seconds. A sell simulation inside that window returns a catastrophic
 * effective tax and looks exactly like a honeypot. Concluding "honeypot" there
 * would reject every legitimate launch, so the window returns 'unknown' - which
 * still fails the gate, but as "come back in a minute", not "you are a scam".
 */

import { ScreeningFailClosed } from './flags.js'

export const DILIGENCE_CHECKS = [
  'mint_authority_revoked',
  'freeze_authority_revoked',
  'lp_locked',
  'not_honeypot',
  'dev_identity_known',
  'not_previously_declined',
] as const

export type DiligenceCheck = (typeof DILIGENCE_CHECKS)[number]

/** 'unknown' is a failure. There is no benefit of the doubt at this gate. */
export type CheckOutcome = 'pass' | 'fail' | 'unknown'

export interface AuthorityStatus {
  revoked: CheckOutcome
  /** Reads are pinned by block hash, never block number. */
  blockHash?: string
}

export interface LpLockStatus {
  locked: CheckOutcome
  lockerAddress?: string
  unlockAtUnix?: number
  /**
   * True for a locker whose verified ABI has no unlock, withdraw or transfer
   * path at all: the position can never leave. Satisfies the minimum-remaining
   * policy without an unlock time to compare against.
   */
  permanent?: boolean
  blockHash?: string
}

export interface SellSimulation {
  outcome: CheckOutcome
  /** Effective tax observed on a simulated exit, in bps. */
  effectiveTaxBps?: number
  revertReason?: string
}

export interface ChainDiligenceProbe {
  mintAuthority(token: string): Promise<AuthorityStatus>
  freezeAuthority(token: string): Promise<AuthorityStatus>
  lpLock(token: string): Promise<LpLockStatus>
  /** A simulated exit against current state. Never a real trade. */
  simulateSell(token: string, probeAmountMinor: bigint): Promise<SellSimulation>
  /** Undefined when the launch block cannot be established. */
  launchedAtUnix(token: string): Promise<number | undefined>
}

export interface IdentityRecord {
  verified: CheckOutcome
  verifiedAtUnix?: number
  /** Opaque reference to the KYB/KYC file. Never the underlying documents. */
  fileRef?: string
}

export interface IdentityProvider {
  record(devAddress: string): Promise<IdentityRecord>
}

export interface DiligencePolicy {
  /**
   * Lockers whose locks we will credit. EMPTY BY DEFAULT: the composition root
   * injects the Venue launch locker address from config/protocol. An empty list
   * fails every lock check, which is the correct behaviour for a deployment
   * that has not been told what a real lock looks like.
   */
  allowedLockers: string[]
  minLpLockRemainingSeconds: number
  /** Above this simulated exit tax the token is treated as a honeypot. */
  maxSellTaxBps: number
  identityMaxAgeSeconds: number
  /**
   * Seconds after launch during which a sell simulation is meaningless because
   * the anti-snipe tax has not decayed. It decays in ~3s; the margin covers
   * block timing and RPC lag.
   */
  antiSnipeSettleSeconds: number
  probeAmountMinor: bigint
}

export const DEFAULT_DILIGENCE_POLICY: DiligencePolicy = {
  allowedLockers: [],
  minLpLockRemainingSeconds: 180 * 24 * 60 * 60,
  maxSellTaxBps: 1_000,
  identityMaxAgeSeconds: 365 * 24 * 60 * 60,
  antiSnipeSettleSeconds: 60,
  probeAmountMinor: 1_000_000n,
}

export interface DiligenceCheckResult {
  check: DiligenceCheck
  outcome: CheckOutcome
  /** Operator-facing. Never contains client documents. */
  detail?: string
  blockHash?: string
}

export interface DiligenceReport {
  token: string
  devAddress: string
  admitted: boolean
  results: DiligenceCheckResult[]
  blockers: DiligenceCheck[]
  /** True when the only blocker is the anti-snipe window: retry, do not reject. */
  retryable: boolean
  assessedAtUnix: number
}

export interface DiligenceDeps {
  probe: ChainDiligenceProbe
  identity: IdentityProvider
  /** Consulted so a declined token cannot be re-onboarded under a new vault. */
  declineList?: { has(token: string): Promise<boolean> }
  policy?: DiligencePolicy
}

export async function runFraudDiligence(
  token: string,
  devAddress: string,
  deps: DiligenceDeps,
  nowUnix: number,
): Promise<DiligenceReport> {
  const policy = deps.policy ?? DEFAULT_DILIGENCE_POLICY
  const results: DiligenceCheckResult[] = []
  let retryable = false

  results.push(
    await authorityCheck('mint_authority_revoked', () => deps.probe.mintAuthority(token)),
  )
  results.push(
    await authorityCheck('freeze_authority_revoked', () => deps.probe.freezeAuthority(token)),
  )

  results.push(await lpCheck(token, deps, policy, nowUnix))

  const honeypot = await honeypotCheck(token, deps, policy, nowUnix)
  if (honeypot.detail === ANTI_SNIPE_DETAIL) retryable = true
  results.push(honeypot)

  results.push(await identityCheck(devAddress, deps, policy, nowUnix))

  results.push(await declineCheck(token, deps))

  const blockers = results.filter((r) => r.outcome !== 'pass').map((r) => r.check)

  return {
    token,
    devAddress,
    admitted: blockers.length === 0,
    results,
    blockers,
    retryable: retryable && blockers.length === 1,
    assessedAtUnix: nowUnix,
  }
}

/** Onboarding calls this. It throws rather than returning a boolean to ignore. */
export function assertOnboardingAdmitted(report: DiligenceReport): void {
  if (report.admitted) return
  throw new ScreeningFailClosed(
    `fraud diligence blocked onboarding: ${report.blockers.join(', ')}`,
    report.token,
  )
}

const ANTI_SNIPE_DETAIL = 'anti-snipe window: sell simulation is not meaningful yet'

async function authorityCheck(
  check: DiligenceCheck,
  read: () => Promise<AuthorityStatus>,
): Promise<DiligenceCheckResult> {
  try {
    const status = await read()
    const result: DiligenceCheckResult = { check, outcome: status.revoked }
    if (status.blockHash !== undefined) result.blockHash = status.blockHash
    if (status.revoked !== 'pass') result.detail = 'authority is not provably revoked'
    return result
  } catch (error) {
    return { check, outcome: 'unknown', detail: describe(error) }
  }
}

async function lpCheck(
  token: string,
  deps: DiligenceDeps,
  policy: DiligencePolicy,
  nowUnix: number,
): Promise<DiligenceCheckResult> {
  try {
    const status = await deps.probe.lpLock(token)
    if (status.locked !== 'pass') {
      return { check: 'lp_locked', outcome: status.locked, detail: 'no provable LP lock' }
    }
    const locker = status.lockerAddress?.toLowerCase()
    const allowed = policy.allowedLockers.map((a) => a.toLowerCase())
    if (locker === undefined || !allowed.includes(locker)) {
      return {
        check: 'lp_locked',
        outcome: 'fail',
        detail: 'lock held by an address that is not an allowlisted locker',
      }
    }
    if (status.permanent !== true) {
      const remaining = (status.unlockAtUnix ?? 0) - nowUnix
      if (remaining < policy.minLpLockRemainingSeconds) {
        return {
          check: 'lp_locked',
          outcome: 'fail',
          detail: `lock expires in ${Math.max(0, remaining)}s, below policy`,
        }
      }
    }
    const result: DiligenceCheckResult = { check: 'lp_locked', outcome: 'pass' }
    if (status.blockHash !== undefined) result.blockHash = status.blockHash
    return result
  } catch (error) {
    return { check: 'lp_locked', outcome: 'unknown', detail: describe(error) }
  }
}

async function honeypotCheck(
  token: string,
  deps: DiligenceDeps,
  policy: DiligencePolicy,
  nowUnix: number,
): Promise<DiligenceCheckResult> {
  try {
    const launchedAt = await deps.probe.launchedAtUnix(token)
    if (launchedAt === undefined) {
      return { check: 'not_honeypot', outcome: 'unknown', detail: 'launch block not established' }
    }
    if (nowUnix - launchedAt < policy.antiSnipeSettleSeconds) {
      return { check: 'not_honeypot', outcome: 'unknown', detail: ANTI_SNIPE_DETAIL }
    }

    const simulation = await deps.probe.simulateSell(token, policy.probeAmountMinor)
    if (simulation.outcome !== 'pass') {
      return {
        check: 'not_honeypot',
        outcome: simulation.outcome,
        detail: simulation.revertReason ?? 'simulated exit did not succeed',
      }
    }
    const tax = simulation.effectiveTaxBps
    if (tax === undefined) {
      return { check: 'not_honeypot', outcome: 'unknown', detail: 'no effective tax measured' }
    }
    if (tax > policy.maxSellTaxBps) {
      return {
        check: 'not_honeypot',
        outcome: 'fail',
        detail: `simulated exit tax ${tax} bps exceeds policy`,
      }
    }
    return { check: 'not_honeypot', outcome: 'pass', detail: `exit tax ${tax} bps` }
  } catch (error) {
    return { check: 'not_honeypot', outcome: 'unknown', detail: describe(error) }
  }
}

async function identityCheck(
  devAddress: string,
  deps: DiligenceDeps,
  policy: DiligencePolicy,
  nowUnix: number,
): Promise<DiligenceCheckResult> {
  try {
    const record = await deps.identity.record(devAddress)
    if (record.verified !== 'pass') {
      return {
        check: 'dev_identity_known',
        outcome: record.verified,
        detail: 'no completed identity verification for the dev signer',
      }
    }
    const verifiedAt = record.verifiedAtUnix
    if (verifiedAt === undefined || nowUnix - verifiedAt > policy.identityMaxAgeSeconds) {
      return {
        check: 'dev_identity_known',
        outcome: 'fail',
        detail: 'identity verification missing or older than policy',
      }
    }
    return { check: 'dev_identity_known', outcome: 'pass' }
  } catch (error) {
    return { check: 'dev_identity_known', outcome: 'unknown', detail: describe(error) }
  }
}

async function declineCheck(token: string, deps: DiligenceDeps): Promise<DiligenceCheckResult> {
  if (deps.declineList === undefined) {
    return { check: 'not_previously_declined', outcome: 'pass', detail: 'no decline list wired' }
  }
  try {
    const declined = await deps.declineList.has(token)
    return declined
      ? { check: 'not_previously_declined', outcome: 'fail', detail: 'token is on the decline list' }
      : { check: 'not_previously_declined', outcome: 'pass' }
  } catch (error) {
    return { check: 'not_previously_declined', outcome: 'unknown', detail: describe(error) }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 160) : 'unknown error'
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

export interface FakeChainState {
  mintRevoked?: CheckOutcome
  freezeRevoked?: CheckOutcome
  lp?: LpLockStatus
  sell?: SellSimulation
  launchedAtUnix?: number
  throwOn?: Partial<Record<'mint' | 'freeze' | 'lp' | 'sell' | 'launch', boolean>>
}

export class FakeChainDiligenceProbe implements ChainDiligenceProbe {
  constructor(private readonly state: Map<string, FakeChainState> = new Map()) {}

  set(token: string, state: FakeChainState): void {
    this.state.set(token.toLowerCase(), state)
  }

  private read(token: string): FakeChainState {
    return this.state.get(token.toLowerCase()) ?? {}
  }

  async mintAuthority(token: string): Promise<AuthorityStatus> {
    const state = this.read(token)
    if (state.throwOn?.mint === true) throw new Error('rpc unreachable')
    return { revoked: state.mintRevoked ?? 'unknown', blockHash: '0xfake' }
  }

  async freezeAuthority(token: string): Promise<AuthorityStatus> {
    const state = this.read(token)
    if (state.throwOn?.freeze === true) throw new Error('rpc unreachable')
    return { revoked: state.freezeRevoked ?? 'unknown', blockHash: '0xfake' }
  }

  async lpLock(token: string): Promise<LpLockStatus> {
    const state = this.read(token)
    if (state.throwOn?.lp === true) throw new Error('rpc unreachable')
    return state.lp ?? { locked: 'unknown' }
  }

  async simulateSell(token: string): Promise<SellSimulation> {
    const state = this.read(token)
    if (state.throwOn?.sell === true) throw new Error('rpc unreachable')
    return state.sell ?? { outcome: 'unknown' }
  }

  async launchedAtUnix(token: string): Promise<number | undefined> {
    const state = this.read(token)
    if (state.throwOn?.launch === true) throw new Error('rpc unreachable')
    return state.launchedAtUnix
  }
}

export class FakeIdentityProvider implements IdentityProvider {
  constructor(private readonly records: Map<string, IdentityRecord> = new Map()) {}

  set(devAddress: string, record: IdentityRecord): void {
    this.records.set(devAddress.toLowerCase(), record)
  }

  async record(devAddress: string): Promise<IdentityRecord> {
    return this.records.get(devAddress.toLowerCase()) ?? { verified: 'unknown' }
  }
}

/**
 * Watchers for the two ways a coin's fee stream can be taken away from us.
 *
 * 1. UPDATE. CreatorFeeRecipientUpdated is the moment recipiency actually moves:
 *    self-service by the CURRENT recipient (immediate, no timelock) or an
 *    executed owner override. If our vault is the recipient the self-service
 *    path should be impossible without our key, so observing it is a compromise
 *    indication rather than a routine event. Either way the money stops
 *    arriving the moment it happens.
 *
 * 2. OVERRIDE. The Venue owner holds a timelocked power to reassign any coin's
 *    fee recipient (measured: 3 days, plus a 3-day execution window that can
 *    lapse or be cancelled). The timelock is the entire response window, so the
 *    alert fires at PROPOSAL time, not at execution time.
 *
 * THE GUARANTEE: spend halts within one sweep interval. That holds even when the
 * chain is unreachable, because staleness is itself a halt condition - a fee
 * recipient we have not confirmed recently is indistinguishable from one that has
 * already been taken. The watcher cannot silently stop watching.
 *
 * This package SIGNALS the halt; the broker and the vault enforce it. Keeping
 * enforcement out of the ingestion plane is deliberate: this plane reads
 * untrusted chain data and therefore holds no keys and no spending authority.
 */

import type { Address } from '@fee-split-vaults/core'
import {
  CREATOR_FEE_RECIPIENT_CHANGE_CANCELLED,
  CREATOR_FEE_RECIPIENT_CHANGE_PROPOSED,
  CREATOR_FEE_RECIPIENT_UPDATED,
  GET_LAUNCHED_TOKEN_SELECTOR,
  decodeEventLog,
  decodeLaunchedToken,
  encodeAddressArgCall,
  requireAddress,
  requireBigInt,
  type LaunchedToken,
} from './abi.js'
import { DecodeError, StaleWatchError } from './errors.js'
import { addressEquals, normalizeHash32, type Hex } from './hex.js'
import type { PendingOverride, RecipientObservation, WatchTarget } from './model.js'
import { VENUE } from './protocol.js'
import type { QuorumRpc } from './quorum.js'
import type { BlockRef, RpcLog } from './rpc.js'
import type { IndexerStore } from './store.js'

export type HaltReason =
  | 'recipient_diverged'
  | 'recipient_transferred'
  | 'owner_override_proposed'
  | 'owner_override_executable'
  | 'watch_stale'
  | 'asset_disabled'
  | 'read_failure'

export interface HaltNotice {
  readonly vault: Address
  readonly token: Address
  readonly reason: HaltReason
  readonly detail: string
  readonly detectedAtUnix: number
  readonly evidence?: {
    readonly blockHash?: Hex
    readonly blockNumber?: bigint
    readonly txHash?: Hex
  }
}

export interface HaltSink {
  halt(notice: HaltNotice): Promise<void> | void
}

export class InMemoryHaltSink implements HaltSink {
  readonly notices: HaltNotice[] = []

  halt(notice: HaltNotice): void {
    this.notices.push(notice)
  }

  byReason(reason: HaltReason): HaltNotice[] {
    return this.notices.filter((notice) => notice.reason === reason)
  }

  clear(): void {
    this.notices.length = 0
  }
}

export interface RecipientWatcherOptions {
  /**
   * The deadline. A vault whose recipient has not been confirmed within this
   * many seconds is halted, which is what makes "within one sweep interval" a
   * property of the system rather than a hope about the scheduler.
   */
  readonly sweepIntervalSeconds: number
  /** Contract exposing getLaunchedToken(address). Defaults to the V2 factory. */
  readonly recipientRegistry?: Address
}

export interface RecipientCheck {
  readonly ok: boolean
  readonly observation?: RecipientObservation
  /** The whole struct the recipient was read from, for the caller to verify its binding against. */
  readonly launched?: LaunchedToken
  readonly halted: readonly HaltNotice[]
}

export class RecipientWatcher {
  private readonly registry: Address
  private readonly lastOkAtUnix = new Map<string, number>()

  constructor(
    private readonly rpc: QuorumRpc,
    private readonly store: IndexerStore,
    private readonly sink: HaltSink,
    private readonly options: RecipientWatcherOptions,
  ) {
    this.registry = options.recipientRegistry ?? VENUE.contracts.v2Factory
  }

  /** When this coin's recipient was last confirmed correct, if ever. */
  lastConfirmedAt(target: WatchTarget): number | undefined {
    return this.lastOkAtUnix.get(target.token.toLowerCase())
  }

  /** Seed freshness from persisted state so a restart is not instantly stale. */
  async primeFrom(target: WatchTarget): Promise<void> {
    const stored = await this.store.recipientObservation(target.token)
    if (stored?.matches === true) {
      this.lastOkAtUnix.set(target.token.toLowerCase(), stored.observedAtUnix)
    }
  }

  /**
   * Hash-pinned read of who the protocol currently pays. Pinned, not latest: an
   * answer from an unnamed block is an answer we cannot reproduce in a dispute.
   *
   * The struct is also checked against the coin's binding when one exists: a
   * recipient read off a launch record whose curve or pair token is not the one
   * we bound is not a confirmation of anything, it is evidence of a mis-binding.
   */
  async check(target: WatchTarget, atBlock: BlockRef, nowUnix: number): Promise<RecipientCheck> {
    const halted: HaltNotice[] = []
    const data = encodeAddressArgCall(GET_LAUNCHED_TOKEN_SELECTOR, target.token)

    // A failed read is NOT swallowed and NOT treated as "unchanged". It
    // propagates, and the caller answers it with assertFresh(), which is the
    // single place that decides whether the silence has lasted too long.
    const raw = await this.rpc.call({ to: this.registry, data, blockHash: atBlock.hash })
    const launched = decodeLaunchedToken(raw)
    if (!launched.exists || !addressEquals(launched.token, target.token)) {
      throw new DecodeError(`getLaunchedToken(${target.token}) reports no such launch at ${atBlock.hash}`)
    }
    const bound = await this.store.bindingByToken(target.token)
    if (
      bound !== undefined &&
      (!addressEquals(launched.curve, bound.curve) || !addressEquals(launched.pairToken, bound.quoteAsset))
    ) {
      throw new DecodeError(
        `getLaunchedToken(${target.token}) names curve ${launched.curve} / pair ${launched.pairToken}; ` +
          `binding has curve ${bound.curve} / pair ${bound.quoteAsset}; refusing to confirm a recipient ` +
          `for a coin whose binding the chain contradicts`,
      )
    }
    const recipient: Address = launched.creatorFeeRecipient

    const matches = addressEquals(recipient, target.vault)
    const observation: RecipientObservation = {
      token: target.token,
      recipient,
      expected: target.vault,
      matches,
      blockHash: atBlock.hash,
      blockNumber: atBlock.number,
      observedAtUnix: nowUnix,
    }
    await this.store.putRecipientObservation(observation)

    if (matches) {
      this.lastOkAtUnix.set(target.token.toLowerCase(), nowUnix)
      return { ok: true, observation, launched, halted }
    }

    const notice: HaltNotice = {
      vault: target.vault,
      token: target.token,
      reason: 'recipient_diverged',
      detail:
        `protocol pays ${recipient} for this coin, not our vault ${target.vault}; ` +
        `fees are no longer arriving and spend authority is void`,
      detectedAtUnix: nowUnix,
      evidence: { blockHash: atBlock.hash, blockNumber: atBlock.number },
    }
    halted.push(notice)
    await this.sink.halt(notice)
    return { ok: false, observation, launched, halted }
  }

  private staleNotice(target: WatchTarget, nowUnix: number, detail: string): HaltNotice | null {
    const lastOk = this.lastOkAtUnix.get(target.token.toLowerCase())
    const age = lastOk === undefined ? Number.POSITIVE_INFINITY : nowUnix - lastOk
    if (age <= this.options.sweepIntervalSeconds) return null
    return {
      vault: target.vault,
      token: target.token,
      reason: 'watch_stale',
      detail:
        `recipient unconfirmed for ${age === Number.POSITIVE_INFINITY ? 'ever' : `${age}s`} ` +
        `(limit ${this.options.sweepIntervalSeconds}s): ${detail}`,
      detectedAtUnix: nowUnix,
    }
  }

  /**
   * Freshness check, run every tick whether or not a read was attempted. This is
   * the path that halts a vault when the chain is simply unreachable.
   */
  async assertFresh(target: WatchTarget, nowUnix: number): Promise<HaltNotice | null> {
    const notice = this.staleNotice(target, nowUnix, 'no successful confirmation in the window')
    if (notice) await this.sink.halt(notice)
    return notice
  }

  async requireFresh(target: WatchTarget, nowUnix: number): Promise<void> {
    const notice = await this.assertFresh(target, nowUnix)
    if (notice) {
      throw new StaleWatchError(
        `recipient watcher for ${target.token}`,
        this.lastOkAtUnix.get(target.token.toLowerCase()) ?? 0,
        this.options.sweepIntervalSeconds,
      )
    }
  }

  /**
   * The fast path: recipiency moved away from our vault. This beats the polled
   * read and should halt the moment the log is seen.
   */
  async ingestUpdatedLog(
    log: RpcLog,
    target: WatchTarget,
    block: BlockRef,
  ): Promise<HaltNotice | null> {
    const decoded = decodeEventLog(CREATOR_FEE_RECIPIENT_UPDATED, log)
    const previous = requireAddress(decoded, 'previousRecipient')
    const next = requireAddress(decoded, 'newRecipient')
    if (!addressEquals(previous, target.vault) && !addressEquals(next, target.vault)) return null
    if (addressEquals(next, target.vault)) {
      this.lastOkAtUnix.set(target.token.toLowerCase(), block.timestampUnix)
      return null
    }

    const notice: HaltNotice = {
      vault: target.vault,
      token: target.token,
      reason: 'recipient_transferred',
      detail:
        `recipiency moved from our vault to ${next} with no timelock; ` +
        `this is self-service by the current recipient and should be impossible without our key`,
      detectedAtUnix: block.timestampUnix,
      evidence: {
        blockHash: normalizeHash32(log.blockHash),
        blockNumber: log.blockNumber,
        txHash: normalizeHash32(log.transactionHash),
      },
    }
    this.lastOkAtUnix.delete(target.token.toLowerCase())
    await this.sink.halt(notice)
    return notice
  }
}

export const OVERRIDE_TIMELOCK_SECONDS = 3 * 86_400

export interface OwnerOverrideWatcherOptions {
  /** Escalate again once execution is this close. Default one day. */
  readonly imminentSeconds?: number
}

export class OwnerOverrideWatcher {
  private readonly imminentSeconds: number

  constructor(
    private readonly store: IndexerStore,
    private readonly sink: HaltSink,
    options: OwnerOverrideWatcherOptions = {},
  ) {
    this.imminentSeconds = options.imminentSeconds ?? 86_400
  }

  /**
   * Record a proposal and alert immediately. Waiting for effectiveAt would spend
   * the response window watching it elapse.
   */
  async ingestProposalLog(
    log: RpcLog,
    target: WatchTarget,
    block: BlockRef,
  ): Promise<{ override: PendingOverride; notice: HaltNotice }> {
    const decoded = decodeEventLog(CREATOR_FEE_RECIPIENT_CHANGE_PROPOSED, log)
    const currentRecipient = requireAddress(decoded, 'currentRecipient')
    const newRecipient = requireAddress(decoded, 'proposedRecipient')
    const effectiveAt = requireBigInt(decoded, 'effectiveAt')
    const expiresAt = requireBigInt(decoded, 'expiresAt')
    if (effectiveAt > BigInt(Number.MAX_SAFE_INTEGER) || expiresAt > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new DecodeError(`override timestamps ${effectiveAt}/${expiresAt} are not unix seconds`)
    }

    const override: PendingOverride = {
      token: target.token,
      currentRecipient,
      newRecipient,
      effectiveAtUnix: Number(effectiveAt),
      expiresAtUnix: Number(expiresAt),
      proposedAtUnix: block.timestampUnix,
      txHash: normalizeHash32(log.transactionHash),
      blockHash: normalizeHash32(log.blockHash),
      blockNumber: log.blockNumber,
    }
    await this.store.putOverride(override)

    const notice: HaltNotice = {
      vault: target.vault,
      token: target.token,
      reason: 'owner_override_proposed',
      detail:
        `Venue owner proposed reassigning this coin's fee recipient from ${currentRecipient} ` +
        `to ${newRecipient}, executable from ${override.effectiveAtUnix} until ${override.expiresAtUnix} ` +
        `(${OVERRIDE_TIMELOCK_SECONDS}s timelock). ` +
        `Sweep and claim to zero before recipiency can move: credited balances strand ` +
        `under the old recipient address.`,
      detectedAtUnix: block.timestampUnix,
      evidence: {
        blockHash: override.blockHash,
        blockNumber: override.blockNumber,
        txHash: normalizeHash32(override.txHash),
      },
    }
    await this.sink.halt(notice)

    return { override, notice }
  }

  /** The owner withdrew a proposal. Clears every pending override to that recipient. */
  async ingestCancellationLog(log: RpcLog, target: WatchTarget): Promise<PendingOverride[]> {
    const decoded = decodeEventLog(CREATOR_FEE_RECIPIENT_CHANGE_CANCELLED, log)
    const proposedRecipient = requireAddress(decoded, 'proposedRecipient')
    const cleared: PendingOverride[] = []
    for (const override of await this.store.overrides(target.token)) {
      if (!addressEquals(override.newRecipient, proposedRecipient)) continue
      await this.store.clearOverride(target.token, override.effectiveAtUnix)
      cleared.push(override)
    }
    return cleared
  }

  /**
   * Re-escalate proposals that are now imminent or executable. A proposal past
   * its execution window can no longer move recipiency and is dropped.
   */
  async review(target: WatchTarget, nowUnix: number): Promise<HaltNotice[]> {
    const pending = await this.store.overrides(target.token)
    const raised: HaltNotice[] = []
    for (const override of pending) {
      if (override.expiresAtUnix <= nowUnix) {
        await this.store.clearOverride(target.token, override.effectiveAtUnix)
        continue
      }
      const remaining = override.effectiveAtUnix - nowUnix
      if (remaining > this.imminentSeconds) continue
      const notice: HaltNotice = {
        vault: target.vault,
        token: target.token,
        reason: 'owner_override_executable',
        detail:
          remaining <= 0
            ? `override to ${override.newRecipient} is executable now, until ${override.expiresAtUnix}`
            : `override to ${override.newRecipient} becomes executable in ${remaining}s`,
        detectedAtUnix: nowUnix,
        evidence: {
          blockHash: override.blockHash,
          blockNumber: override.blockNumber,
          txHash: normalizeHash32(override.txHash),
        },
      }
      raised.push(notice)
      await this.sink.halt(notice)
    }
    return raised
  }
}

import { randomUUID } from 'node:crypto'
import {
  parseImageAssetId,
  requireOperatorName,
  type ImageAssetSource,
  type PublishResult,
} from '@fee-split-vaults/core'
import { DISCLOSURE } from '../../../config/protocol.js'
import type { ApprovalDecision, ApprovalGate } from './approval.js'
import { ChannelTransportError, type ChannelAdapter, type FetchedPost, type PublishedPost } from './channels/types.js'
import { classifyContent } from './classify.js'
import {
  composeDisclosedMessage,
  disclosureTokens,
  receiptUrlFor,
  stripAuthoredDisclosure,
  verifyDisclosurePresent,
  type ComposeOutcome,
  type DisclosureSpec,
} from './disclosure.js'
import { channelHealthVerdict, HEALTH_GATED_CHANNELS, type ChannelHealthStore } from './health.js'
import { buildLinkPolicy, checkLinksAndAddresses, normalizeAddress } from './links.js'
import type { PublisherEvent, PublisherEventLog } from './log.js'
import { scanForRefusals } from './refusal.js'
import type { AccountRegistry, PostRegistry, ReadBackOutcome } from './registry.js'
import type { Clock, DelayedTaskScheduler } from './scheduler.js'
import { normalizeVisibleText, sha256Hex } from './text.js'
import { checkTickerPolicy } from './tickers.js'
import type {
  AccountBinding,
  Channel,
  PublisherInput,
  PublisherPolicy,
  Rejection,
  ResolvedPolicy,
} from './types.js'

/**
 * THE PUBLISHER.
 *
 * Everything that reaches a human audience goes through here, and the order of
 * the checks is part of the design:
 *
 *   1  normalize        - kill invisible and bidi characters first, so every
 *                         later check sees the same text a reader will see
 *   2  strip disclosure - remove any model-authored disclosure BEFORE the link
 *                         allowlist runs, so a forged "receipts: <attacker>"
 *                         line is deleted as a forgery rather than judged as a
 *                         link the copy needed
 *   3  refuse           - fail-closed outbound classifier
 *   4  links/addresses  - hard reject on any unallowlisted address
 *   4b images           - every asset id must belong to the bound coin
 *   5  tickers          - one ticker per account, no cross-promotion
 *   6  classify         - rule engine decides promotional vs operational
 *   7  compose          - canonical disclosure appended, truncation eats body
 *   8  re-scan          - the exact bytes we are about to send, checked again
 *   9  account check    - delegated account's own disclosure, before every post
 *  10  approval         - human sees the final artifact, not a draft
 *  11  publish          - then read-back is scheduled
 *
 * Before any of it, step 0: the account's platform standing. An X account
 * whose latest recorded probe (health.ts) is not a fresh `ok` is refused at
 * `channel_suspended` before a body is even read, so a suspension is never
 * answered with a retry storm.
 *
 * Every exit before step 11 is a refusal, and every refusal is logged.
 */

/** Channel is a type union in core with no runtime companion; this is it. */
const KNOWN_CHANNELS: readonly Channel[] = ['telegram', 'x_operator', 'x_client_delegated', 'site']

// The placeholder predicate lives in @fee-split-vaults/core so the API, the desk, the
// pilot and this publisher cannot drift apart on what counts as "named". A local
// re-declaration here is what let the desk's copy rot unnoticed.

export interface PublisherDeps {
  policy: PublisherPolicy
  adapters: Partial<Record<Channel, ChannelAdapter>>
  accounts: AccountRegistry
  posts: PostRegistry
  /** Required before any request with imageRefs can pass; absent means every image is refused. */
  images?: ImageAssetSource
  /**
   * Platform account standing for HEALTH_GATED_CHANNELS. When wired, a post
   * from an account with no fresh `ok` probe is refused. Absent only where
   * nothing probes (tests, the sandbox); the live fleet always wires it.
   */
  health?: ChannelHealthStore
  log: PublisherEventLog
  approvals: ApprovalGate
  scheduler: DelayedTaskScheduler
  clock: Clock
}

export interface Publisher {
  publish(input: PublisherInput): Promise<PublishResult>
  /** Re-fetch a published post and delete it if the disclosure is not there. */
  verifyReadBack(externalId: string): Promise<ReadBackOutcome>
  /** Timer-independent sweep, for process restarts. */
  sweepUnverified(): Promise<ReadBackOutcome[]>
  readonly resolvedPolicy: ResolvedPolicy
}

export class PublisherConfigError extends Error {
  constructor(message: string) {
    super(`publisher config: ${message}`)
    this.name = 'PublisherConfigError'
  }
}

function resolvePolicy(policy: PublisherPolicy): ResolvedPolicy {
  const operatorName = requireOperatorName(
    policy.operatorName ?? DISCLOSURE.operatorName,
    (message) => new PublisherConfigError(message),
  )

  let receiptsUrl: URL
  try {
    receiptsUrl = new URL(policy.receiptsBaseUrl)
  } catch {
    throw new PublisherConfigError(`receiptsBaseUrl "${policy.receiptsBaseUrl}" is not a URL`)
  }
  if (receiptsUrl.protocol !== 'https:') {
    throw new PublisherConfigError('receiptsBaseUrl must be https')
  }
  if (policy.maxAccountLabelAgeSeconds <= 0) {
    throw new PublisherConfigError('maxAccountLabelAgeSeconds must be positive')
  }

  const hosts = new Set(
    [...policy.allowedLinkHosts, receiptsUrl.hostname].map((h) => h.trim().toLowerCase()),
  )

  return {
    ...policy,
    operatorName,
    allowedLinkHosts: [...hosts],
    allowedRouterAddresses: policy.allowedRouterAddresses.map(normalizeAddress),
  }
}

export function createPublisher(deps: PublisherDeps): Publisher {
  const policy = resolvePolicy(deps.policy)

  function log(event: PublisherEvent): void {
    deps.log.record(event)
  }

  function rejectionResult(
    rejection: Rejection,
    context: {
      vault: string
      channel: Channel
      accountId: string
      correlationId: string
      bodyHash: string
    },
  ): PublishResult {
    log({
      kind: 'refusal',
      atUnix: deps.clock.nowUnix(),
      vault: context.vault,
      channel: context.channel,
      accountId: context.accountId,
      correlationId: context.correlationId,
      stage: rejection.stage,
      reason: rejection.reason,
      ...(rejection.refusalClasses === undefined ? {} : { refusalClasses: rejection.refusalClasses }),
      ...(rejection.detail === undefined ? {} : { detail: rejection.detail }),
      bodyHash: context.bodyHash,
      severity: 'warn',
    })
    return { published: false, rejectedReason: `${rejection.stage}:${rejection.reason}` }
  }

  async function verifyReadBack(externalId: string): Promise<ReadBackOutcome> {
    const nowUnix = deps.clock.nowUnix()
    const record = await deps.posts.get(externalId)
    if (record === null) {
      return {
        externalId,
        verifiedAtUnix: nowUnix,
        ok: false,
        missing: [],
        deleted: false,
        reason: 'unknown_post',
      }
    }

    const adapter = deps.adapters[record.channel]
    const base = {
      atUnix: nowUnix,
      vault: record.vault,
      channel: record.channel,
      accountId: record.accountId,
      correlationId: record.correlationId,
      externalId,
    }

    if (adapter === undefined) {
      const outcome: ReadBackOutcome = {
        externalId,
        verifiedAtUnix: nowUnix,
        ok: false,
        missing: record.requiredTokens,
        deleted: false,
        reason: 'channel_unavailable',
      }
      await deps.posts.setReadBack(externalId, outcome)
      log({ ...base, kind: 'read_back_delete_failed', reason: 'channel_unavailable', severity: 'critical' })
      return outcome
    }

    const takedown = async (reason: string, missing: string[]): Promise<ReadBackOutcome> => {
      let deleted = false
      let deleteError: string | undefined
      try {
        await adapter.deletePost(externalId)
        deleted = true
      } catch (error: unknown) {
        deleteError = error instanceof Error ? error.message : String(error)
      }
      const outcome: ReadBackOutcome = {
        externalId,
        verifiedAtUnix: nowUnix,
        ok: false,
        missing,
        deleted,
        reason,
        ...(deleteError === undefined ? {} : { deleteError }),
      }
      await deps.posts.setReadBack(externalId, outcome)
      log({
        ...base,
        kind: deleted ? 'read_back_failed' : 'read_back_delete_failed',
        reason,
        detail: missing.length > 0 ? `missing:${missing.join('|')}` : deleteError,
        severity: deleted ? 'warn' : 'critical',
      })
      return outcome
    }

    let fetched: FetchedPost | null
    try {
      fetched = await adapter.fetchPost(externalId)
    } catch (error: unknown) {
      // We could not tell whether the disclosure is live. Fail closed: take it down.
      return await takedown(
        `read_back_unreadable:${error instanceof Error ? error.message : String(error)}`,
        record.requiredTokens,
      )
    }

    if (fetched === null) {
      const outcome: ReadBackOutcome = {
        externalId,
        verifiedAtUnix: nowUnix,
        ok: false,
        missing: record.requiredTokens,
        deleted: false,
        reason: 'post_absent',
      }
      await deps.posts.setReadBack(externalId, outcome)
      log({ ...base, kind: 'read_back_failed', reason: 'post_absent', severity: 'warn' })
      return outcome
    }

    const verdict = verifyDisclosurePresent(fetched.text, record.disclosure)
    if (!verdict.ok) {
      return await takedown('disclosure_absent_on_read_back', verdict.missing)
    }

    const outcome: ReadBackOutcome = {
      externalId,
      verifiedAtUnix: nowUnix,
      ok: true,
      missing: [],
      deleted: false,
    }
    await deps.posts.setReadBack(externalId, outcome)
    log({ ...base, kind: 'read_back_verified', severity: 'info' })
    return outcome
  }

  async function publish(input: PublisherInput): Promise<PublishResult> {
    const { request } = input
    const correlationId = input.correlationId ?? `pub-${randomUUID()}`
    const bodyHash = sha256Hex(request.body)
    const context = {
      vault: request.vault,
      channel: request.channel,
      accountId: input.accountId,
      correlationId,
      bodyHash,
    }
    const reject = (rejection: Rejection): PublishResult => rejectionResult(rejection, context)

    if (!KNOWN_CHANNELS.includes(request.channel)) {
      return reject({ stage: 'channel', reason: 'unknown_channel', detail: String(request.channel) })
    }
    const adapter = deps.adapters[request.channel]
    if (adapter === undefined) {
      return reject({ stage: 'channel', reason: 'channel_unavailable' })
    }

    const binding: AccountBinding | null = await deps.accounts.get(request.channel, input.accountId)
    if (binding === null) {
      return reject({ stage: 'account_binding', reason: 'account_not_bound', detail: input.accountId })
    }
    if (normalizeAddress(binding.vault) !== normalizeAddress(request.vault)) {
      return reject({
        stage: 'account_binding',
        reason: 'account_vault_mismatch',
        detail: `${input.accountId} speaks for ${binding.vault}`,
      })
    }

    if (deps.health !== undefined && HEALTH_GATED_CHANNELS.includes(request.channel)) {
      const verdict = channelHealthVerdict(
        await deps.health.get(request.channel, input.accountId),
        deps.clock.nowUnix(),
      )
      if (!verdict.ok) {
        return reject({
          stage: 'channel_suspended',
          reason: verdict.reason,
          ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
        })
      }
    }

    const normalizedBody = normalizeVisibleText(request.body)
    if (normalizedBody.length === 0) {
      return reject({ stage: 'configuration', reason: 'empty_body' })
    }

    const stripped = stripAuthoredDisclosure(normalizedBody, policy.operatorName)
    if (stripped.removed.length > 0) {
      log({
        kind: 'disclosure_stripped',
        atUnix: deps.clock.nowUnix(),
        vault: request.vault,
        channel: request.channel,
        accountId: input.accountId,
        correlationId,
        detail: stripped.removed.join(' | '),
        bodyHash,
        severity: 'warn',
      })
    }
    if (stripped.body.length === 0) {
      return reject({ stage: 'configuration', reason: 'body_was_only_authored_disclosure' })
    }

    const refusalScan = scanOutbound(stripped.body)
    if (refusalScan !== null) return reject(refusalScan)

    const linkPolicy = buildLinkPolicy({
      allowedHosts: policy.allowedLinkHosts,
      allowedAddresses: [binding.token, binding.vault, ...policy.allowedRouterAddresses],
    })

    const linkRejection = checkLinksAndAddresses(stripped.body, request.links ?? [], linkPolicy)
    if (linkRejection !== null) return reject(linkRejection)

    // Image ids are allowlisted exactly like link ids: the id names an asset
    // trusted code minted for this coin. Anything else - another coin's asset,
    // a malformed id, a bare media id, an id nothing was rendered under - is
    // refused before a human is asked to approve and before bytes are touched.
    const imageRefs = request.imageRefs ?? []
    for (const id of imageRefs) {
      if (deps.images === undefined) {
        return reject({ stage: 'image_not_allowlisted', reason: 'image_source_unavailable' })
      }
      const parsed = parseImageAssetId(id)
      if (parsed === null) {
        return reject({ stage: 'image_not_allowlisted', reason: 'image_ref_malformed', detail: id })
      }
      if (parsed.coinRef !== binding.coinRef) {
        return reject({
          stage: 'image_not_allowlisted',
          reason: 'image_ref_foreign_coin',
          detail: `${id} is not ${binding.coinRef}'s`,
        })
      }
      const asset = await deps.images.get(id)
      if (asset === null) {
        return reject({ stage: 'image_not_allowlisted', reason: 'image_asset_missing', detail: id })
      }
      if (asset.coinRef !== binding.coinRef || asset.id !== id) {
        return reject({ stage: 'image_not_allowlisted', reason: 'image_asset_mismatch', detail: id })
      }
    }

    const tickerRejection = checkTickerPolicy({
      text: stripped.body,
      binding,
      roster: await deps.accounts.roster(),
    })
    if (tickerRejection !== null) return reject(tickerRejection)

    const classification = classifyContent({
      body: stripped.body,
      links: request.links ?? [],
      declaredPromotional: request.isPromotional,
      hasImages: imageRefs.length > 0,
    })

    const spec: DisclosureSpec = {
      operatorName: policy.operatorName,
      receiptUrl: receiptUrlFor(policy.receiptsBaseUrl, request.vault),
      paidPromotion: classification.isPromotional,
    }

    const maxChars =
      imageRefs.length > 0 && adapter.limits.maxCaptionChars !== undefined
        ? adapter.limits.maxCaptionChars
        : adapter.limits.maxChars
    let composed: ComposeOutcome
    try {
      composed = composeDisclosedMessage({
        body: stripped.body,
        spec,
        measure: adapter.limits.measure,
        maxChars,
      })
    } catch (error: unknown) {
      // The composer asserts its own post-condition. If that assertion ever
      // fires we have a bug, and a bug in the disclosure path is a refusal.
      return reject({
        stage: 'disclosure_budget',
        reason: 'disclosure_invariant_violation',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    if (!composed.ok) return reject(composed.rejection)

    // The exact bytes about to be sent, re-scanned: truncation can slice an
    // address into a different address, and only this scan would catch it.
    const finalRejection = checkLinksAndAddresses(composed.text, [], linkPolicy)
    if (finalRejection !== null) {
      return reject({ ...finalRejection, detail: `post-compose: ${finalRejection.detail ?? ''}` })
    }

    if (binding.delegated || adapter.verifyAccountDisclosure !== undefined) {
      if (adapter.verifyAccountDisclosure === undefined) {
        return reject({ stage: 'account_disclosure', reason: 'account_verification_unavailable' })
      }
      try {
        const check = await adapter.verifyAccountDisclosure(input.accountId, {
          operatorName: policy.operatorName,
          aiOperationTag: DISCLOSURE.aiOperationTag,
          nowUnix: deps.clock.nowUnix(),
          maxLabelAgeSeconds: policy.maxAccountLabelAgeSeconds,
        })
        if (!check.ok) {
          return reject({
            stage: 'account_disclosure',
            reason: 'account_disclosure_missing',
            ...(check.detail === undefined ? {} : { detail: check.detail }),
          })
        }
      } catch (error: unknown) {
        return reject({
          stage: 'account_disclosure',
          reason: 'account_verification_failed',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const autonomous = request.channel === 'telegram' && input.replyTo !== undefined
    let approvedBy: string | undefined
    if (!autonomous) {
      let decision: ApprovalDecision
      try {
        decision = await deps.approvals.request({
          correlationId,
          vault: request.vault,
          channel: request.channel,
          accountId: input.accountId,
          text: composed.text,
          imageRefs,
          isPromotional: classification.isPromotional,
          requestedAtUnix: deps.clock.nowUnix(),
        })
      } catch (error: unknown) {
        return reject({
          stage: 'human_approval',
          reason: 'approval_gate_failed',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
      if (decision.status === 'pending') {
        log({
          kind: 'approval_pending',
          atUnix: deps.clock.nowUnix(),
          vault: request.vault,
          channel: request.channel,
          accountId: input.accountId,
          correlationId,
          detail: decision.ticketId,
          bodyHash,
          severity: 'info',
        })
        return { published: false, rejectedReason: `human_approval:awaiting_human_approval:${decision.ticketId}` }
      }
      if (decision.status === 'rejected') {
        log({
          kind: 'approval_rejected',
          atUnix: deps.clock.nowUnix(),
          vault: request.vault,
          channel: request.channel,
          accountId: input.accountId,
          correlationId,
          reason: decision.reason,
          bodyHash,
          severity: 'warn',
        })
        return reject({ stage: 'human_approval', reason: 'rejected_by_reviewer', detail: decision.reason })
      }
      approvedBy = decision.approver
    }

    let published: PublishedPost
    try {
      published = await adapter.publish({
        accountId: input.accountId,
        text: composed.text,
        correlationId,
        ...(imageRefs.length === 0 ? {} : { imageRefs }),
        ...(input.replyTo === undefined ? {} : { inReplyToId: input.replyTo.inReplyToId }),
      })
    } catch (error: unknown) {
      return reject({
        stage: 'transport',
        reason: error instanceof ChannelTransportError && error.code !== undefined ? error.code : 'publish_failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    }

    await deps.posts.put({
      externalId: published.externalId,
      vault: request.vault,
      channel: request.channel,
      accountId: input.accountId,
      correlationId,
      publishedAtUnix: published.publishedAtUnix,
      isPromotional: classification.isPromotional,
      classificationRules: classification.matched,
      disclosure: spec,
      requiredTokens: disclosureTokens(spec),
      publishedTextHash: sha256Hex(composed.text),
      bodyTruncated: composed.bodyTruncated,
      ...(approvedBy === undefined ? {} : { approvedBy }),
    })

    log({
      kind: 'published',
      atUnix: published.publishedAtUnix,
      vault: request.vault,
      channel: request.channel,
      accountId: input.accountId,
      correlationId,
      externalId: published.externalId,
      detail: classification.isPromotional ? 'promotional' : 'operational',
      bodyHash,
      severity: 'info',
    })

    deps.scheduler.schedule(
      published.externalId,
      DISCLOSURE.readBackVerifySeconds,
      async () => {
        await verifyReadBack(published.externalId)
      },
    )

    // readBackVerified is deliberately absent rather than false: verification
    // happens readBackVerifySeconds from now, and "not yet checked" is not the
    // same claim as "checked and missing". The answer lands on the post record.
    return {
      published: true,
      externalId: published.externalId,
      publishedAtUnix: published.publishedAtUnix,
    }
  }

  async function sweepUnverified(): Promise<ReadBackOutcome[]> {
    const cutoff = deps.clock.nowUnix() - DISCLOSURE.readBackVerifySeconds
    const outcomes: ReadBackOutcome[] = []
    for (const record of await deps.posts.awaitingReadBack(cutoff)) {
      outcomes.push(await verifyReadBack(record.externalId))
    }
    return outcomes
  }

  return { publish, verifyReadBack, sweepUnverified, resolvedPolicy: policy }
}

/** Outbound refusal scan, wired to the shared rule table. */
function scanOutbound(text: string): Rejection | null {
  const scan = scanForRefusals(text)
  if (!scan.refused) return null
  return {
    stage: 'refusal_classifier',
    reason: scan.reason ?? `refused:${scan.classes.join(',')}`,
    refusalClasses: scan.classes,
    detail: scan.matches.map((match) => `${match.ruleId}:${match.excerpt}`).join(' | '),
  }
}

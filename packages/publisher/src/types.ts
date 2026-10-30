import type { Address, Channel, PublishRequest } from '@fee-split-vaults/core'
import type { RefusalClass } from '../../../config/protocol.js'

/** Where a publish attempt died. Every value here is a fail-closed exit. */
export type RejectionStage =
  | 'configuration'
  | 'account_binding'
  | 'channel'
  | 'channel_suspended'
  | 'refusal_classifier'
  | 'link_allowlist'
  | 'image_not_allowlisted'
  | 'ticker_policy'
  | 'account_disclosure'
  | 'human_approval'
  | 'disclosure_budget'
  | 'transport'
  | 'read_back'

export interface Rejection {
  stage: RejectionStage
  /** Stable machine-readable code. Logged, reported, and asserted on in tests. */
  reason: string
  detail?: string
  refusalClasses?: RefusalClass[]
}

/**
 * A publish attempt. The core PublishRequest carries the model's body; the
 * account, the reply linkage and the audit id are the publisher's own framing.
 */
export interface PublisherInput {
  request: PublishRequest
  /** Platform account the post goes out from. Bound to exactly one ticker. */
  accountId: string
  /**
   * Set only when this is a direct reply to an inbound message in the coin's
   * own Telegram group. Replies are autonomous; everything else is gated.
   */
  replyTo?: { inReplyToId: string }
  correlationId?: string
}

/**
 * One platform account, bound to exactly one client coin.
 *
 * The binding is the enforcement point for DISCLOSURE.maxTickersPerAccount: an
 * agency roster is many accounts each speaking for one coin, and a coordinated
 * inauthentic network is one account speaking for many.
 */
export interface AccountBinding {
  accountId: string
  channel: Channel
  /** The coin this account speaks for. Image assets are minted under it. */
  coinRef: string
  vault: Address
  /** The bound token contract. The only address that may appear in a body. */
  token: Address
  /** Ticker without the leading '$'. Compared case-insensitively. */
  ticker: string
  /** Delegated accounts are owned by the dev, so their bio can change under us. */
  delegated: boolean
}

/** Other clients on the book. Used only to detect and refuse cross-promotion. */
export interface RosterEntry {
  vault: Address
  token: Address
  ticker: string
}

export interface PublisherPolicy {
  /**
   * Overrides DISCLOSURE.operatorName. The shipped constant is a placeholder
   * and the publisher refuses to construct while it is still in place.
   */
  operatorName?: string
  /** Receipt links are built from this. Must be https. */
  receiptsBaseUrl: string
  /** Hosts a post body may link to. Exact host or a subdomain of one. */
  allowedLinkHosts: readonly string[]
  /** Router/aggregator contracts allowed to appear in a body alongside the token. */
  allowedRouterAddresses: readonly Address[]
  /**
   * How stale an observation of X's automated-account label may be before a
   * delegated post is refused.
   */
  maxAccountLabelAgeSeconds: number
}

export interface ResolvedPolicy extends PublisherPolicy {
  operatorName: string
  allowedLinkHosts: readonly string[]
}

export type { Address, Channel, PublishRequest }

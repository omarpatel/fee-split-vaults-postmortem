import { countCodePoints, type Measure } from '../text.js'
import type { Channel } from '../types.js'

/**
 * One interface for every surface. The publisher does all disclosure, link,
 * ticker and refusal work before an adapter is touched; an adapter's only jobs
 * are transport, read-back and deletion.
 *
 * Read-back and deletion are mandatory, not optional: a channel we cannot
 * re-read or cannot delete from is a channel we cannot prove disclosure on, and
 * the publisher fails closed rather than trusting a write receipt.
 */

export interface ChannelLimits {
  maxChars: number
  /**
   * Applies instead of maxChars when the post carries an image. Telegram caps a
   * photo caption well below a text message; a channel without the distinction
   * leaves it unset.
   */
  maxCaptionChars?: number
  /** Channel-specific counting. X weights every URL as 23 characters. */
  measure: Measure
  /** A public surface. Public posts require human approval before publishing. */
  isPublic: boolean
}

export interface AdapterPublishInput {
  accountId: string
  /** Final composed text, disclosure already appended. Adapters must not edit it. */
  text: string
  imageRefs?: readonly string[]
  inReplyToId?: string
  correlationId?: string
}

export interface PublishedPost {
  externalId: string
  url?: string
  publishedAtUnix: number
}

export interface FetchedPost {
  externalId: string
  text: string
  url?: string
}

export interface AccountDisclosureRequirement {
  operatorName: string
  aiOperationTag: string
  nowUnix: number
  maxLabelAgeSeconds: number
}

export interface AccountDisclosureCheck {
  ok: boolean
  /** The platform's own automated-account label. Unknown counts as absent. */
  automatedLabel: boolean
  labelObservedAtUnix: number
  bioHasOperator: boolean
  bioHasAiTag: boolean
  detail?: string
}

export interface ChannelAdapter {
  readonly channel: Channel
  readonly limits: ChannelLimits
  publish(input: AdapterPublishInput): Promise<PublishedPost>
  /** Null means the post is gone. Throwing means we could not tell. Both fail closed. */
  fetchPost(externalId: string): Promise<FetchedPost | null>
  deletePost(externalId: string): Promise<void>
  /**
   * Required on any account the operator does not own outright. The dev owns a
   * delegated X account and can silently edit the disclosure out of the bio, so
   * it is re-verified before EVERY post, never cached across posts.
   */
  verifyAccountDisclosure?(
    accountId: string,
    requirement: AccountDisclosureRequirement,
  ): Promise<AccountDisclosureCheck>
}

export type ChannelTransportCode =
  | 'credential_missing'
  | 'credential_expired'
  | 'credential_refresh_failed'
  | 'image_asset_missing'
  | 'caption_too_long'

export class ChannelTransportError extends Error {
  /** Set when the failure is a known refusal rather than a network fault; the publisher reports it verbatim. */
  readonly code: ChannelTransportCode | undefined

  constructor(
    message: string,
    readonly channel: Channel,
    override readonly cause?: unknown,
    code?: ChannelTransportCode,
  ) {
    super(`${channel}: ${message}`)
    this.name = 'ChannelTransportError'
    this.code = code
  }
}

const URL_IN_TEXT = /\bhttps?:\/\/\S+/gi
/** X shortens every link to a t.co of this fixed weight. */
export const X_URL_WEIGHT = 23

export const measureXChars: Measure = (text) =>
  countCodePoints(text.replace(URL_IN_TEXT, 'u'.repeat(X_URL_WEIGHT)))

export const TELEGRAM_LIMITS: ChannelLimits = {
  maxChars: 4_096,
  maxCaptionChars: 1_024,
  measure: countCodePoints,
  isPublic: true,
}

export const X_LIMITS: ChannelLimits = {
  maxChars: 280,
  measure: measureXChars,
  isPublic: true,
}

export const SITE_LIMITS: ChannelLimits = {
  maxChars: 100_000,
  measure: countCodePoints,
  isPublic: true,
}

/**
 * The inbound message shape.
 *
 * Everything on it except the channel plumbing is ATTACKER CONTROLLED. Nothing
 * downstream may treat `text`, `authorUsername`, or `authorDisplayName` as
 * anything other than untrusted bytes, and no field here ever becomes an
 * address, an amount, or a destination anywhere in this package.
 */

import type { Channel } from '@fee-split-vaults/core'

export interface InboundMessage {
  channel: Channel
  chatId: string
  messageId: string
  authorId: string
  /** Untrusted. Used only for impersonation comparison, never for authority. */
  authorUsername?: string
  /** Untrusted. Same. */
  authorDisplayName?: string
  authorJoinedUnix?: number
  /** Untrusted. Never parsed for values, never followed as an instruction. */
  text: string
  sentAtUnix: number
  replyToBot?: boolean
  mentionsBot?: boolean
  /**
   * Set by the platform, not by the message. An admin still cannot instruct the
   * desk to spend, sign, or publish - there is no such tool on this plane.
   */
  isFromAdmin?: boolean
}

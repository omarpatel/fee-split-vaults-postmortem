/**
 * Moderation as a first-class product, not a side effect of answering.
 *
 * Scam removal, raid throttling, impersonator bans and the escalation queue are
 * the T0 deliverable. A holder judges a token chat by whether the drainer link
 * posted at 3am was gone by 3:01, not by whether the bot writes nice sentences.
 *
 * Everything here is deterministic. No model participates in a removal or a ban
 * decision, which means every action is reproducible from the message plus the
 * rule table, and an appeal can be answered with the rule id.
 *
 * The escalation path exists because some of these judgements are genuinely
 * close: a suspected impersonator may be a real team member who changed their
 * display name. Those go to a human instead of being decided confidently.
 */

import { createHash } from 'node:crypto'
import type { Address, TopicCode } from '@fee-split-vaults/core'
import type { InboundMessage } from '../message.js'
import { foldPattern, normalize, similarity } from '../text/normalize.js'
import type { TelegramAdmin, TelegramClient } from '../telegram/client.js'
import { LinkPolicy, type LinkVerdict } from './blocklist.js'
import { defang, type EscalationDraft } from './escalation.js'

export type ModerationReason =
  | 'blocked_link'
  | 'dm_solicitation'
  | 'impersonation'
  | 'role_claim'
  | 'credential_phishing'
  | 'scam_pattern'
  | 'author_flood'
  | 'chat_flood'
  | 'coordinated_duplicate'
  | 'prompt_injection'

export type ModerationActionKind = 'delete' | 'warn' | 'mute' | 'ban' | 'lock_chat' | 'escalate'

export interface ModerationAction {
  kind: ModerationActionKind
  reason: ModerationReason
  /** Rule id. Quoted verbatim in an appeal. */
  rule: string
  detail: string
  untilUnix?: number
}

export interface ModerationVerdict {
  actions: ModerationAction[]
  /** The message should not be answered or admitted to the corpus. */
  removed: boolean
  /** True when the desk must not run a model on this message. */
  suppressModel: boolean
  topics: TopicCode[]
  escalations: EscalationDraft[]
  /** Fixed, code-authored warning text, when a warn action is present. */
  warning?: string
}

export interface RaidThresholds {
  /** Messages per minute in one chat before the chat is locked. */
  chatMessagesPerMinute: number
  /** Messages per minute from one author before that author is muted. */
  authorMessagesPerMinute: number
  /** Distinct authors posting identical text before it is treated as coordinated. */
  duplicateAuthors: number
  duplicateWindowSeconds: number
  lockSeconds: number
  muteSeconds: number
}

export const DEFAULT_RAID_THRESHOLDS: RaidThresholds = {
  chatMessagesPerMinute: 60,
  authorMessagesPerMinute: 12,
  duplicateAuthors: 5,
  duplicateWindowSeconds: 120,
  lockSeconds: 300,
  muteSeconds: 900,
}

export interface ModerationOptions {
  /** The coin this desk instance serves. Bound by trusted code, never by a message. */
  vault: Address
  linkPolicy: LinkPolicy
  admins?: TelegramAdmin[]
  raid?: Partial<RaidThresholds>
  /** Mute length for a repeat DM solicitation. Defaults to the raid mute length. */
  warnMuteSeconds?: number
  /** Similarity above which a name is treated as impersonating an admin. */
  impersonationThreshold?: number
}

const DM_SOLICITATION = foldPattern(
  /(dmme|dmsent|dmopen|checkdm|checkyourdm|checkyourdms|inboxme|pmme|messagemedirectly|messagemeprivately|writemeprivately|hitmeup|contactmeon|textmeon|sendmeadm|slideintodm)/,
)

const DM_SOLICITATION_NATIVE =
  /(escribeme|escríbeme|me chama no privado|chama no pv|ecris moi|écris-moi|schreib mir privat|напиши в лс|пиши в личку|私信して|디엠|دي إم)/

const CREDENTIAL_PHISHING = foldPattern(
  /(seedphrase|recoveryphrase|privatekey|mnemonic|keystorefile|twelvewords|24words|12words|walletpassword|importyourwallet|restoreyourwallet)/,
)

const WALLET_FUNNEL = foldPattern(
  /(verifyyourwallet|validateyourwallet|syncyourwallet|connectyourwallet|walletnoteligible|claimyourairdrop|unclaimedtokens|claimreward|activateyouraccount|resolveyourissue)/,
)

const DOUBLING_SCAM = /\b(send|deposit)\s*\d[\d.,]*\s*(eth|weth|usd|usdg|sol|btc)\b[\s\S]{0,40}\b(get|receive|back|return)\b/

const SUPPORT_IMPERSONATION = foldPattern(
  /(officialsupport|supportteamhere|customersupportagent|opensupportticket|ticketnumber|verifyyouridentity)/,
)

const ROLE_CLAIM =
  /\b(admin|administrator|moderator|mod|support|founder|dev|developer|team|owner|helpdesk|official|customer service)\b/

const PROMPT_INJECTION = foldPattern(
  /(ignore(all)?(previous|prior|above)(instructions|prompts|rules)|disregard(all|any)?(previous|prior|above)|systemprompt|youarenow|newinstructions|actasa|developermode|jailbreak|revealyour(prompt|instructions|rules)|repeatyour(system)?prompt|printyourprompt|forgetyourrules)/,
)

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

interface Window {
  timestamps: number[]
}

export class ModerationEngine {
  private readonly thresholds: RaidThresholds
  private readonly linkPolicy: LinkPolicy
  private readonly vault: Address
  private admins: TelegramAdmin[]
  private readonly impersonationThreshold: number
  private readonly warnMuteSeconds: number

  private readonly chatWindows = new Map<string, Window>()
  private readonly authorWindows = new Map<string, Window>()
  private readonly duplicates = new Map<string, { authors: Set<string>; firstUnix: number }>()
  private readonly warned = new Set<string>()

  constructor(options: ModerationOptions) {
    this.thresholds = { ...DEFAULT_RAID_THRESHOLDS, ...options.raid }
    this.linkPolicy = options.linkPolicy
    this.vault = options.vault
    this.admins = options.admins ?? []
    this.impersonationThreshold = options.impersonationThreshold ?? 0.86
    this.warnMuteSeconds = options.warnMuteSeconds ?? 0
  }

  setAdmins(admins: TelegramAdmin[]): void {
    this.admins = admins
  }

  private bump(map: Map<string, Window>, key: string, nowUnix: number, windowSeconds = 60): number {
    const entry = map.get(key) ?? { timestamps: [] }
    entry.timestamps = entry.timestamps.filter((t) => nowUnix - t < windowSeconds)
    entry.timestamps.push(nowUnix)
    map.set(key, entry)
    return entry.timestamps.length
  }

  /**
   * The impersonation check. An exact match after normalisation but a different
   * raw string is the homoglyph attack and is treated as certain; a near match
   * is treated as probable and still escalated for a human to look at.
   */
  private checkImpersonation(message: InboundMessage): ModerationAction[] {
    if (message.isFromAdmin) return []
    const candidates = [message.authorUsername, message.authorDisplayName].filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    )
    if (candidates.length === 0) return []

    const actions: ModerationAction[] = []

    for (const candidate of candidates) {
      for (const admin of this.admins) {
        if (admin.userId === message.authorId) continue
        for (const adminName of [admin.username, admin.displayName]) {
          if (!adminName) continue
          const normalizedCandidate = normalize(candidate).squeezed
          const normalizedAdmin = normalize(adminName).squeezed
          if (normalizedAdmin.length < 4) continue

          if (normalizedCandidate === normalizedAdmin) {
            actions.push({
              kind: 'ban',
              reason: 'impersonation',
              rule: 'imp.exact_after_fold',
              detail: `name folds to an admin name (${defang(adminName)})`,
            })
          } else if (similarity(candidate, adminName) >= this.impersonationThreshold) {
            actions.push({
              kind: 'mute',
              reason: 'impersonation',
              rule: 'imp.near_match',
              detail: `name is close to an admin name (${defang(adminName)})`,
            })
          }
        }
      }
    }

    if (actions.length === 0) {
      const folded = normalize(candidates.join(' ')).folded
      if (ROLE_CLAIM.test(folded)) {
        actions.push({
          kind: 'mute',
          reason: 'role_claim',
          rule: 'imp.role_claim',
          detail: 'claims a staff role in the display name without being an admin',
        })
      }
    }

    // Only the strongest action per message; a ban subsumes a mute.
    const ban = actions.find((action) => action.kind === 'ban')
    return ban ? [ban] : actions.slice(0, 1)
  }

  scan(message: InboundMessage, nowUnix: number = message.sentAtUnix): ModerationVerdict {
    const actions: ModerationAction[] = []
    const topics: TopicCode[] = []
    const escalations: EscalationDraft[] = []
    const { squeezed, lower, folded } = normalize(message.text)

    // --- links ---------------------------------------------------------
    const linkVerdict: LinkVerdict = this.linkPolicy.check(message.text)
    if (linkVerdict.blocked && !message.isFromAdmin) {
      const hard = linkVerdict.reasons.some((reason) =>
        [
          'operator_blocklist',
          'lookalike_of_official_domain',
          'official_label_on_foreign_domain',
          'official_label_embedded',
          'punycode_host',
          'drainer_funnel_vocabulary',
        ].includes(reason),
      )
      actions.push({
        kind: 'delete',
        reason: 'blocked_link',
        rule: `link.${linkVerdict.reasons[0] ?? 'unknown'}`,
        detail: linkVerdict.reasons.join(','),
      })
      if (hard) {
        actions.push({
          kind: 'ban',
          reason: 'blocked_link',
          rule: 'link.drainer',
          detail: 'posted a link matching a drainer pattern',
        })
        topics.push('scam_report')
        escalations.push({
          vault: this.vault,
          reason: 'drainer_link',
          summary: `Removed a link matching ${linkVerdict.reasons.join(', ')} and banned the poster.`,
          evidence: linkVerdict.blockedLinks.map((link) => defang(link.host + link.path)),
          chatId: message.chatId,
          messageId: message.messageId,
          authorId: message.authorId,
        })
      } else {
        topics.push('moderation_needed')
      }
    }

    // --- credential phishing and scam funnels --------------------------
    if (CREDENTIAL_PHISHING.test(squeezed)) {
      actions.push({
        kind: 'delete',
        reason: 'credential_phishing',
        rule: 'scam.credentials',
        detail: 'asks for wallet secrets',
      })
      actions.push({
        kind: 'ban',
        reason: 'credential_phishing',
        rule: 'scam.credentials',
        detail: 'asks for wallet secrets',
      })
      topics.push('scam_report')
      escalations.push({
        vault: this.vault,
        reason: 'drainer_link',
        summary: 'Removed a message soliciting wallet secrets and banned the poster.',
        chatId: message.chatId,
        messageId: message.messageId,
        authorId: message.authorId,
      })
    } else if (WALLET_FUNNEL.test(squeezed) || SUPPORT_IMPERSONATION.test(squeezed) || DOUBLING_SCAM.test(lower)) {
      actions.push({
        kind: 'delete',
        reason: 'scam_pattern',
        rule: 'scam.funnel',
        detail: 'matches a known scam funnel phrasing',
      })
      actions.push({
        kind: 'mute',
        reason: 'scam_pattern',
        rule: 'scam.funnel',
        detail: 'matches a known scam funnel phrasing',
      })
      topics.push('scam_report')
    }

    // --- DM solicitation: auto-warn, never an immediate ban ------------
    const solicits = DM_SOLICITATION.test(squeezed) || DM_SOLICITATION_NATIVE.test(lower)
    if (solicits && !message.isFromAdmin) {
      const repeat = this.warned.has(`${message.chatId}:${message.authorId}`)
      this.warned.add(`${message.chatId}:${message.authorId}`)
      actions.push({
        kind: repeat ? 'mute' : 'warn',
        reason: 'dm_solicitation',
        rule: repeat ? 'dm.repeat' : 'dm.first',
        detail: 'solicited a private message',
        untilUnix: repeat ? nowUnix + (this.warnMuteSeconds || this.thresholds.muteSeconds) : undefined,
      })
      if (linkVerdict.blocked) {
        actions.push({
          kind: 'delete',
          reason: 'dm_solicitation',
          rule: 'dm.with_link',
          detail: 'solicited a DM alongside an unrecognised link',
        })
      }
      topics.push('moderation_needed')
    }

    // --- impersonation --------------------------------------------------
    const impersonation = this.checkImpersonation(message)
    if (impersonation.length > 0) {
      actions.push(...impersonation)
      topics.push('impersonator_report')
      escalations.push({
        vault: this.vault,
        reason: 'impersonation',
        summary: `${impersonation[0]!.detail}. Action taken: ${impersonation[0]!.kind}.`,
        evidence: [
          defang(message.authorDisplayName ?? ''),
          defang(message.authorUsername ?? ''),
        ].filter((fragment) => fragment.length > 0),
        chatId: message.chatId,
        messageId: message.messageId,
        authorId: message.authorId,
      })
    }

    // --- flood control --------------------------------------------------
    const chatRate = this.bump(this.chatWindows, message.chatId, nowUnix)
    const authorRate = this.bump(
      this.authorWindows,
      `${message.chatId}:${message.authorId}`,
      nowUnix,
    )

    if (authorRate > this.thresholds.authorMessagesPerMinute && !message.isFromAdmin) {
      actions.push({
        kind: 'mute',
        reason: 'author_flood',
        rule: 'raid.author_rate',
        detail: `${authorRate} messages in the last minute`,
        untilUnix: nowUnix + this.thresholds.muteSeconds,
      })
      topics.push('raid_or_spam')
    }

    if (chatRate > this.thresholds.chatMessagesPerMinute) {
      actions.push({
        kind: 'lock_chat',
        reason: 'chat_flood',
        rule: 'raid.chat_rate',
        detail: `${chatRate} messages in the last minute`,
        untilUnix: nowUnix + this.thresholds.lockSeconds,
      })
      topics.push('raid_or_spam')
      escalations.push({
        vault: this.vault,
        reason: 'raid',
        summary: `Chat locked: ${chatRate} messages in one minute.`,
        chatId: message.chatId,
      })
    }

    // Identical text from many distinct authors is a coordinated raid, and it
    // is the shape that a rate limit alone never catches.
    if (squeezed.length >= 12) {
      const key = `${message.chatId}:${hashText(squeezed)}`
      const entry = this.duplicates.get(key) ?? { authors: new Set<string>(), firstUnix: nowUnix }
      if (nowUnix - entry.firstUnix > this.thresholds.duplicateWindowSeconds) {
        entry.authors.clear()
        entry.firstUnix = nowUnix
      }
      entry.authors.add(message.authorId)
      this.duplicates.set(key, entry)
      if (entry.authors.size >= this.thresholds.duplicateAuthors) {
        actions.push({
          kind: 'delete',
          reason: 'coordinated_duplicate',
          rule: 'raid.duplicate_authors',
          detail: `${entry.authors.size} authors posting identical text`,
        })
        actions.push({
          kind: 'lock_chat',
          reason: 'coordinated_duplicate',
          rule: 'raid.duplicate_authors',
          detail: `${entry.authors.size} authors posting identical text`,
          untilUnix: nowUnix + this.thresholds.lockSeconds,
        })
        topics.push('raid_or_spam')
        escalations.push({
          vault: this.vault,
          reason: 'scam_wave',
          summary: `${entry.authors.size} accounts posted identical text within ${this.thresholds.duplicateWindowSeconds}s.`,
          chatId: message.chatId,
        })
      }
    }

    // --- prompt injection ----------------------------------------------
    let suppressModel = false
    if (PROMPT_INJECTION.test(squeezed) || PROMPT_INJECTION.test(folded)) {
      suppressModel = true
      actions.push({
        kind: 'escalate',
        reason: 'prompt_injection',
        rule: 'inj.instruction_override',
        detail: 'message contains instruction-override phrasing',
      })
      topics.push('moderation_needed')
      escalations.push({
        vault: this.vault,
        reason: 'prompt_injection',
        summary:
          'A message tried to give the desk instructions. No tool exists on this plane to act on them; the desk declined to answer it.',
        chatId: message.chatId,
        messageId: message.messageId,
        authorId: message.authorId,
      })
    }

    const removed = actions.some((action) => action.kind === 'delete' || action.kind === 'ban')

    return {
      actions,
      removed,
      suppressModel: suppressModel || removed,
      topics: [...new Set(topics)],
      escalations,
      warning: actions.some((action) => action.kind === 'warn') ? DM_WARNING : undefined,
    }
  }
}

/** Fixed warning text. Code-authored, identical every time it is used. */
export const DM_WARNING = [
  'Heads up: nobody from this project will DM you first, and no admin will ever ask you to connect a wallet, verify an address, or share a phrase.',
  'Treat any DM claiming to be support as a scam. Report it here instead.',
].join('\n')

export interface ModerationOutcome {
  applied: ModerationAction[]
  failed: Array<{ action: ModerationAction; error: unknown }>
}

/**
 * Execute a verdict. Ordered so a delete always precedes a ban and a lock is
 * last, and so one failing call does not abandon the rest.
 */
export async function executeModeration(
  client: TelegramClient,
  message: InboundMessage,
  verdict: ModerationVerdict,
  options: { operatorWarning?: (text: string) => Promise<void> } = {},
): Promise<ModerationOutcome> {
  const order: ModerationActionKind[] = ['delete', 'warn', 'mute', 'ban', 'lock_chat', 'escalate']
  const sorted = [...verdict.actions].sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
  )

  const applied: ModerationAction[] = []
  const failed: Array<{ action: ModerationAction; error: unknown }> = []

  for (const action of sorted) {
    try {
      switch (action.kind) {
        case 'delete':
          await client.deleteMessage(message.chatId, message.messageId)
          break
        case 'warn':
          if (verdict.warning && options.operatorWarning) await options.operatorWarning(verdict.warning)
          break
        case 'mute':
          await client.muteMember(
            message.chatId,
            message.authorId,
            action.untilUnix ?? message.sentAtUnix + 900,
          )
          break
        case 'ban':
          await client.banMember(message.chatId, message.authorId, true)
          break
        case 'lock_chat':
          await client.setChatLocked(message.chatId, true)
          break
        case 'escalate':
          break
      }
      applied.push(action)
    } catch (error) {
      failed.push({ action, error })
    }
  }

  return { applied, failed }
}

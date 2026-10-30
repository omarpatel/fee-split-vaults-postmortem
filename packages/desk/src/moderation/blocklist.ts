/**
 * Link policy: the drainer defence.
 *
 * The default mode is ALLOWLIST. In a token chat, every link that is not one of
 * the handful the project actually publishes is noise at best and a wallet
 * drainer at worst, and no heuristic beats "we only post four links here". Fail
 * closed means an unrecognised link is removed, not scored.
 *
 * A heuristic mode exists for chats that will not accept an allowlist. It is
 * strictly weaker and it says so.
 *
 * WHAT IS NOT HERE. A list of "known drainer domains" invented at authoring
 * time. Naming specific real-world hosts as malicious from memory would be both
 * unverifiable and defamatory; the operator supplies that feed. What IS here is
 * the structural half, which is the durable half: lookalikes of the project's
 * own domains, punycode, raw-IP hosts, shorteners that hide a destination, and
 * the claim/connect/verify path vocabulary every drainer funnel uses.
 */

import { editDistance, normalize } from '../text/normalize.js'

export interface LinkRef {
  /** As written, for the audit log. */
  raw: string
  /** Homoglyph-folded, lowercased host. Matching happens on this. */
  host: string
  path: string
}

/** Matches host-shaped runs, including bare IPv4, with or without a scheme. */
const LINK_PATTERN =
  /\b((?:https?:\/\/)?(?:\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}))((?:\/|\?)[^\s]*)?/gi

/** Hosts whose whole purpose is to hide the destination from the reader. */
const SHORTENERS: readonly string[] = [
  'bit.ly',
  'tinyurl.com',
  't.co',
  'is.gd',
  'cutt.ly',
  'rebrand.ly',
  'shorturl.at',
  't.ly',
  'rb.gy',
  'ow.ly',
  'buff.ly',
  's.id',
  'v.gd',
  'lnkd.in',
  'shorte.st',
  'tiny.cc',
]

/** The funnel vocabulary. Present in the host label or the first path segment. */
const DRAINER_TOKENS: readonly string[] = [
  'claim',
  'airdrop',
  'connect',
  'connectwallet',
  'validate',
  'verify',
  'verification',
  'sync',
  'migrate',
  'migration',
  'restore',
  'recovery',
  'unlock',
  'rectify',
  'refund',
  'support',
  'helpdesk',
  'giveaway',
  'presale',
  'whitelist',
  'mint',
]

export type LinkPolicyMode = 'allowlist' | 'heuristic'

export interface LinkPolicyOptions {
  mode?: LinkPolicyMode
  /** Hosts the project actually publishes. Exact host or any subdomain. */
  allowedHosts?: string[]
  /** The project's own domains, used as the lookalike reference set. */
  officialHosts?: string[]
  /** Operator-supplied known-bad feed. Exact host or any subdomain. */
  blockedHosts?: string[]
}

export interface LinkVerdict {
  blocked: boolean
  /** Rule ids, most specific first. Logged verbatim. */
  reasons: string[]
  links: LinkRef[]
  blockedLinks: LinkRef[]
}

function foldHost(host: string): string {
  return normalize(host).folded.replace(/[^a-z0-9.-]/g, '')
}

function hostMatches(host: string, listed: string): boolean {
  return host === listed || host.endsWith('.' + listed)
}

/** Second-level label, e.g. "example" from "app.example.co.uk". */
function primaryLabel(host: string): string {
  const parts = host.split('.').filter(Boolean)
  if (parts.length <= 2) return parts[0] ?? host
  const secondLast = parts[parts.length - 2] ?? ''
  if (secondLast.length <= 3 && parts.length >= 3) return parts[parts.length - 3] ?? secondLast
  return secondLast
}

export function extractLinks(text: string): LinkRef[] {
  const views = [normalize(text).lower, normalize(text).folded]
  const seen = new Map<string, LinkRef>()
  for (const view of views) {
    LINK_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = LINK_PATTERN.exec(view)) !== null) {
      const rawHost = (match[1] ?? '').replace(/^https?:\/\//, '')
      const host = foldHost(rawHost)
      if (host.length === 0) continue
      const path = (match[2] ?? '').toLowerCase()
      const key = host + path
      if (!seen.has(key)) seen.set(key, { raw: match[0], host, path })
    }
  }
  return [...seen.values()]
}

export class LinkPolicy {
  private readonly mode: LinkPolicyMode
  private readonly allowed: string[]
  private readonly official: string[]
  private readonly blocked: Set<string>

  constructor(options: LinkPolicyOptions = {}) {
    this.mode = options.mode ?? 'allowlist'
    this.allowed = (options.allowedHosts ?? []).map(foldHost)
    this.official = (options.officialHosts ?? options.allowedHosts ?? []).map(foldHost)
    this.blocked = new Set((options.blockedHosts ?? []).map(foldHost))
  }

  /** Extend the operator-supplied feed at runtime. */
  block(host: string): void {
    this.blocked.add(foldHost(host))
  }

  isAllowed(host: string): boolean {
    return this.allowed.some((listed) => hostMatches(host, listed))
  }

  private reasonsFor(link: LinkRef): string[] {
    const reasons: string[] = []
    const { host, path } = link

    for (const listed of this.blocked) {
      if (hostMatches(host, listed)) reasons.push('operator_blocklist')
    }
    if (host.includes('xn--')) reasons.push('punycode_host')
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) reasons.push('raw_ip_host')

    // An allowlisted host is the project's own. Lookalike and funnel rules exist
    // to catch impostors OF it and must not fire against it.
    if (this.isAllowed(host)) return [...new Set(reasons)]

    if (SHORTENERS.some((listed) => hostMatches(host, listed))) reasons.push('url_shortener')

    const label = primaryLabel(host)
    for (const official of this.official) {
      const officialLabel = primaryLabel(official)
      if (officialLabel.length < 4) continue
      const threshold = officialLabel.length >= 8 ? 2 : 1
      if (label === officialLabel) {
        reasons.push('official_label_on_foreign_domain')
      } else if (label.includes(officialLabel)) {
        reasons.push('official_label_embedded')
      } else if (editDistance(label, officialLabel, threshold) <= threshold) {
        reasons.push('lookalike_of_official_domain')
      }
    }

    const firstSegment = path.replace(/^\//, '').split(/[/?#]/)[0] ?? ''
    if (DRAINER_TOKENS.some((token) => label.includes(token) || firstSegment === token)) {
      // Only meaningful off the allowlist; an official /claim page is fine.
      if (!this.isAllowed(host)) reasons.push('drainer_funnel_vocabulary')
    }

    return [...new Set(reasons)]
  }

  check(text: string): LinkVerdict {
    const links = extractLinks(text)
    const reasons: string[] = []
    const blockedLinks: LinkRef[] = []

    for (const link of links) {
      const linkReasons = this.reasonsFor(link)
      if (this.mode === 'allowlist' && !this.isAllowed(link.host) && linkReasons.length === 0) {
        linkReasons.push('not_on_allowlist')
      }
      if (linkReasons.length > 0) {
        blockedLinks.push(link)
        reasons.push(...linkReasons)
      }
    }

    return {
      blocked: blockedLinks.length > 0,
      reasons: [...new Set(reasons)],
      links,
      blockedLinks,
    }
  }
}

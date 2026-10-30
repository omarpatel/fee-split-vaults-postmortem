import {
  HOST_LIKE_SOURCE,
  OBFUSCATED_HOST_SOURCE,
  addressLikeTokens,
  handleTokens,
  hostLikeTokens,
  namingServiceTokens,
  normalizeAddressToken,
} from '@fee-split-vaults/core'
import { normalizeVisibleText } from './text.js'
import type { Rejection } from './types.js'

/**
 * LINK AND ADDRESS ALLOWLIST.
 *
 * The attack this closes: a "contract migration" injection. Untrusted community
 * text says the contract moved, that text influences copy, and our own labelled,
 * trusted bot answers "where do I buy" with the attacker's address. The airlock
 * already prevents an address from reaching the planner, and this is the second
 * wall: an address-shaped token in an outbound body that is not the bound token,
 * the coin's own vault, or an allowlisted router is a HARD REJECT. Not sanitized,
 * not truncated away - refused, and logged.
 *
 * FOUR WAYS THIS WALL USED TO BE WALKED PAST, all now closed and all with their
 * rules moved into @fee-split-vaults/core so no copy of them can drift again:
 *
 *   1. `0X…`. ADDRESS_LIKE was `/0x[0-9a-fA-F]{4,}/g`: the hex body was
 *      case-insensitive by character class, the two-character prefix was a
 *      case-SENSITIVE literal. The same address in uppercase-prefix form was not
 *      an address here, and it published.
 *   2. No prefix at all. An EVM address is 40 hex characters; `0x` is a display
 *      convention. Dropped, it matched nothing.
 *   3. Invisible characters this package did not strip (see text.ts).
 *   4. The link "allowlist" was gated by a TLD DENY-LIST: a host whose TLD was
 *      not in a 30-entry list was never recognised as a link, so it was never
 *      handed to checkUrl and the allowlist never ran. Nineteen of twenty-one
 *      TLDs tested walked straight through. Detection is now by SHAPE and the
 *      allowlist decides, which is the only ordering in which an allowlist is
 *      actually an allowlist.
 *
 * And two shapes it never covered: naming-service names (venuevault.eth is not a
 * website, it is a destination a wallet resolves) and contact handles
 * ("message vnx_support_desk on Telegram" is the standard drainer funnel and
 * this file had no handle check at all).
 */

const EXPLICIT_URL = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi
const BARE_HOST = new RegExp(`${HOST_LIKE_SOURCE}(?:\\/[^\\s<>"'\`)\\]}]*)?`, 'gi')
const OBFUSCATED_DOMAIN = new RegExp(OBFUSCATED_HOST_SOURCE, 'iu')
const IP_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/

export interface LinkPolicy {
  allowedHosts: readonly string[]
  /** Bound token, coin vault and allowlisted routers. Lower-cased on load. */
  allowedAddresses: readonly string[]
}

/**
 * Fold two spellings of the same destination together. `0x…`, `0X…` and the
 * prefix-free form are one address, so the allowlist has to say so - otherwise
 * fixing the matcher would just move the bypass into the comparison.
 */
export function normalizeAddress(value: string): string {
  return normalizeAddressToken(value)
}

export function buildLinkPolicy(input: {
  allowedHosts: readonly string[]
  allowedAddresses: readonly string[]
}): LinkPolicy {
  return {
    allowedHosts: input.allowedHosts.map((h) => h.trim().toLowerCase().replace(/^\.+|\.+$/g, '')),
    allowedAddresses: input.allowedAddresses.map(normalizeAddress),
  }
}

export function extractAddressLikeTokens(text: string): string[] {
  return addressLikeTokens(normalizeVisibleText(text))
}

export function extractUrls(text: string): string[] {
  const normalized = normalizeVisibleText(text)
  const explicit = normalized.match(EXPLICIT_URL) ?? []
  const bare = (normalized.match(BARE_HOST) ?? [])
    .filter((candidate) => !explicit.some((url) => url.includes(candidate)))
    // A host-shaped token that is a known prose form is not a link candidate.
    .filter((candidate) => hostLikeTokens(candidate).length > 0)
  return [...explicit, ...bare].map((raw) => raw.replace(/[.,;:!?)]+$/, ''))
}

function hostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return allowedHosts.some((allowed) => h === allowed || h.endsWith(`.${allowed}`))
}

/**
 * Reject anything that is not a plain https URL on an allowlisted host.
 *
 * Userinfo, non-default ports, IP literals and punycode hosts are refused
 * outright: "https://receipts.example.com@evil.tld/" is a link to evil.tld, and
 * an IDN host is a homograph vector we have no reason to accept.
 */
export function checkUrl(raw: string, policy: LinkPolicy): Rejection | null {
  const candidate = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { stage: 'link_allowlist', reason: 'unparseable_link', detail: raw }
  }
  if (url.protocol !== 'https:') {
    return { stage: 'link_allowlist', reason: 'insecure_link_scheme', detail: raw }
  }
  if (url.username !== '' || url.password !== '') {
    return { stage: 'link_allowlist', reason: 'link_carries_credentials', detail: raw }
  }
  if (url.port !== '') {
    return { stage: 'link_allowlist', reason: 'link_has_explicit_port', detail: raw }
  }
  if (IP_HOST.test(url.hostname)) {
    return { stage: 'link_allowlist', reason: 'link_to_ip_literal', detail: raw }
  }
  if (url.hostname.includes('xn--') && !policy.allowedHosts.includes(url.hostname.toLowerCase())) {
    return { stage: 'link_allowlist', reason: 'punycode_host', detail: raw }
  }
  if (!hostAllowed(url.hostname, policy.allowedHosts)) {
    return { stage: 'link_allowlist', reason: 'host_not_allowlisted', detail: url.hostname }
  }
  return null
}

/**
 * Full outbound scan. Ordered and deterministic: the first failure wins, so the
 * reason code is reproducible for the same input.
 */
export function checkLinksAndAddresses(
  text: string,
  declaredLinks: readonly string[],
  policy: LinkPolicy,
): Rejection | null {
  const normalized = normalizeVisibleText(text)

  for (const token of extractAddressLikeTokens(normalized)) {
    if (!policy.allowedAddresses.includes(normalizeAddress(token))) {
      return {
        stage: 'link_allowlist',
        reason: 'unallowlisted_address_in_body',
        detail: token,
      }
    }
  }

  // A naming-service name is not a link and cannot be allowlisted: a wallet
  // RESOLVES venuevault.eth to an address, so it is a payment destination and the
  // desk has no legitimate reason to put one in outbound copy.
  const [namingService] = namingServiceTokens(normalized)
  if (namingService !== undefined) {
    return {
      stage: 'link_allowlist',
      reason: 'naming_service_destination_in_body',
      detail: namingService,
    }
  }

  // Impersonated-support-DM is the most common memecoin drain funnel, and it
  // arrives here with the operator's own disclosure attached. Support contacts
  // are named by the disclosure block, never by a body.
  const [handle] = handleTokens(normalized)
  if (handle !== undefined) {
    return { stage: 'link_allowlist', reason: 'contact_handle_in_body', detail: handle }
  }

  if (OBFUSCATED_DOMAIN.test(normalized)) {
    return { stage: 'link_allowlist', reason: 'obfuscated_link', detail: 'dot-notation domain' }
  }

  for (const url of extractUrls(normalized)) {
    const rejection = checkUrl(url, policy)
    if (rejection) return rejection
  }

  for (const link of declaredLinks) {
    const rejection = checkUrl(link.trim(), policy)
    if (rejection) return rejection
  }

  return null
}

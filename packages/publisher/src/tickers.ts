import { DISCLOSURE } from '../../../config/protocol.js'
import { normalizeVisibleText } from './text.js'
import type { AccountBinding, Rejection, RosterEntry } from './types.js'

/**
 * ONE TICKER PER ACCOUNT.
 *
 * This is the line between an agency roster and a coordinated inauthentic
 * network. An agency runs many accounts, each openly speaking for one client. A
 * network runs accounts that promote each other's coins. The difference is not
 * intent, it is enforced here: an account is bound to exactly one ticker and a
 * body naming any other client's ticker is refused.
 *
 * The bound ticker itself is never inferred from content - it comes from the
 * account binding, which is operator-configured trusted state.
 */

const CASHTAG = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g

export function extractCashtags(text: string): string[] {
  const out: string[] = []
  const normalized = normalizeVisibleText(text)
  for (const match of normalized.matchAll(CASHTAG)) {
    const ticker = match[1]
    if (ticker !== undefined) out.push(ticker.toUpperCase())
  }
  return out
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A bare ticker only counts when it appears in upper case (BONK, not "bonk" in
 * a sentence). Cashtags count in any case. Two-letter tickers are matched only
 * as cashtags: bare two-letter upper-case runs collide with ordinary English.
 */
function mentionsBareTicker(text: string, ticker: string): boolean {
  if (ticker.length < 3) return false
  return new RegExp(`\\b${escapeRegExp(ticker.toUpperCase())}\\b`).test(text)
}

export interface TickerCheckInput {
  text: string
  binding: AccountBinding
  /** Every other client coin on the book. */
  roster: readonly RosterEntry[]
  maxTickersPerAccount?: number
}

export function checkTickerPolicy(input: TickerCheckInput): Rejection | null {
  const max = input.maxTickersPerAccount ?? DISCLOSURE.maxTickersPerAccount
  const normalized = normalizeVisibleText(input.text)
  const bound = input.binding.ticker.toUpperCase()
  const cashtags = distinct(extractCashtags(normalized))

  if (cashtags.length > max) {
    return {
      stage: 'ticker_policy',
      reason: 'ticker_limit_exceeded',
      detail: `${cashtags.length} tickers on an account limited to ${max}: ${cashtags.join(', ')}`,
    }
  }

  const others = input.roster.filter((entry) => entry.ticker.toUpperCase() !== bound)

  for (const tag of cashtags) {
    if (tag === bound) continue
    const isClient = others.some((entry) => entry.ticker.toUpperCase() === tag)
    return {
      stage: 'ticker_policy',
      reason: isClient ? 'cross_promotion' : 'unbound_ticker',
      detail: `$${tag} on an account bound to $${bound}`,
    }
  }

  for (const entry of others) {
    if (mentionsBareTicker(normalized, entry.ticker)) {
      return {
        stage: 'ticker_policy',
        reason: 'cross_promotion',
        detail: `${entry.ticker.toUpperCase()} named on an account bound to $${bound}`,
      }
    }
  }

  return null
}

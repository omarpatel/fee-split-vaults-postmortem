/**
 * The grounding check.
 *
 * This is the control that makes "an absent field never produces an invented
 * answer" a property of the system rather than a hope about the model. It runs
 * on the model's finished text and asks three questions:
 *
 *   - Does every figure in this answer appear in a fact that was cited?
 *   - Does every address in it match an address the desk actually read?
 *   - Does every link in it point somewhere the desk is allowed to send people?
 *
 * Anything that fails is discarded whole. There is no repair path and no
 * partial acceptance: an answer with one unverifiable number in it is an answer
 * that taught a holder something false, and shortening it does not fix that.
 *
 * Numbers are matched against CITED facts only. Allowing a match against any
 * fact on the sheet would let a model attach the holder count to a question
 * about supply and pass.
 */

import { ADDRESS_LIKE_SOURCE, foldForDetection, normalizeAddressToken } from '@fee-split-vaults/core'
import { citeFact, lookupFact, type Citation, type FactSheet } from '../factsheet/builder.js'
import { FACT_FIELDS, type FactFieldId } from '../factsheet/fields.js'
import { extractLinks } from '../moderation/blocklist.js'

export type GroundingViolationKind =
  | 'ungrounded_number'
  | 'ungrounded_address'
  | 'ungrounded_link'
  | 'uncited_figure'
  | 'unknown_field'
  | 'stale_citation'
  | 'absent_citation'

export interface GroundingViolation {
  kind: GroundingViolationKind
  detail: string
}

export interface GroundingResult {
  ok: boolean
  violations: GroundingViolation[]
  citations: Citation[]
}

export interface GroundingOptions {
  sheet: FactSheet
  nowUnix: number
  citedFields: readonly string[]
  /** Hosts the desk may link to, beyond the explorer. */
  allowedHosts?: string[]
}

/**
 * Address detection is core's, not this file's.
 *
 * It used to be a local `/0x[a-fA-F0-9]{6,}/g` - no `i` flag - so the question
 * "does every address in this answer match one the desk actually read?" was only
 * answered for a lowercase prefix. An ungrounded `0X…` address was invisible
 * here, and the number check could not back it up: once the address matcher
 * declines to consume the token, numbersIn() splits the hex into single digits
 * and every one of 0-9 is in STRUCTURAL_NUMBERS. The desk returned the model's
 * text verbatim as a verified fact, and a Telegram reply publishes autonomously.
 */
const addressPattern = (): RegExp => new RegExp(ADDRESS_LIKE_SOURCE, 'gu')
const NUMBER_PATTERN = /\d[\d,._]*/g

/** Bare ordinals and list markers a writer needs and cannot misuse. */
const STRUCTURAL_NUMBERS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])

function canonicalNumber(raw: string): string {
  const trimmed = raw.replace(/[,_]/g, '').replace(/\.$/, '')
  if (!trimmed.includes('.')) return trimmed.replace(/^0+(?=\d)/, '')
  const [whole = '', fraction = ''] = trimmed.split('.')
  const trimmedFraction = fraction.replace(/0+$/, '')
  const trimmedWhole = whole.replace(/^0+(?=\d)/, '')
  return trimmedFraction.length > 0 ? `${trimmedWhole}.${trimmedFraction}` : trimmedWhole
}

function numbersIn(text: string): string[] {
  const out: string[] = []
  NUMBER_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = NUMBER_PATTERN.exec(text)) !== null) out.push(canonicalNumber(match[0]))
  return out
}

function hostOf(url: string): string | undefined {
  const links = extractLinks(url)
  return links[0]?.host
}

export function groundAnswer(text: string, options: GroundingOptions): GroundingResult {
  const violations: GroundingViolation[] = []
  const citations: Citation[] = []
  const { sheet, nowUnix } = options

  // 1. Resolve citations. Unknown, absent, or stale fields invalidate the answer.
  const allowedNumbers = new Set<string>(STRUCTURAL_NUMBERS)
  const allowedAddresses = new Set<string>()

  for (const field of options.citedFields) {
    if (!(FACT_FIELDS as readonly string[]).includes(field)) {
      violations.push({ kind: 'unknown_field', detail: `cited "${field}", which is not a fact id` })
      continue
    }
    const found = lookupFact(sheet, field as FactFieldId, nowUnix)
    if (found.status === 'absent') {
      violations.push({ kind: 'absent_citation', detail: `cited "${field}", which the desk has not read` })
      continue
    }
    if (found.status === 'stale') {
      violations.push({
        kind: 'stale_citation',
        detail: `cited "${field}", whose reading is ${found.ageSeconds}s old and past its limit`,
      })
      continue
    }
    citations.push(citeFact(sheet, found.fact, nowUnix))
    for (const number of numbersIn(found.fact.display)) allowedNumbers.add(number)
    for (const token of found.fact.display.match(addressPattern()) ?? []) {
      allowedAddresses.add(normalizeAddressToken(token))
    }
  }

  // The contract address is always quotable: it is the one value the desk is
  // bound to by trusted code rather than by a reading.
  const contract = lookupFact(sheet, 'contract_address', nowUnix)
  if (contract.status === 'fresh' && contract.fact.value.kind === 'address') {
    allowedAddresses.add(normalizeAddressToken(contract.fact.value.address))
  }

  // 2. Addresses. Folded first, so an answer cannot hide one in an invisible
  //    character or a fullwidth homoglyph.
  const withoutAddresses = foldForDetection(text).replace(addressPattern(), (match) => {
    if (!allowedAddresses.has(normalizeAddressToken(match))) {
      violations.push({ kind: 'ungrounded_address', detail: `address ${match} is not one the desk read` })
    }
    return ' '
  })

  // 3. Links. Only the explorer and explicitly allowed hosts.
  const allowedHosts = new Set<string>()
  const explorerHost = hostOf(sheet.explorer.addressUrl(sheet.token))
  if (explorerHost) allowedHosts.add(explorerHost)
  for (const host of options.allowedHosts ?? []) {
    const folded = hostOf(host) ?? host.toLowerCase()
    allowedHosts.add(folded)
  }

  for (const link of extractLinks(withoutAddresses)) {
    const permitted = [...allowedHosts].some(
      (allowed) => link.host === allowed || link.host.endsWith('.' + allowed),
    )
    if (!permitted) {
      violations.push({ kind: 'ungrounded_link', detail: `link to ${link.host} is not on the desk's list` })
    }
  }

  // 4. Numbers, with link and address text already removed so their digits do
  //    not have to be individually excused.
  const withoutLinks = withoutAddresses.replace(/\b(?:https?:\/\/)?\S*\.[a-z]{2,24}\S*/gi, ' ')
  const figures = numbersIn(withoutLinks)
  if (figures.length > 0 && citations.length === 0) {
    violations.push({
      kind: 'uncited_figure',
      detail: 'the answer contains figures but cites no fact',
    })
  }
  for (const figure of figures) {
    if (!allowedNumbers.has(figure)) {
      violations.push({
        kind: 'ungrounded_number',
        detail: `"${figure}" does not appear in any cited fact`,
      })
    }
  }

  return { ok: violations.length === 0, violations, citations }
}

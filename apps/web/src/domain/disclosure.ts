/**
 * The disclosure block, code-owned.
 *
 * Three regimes converge on one requirement and it is not "link to a policy
 * page": FTC Endorsement Guides and Securities Act 17(b) require the disclosure
 * IN the communication; EU AI Act Art. 50 and CA SB 1001 require the machine
 * operator to be identified in it. A receipts ledger on a separate page cures
 * none of them, so the block below is rendered inside the coin page itself and
 * is assembled from constants here rather than from any editable content.
 *
 * THE 17(b) CLAUSE. `COMPENSATION_SENTENCE` is the element that is easiest to
 * drop in a redesign because it reads as self-incriminating. It is the whole
 * point. 17(b) attaches to describing a security for consideration received
 * from an issuer without disclosing that consideration; "we are paid a
 * percentage of member trading fees and therefore profit when member trading
 * volume rises" is the disclosure of the consideration and of its direction.
 * A test asserts it survives into the rendered block verbatim.
 */

import { DISCLOSURE } from '../protocol.js'
import { formatBps } from './money.js'

/** Verbatim. Do not paraphrase, do not split, do not summarise. */
export const COMPENSATION_SENTENCE =
  'we hold no member tokens, AND we are paid a percentage of member trading fees ' +
  'and therefore profit when member trading volume rises.'

export const AI_OPERATION_SENTENCE =
  'This page and the support channels for this coin are AI-operated. A machine ' +
  'writes the answers; a human is reachable through the escalation queue.'

export interface DisclosureFacts {
  /** The operator's legal name. Never a brand, never an abbreviation. */
  operatorLegalName: string
  /** Immutable, frozen in this vault's salt. */
  operatorBps: number
  /** The dev's current dial. Changes; the operator fee does not. */
  budgetBps: number
  /** Every address the operator controls that touches this coin's money. */
  operatorAddresses: Array<{ label: string; address: string; role: string }>
  /** This coin's own vault. Non-custodial; the dev leg is pull-only. */
  vaultAddress: string
  paidPromotionInUse: boolean
}

export interface DisclosureBlock {
  headline: string
  /** Rendered as separate paragraphs, in order. All of them are required. */
  paragraphs: string[]
  tags: string[]
  addresses: Array<{ label: string; address: string; role: string }>
}

export function buildDisclosureBlock(facts: DisclosureFacts): DisclosureBlock {
  const tags: string[] = [DISCLOSURE.aiOperationTag]
  if (facts.paidPromotionInUse) tags.unshift(DISCLOSURE.paidPromotionTag)

  const paragraphs = [
    AI_OPERATION_SENTENCE,
    `The operator of record is ${facts.operatorLegalName}.`,
    // The compensation sentence is built as its own paragraph so no future
    // truncation or "read more" control can cut it off mid-clause.
    `Compensation and holdings: ${COMPENSATION_SENTENCE}`,
    `The operator fee is ${formatBps(facts.operatorBps)} of the creator fees credited to this ` +
      `coin’s vault, and is fixed for the life of this vault because it is part of the address ` +
      `the vault was deployed at. The dev’s procurement dial is currently ` +
      `${formatBps(facts.budgetBps)} and is set by the dev, not by the operator.`,
    facts.paidPromotionInUse
      ? 'Third-party promotion listed on this page was paid for. The operator buys it as ' +
        'principal at the vendor’s list price, with zero markup, and is reimbursed from the ' +
        'procurement budget. No third party is ever paid directly out of this vault.'
      : 'No paid third-party promotion has been purchased for this coin.',
    'This coin is not cross-promoted with any other member coin, and no operator account ' +
      'promotes more than one ticker.',
  ]

  return {
    headline: 'Disclosure',
    paragraphs,
    tags,
    addresses: [
      {
        label: 'This coin’s vault',
        address: facts.vaultAddress,
        role: 'Receives creator fees. Non-custodial: the dev leg is withdrawable only by the dev.',
      },
      ...facts.operatorAddresses,
    ],
  }
}

/**
 * The fixed "what we did not do" section.
 *
 * This is a product feature, not filler. Every line is a capability the
 * architecture forecloses, and each one is the negation of a thing agencies in
 * this market routinely do. It is fixed copy: it does not vary by coin, by
 * tier, or by how the week went, because a list of abstentions that moves is
 * not a commitment.
 */
export const WHAT_WE_DID_NOT_DO: readonly string[] = [
  'We did not hold, buy, sell, or receive any of this coin’s tokens. Not as payment, not as a ' +
    'bonus, not in a team wallet.',
  'We did not take custody of the dev’s money. The dev leg is withdrawable only by the dev’s own ' +
    'address, and no operator key can reach it.',
  'We did not pay any third party out of this vault. The operator buys media as principal and is ' +
    'reimbursed against a countersigned invoice.',
  'We did not operate an undisclosed account. Every account that posted about this coin is listed ' +
    'above, is labelled AI-operated, and posts about exactly one ticker.',
  'We did not promote this coin to holders of another member coin, and we did not promote another ' +
    'member coin here.',
  'We did not predict a price, recommend a purchase or a sale, or imply a future value. The desk ' +
    'refuses those questions as a class rather than answering them carefully.',
  'We did not buy engagement we could not verify. Every purchase on this page has a delivery ' +
    'predicate and a result, and a failed predicate is a withheld payment, shown as such.',
  'We did not spend against fees that had not yet arrived. Nothing here was financed on projected ' +
    'flow, on credit, or out of another coin’s budget.',
]

/**
 * Refusal classes, rendered for the public page so holders can see what the
 * desk will not answer BEFORE they ask and read the refusal as evasion.
 */
export const REFUSAL_EXPLANATIONS: Readonly<Record<string, string>> = {
  price_prediction: 'Where the price is going',
  buy_sell_advice: 'Whether to buy, sell, or hold',
  future_value_implication: 'What this will be worth later',
  user_financial_situation: 'What someone should do with their own money',
  wen_moon: 'When it moons',
  comparative_investment_merit: 'Whether this is a better buy than something else',
}

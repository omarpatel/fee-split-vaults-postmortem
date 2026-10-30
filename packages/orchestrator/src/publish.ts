/**
 * Post proposals to the publisher.
 *
 * This module is deliberately thin. Everything that decides whether a body may
 * be sent - the outbound refusal classifier, the link and address allowlist,
 * one ticker per account, the promotional rule engine, canonical disclosure
 * injection, the delegated-account bio check, and the read-back that DELETES a
 * post whose disclosure is missing - lives in the publisher, which is the
 * absolute owner of disclosure. Adding any of it here would create a second
 * copy that can drift from the one that runs.
 *
 * The one thing that happens here and nowhere else: allowlist ids become URLs.
 * The model proposed `linkRefs: ["site"]`, never a URL, and this is the moment
 * after the model is out of the loop when a real destination is attached.
 */

import type { Address, Channel, PublishResult } from '@fee-split-vaults/core'
import { AirlockViolation } from '@fee-split-vaults/core'
import type { PostProposal } from '@fee-split-vaults/runtime'
import { toPublishRequest } from '@fee-split-vaults/runtime'
import type { Publisher } from '@fee-split-vaults/publisher'

export interface PublishDeps {
  publisher: Publisher
  /** Allowlist id -> URL. Code-owned; never derived from message content. */
  links: ReadonlyMap<string, string>
  /** Which platform account this coin speaks from, per channel. */
  accounts: ReadonlyMap<Channel, string>
}

export interface PublishAttempt {
  channel: Channel
  intent: string
  result: PublishResult
}

export async function publishProposals(
  deps: PublishDeps,
  vault: Address,
  proposals: readonly PostProposal[],
  correlationPrefix: string,
): Promise<PublishAttempt[]> {
  const attempts: PublishAttempt[] = []

  for (const [index, proposal] of proposals.entries()) {
    const accountId = deps.accounts.get(proposal.channel)
    if (accountId === undefined) {
      // No bound account for this channel is not "post it anywhere else". A
      // channel we have no account on is a channel we cannot speak on.
      attempts.push({
        channel: proposal.channel,
        intent: proposal.intent,
        result: { published: false, rejectedReason: 'account_binding:no_account_for_channel' },
      })
      continue
    }

    let request
    try {
      request = toPublishRequest(proposal, vault, deps.links)
    } catch (error) {
      // An unresolvable link ref is an airlock violation, not a soft failure:
      // it means something proposed a destination that is not on the allowlist.
      attempts.push({
        channel: proposal.channel,
        intent: proposal.intent,
        result: {
          published: false,
          rejectedReason:
            error instanceof AirlockViolation
              ? `link_allowlist:${error.message}`
              : `link_allowlist:${String(error)}`,
        },
      })
      continue
    }

    const result = await deps.publisher.publish({
      request,
      accountId,
      correlationId: `${correlationPrefix}:${index}`,
    })
    attempts.push({ channel: proposal.channel, intent: proposal.intent, result })
  }

  return attempts
}

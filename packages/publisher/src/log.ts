import type { RefusalClass } from '../../../config/protocol.js'
import type { Address, Channel, RejectionStage } from './types.js'

/**
 * Every refusal is logged. A fail-closed control that refuses silently is
 * indistinguishable from a control that is not running, and the refusal rate is
 * the only evidence that the outbound classifier is doing anything at all.
 */
export type PublisherEventKind =
  | 'refusal'
  | 'disclosure_stripped'
  | 'approval_pending'
  | 'approval_rejected'
  | 'published'
  | 'read_back_verified'
  | 'read_back_failed'
  | 'read_back_delete_failed'

export interface PublisherEvent {
  kind: PublisherEventKind
  atUnix: number
  vault: Address
  channel: Channel
  accountId: string
  correlationId: string
  /** Machine-readable code. Stable across releases; asserted on in tests. */
  reason?: string
  stage?: RejectionStage
  refusalClasses?: readonly RefusalClass[]
  externalId?: string
  detail?: string
  /** sha256 of the model body. The body itself is not logged by default. */
  bodyHash?: string
  severity?: 'info' | 'warn' | 'critical'
}

export interface PublisherEventLog {
  record(event: PublisherEvent): void
  entries(): readonly PublisherEvent[]
  refusals(): readonly PublisherEvent[]
}

export function createInMemoryEventLog(): PublisherEventLog {
  const events: PublisherEvent[] = []
  return {
    record(event) {
      events.push(event)
    },
    entries() {
      return events
    },
    refusals() {
      return events.filter((event) => event.kind === 'refusal')
    },
  }
}

/**
 * Real sink. Structured single-line JSON so a refusal is greppable and a
 * critical read-back failure can be alerted on without parsing prose.
 */
export function createJsonEventLog(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  keep = 1_000,
): PublisherEventLog {
  const recent: PublisherEvent[] = []
  return {
    record(event) {
      write(JSON.stringify({ component: 'publisher', ...event }))
      recent.push(event)
      if (recent.length > keep) recent.shift()
    },
    entries() {
      return recent
    },
    refusals() {
      return recent.filter((event) => event.kind === 'refusal')
    },
  }
}

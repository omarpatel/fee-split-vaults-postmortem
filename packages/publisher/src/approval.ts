import type { Address, Channel } from './types.js'

/**
 * HUMAN APPROVE-BEFORE-PUBLISH.
 *
 * The Anthropic Media High-Risk clause may attach a qualified-review
 * requirement to published content, so every outbound PUBLIC post is gated on a
 * human decision. Inbound Telegram replies stay autonomous: they are answers to
 * a question already asked, in the coin's own group, and gating them would make
 * the desk useless without changing the risk.
 *
 * The approver sees the EXACT text that will be published - disclosure appended,
 * truncation already applied. Approving a draft that is not the final artifact
 * is not review.
 */

export interface ApprovalRequest {
  correlationId: string
  vault: Address
  channel: Channel
  accountId: string
  /** Byte-for-byte what will be sent. */
  text: string
  /** Asset ids that will be attached, already allowlisted to the account's coin. */
  imageRefs: readonly string[]
  isPromotional: boolean
  requestedAtUnix: number
}

export type ApprovalDecision =
  | { status: 'approved'; approver: string; decidedAtUnix: number }
  | { status: 'rejected'; approver: string; reason: string; decidedAtUnix: number }
  | { status: 'pending'; ticketId: string }

export interface ApprovalGate {
  request(request: ApprovalRequest): Promise<ApprovalDecision>
}

export interface HttpApprovalOptions {
  endpoint: string
  apiToken: string
  fetchImpl?: typeof fetch
  nowUnix?: () => number
}

interface ApprovalApiResponse {
  status: 'approved' | 'rejected' | 'pending'
  approver?: string
  reason?: string
  ticket_id?: string
  decided_at?: number
}

/**
 * Real gate: posts the final artifact to an operator review queue. Any
 * transport failure is a REJECTION, not a retry-and-hope - an unreachable
 * reviewer must not become an auto-approval.
 */
export function createHttpApprovalGate(options: HttpApprovalOptions): ApprovalGate {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const now = options.nowUnix ?? (() => Math.floor(Date.now() / 1000))

  return {
    async request(request) {
      let response: Response
      try {
        response = await doFetch(options.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            correlation_id: request.correlationId,
            vault: request.vault,
            channel: request.channel,
            account_id: request.accountId,
            text: request.text,
            image_refs: request.imageRefs,
            is_promotional: request.isPromotional,
            requested_at: request.requestedAtUnix,
          }),
        })
      } catch {
        return {
          status: 'rejected',
          approver: 'system',
          reason: 'approval_service_unreachable',
          decidedAtUnix: now(),
        }
      }
      if (!response.ok) {
        return {
          status: 'rejected',
          approver: 'system',
          reason: `approval_service_status_${response.status}`,
          decidedAtUnix: now(),
        }
      }
      const body = (await response.json().catch(() => null)) as ApprovalApiResponse | null
      if (body === null) {
        return {
          status: 'rejected',
          approver: 'system',
          reason: 'approval_service_unparseable',
          decidedAtUnix: now(),
        }
      }
      if (body.status === 'approved') {
        return {
          status: 'approved',
          approver: body.approver ?? 'unknown',
          decidedAtUnix: body.decided_at ?? now(),
        }
      }
      if (body.status === 'rejected') {
        return {
          status: 'rejected',
          approver: body.approver ?? 'unknown',
          reason: body.reason ?? 'rejected_by_reviewer',
          decidedAtUnix: body.decided_at ?? now(),
        }
      }
      return { status: 'pending', ticketId: body.ticket_id ?? request.correlationId }
    },
  }
}

export interface ManualApprovalGate extends ApprovalGate {
  /** Tickets awaiting a decision, oldest first. */
  pending(): Array<{ ticketId: string; request: ApprovalRequest }>
  approve(ticketId: string, approver?: string): void
  reject(ticketId: string, reason: string, approver?: string): void
}

/**
 * Fake gate with a real queue: the first attempt parks a ticket, a decision is
 * recorded out of band, and a re-submission of the same correlation id carries
 * the decision. That is the shape of the production flow.
 */
export function createManualApprovalGate(nowUnix: () => number = () => Math.floor(Date.now() / 1000)): ManualApprovalGate {
  const tickets = new Map<string, ApprovalRequest>()
  const decisions = new Map<string, ApprovalDecision>()

  return {
    pending() {
      return [...tickets.entries()]
        .filter(([id]) => !decisions.has(id))
        .map(([ticketId, request]) => ({ ticketId, request }))
    },
    approve(ticketId, approver = 'reviewer') {
      decisions.set(ticketId, { status: 'approved', approver, decidedAtUnix: nowUnix() })
    },
    reject(ticketId, reason, approver = 'reviewer') {
      decisions.set(ticketId, { status: 'rejected', approver, reason, decidedAtUnix: nowUnix() })
    },
    async request(request) {
      const ticketId = request.correlationId
      const decided = decisions.get(ticketId)
      if (decided !== undefined) return decided
      tickets.set(ticketId, request)
      return { status: 'pending', ticketId }
    },
  }
}

/** Test double for the approved path. Never wire this into a real deployment. */
export function createAutoApprovalGate(
  approver = 'test-reviewer',
  nowUnix: () => number = () => Math.floor(Date.now() / 1000),
): ApprovalGate {
  return {
    async request() {
      return { status: 'approved', approver, decidedAtUnix: nowUnix() }
    },
  }
}

export function createDenyAllApprovalGate(
  reason = 'denied',
  nowUnix: () => number = () => Math.floor(Date.now() / 1000),
): ApprovalGate {
  return {
    async request() {
      return { status: 'rejected', approver: 'test-reviewer', reason, decidedAtUnix: nowUnix() }
    },
  }
}

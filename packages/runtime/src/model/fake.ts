import { estimateTokens } from '../corpus/sanitize.js'
import { ZERO_USAGE } from './client.js'
import type {
  BatchItem,
  BatchOutcome,
  ModelClient,
  ModelContentBlock,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
  ModelUsage,
} from './client.js'

/**
 * Scripted in-memory ModelClient.
 *
 * Usage is derived from the real request text rather than hardcoded, so a test
 * that asserts "a 500,000 message flood costs the same as a 500 message window"
 * is asserting something about the assembler and not about a stubbed number.
 */

export interface ScriptedReply {
  /** Optional predicate; the first matching unused entry wins. */
  when?: (request: ModelRequest) => boolean
  content: ModelContentBlock[]
  stopReason?: ModelStopReason
  /** Overrides the derived usage when a test needs an exact figure. */
  usage?: Partial<ModelUsage>
  /** Thrown instead of returning, to exercise fail-closed paths. */
  throws?: Error
}

export type ScriptedResponder = (request: ModelRequest) => ScriptedReply

export function textReply(text: string, stopReason: ModelStopReason = 'end_turn'): ScriptedReply {
  return { content: [{ type: 'text', text }], stopReason }
}

export function toolUseReply(
  calls: Array<{ name: string; input: unknown; id?: string }>,
): ScriptedReply {
  return {
    content: calls.map((c, i) => ({
      type: 'tool_use' as const,
      id: c.id ?? `toolu_fake_${String(i)}`,
      name: c.name,
      input: c.input,
    })),
    stopReason: 'tool_use',
  }
}

export class FakeModelClient implements ModelClient {
  readonly calls: ModelRequest[] = []
  readonly batchCalls: BatchItem[][] = []
  private readonly queue: ScriptedReply[]
  private readonly responder: ScriptedResponder | undefined

  constructor(script: ScriptedReply[] | ScriptedResponder) {
    if (typeof script === 'function') {
      this.responder = script
      this.queue = []
    } else {
      this.responder = undefined
      this.queue = [...script]
    }
  }

  /** Every request this client has seen, for airlock assertions in tests. */
  get lastRequest(): ModelRequest | undefined {
    return this.calls[this.calls.length - 1]
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request)
    const reply = this.next(request)
    if (reply.throws !== undefined) throw reply.throws
    return this.materialise(request, reply, false)
  }

  async completeBatch(items: BatchItem[]): Promise<Map<string, BatchOutcome>> {
    this.batchCalls.push([...items])
    const out = new Map<string, BatchOutcome>()
    for (const item of items) {
      this.calls.push(item.request)
      const reply = this.next(item.request)
      if (reply.throws !== undefined) {
        out.set(item.customId, { status: 'failed', reason: reply.throws.message })
        continue
      }
      out.set(item.customId, {
        status: 'succeeded',
        response: this.materialise(item.request, reply, true),
      })
    }
    return out
  }

  private next(request: ModelRequest): ScriptedReply {
    if (this.responder !== undefined) return this.responder(request)
    const index = this.queue.findIndex((r) => r.when === undefined || r.when(request))
    if (index === -1) {
      throw new Error(
        `FakeModelClient: no scripted reply left for a ${request.model} call (${this.calls.length} calls made)`,
      )
    }
    const [reply] = this.queue.splice(index, 1)
    if (reply === undefined) throw new Error('FakeModelClient: queue corruption')
    return reply
  }

  private materialise(
    request: ModelRequest,
    reply: ScriptedReply,
    batched: boolean,
  ): ModelResponse {
    const systemText = request.system.map((b) => b.text).join('\n')
    const outputText = reply.content
      .map((b) => (b.type === 'text' ? b.text : JSON.stringify(b.input)))
      .join('\n')
    const derived: ModelUsage = {
      ...ZERO_USAGE,
      inputTokens: estimateTokens(systemText) + estimateTokens(request.userText),
      outputTokens: estimateTokens(outputText),
    }
    return {
      model: request.model,
      stopReason: reply.stopReason ?? 'end_turn',
      content: reply.content,
      usage: { ...derived, ...reply.usage },
      batched,
    }
  }
}

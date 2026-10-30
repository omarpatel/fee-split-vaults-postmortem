/**
 * The Messages API over plain fetch, in the shape createAnthropicAdjudicator
 * takes. This package deliberately carries no SDK dependency; the adjudicator
 * sends one fixed request shape (system, one user turn, one forced tool) and
 * reads one field back, so a hand-rolled transport is smaller than the SDK's
 * surface and every byte that leaves the process is visible here.
 */

import type {
  AnthropicContentBlock,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicMessagesPort,
} from './stage3.js'

export interface AnthropicMessagesPortOptions {
  apiKey: string
  fetch?: typeof fetch
  /** Defaults to the public API origin. */
  baseUrl?: string
  timeoutMs?: number
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const ANTHROPIC_VERSION = '2023-06-01'

export class AnthropicTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(`anthropic messages: ${message}`)
    this.name = 'AnthropicTransportError'
  }
}

export function createAnthropicMessagesPort(options: AnthropicMessagesPortOptions): AnthropicMessagesPort {
  const apiKey = options.apiKey.trim()
  if (apiKey.length === 0) throw new AnthropicTransportError('apiKey is empty', undefined)
  const fetchImpl = options.fetch ?? fetch
  const url = new URL('/v1/messages', options.baseUrl ?? DEFAULT_BASE_URL).toString()
  const timeoutMs = options.timeoutMs ?? 30_000

  return {
    async create(body: AnthropicMessageRequest): Promise<AnthropicMessageResponse> {
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        throw new AnthropicTransportError(error instanceof Error ? error.message : String(error), undefined)
      }
      if (!response.ok) {
        // The body of an error response is never echoed: it is the vendor's
        // text, and the adjudicator's caller fails closed on the status alone.
        throw new AnthropicTransportError(`HTTP ${response.status}`, response.status)
      }
      let parsed: unknown
      try {
        parsed = await response.json()
      } catch {
        throw new AnthropicTransportError('response is not JSON', response.status)
      }
      if (typeof parsed !== 'object' || parsed === null || !('content' in parsed) || !Array.isArray(parsed.content)) {
        throw new AnthropicTransportError('response carries no content array', response.status)
      }
      const content = parsed.content.map((block: unknown): AnthropicContentBlock => {
        if (typeof block !== 'object' || block === null || !('type' in block) || typeof block.type !== 'string') {
          throw new AnthropicTransportError('content block without a type', response.status)
        }
        const out: AnthropicContentBlock = { type: block.type }
        if ('name' in block && typeof block.name === 'string') out.name = block.name
        if ('input' in block && block.input !== undefined) out.input = block.input
        return out
      })
      const out: AnthropicMessageResponse = { content }
      if ('stop_reason' in parsed && (typeof parsed.stop_reason === 'string' || parsed.stop_reason === null)) {
        out.stop_reason = parsed.stop_reason
      }
      return out
    },
  }
}

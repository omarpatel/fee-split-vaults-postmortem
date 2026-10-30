import type AnthropicSdk from '@anthropic-ai/sdk'
import { MODEL_CONTEXT_TOKENS, supportsAdaptiveThinking, supportsEffort } from './ids.js'
import type { ModelId } from './ids.js'
import { ModelCallFailed, ModelRefused, ModelTruncated } from './client.js'
import type {
  BatchItem,
  BatchOutcome,
  ModelClient,
  ModelContentBlock,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
} from './client.js'

/**
 * The real transport. Everything security-relevant about this file is what it
 * does NOT send:
 *
 *   - no server tools (no web_search, no web_fetch, no code_execution)
 *   - no container, no files, no MCP servers
 *   - no assistant turns, so no tool_result can ever be fed back
 *
 * A request built here is one system prompt, one user turn, and an optional list
 * of proposal tools. There is no loop, so a tool_use block is a record, not an
 * action.
 */

export interface AnthropicModelClientOptions {
  /** Omit to let the SDK resolve ANTHROPIC_API_KEY or an `ant auth login` profile. */
  apiKey?: string
  maxRetries?: number
  timeoutMs?: number
  batchPollIntervalMs?: number
  /** Hard stop for a batch. Batches usually finish within an hour, max 24h. */
  batchDeadlineMs?: number
  /** Injected in tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULTS = {
  maxRetries: 2,
  timeoutMs: 120_000,
  batchPollIntervalMs: 30_000,
  batchDeadlineMs: 6 * 60 * 60 * 1_000,
} as const

class RequestShapeError extends Error {
  constructor(message: string) {
    super(`refusing to send a malformed request: ${message}`)
    this.name = 'RequestShapeError'
  }
}

/**
 * Build the wire params. Exported for tests: the adversarial suite asserts that
 * a reader request carries no `tools` key at all, and that effort and adaptive
 * thinking are never sent to a model that rejects them.
 */
export function toCreateParams(
  request: ModelRequest,
): AnthropicSdk.Messages.MessageCreateParamsNonStreaming {
  if (request.system.length === 0) throw new RequestShapeError('empty system prompt')
  if (request.userText.length === 0) throw new RequestShapeError('empty user turn')
  if (request.userIdHash.length === 0) {
    throw new RequestShapeError('missing hashed user id; every call must be attributable')
  }
  if (request.maxTokens <= 0) throw new RequestShapeError('maxTokens must be positive')

  const breakpointIndex = lastCacheBreakpoint(request)
  const system: AnthropicSdk.Messages.TextBlockParam[] = request.system.map((block, i) => {
    const out: AnthropicSdk.Messages.TextBlockParam = { type: 'text', text: block.text }
    if (i === breakpointIndex) out.cache_control = { type: 'ephemeral' }
    return out
  })

  const params: AnthropicSdk.Messages.MessageCreateParamsNonStreaming = {
    model: request.model,
    max_tokens: request.maxTokens,
    system,
    messages: [{ role: 'user', content: request.userText }],
    metadata: { user_id: request.userIdHash },
  }

  if (request.tools !== undefined && request.tools.length > 0) {
    params.tools = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object' as const,
        properties: t.inputSchema.properties,
        required: t.inputSchema.required,
        additionalProperties: false,
      },
      // Guarantees the arguments validate against the schema, which is what makes
      // "the planner cannot name a payee" a property of the wire and not a hope.
      strict: true,
    }))
    params.tool_choice = { type: request.toolChoice ?? 'auto' }
  } else if (request.toolChoice !== undefined && request.toolChoice !== 'none') {
    throw new RequestShapeError(`toolChoice=${request.toolChoice} with no tools`)
  }

  if (request.effort !== undefined) {
    if (!supportsEffort(request.model)) {
      throw new RequestShapeError(`output_config.effort is rejected by ${request.model}`)
    }
    params.output_config = { effort: request.effort }
  }

  if (request.thinking === 'adaptive') {
    if (!supportsAdaptiveThinking(request.model)) {
      throw new RequestShapeError(`adaptive thinking is not available on ${request.model}`)
    }
    params.thinking = { type: 'adaptive', display: 'omitted' }
  } else if (request.thinking === 'off' && supportsAdaptiveThinking(request.model)) {
    // Omitting `thinking` on Sonnet 5 runs adaptive thinking and bills for it.
    // Turning it off has to be explicit. On Haiku 4.5 the default really is off,
    // and the disabled form is not part of that model's surface, so send nothing.
    params.thinking = { type: 'disabled' }
  }

  return params
}

function lastCacheBreakpoint(request: ModelRequest): number {
  for (let i = request.system.length - 1; i >= 0; i -= 1) {
    if (request.system[i]?.cacheBreakpoint === true) return i
  }
  return -1
}

function toStopReason(raw: string | null): ModelStopReason {
  switch (raw) {
    case 'end_turn':
    case 'max_tokens':
    case 'stop_sequence':
    case 'tool_use':
    case 'pause_turn':
    case 'refusal':
      return raw
    default:
      return 'unknown'
  }
}

/**
 * Map a wire message onto the narrow response type, dropping every block kind
 * this runtime has no business acting on (thinking, server tool results,
 * documents). Fail closed on refusal and on truncation: a half-written digest
 * parses as a valid digest with the wrong numbers in it.
 */
export function fromMessage(model: ModelId, message: AnthropicSdk.Messages.Message, batched: boolean): ModelResponse {
  const stopReason = toStopReason(message.stop_reason)
  if (stopReason === 'refusal') {
    const details = message.stop_details
    throw new ModelRefused(details !== null && details !== undefined ? details.category : null)
  }

  const content: ModelContentBlock[] = []
  for (const block of message.content) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'tool_use') {
      content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
    }
  }

  return {
    model,
    stopReason,
    content,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    },
    batched,
  }
}

function assertFits(request: ModelRequest, estimatedInputTokens: number): void {
  const ceiling = MODEL_CONTEXT_TOKENS[request.model]
  if (estimatedInputTokens + request.maxTokens > ceiling) {
    throw new RequestShapeError(
      `request would exceed the ${String(ceiling)} token window for ${request.model}`,
    )
  }
}

/**
 * Construct the live client. The SDK is imported dynamically so that importing
 * this package in a test process does not require the dependency to be present
 * or an API key to be configured.
 */
export async function createAnthropicModelClient(
  options: AnthropicModelClientOptions = {},
): Promise<ModelClient> {
  const mod = await import('@anthropic-ai/sdk')
  const Anthropic = mod.default
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const client = new Anthropic({
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
    timeout: options.timeoutMs ?? DEFAULTS.timeoutMs,
  })

  const pollMs = options.batchPollIntervalMs ?? DEFAULTS.batchPollIntervalMs
  const deadlineMs = options.batchDeadlineMs ?? DEFAULTS.batchDeadlineMs

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const params = toCreateParams(request)
      assertFits(request, roughInputTokens(params))
      let message: AnthropicSdk.Messages.Message
      try {
        message = await client.messages.create(params)
      } catch (error: unknown) {
        throw translate(Anthropic, error)
      }
      const response = fromMessage(request.model, message, false)
      if (response.stopReason === 'max_tokens') throw new ModelTruncated(request.maxTokens)
      return response
    },

    async completeBatch(items: BatchItem[]): Promise<Map<string, BatchOutcome>> {
      const out = new Map<string, BatchOutcome>()
      if (items.length === 0) return out

      const byCustomId = new Map<string, ModelRequest>()
      const requests = items.map((item) => {
        if (byCustomId.has(item.customId)) {
          throw new RequestShapeError(`duplicate custom_id ${item.customId}`)
        }
        byCustomId.set(item.customId, item.request)
        return { custom_id: item.customId, params: toCreateParams(item.request) }
      })

      let batch: AnthropicSdk.Messages.Batches.MessageBatch
      try {
        batch = await client.messages.batches.create({ requests })
      } catch (error: unknown) {
        throw translate(Anthropic, error)
      }

      const startedAt = Date.now()
      while (batch.processing_status !== 'ended') {
        if (Date.now() - startedAt > deadlineMs) {
          throw new ModelCallFailed(`batch ${batch.id} did not finish before the deadline`)
        }
        await sleep(pollMs)
        try {
          batch = await client.messages.batches.retrieve(batch.id)
        } catch (error: unknown) {
          throw translate(Anthropic, error)
        }
      }

      for await (const entry of await client.messages.batches.results(batch.id)) {
        const request = byCustomId.get(entry.custom_id)
        if (request === undefined) continue
        switch (entry.result.type) {
          case 'succeeded': {
            try {
              const response = fromMessage(request.model, entry.result.message, true)
              if (response.stopReason === 'max_tokens') {
                out.set(entry.custom_id, { status: 'failed', reason: 'output truncated' })
              } else {
                out.set(entry.custom_id, { status: 'succeeded', response })
              }
            } catch (error: unknown) {
              out.set(entry.custom_id, { status: 'failed', reason: describe(error) })
            }
            break
          }
          case 'errored':
            out.set(entry.custom_id, {
              status: 'failed',
              reason: `errored: ${entry.result.error.error.type}`,
            })
            break
          default:
            out.set(entry.custom_id, { status: 'failed', reason: entry.result.type })
        }
      }

      // Anything the API never reported on is a failure, not a silent skip.
      for (const item of items) {
        if (!out.has(item.customId)) {
          out.set(item.customId, { status: 'failed', reason: 'no result returned' })
        }
      }
      return out
    },
  }
}

function roughInputTokens(params: AnthropicSdk.Messages.MessageCreateParamsNonStreaming): number {
  const system = Array.isArray(params.system)
    ? params.system.map((b) => b.text).join('')
    : (params.system ?? '')
  const user = params.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('')
  return Math.ceil((system.length + user.length) / 3)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Typed SDK errors, most specific first. A rate limit and a bad request are not
 * the same failure and must not collapse into one retry policy.
 */
function translate(ctor: typeof AnthropicSdk, error: unknown): Error {
  if (error instanceof ctor.BadRequestError) {
    return new ModelCallFailed(`bad request: ${error.message}`, error)
  }
  if (error instanceof ctor.AuthenticationError) {
    return new ModelCallFailed('authentication failed', error)
  }
  if (error instanceof ctor.RateLimitError) {
    return new ModelCallFailed('rate limited', error)
  }
  if (error instanceof ctor.APIConnectionError) {
    return new ModelCallFailed('connection failed', error)
  }
  if (error instanceof ctor.APIError) {
    return new ModelCallFailed(`api error ${String(error.status)}: ${error.message}`, error)
  }
  return new ModelCallFailed(describe(error), error)
}

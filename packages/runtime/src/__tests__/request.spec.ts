import { describe, expect, it } from 'vitest'
import { toCreateParams, fromMessage } from '../model/anthropic.js'
import { MODEL } from '../model/ids.js'
import { ModelRefused } from '../model/client.js'
import type { ModelRequest } from '../model/client.js'
import { batchRouted } from '../model/routing.js'
import { FakeModelClient, textReply } from '../model/fake.js'
import { hashUserId } from '../isolation/userId.js'
import { COIN, SALT } from './helpers.js'

const userIdHash = hashUserId(SALT, COIN)

function base(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: MODEL.haiku45,
    system: [{ text: 'frozen system prompt', cacheBreakpoint: true }],
    userText: 'the turn',
    maxTokens: 512,
    userIdHash,
    ...overrides,
  }
}

describe('wire request shaping', () => {
  it('sends the hashed user id on every call', () => {
    expect(toCreateParams(base()).metadata).toEqual({ user_id: userIdHash })
  })

  it('places the cache breakpoint on the frozen prefix and nowhere else', () => {
    const params = toCreateParams(
      base({
        system: [
          { text: 'frozen', cacheBreakpoint: true },
          { text: 'also stable' },
        ],
      }),
    )
    const system = params.system as Array<{ text: string; cache_control?: unknown }>
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(system[1]?.cache_control).toBeUndefined()
  })

  it('omits tools entirely when none are declared', () => {
    const params = toCreateParams(base())
    expect(params.tools).toBeUndefined()
    expect(params.tool_choice).toBeUndefined()
  })

  it('marks every declared tool strict', () => {
    const params = toCreateParams(
      base({
        model: MODEL.sonnet5,
        toolChoice: 'any',
        tools: [
          {
            name: 'propose_no_action',
            description: 'do nothing',
            inputSchema: {
              type: 'object',
              properties: { reason: { type: 'string' } },
              required: ['reason'],
              additionalProperties: false,
            },
          },
        ],
      }),
    )
    expect(params.tool_choice).toEqual({ type: 'any' })
    const tools = params.tools as Array<{ strict?: boolean; input_schema: { additionalProperties?: unknown } }>
    expect(tools[0]?.strict).toBe(true)
    expect(tools[0]?.input_schema.additionalProperties).toBe(false)
  })

  it('never sends output_config.effort to a model that rejects it', () => {
    expect(() => toCreateParams(base({ effort: 'low' }))).toThrow(/effort is rejected/u)
    expect(toCreateParams(base({ model: MODEL.sonnet5, effort: 'low' })).output_config).toEqual({
      effort: 'low',
    })
  })

  it('never sends adaptive thinking to a model that does not have it', () => {
    expect(() => toCreateParams(base({ thinking: 'adaptive' }))).toThrow(/adaptive thinking/u)
    expect(toCreateParams(base({ model: MODEL.sonnet5, thinking: 'adaptive' })).thinking).toEqual({
      type: 'adaptive',
      display: 'omitted',
    })
  })

  it('turns thinking off explicitly where omitting it would leave it on', () => {
    // Omitting `thinking` on Sonnet 5 runs adaptive thinking and bills for it.
    expect(toCreateParams(base({ model: MODEL.sonnet5, thinking: 'off' })).thinking).toEqual({
      type: 'disabled',
    })
    // On Haiku 4.5 the default is already off and the disabled form is not part
    // of that model's surface.
    expect(toCreateParams(base({ thinking: 'off' })).thinking).toBeUndefined()
  })

  it('refuses a request with no user id, no system prompt, or no turn', () => {
    expect(() => toCreateParams(base({ userIdHash: '' }))).toThrow(/hashed user id/u)
    expect(() => toCreateParams(base({ system: [] }))).toThrow(/empty system prompt/u)
    expect(() => toCreateParams(base({ userText: '' }))).toThrow(/empty user turn/u)
  })

  it('carries no server tools, container, or files', () => {
    const params = toCreateParams(base()) as unknown as Record<string, unknown>
    for (const forbidden of ['container', 'mcp_servers', 'context_management', 'fallbacks']) {
      expect(params[forbidden]).toBeUndefined()
    }
    expect(params.messages).toHaveLength(1)
  })
})

describe('response mapping fails closed', () => {
  const message = (over: Record<string, unknown>): Parameters<typeof fromMessage>[1] =>
    ({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: MODEL.haiku45,
      content: [{ type: 'text', text: 'hi', citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        cache_creation: null,
        inference_geo: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
      },
      ...over,
    }) as Parameters<typeof fromMessage>[1]

  it('throws on a refusal rather than returning empty content', () => {
    expect(() =>
      fromMessage(
        MODEL.haiku45,
        message({
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: null },
          content: [],
        }),
        false,
      ),
    ).toThrow(ModelRefused)
  })

  it('drops block kinds this runtime has no business acting on', () => {
    const mapped = fromMessage(
      MODEL.haiku45,
      message({
        content: [
          { type: 'thinking', thinking: 'secret', signature: 'sig' },
          { type: 'text', text: 'kept', citations: null },
        ],
      }),
      false,
    )
    expect(mapped.content).toEqual([{ type: 'text', text: 'kept' }])
  })

  it('normalises usage, treating absent cache counters as zero', () => {
    const mapped = fromMessage(MODEL.haiku45, message({}), true)
    expect(mapped.usage).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    })
    expect(mapped.batched).toBe(true)
  })
})

describe('batch routing', () => {
  it('routes a single call through the batch path and marks it batched', async () => {
    const client = new FakeModelClient(() => textReply('{"a":1}'))
    const routed = batchRouted(client, 'w1:planner')
    const response = await routed.complete(base())
    expect(response.batched).toBe(true)
    expect(client.batchCalls[0]?.[0]?.customId).toBe('w1:planner')
  })

  it('fails closed when the batch returns nothing for the request', async () => {
    const client = new FakeModelClient(() => ({
      content: [],
      throws: new Error('provider said no'),
    }))
    await expect(batchRouted(client).complete(base())).rejects.toThrow(/batch failed/u)
  })
})

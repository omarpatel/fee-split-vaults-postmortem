import type { ModelId } from './ids.js'

/**
 * The narrow port every cognition-plane call goes through.
 *
 * Deliberately not a wrapper over the whole Messages API. The runtime makes
 * exactly one shape of call: a frozen system prompt, one user turn, an optional
 * closed set of proposal tools, and nothing else. Streaming, multi-turn history,
 * server tools, files, and containers are all absent because none of them has a
 * use in a plane that must not fetch, post, or execute anything.
 */

export interface ModelTextBlock {
  type: 'text'
  text: string
}

/**
 * A tool_use block is a PROPOSAL record. This runtime never executes one and
 * never returns a tool_result, so no agentic loop exists to hijack.
 */
export interface ModelToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export type ModelContentBlock = ModelTextBlock | ModelToolUseBlock

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export const ZERO_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
}

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  }
}

/** JSON Schema subset the proposal tools are allowed to use. */
export interface JsonSchemaProperty {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array'
  description?: string
  enum?: readonly (string | number)[]
  items?: JsonSchemaProperty
  maxLength?: number
  minimum?: number
  maximum?: number
  maxItems?: number
}

export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, JsonSchemaProperty>
  required: string[]
  additionalProperties: false
}

export interface ModelToolSpec {
  name: string
  description: string
  inputSchema: JsonSchemaObject
}

export type ModelToolChoice = 'auto' | 'any' | 'none'

/** Cacheable blocks come first; the volatile turn is always the user message. */
export interface SystemBlock {
  text: string
  /** Marks the end of the stable prefix. At most one block should set this. */
  cacheBreakpoint?: boolean
}

export interface ModelRequest {
  model: ModelId
  system: SystemBlock[]
  /** The single user turn. Untrusted corpus text, or a validated digest. */
  userText: string
  maxTokens: number
  /**
   * Absent for the reader and the desk. READER_TOOLS is empty and this runtime
   * asserts that at construction; see Reader.
   */
  tools?: ModelToolSpec[]
  toolChoice?: ModelToolChoice
  /**
   * Hashed per-client identifier for metadata.user_id. Never a handle, an
   * address, or anything else that could identify a person.
   */
  userIdHash: string
  effort?: 'low' | 'medium' | 'high'
  thinking?: 'off' | 'adaptive'
  /** Correlation id for audit. Not sent to the API. */
  traceId?: string
}

export type ModelStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'unknown'

export interface ModelResponse {
  model: ModelId
  stopReason: ModelStopReason
  content: ModelContentBlock[]
  usage: ModelUsage
  /** True when the call was billed at the Batch API rate. */
  batched: boolean
}

export interface BatchItem {
  customId: string
  request: ModelRequest
}

export type BatchOutcome =
  | { status: 'succeeded'; response: ModelResponse }
  | { status: 'failed'; reason: string }

export interface ModelClient {
  /** Synchronous, latency-sensitive path. */
  complete(request: ModelRequest): Promise<ModelResponse>
  /**
   * Non-urgent path, billed at half rate. Results are keyed by customId because
   * the API returns them in arbitrary order; never key by position.
   */
  completeBatch(items: BatchItem[]): Promise<Map<string, BatchOutcome>>
}

// ---------------------------------------------------------------------------
// Failure modes. Every one of these is fail-closed at the call site.
// ---------------------------------------------------------------------------

export class ModelCallFailed extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ModelCallFailed'
  }
}

/** stop_reason "refusal". The turn produced no usable content; do not retry blind. */
export class ModelRefused extends ModelCallFailed {
  constructor(readonly category: string | null) {
    super(`model refused the request (category=${category ?? 'null'})`)
    this.name = 'ModelRefused'
  }
}

/** stop_reason "max_tokens". A truncated digest or proposal is not a valid one. */
export class ModelTruncated extends ModelCallFailed {
  constructor(readonly maxTokens: number) {
    super(`model output hit max_tokens=${maxTokens}; output is truncated and unusable`)
    this.name = 'ModelTruncated'
  }
}

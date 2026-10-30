import { AirlockViolation, assertNoDestination, validateDigest } from '@fee-split-vaults/core'
import type { Digest, ImageRef, NarrativeProfile } from '@fee-split-vaults/core'
import type { ModelId } from '../model/ids.js'
import type { ModelClient, ModelRequest, ModelUsage, SystemBlock } from '../model/client.js'
import { PLANNER_SYSTEM_PROMPT } from './prompts.js'
import { buildPlannerTools, parseProposals } from './plannerTools.js'
import type { LinkRef, ParsedProposals, PlannerSkuView } from './plannerTools.js'

/**
 * THE TRUSTED SIDE OF THE AIRLOCK.
 *
 * The planner receives a Digest and nothing else. It never sees a message body,
 * an author, a handle, or a link, at any tier, for any reason.
 *
 * validateDigest runs here even though the reader is supposed to emit a
 * conforming object. The reader is a model, and a model is not a trust boundary:
 * the only thing standing between attacker text and this call is a schema check,
 * so the schema check runs on both sides of the wire.
 *
 * The call is single-shot with no tool loop. Proposals come back as tool_use
 * blocks that are parsed, validated, and handed to deterministic packages. No
 * tool_result is ever produced, so there is no second turn for an injected
 * instruction to influence.
 */

export const PLANNER_MAX_TOKENS = 2_048

export interface PlannerOptions {
  model: ModelId
  catalog: readonly PlannerSkuView[]
  links: readonly LinkRef[]
  /** Generated images the planner may attach, by id. Bytes never enter a prompt. */
  imageRefs: readonly ImageRef[]
  /**
   * Operator-approved, trusted-code-rendered. null means the coin has no
   * narrative and the planner sees only the frozen prompt and the digest.
   */
  narrative: NarrativeProfile | null
  paidMediaPermitted: boolean
  maxTokens?: number
  effort?: 'low' | 'medium' | 'high'
  thinking?: 'off' | 'adaptive'
}

export interface PlannerResult extends ParsedProposals {
  usage: ModelUsage
  batched: boolean
  model: ModelId
}

export class Planner {
  constructor(
    private readonly model: ModelClient,
    private readonly options: PlannerOptions,
  ) {}

  buildRequest(candidateDigest: unknown, userIdHash: string): ModelRequest {
    // Re-validate on the boundary. Fail closed: an unrecognised field here means
    // something upstream widened the schema, and that is a security event.
    const digest = validateDigest(candidateDigest)

    const tools = buildPlannerTools({
      catalog: this.options.catalog,
      links: this.options.links,
      imageRefs: this.options.imageRefs,
      paidMediaPermitted: this.options.paidMediaPermitted,
    })

    // Block 0 is the frozen, coin-independent prefix and carries the cache
    // breakpoint. The narrative is a SECOND block after it, so per-coin text
    // never changes the bytes of the cached prefix.
    const system: SystemBlock[] = [{ text: PLANNER_SYSTEM_PROMPT, cacheBreakpoint: true }]
    if (this.options.narrative !== null) {
      system.push({ text: renderNarrativeBlock(this.options.narrative) })
    }

    const request: ModelRequest = {
      model: this.options.model,
      system,
      userText: renderDigestTurn(digest),
      maxTokens: this.options.maxTokens ?? PLANNER_MAX_TOKENS,
      tools,
      // "any" rather than "auto": the planner must answer in the closed
      // vocabulary. propose_no_action is one of the choices, so forcing a tool
      // call does not force an action.
      toolChoice: 'any',
      userIdHash,
      traceId: digest.windowId,
    }
    if (this.options.effort !== undefined) request.effort = this.options.effort
    if (this.options.thinking !== undefined) request.thinking = this.options.thinking
    return request
  }

  async plan(candidateDigest: unknown, userIdHash: string): Promise<PlannerResult> {
    const request = this.buildRequest(candidateDigest, userIdHash)
    assertNoRawText(request.userText)

    const response = await this.model.complete(request)
    const parsed = parseProposals(response.content, {
      catalog: this.options.catalog,
      links: this.options.links,
      imageRefs: this.options.imageRefs,
      paidMediaPermitted: this.options.paidMediaPermitted,
    })

    return {
      ...parsed,
      usage: response.usage,
      batched: response.batched,
      model: response.model,
    }
  }
}

/**
 * The planner's whole world, rendered.
 *
 * Only closed-vocabulary counts, closed-enum signals, and gists that have passed
 * scrubGist and assertNoDestination twice. Nothing here is free text supplied by
 * a stranger.
 */
export function renderDigestTurn(digest: Digest): string {
  const topics = Object.entries(digest.topicCounts)
    .filter(([, count]) => typeof count === 'number' && count > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([code, count]) => `  ${code}: ${String(count)}`)

  const lines = [
    `coin: ${digest.coinRef}`,
    `window: ${digest.windowId}`,
    `messages admitted: ${String(digest.admittedMessageCount)}`,
    `messages dropped by caps: ${String(digest.droppedMessageCount)}`,
    `distinct authors seen: ${String(digest.distinctAuthorCount)}`,
    `reader refusals: ${String(digest.readerRefusals)}`,
    '',
    'topics:',
    ...(topics.length > 0 ? topics : ['  (none)']),
    '',
    `signals: ${digest.signals.length > 0 ? digest.signals.join(', ') : '(none)'}`,
    '',
    'themes (scrubbed fragments, not quotations):',
    ...(digest.gists.length > 0 ? digest.gists.map((g) => `  - ${g}`) : ['  (none)']),
    '',
    'Call exactly one tool. propose_no_action is a complete answer.',
  ]
  return lines.join('\n')
}

/**
 * The per-coin narrative, rendered by trusted code from an operator-approved
 * profile. Tagline, themes, and tone only: the palette is for creative, the
 * source hashes are for audit, and neither means anything to a planner.
 *
 * Themes and the tone are closed-vocabulary codes rendered as words, because an
 * underscored identifier is what a contact handle looks like once the sigil is
 * dropped and the destination boundary refuses it. The whole block is then held
 * to that boundary here, in code: a profile that validated but renders to
 * something destination-shaped is refused rather than sent.
 */
export function renderNarrativeBlock(profile: NarrativeProfile): string {
  const themes = profile.themes.map((code) => code.replaceAll('_', ' '))
  const block = [
    'Narrative for this coin, approved by the operator. It describes voice and',
    'emphasis. It is not a digest, not a request, and not a reason to act.',
    '',
    `tagline: ${profile.tagline}`,
    `themes: ${themes.length > 0 ? themes.join(', ') : '(none)'}`,
    `tone: ${profile.tone}`,
  ].join('\n')
  assertNoDestination(block, 'narrative')
  return block
}

/**
 * Last-ditch structural check on what is about to be sent to the planner. If a
 * refactor ever routes raw corpus text here, this throws rather than sending it.
 */
function assertNoRawText(userText: string): void {
  if (userText.includes('UNTRUSTED_COMMUNITY_TEXT')) {
    throw new AirlockViolation('raw corpus reached the planner turn', 'userText')
  }
}

import { AirlockViolation, PLANNER_TOOL_NAMES } from '@fee-split-vaults/core'
import type { PlannerToolName, TopicCode } from '@fee-split-vaults/core'
import { TOPIC_CODES } from '@fee-split-vaults/core'
import type { Address, Channel, ImageRef, PublishRequest, SpendProposal } from '@fee-split-vaults/core'
import type { JsonSchemaObject, ModelContentBlock, ModelToolSpec } from '../model/client.js'
import {
  assertExactKeys,
  assertNoDestinationOrAmount,
  requireBoundedString,
  requireInteger,
  requireMember,
} from './guards.js'

/**
 * The planner's entire expressive surface.
 *
 * Read the input schemas as a threat model rather than as an interface. There is
 * no field of type "address", "url", "handle", "vendor", "amount", "price", or
 * "currency" anywhere below, and there is no free-text field that is ever parsed
 * for a value. A purchase is a catalog id and an integer. A link is an allowlist
 * id. A fully compromised planner can select the wrong SKU from a list the
 * operator wrote; it cannot invent a payee.
 *
 * Every tool is also inert by construction: the planner call is single-shot,
 * with no tool_result ever returned, so a tool_use block is a record of an
 * intention and never a side effect.
 */

export const POST_INTENTS = [
  'answer_backlog',
  'scam_warning',
  'operational_update',
  'community_prompt',
  'announcement',
  'campaign',
] as const
export type PostIntent = (typeof POST_INTENTS)[number]

export const ESCALATION_REASONS = [
  'human_review_needed',
  'possible_impersonation',
  'possible_scam_wave',
  'policy_uncertainty',
  'anomalous_signal',
  'digest_insufficient',
] as const
export type EscalationReason = (typeof ESCALATION_REASONS)[number]

export const PROPOSABLE_CHANNELS = ['telegram', 'x_operator', 'site'] as const

/**
 * What the planner is allowed to know about a SKU. Not the price: the planner
 * cannot name an amount, so giving it one only creates the opportunity to try.
 * A coarse band is enough to choose sensibly and carries no number.
 */
export interface PlannerSkuView {
  id: string
  description: string
  category: string
  costBand: 'low' | 'medium' | 'high'
}

/** Allowlisted destinations, referenced by id. The URL never enters a prompt. */
export interface LinkRef {
  id: string
  description: string
}

export const MAX_POST_BODY_CHARS = 480
export const MAX_RATIONALE_CHARS = 240
export const MAX_LINK_REFS = 2
/** One image per post. The channel adapters attach at most one, and one is enough. */
export const MAX_IMAGE_REFS = 1
export const MAX_PURCHASE_QUANTITY = 10

export interface PlannerToolOptions {
  catalog: readonly PlannerSkuView[]
  links: readonly LinkRef[]
  /** Generated images, by id and kind. Like links: an id, never the thing. */
  imageRefs: readonly ImageRef[]
  /** False at tiers or screening verdicts where paid media is not permitted. */
  paidMediaPermitted: boolean
}

/**
 * Build the tool list. Absence is the control: with an empty catalog, or with
 * paid media not permitted, propose_purchase is not offered at all and the model
 * has no way to express a purchase.
 */
export function buildPlannerTools(options: PlannerToolOptions): ModelToolSpec[] {
  const tools: ModelToolSpec[] = [
    postTool(options.links, options.imageRefs),
    escalationTool(),
    noActionTool(),
  ]
  if (options.paidMediaPermitted && options.catalog.length > 0) {
    tools.splice(1, 0, purchaseTool(options.catalog))
  }
  for (const tool of tools) {
    if (!(PLANNER_TOOL_NAMES as readonly string[]).includes(tool.name)) {
      throw new AirlockViolation(`tool "${tool.name}" is not in PLANNER_TOOL_NAMES`, 'tools')
    }
  }
  return tools
}

function postTool(links: readonly LinkRef[], images: readonly ImageRef[]): ModelToolSpec {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        enum: PROPOSABLE_CHANNELS,
        description: 'Where the post would go.',
      },
      intent: { type: 'string', enum: POST_INTENTS, description: 'Why this post exists.' },
      topic: {
        type: 'string',
        enum: TOPIC_CODES,
        description: 'The digest topic this post responds to.',
      },
      body: {
        type: 'string',
        maxLength: MAX_POST_BODY_CHARS,
        description:
          'Post copy. No links, no @handles, no addresses, no numbers that read as amounts, ' +
          'no price or return talk, and no disclosure text - the publisher adds disclosure.',
      },
    },
    required: ['channel', 'intent', 'topic', 'body'],
    additionalProperties: false,
  }

  if (links.length > 0) {
    schema.properties.linkRefs = {
      type: 'array',
      maxItems: MAX_LINK_REFS,
      description: `Allowlisted link ids. ${links.map((l) => `${l.id}=${l.description}`).join('; ')}`,
      items: { type: 'string', enum: links.map((l) => l.id) },
    }
    schema.required.push('linkRefs')
  }

  if (images.length > 0) {
    schema.properties.imageRefs = {
      type: 'array',
      maxItems: MAX_IMAGE_REFS,
      description: `Generated image ids this coin may attach. ${images.map((i) => `${i.id} (${i.kind})`).join('; ')}`,
      items: { type: 'string', enum: images.map((i) => i.id) },
    }
    schema.required.push('imageRefs')
  }

  return {
    name: 'propose_post',
    description:
      'Propose one post. This does not publish. A publisher rewrites, screens, injects ' +
      'disclosure, and may refuse it.',
    inputSchema: schema,
  }
}

function purchaseTool(catalog: readonly PlannerSkuView[]): ModelToolSpec {
  return {
    name: 'propose_purchase',
    description:
      'Propose one catalog purchase. This does not buy anything and does not move money. ' +
      'A deterministic broker prices the SKU, checks the spend gate, and may refuse.',
    inputSchema: {
      type: 'object',
      properties: {
        skuId: {
          type: 'string',
          enum: catalog.map((s) => s.id),
          description: catalog
            .map((s) => `${s.id}: ${s.description} (${s.category}, ${s.costBand} cost)`)
            .join(' | '),
        },
        quantity: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_PURCHASE_QUANTITY,
          description: 'How many units. The broker computes the cost; you never state one.',
        },
        rationale: {
          type: 'string',
          maxLength: MAX_RATIONALE_CHARS,
          description:
            'Why this SKU addresses something in the digest. Advisory text, never parsed for values.',
        },
      },
      required: ['skuId', 'quantity', 'rationale'],
      additionalProperties: false,
    },
  }
}

function escalationTool(): ModelToolSpec {
  return {
    name: 'propose_escalation',
    description: 'Hand this window to a human. Use it whenever you are unsure.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: ESCALATION_REASONS },
        note: { type: 'string', maxLength: MAX_RATIONALE_CHARS },
      },
      required: ['reason', 'note'],
      additionalProperties: false,
    },
  }
}

function noActionTool(): ModelToolSpec {
  return {
    name: 'propose_no_action',
    description: 'Do nothing this window. This is the correct answer most of the time.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', maxLength: MAX_RATIONALE_CHARS },
      },
      required: ['reason'],
      additionalProperties: false,
    },
  }
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export interface PostProposal {
  kind: 'post'
  channel: Channel
  intent: PostIntent
  topic: TopicCode
  body: string
  linkRefs: string[]
  /** At most one id from the offered ImageRefs. Resolved to bytes at publish time. */
  imageRefs: string[]
}

export interface PurchaseProposal {
  kind: 'purchase'
  skuId: string
  quantity: number
  rationale: string
}

export interface EscalationProposal {
  kind: 'escalation'
  reason: EscalationReason
  note: string
}

export interface NoActionProposal {
  kind: 'no_action'
  reason: string
}

export type Proposal =
  | PostProposal
  | PurchaseProposal
  | EscalationProposal
  | NoActionProposal

export interface ProposalViolation {
  toolName: string
  field: string
  message: string
}

export interface ParsedProposals {
  proposals: Proposal[]
  /** Rejected calls. Never repaired, never partially accepted. */
  violations: ProposalViolation[]
}

export interface ParseOptions {
  catalog: readonly PlannerSkuView[]
  links: readonly LinkRef[]
  imageRefs: readonly ImageRef[]
  paidMediaPermitted: boolean
}

/**
 * Turn tool_use blocks into proposals, discarding anything that does not fit the
 * closed schema. A violation is recorded and dropped; it is never coerced into a
 * valid proposal, because coercion is how an injected value survives a check.
 */
export function parseProposals(
  blocks: readonly ModelContentBlock[],
  options: ParseOptions,
): ParsedProposals {
  const proposals: Proposal[] = []
  const violations: ProposalViolation[] = []
  const skuIds = new Set(options.catalog.map((s) => s.id))
  const linkIds = new Set(options.links.map((l) => l.id))
  const imageIds = new Set(options.imageRefs.map((i) => i.id))

  for (const block of blocks) {
    if (block.type !== 'tool_use') continue
    const name = block.name
    if (!(PLANNER_TOOL_NAMES as readonly string[]).includes(name)) {
      violations.push({
        toolName: name,
        field: 'name',
        message: 'tool is not in PLANNER_TOOL_NAMES',
      })
      continue
    }
    try {
      proposals.push(
        parseOne(name as PlannerToolName, block.input, {
          skuIds,
          linkIds,
          imageIds,
          paidMediaPermitted: options.paidMediaPermitted,
        }),
      )
    } catch (error: unknown) {
      if (error instanceof AirlockViolation) {
        violations.push({ toolName: name, field: error.field, message: error.message })
        continue
      }
      throw error
    }
  }

  return { proposals, violations }
}

interface ParseContext {
  skuIds: Set<string>
  linkIds: Set<string>
  imageIds: Set<string>
  paidMediaPermitted: boolean
}

function parseOne(name: PlannerToolName, rawInput: unknown, ctx: ParseContext): Proposal {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
    throw new AirlockViolation('tool input is not an object', 'input')
  }
  const input = rawInput as Record<string, unknown>

  switch (name) {
    case 'propose_post': {
      assertExactKeys(
        input,
        ['channel', 'intent', 'topic', 'body', 'linkRefs', 'imageRefs'],
        'propose_post',
      )
      const body = requireBoundedString(input.body, 'body', MAX_POST_BODY_CHARS)
      assertNoDestinationOrAmount(body, 'body')
      const linkRefs = parseLinkRefs(input.linkRefs, ctx.linkIds)
      const imageRefs = parseImageRefs(input.imageRefs, ctx.imageIds)
      return {
        kind: 'post',
        channel: requireMember(input.channel, PROPOSABLE_CHANNELS, 'channel'),
        intent: requireMember(input.intent, POST_INTENTS, 'intent'),
        topic: requireMember(input.topic, TOPIC_CODES, 'topic'),
        body,
        linkRefs,
        imageRefs,
      }
    }

    case 'propose_purchase': {
      if (!ctx.paidMediaPermitted) {
        throw new AirlockViolation('paid media is not permitted for this coin', 'skuId')
      }
      assertExactKeys(input, ['skuId', 'quantity', 'rationale'], 'propose_purchase')
      const skuId = requireBoundedString(input.skuId, 'skuId', 128)
      if (!ctx.skuIds.has(skuId)) {
        throw new AirlockViolation(`sku "${skuId}" is not in the catalog`, 'skuId')
      }
      const rationale = requireBoundedString(input.rationale, 'rationale', MAX_RATIONALE_CHARS)
      assertNoDestinationOrAmount(rationale, 'rationale')
      return {
        kind: 'purchase',
        skuId,
        quantity: requireInteger(input.quantity, 'quantity', {
          min: 1,
          max: MAX_PURCHASE_QUANTITY,
        }),
        rationale,
      }
    }

    case 'propose_escalation': {
      assertExactKeys(input, ['reason', 'note'], 'propose_escalation')
      const note = requireBoundedString(input.note, 'note', MAX_RATIONALE_CHARS)
      assertNoDestinationOrAmount(note, 'note')
      return {
        kind: 'escalation',
        reason: requireMember(input.reason, ESCALATION_REASONS, 'reason'),
        note,
      }
    }

    case 'propose_no_action': {
      assertExactKeys(input, ['reason'], 'propose_no_action')
      const reason = requireBoundedString(input.reason, 'reason', MAX_RATIONALE_CHARS)
      assertNoDestinationOrAmount(reason, 'reason')
      return { kind: 'no_action', reason }
    }
  }
}

function parseLinkRefs(raw: unknown, allowed: Set<string>): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new AirlockViolation('linkRefs must be an array', 'linkRefs')
  if (raw.length > MAX_LINK_REFS) {
    throw new AirlockViolation('too many linkRefs', 'linkRefs')
  }
  const out: string[] = []
  for (const value of raw as unknown[]) {
    const id = requireBoundedString(value, 'linkRefs', 64)
    if (!allowed.has(id)) {
      throw new AirlockViolation(`link "${id}" is not on the allowlist`, 'linkRefs')
    }
    out.push(id)
  }
  return out
}

/**
 * Same rule as links: an id is accepted only if it was offered. With nothing
 * offered the set is empty and every id is refused, so a planner cannot attach
 * an image to a coin that has none, or another coin's image to this one.
 */
function parseImageRefs(raw: unknown, allowed: Set<string>): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new AirlockViolation('imageRefs must be an array', 'imageRefs')
  if (raw.length > MAX_IMAGE_REFS) {
    throw new AirlockViolation('too many imageRefs', 'imageRefs')
  }
  const out: string[] = []
  for (const value of raw as unknown[]) {
    const id = requireBoundedString(value, 'imageRefs', 128)
    if (!allowed.has(id)) {
      throw new AirlockViolation(`image "${id}" was not offered`, 'imageRefs')
    }
    out.push(id)
  }
  return out
}

// ---------------------------------------------------------------------------
// Handoff to the deterministic packages
// ---------------------------------------------------------------------------

/**
 * Promotional classification is a rule, not a model judgement: the disclosure
 * regime attaches to what the post IS, and asking the author to self-declare is
 * exactly the failure mode the rule exists to remove.
 */
export function classifyPromotional(proposal: PostProposal): boolean {
  if (proposal.intent === 'announcement' || proposal.intent === 'campaign') return true
  return proposal.linkRefs.length > 0
}

export function toSpendProposal(
  proposal: PurchaseProposal,
  vault: Address,
  proposedAtUnix: number,
): SpendProposal {
  return {
    vault,
    skuId: proposal.skuId,
    quantity: proposal.quantity,
    rationale: proposal.rationale,
    proposedAtUnix,
  }
}

/**
 * Resolve allowlist ids to real URLs. This is the only place a URL is attached
 * to model output, and it happens after the model is out of the loop. Image ids
 * are copied through as ids: the publisher resolves them to bytes and refuses
 * any id that does not belong to the posting coin.
 */
export function toPublishRequest(
  proposal: PostProposal,
  vault: Address,
  allowlist: ReadonlyMap<string, string>,
): PublishRequest {
  const links: string[] = []
  for (const ref of proposal.linkRefs) {
    const url = allowlist.get(ref)
    if (url === undefined) {
      throw new AirlockViolation(`link "${ref}" resolved to nothing`, 'linkRefs')
    }
    links.push(url)
  }
  return {
    vault,
    channel: proposal.channel,
    body: proposal.body,
    isPromotional: classifyPromotional(proposal),
    links,
    imageRefs: [...proposal.imageRefs],
  }
}

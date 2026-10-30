import { describe, expect, it } from 'vitest'
import {
  AirlockViolation,
  PLANNER_TOOL_NAMES,
  addressLikeTokens,
  containsHostLike,
  namingServiceTokens,
  validateNarrativeProfile,
} from '@fee-split-vaults/core'
import type { ImageRef, NarrativeProfile } from '@fee-split-vaults/core'
import { FakeModelClient, textReply, toolUseReply } from '../model/fake.js'
import { MODEL } from '../model/ids.js'
import { PLANNER_SYSTEM_PROMPT } from '../cognition/prompts.js'
import { Planner, renderNarrativeBlock } from '../cognition/planner.js'
import { parseProposals, toPublishRequest } from '../cognition/plannerTools.js'
import { NarrativeDerivationFailed, deriveNarrativeCandidate } from '../narrative/derive.js'
import { hashUserId } from '../isolation/userId.js'
import { CATALOG, COIN, LINKS, SALT, VAULT, digestFixture } from './helpers.js'

const userIdHash = hashUserId(SALT, COIN)
const HASH = 'b'.repeat(64)

/**
 * As adversarial as a tagline can be and still be a valid profile: it went
 * through validateNarrativeProfile, so what is being tested is that RENDERING
 * cannot reintroduce a destination shape around clean words.
 */
function narrative(overrides: Partial<NarrativeProfile> = {}): NarrativeProfile {
  return validateNarrativeProfile({
    version: 1,
    tagline: 'frogs who dm nobody and claim nothing at all',
    themes: ['how_to_buy', 'contract_address_request', 'unanswered_backlog'],
    tone: 'community',
    palette: { primary: '#22aa55', secondary: '#112233' },
    approvedAtUnix: 1_788_652_800,
    approvedBy: 'ops.alice',
    sourceHashes: [HASH],
    ...overrides,
  })
}

const IMAGES: ImageRef[] = [
  { id: `${COIN}:card:0123456789abcdef`, kind: 'card' },
  { id: `${COIN}:banner:fedcba9876543210`, kind: 'banner' },
]

function post(input: Record<string, unknown>) {
  return toolUseReply([
    {
      name: 'propose_post',
      input: {
        channel: 'telegram',
        intent: 'operational_update',
        topic: 'how_to_buy',
        body: 'the guide is pinned in the channel',
        linkRefs: [],
        ...input,
      },
    },
  ]).content
}

describe('the narrative block', () => {
  it('renders tagline, themes as words, and tone, and nothing else', () => {
    const block = renderNarrativeBlock(narrative())
    expect(block).toContain('tagline: frogs who dm nobody and claim nothing at all')
    expect(block).toContain('themes: how to buy, contract address request, unanswered backlog')
    expect(block).toContain('tone: community')
    expect(block).not.toContain('#22aa55')
    expect(block).not.toContain(HASH)
    expect(block).not.toContain('ops.alice')
    expect(block).not.toMatch(/[a-z]_[a-z]/u)
  })

  it('carries no host, handle, or address shape into what the planner sees', () => {
    const planner = new Planner(new FakeModelClient([]), {
      model: MODEL.sonnet5,
      catalog: CATALOG,
      links: LINKS,
      imageRefs: IMAGES,
      narrative: narrative(),
      paidMediaPermitted: true,
    })
    const request = planner.buildRequest(digestFixture(), userIdHash)
    expect(request.system[0]).toEqual({ text: PLANNER_SYSTEM_PROMPT, cacheBreakpoint: true })
    expect(request.system).toHaveLength(2)
    // Everything per-coin: the narrative block and the digest turn. The frozen
    // prompt is a constant that itself says "@handle", so it is excluded.
    const seen = `${request.system[1]?.text ?? ''}\n${request.userText}`
    expect(addressLikeTokens(seen)).toEqual([])
    expect(namingServiceTokens(seen)).toEqual([])
    expect(containsHostLike(seen)).toBe(false)
    expect(seen).not.toMatch(/@[A-Za-z0-9_]{2,}/u)
    expect(seen).not.toContain('UNTRUSTED_COMMUNITY_TEXT')
  })

  it('is absent when the coin has no narrative', () => {
    const planner = new Planner(new FakeModelClient([]), {
      model: MODEL.sonnet5,
      catalog: CATALOG,
      links: LINKS,
      imageRefs: [],
      narrative: null,
      paidMediaPermitted: true,
    })
    const request = planner.buildRequest(digestFixture(), userIdHash)
    expect(request.system).toEqual([{ text: PLANNER_SYSTEM_PROMPT, cacheBreakpoint: true }])
  })

  it('refuses in code, not only in tests, if a profile renders destination-shaped', () => {
    // Bypass the validator on purpose: this is the rendering boundary's own check.
    const forged = { ...narrative(), tagline: 'claim at vnx-claim.top' } as NarrativeProfile
    expect(() => renderNarrativeBlock(forged)).toThrow(AirlockViolation)
  })
})

describe('propose_post imageRefs', () => {
  const offered = { catalog: CATALOG, links: LINKS, imageRefs: IMAGES, paidMediaPermitted: true }
  const none = { catalog: CATALOG, links: LINKS, imageRefs: [], paidMediaPermitted: true }

  it('offers image ids in the tool schema as id (kind), and only when there are any', () => {
    const withImages = new Planner(new FakeModelClient([]), {
      model: MODEL.sonnet5,
      ...offered,
      narrative: null,
    }).buildRequest(digestFixture(), userIdHash)
    const postTool = withImages.tools?.find((t) => t.name === 'propose_post')
    const imageProp = postTool?.inputSchema.properties.imageRefs
    expect(imageProp?.items?.enum).toEqual(IMAGES.map((i) => i.id))
    expect(imageProp?.maxItems).toBe(1)
    expect(imageProp?.description).toContain(`${IMAGES[0]?.id} (card)`)
    expect(postTool?.inputSchema.required).toContain('imageRefs')
    expect(withImages.tools?.map((t) => t.name).every((n) => (PLANNER_TOOL_NAMES as readonly string[]).includes(n))).toBe(true)

    const without = new Planner(new FakeModelClient([]), {
      model: MODEL.sonnet5,
      ...none,
      narrative: null,
    }).buildRequest(digestFixture(), userIdHash)
    const bare = without.tools?.find((t) => t.name === 'propose_post')
    expect(bare?.inputSchema.properties.imageRefs).toBeUndefined()
    expect(bare?.inputSchema.required).not.toContain('imageRefs')
  })

  it('accepts one offered id and carries it to the publish request', () => {
    const { proposals, violations } = parseProposals(post({ imageRefs: [IMAGES[1]?.id] }), offered)
    expect(violations).toEqual([])
    expect(proposals).toHaveLength(1)
    const proposal = proposals[0]
    if (proposal?.kind !== 'post') throw new Error('expected a post')
    expect(proposal.imageRefs).toEqual([IMAGES[1]?.id])
    const request = toPublishRequest(proposal, VAULT, new Map())
    expect(request.imageRefs).toEqual([IMAGES[1]?.id])
  })

  it('treats a missing imageRefs field as none', () => {
    const { proposals } = parseProposals(post({}), offered)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.kind === 'post' && proposals[0].imageRefs).toEqual([])
  })

  it('refuses an id that was not offered, including another coin’s image', () => {
    for (const id of ['other_coin:card:0123456789abcdef', `${COIN}:card:ffffffffffffffff`, 'https://evil.example/x.png']) {
      const { proposals, violations } = parseProposals(post({ imageRefs: [id] }), offered)
      expect(proposals).toHaveLength(0)
      expect(violations[0]?.field).toBe('imageRefs')
    }
  })

  it('refuses more than one id even when both were offered', () => {
    const { proposals, violations } = parseProposals(post({ imageRefs: IMAGES.map((i) => i.id) }), offered)
    expect(proposals).toHaveLength(0)
    expect(violations[0]?.field).toBe('imageRefs')
  })

  it('refuses any id at all when none were offered', () => {
    const { proposals, violations } = parseProposals(post({ imageRefs: [IMAGES[0]?.id] }), none)
    expect(proposals).toHaveLength(0)
    expect(violations[0]?.field).toBe('imageRefs')
  })
})

describe('deriveNarrativeCandidate', () => {
  const clock = { nowUnix: () => 1_788_652_800 }
  const sources = [{ text: 'A frog coin for people who like frogs. Community first.', sha256: HASH }]

  function answer(candidate: Record<string, unknown>): string {
    return JSON.stringify({
      tagline: 'a frog coin for people who like frogs',
      themes: ['sentiment_positive'],
      tone: 'playful',
      palette: { primary: '#22aa55', secondary: '#112233' },
      ...candidate,
    })
  }

  it('returns a clean candidate with the source hashes and no approval', async () => {
    const client = new FakeModelClient([textReply(answer({}))])
    const candidate = await deriveNarrativeCandidate(sources, client, clock)
    expect(candidate).toEqual({
      version: 1,
      tagline: 'a frog coin for people who like frogs',
      themes: ['sentiment_positive'],
      tone: 'playful',
      palette: { primary: '#22aa55', secondary: '#112233' },
      sourceHashes: [HASH],
    })
    expect('approvedAtUnix' in candidate).toBe(false)

    // Reader plane: no tools, the source fenced with the corpus marker.
    const request = client.lastRequest
    expect(request?.tools).toBeUndefined()
    expect(request?.toolChoice).toBeUndefined()
    expect(request?.model).toBe(MODEL.haiku45)
    expect(request?.userText).toContain('<<<UNTRUSTED_COMMUNITY_TEXT')
    expect(request?.userText).toContain(sources[0]?.text)
  })

  it('refuses a tagline that smuggles a URL rather than laundering it', async () => {
    for (const tagline of [
      'frogs, see https://frogs.example/claim',
      'frogs at frogs.top',
      'frogs, dm @frog_support',
      'frogs f\u200br\u200bo\u200bg\u200bs.top',
    ]) {
      const client = new FakeModelClient([textReply(answer({ tagline }))])
      await expect(deriveNarrativeCandidate(sources, client, clock)).rejects.toThrow(NarrativeDerivationFailed)
    }
  })

  it('refuses an answer with an extra key, a bad theme, a bad tone, or a bad palette', async () => {
    for (const bad of [
      { website: 'frogs.example' },
      { themes: ['moon'] },
      { tone: 'shouty' },
      { palette: { primary: 'green', secondary: '#112233' } },
    ]) {
      const client = new FakeModelClient([textReply(answer(bad))])
      await expect(deriveNarrativeCandidate(sources, client, clock)).rejects.toThrow(NarrativeDerivationFailed)
    }
  })

  it('refuses prose around the object, and an empty answer', async () => {
    await expect(
      deriveNarrativeCandidate(sources, new FakeModelClient([textReply(`Sure! ${answer({})}`)]), clock),
    ).rejects.toThrow(NarrativeDerivationFailed)
    await expect(
      deriveNarrativeCandidate(sources, new FakeModelClient([textReply('')]), clock),
    ).rejects.toThrow(NarrativeDerivationFailed)
  })

  it('refuses before calling the model when there is nothing valid to read', async () => {
    const client = new FakeModelClient([textReply(answer({}))])
    await expect(deriveNarrativeCandidate([], client, clock)).rejects.toThrow(NarrativeDerivationFailed)
    await expect(
      deriveNarrativeCandidate([{ text: 'frogs', sha256: 'nope' }], client, clock),
    ).rejects.toThrow(NarrativeDerivationFailed)
    await expect(
      deriveNarrativeCandidate([{ text: '\u200b  ', sha256: HASH }], client, clock),
    ).rejects.toThrow(NarrativeDerivationFailed)
    expect(client.calls).toHaveLength(0)
  })

  it('bounds what one derivation reads, whatever the site sends', async () => {
    const client = new FakeModelClient(() => textReply(answer({})))
    const huge = [{ text: 'frog '.repeat(200_000), sha256: HASH }]
    await deriveNarrativeCandidate(huge, client, clock)
    const small = [{ text: 'frog '.repeat(2_000), sha256: HASH }]
    await deriveNarrativeCandidate(small, client, clock)
    const [big, little] = client.calls
    expect(big?.userText.length).toBeLessThan(10_000)
    expect(big?.userText.length).toBe(little?.userText.length)
  })
})

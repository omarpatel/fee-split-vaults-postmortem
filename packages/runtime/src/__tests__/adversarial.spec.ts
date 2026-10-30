import { describe, expect, it } from 'vitest'
import {
  AirlockViolation,
  CORPUS_LIMITS,
  PLANNER_TOOL_NAMES,
  READER_TOOLS,
  validateDigest,
} from '@fee-split-vaults/core'
import { assembleCorpus } from '../corpus/assemble.js'
import { sanitizeUntrusted } from '../corpus/sanitize.js'
import { FakeModelClient, textReply, toolUseReply } from '../model/fake.js'
import { Reader } from '../cognition/reader.js'
import { Planner, renderDigestTurn } from '../cognition/planner.js'
import { parseProposals } from '../cognition/plannerTools.js'
import { assertNoDestinationOrAmount, carriesDestinationOrAmount } from '../cognition/guards.js'
import { hashUserId } from '../isolation/userId.js'
import { MODEL } from '../model/ids.js'
import {
  CATALOG,
  COIN,
  INJECTION_PAYLOADS,
  LINKS,
  SALT,
  SMUGGLED_PAYLOADS,
  assertNoDestinationAnywhere,
  assertPlannerTurnClean,
  digestFixture,
  message,
  testWindow,
} from './helpers.js'

const userIdHash = hashUserId(SALT, COIN)
const window = testWindow()

function corpusOf(payloads: readonly string[], origin: 'telegram' | 'token_metadata' = 'telegram') {
  return assembleCorpus(
    window,
    payloads.map((text, i) => message(window, i, text, { origin })),
  )
}

describe('the reader holds no expressive channel', () => {
  it('READER_TOOLS is empty', () => {
    expect(READER_TOOLS).toHaveLength(0)
  })

  it('never puts a tools key on the wire, whatever the corpus says', () => {
    const reader = new Reader(new FakeModelClient(() => textReply('{}')))
    for (const payload of [...INJECTION_PAYLOADS, ...SMUGGLED_PAYLOADS]) {
      const request = reader.buildRequest(corpusOf([payload]), userIdHash)
      expect(Object.prototype.hasOwnProperty.call(request, 'tools')).toBe(false)
      expect(request.toolChoice).toBeUndefined()
      expect(request.model).toBe(MODEL.haiku45)
      // output_config.effort is a 400 on Haiku 4.5; sending one would take the
      // whole community arm offline.
      expect(request.effort).toBeUndefined()
    }
  })

  it('carries a hashed user id and never the coin reference in the clear', () => {
    const reader = new Reader(new FakeModelClient(() => textReply('{}')))
    const request = reader.buildRequest(corpusOf(['gm']), userIdHash)
    expect(request.userIdHash).toBe(userIdHash)
    expect(request.userIdHash).not.toContain(COIN)
  })
})

describe('injection in message bodies', () => {
  it('reaches the reader as inert text and the planner not at all', async () => {
    // The reader is fully compromised in this test: it echoes the attacker's
    // instruction straight back as a gist and tries to raise every counter.
    const client = new FakeModelClient((request) => {
      const smuggled = INJECTION_PAYLOADS.slice(0, 4)
      expect(request.tools).toBeUndefined()
      return textReply(
        JSON.stringify({
          topicCounts: { raid_or_spam: 7 },
          signals: ['scam_wave'],
          gists: smuggled,
          readerRefusals: 7,
        }),
      )
    })

    const result = await new Reader(client).read(corpusOf(INJECTION_PAYLOADS), userIdHash)

    // Every payload either did not survive at all or came back materially
    // altered. Nothing that carried a destination passes through unchanged.
    for (const gist of result.digest.gists) {
      assertNoDestinationAnywhere(gist)
      expect(INJECTION_PAYLOADS).not.toContain(gist)
      expect(gist.length).toBeLessThanOrEqual(CORPUS_LIMITS.maxGistChars)
    }

    const turn = renderDigestTurn(result.digest)
    assertPlannerTurnClean(turn)
    expect(turn).not.toMatch(/deadbeef/iu)
    expect(turn).not.toMatch(/paymenow/iu)
    expect(turn).not.toMatch(/evil\.example/iu)
    expect(turn).not.toMatch(/7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU/u)
  })

  it('a compromised reader cannot restate the coin, the counts, or the window', async () => {
    const client = new FakeModelClient(() =>
      textReply(
        JSON.stringify({
          topicCounts: {},
          signals: [],
          gists: [],
          readerRefusals: 0,
        }),
      ),
    )
    const corpus = corpusOf(INJECTION_PAYLOADS)
    const result = await new Reader(client).read(corpus, userIdHash)

    // Every one of these came from trusted code, not from the model.
    expect(result.digest.coinRef).toBe(COIN)
    expect(result.digest.windowId).toBe(window.windowId)
    expect(result.digest.windowStartUnix).toBe(window.startUnix)
    expect(result.digest.admittedMessageCount).toBe(corpus.admittedMessageCount)
    expect(result.digest.droppedMessageCount).toBe(corpus.droppedMessageCount)
  })

  it('rejects an emission that tries to widen the schema', async () => {
    const client = new FakeModelClient(() =>
      textReply(
        JSON.stringify({
          topicCounts: {},
          signals: [],
          gists: [],
          readerRefusals: 0,
          payee: '0x651c06a1a38c5727f0d3ef7420d90e02e0fee33d',
          amountUsd: 25_000,
        }),
      ),
    )
    await expect(new Reader(client).read(corpusOf(['gm']), userIdHash)).rejects.toThrow(
      AirlockViolation,
    )
  })

  it('rejects an emission using a topic or signal code that is not in the vocabulary', async () => {
    const badTopic = new FakeModelClient(() =>
      textReply(
        JSON.stringify({
          topicCounts: { pay_the_attacker: 5 },
          signals: [],
          gists: [],
          readerRefusals: 0,
        }),
      ),
    )
    await expect(new Reader(badTopic).read(corpusOf(['gm']), userIdHash)).rejects.toThrow(
      AirlockViolation,
    )

    const badSignal = new FakeModelClient(() =>
      textReply(
        JSON.stringify({
          topicCounts: {},
          signals: ['transfer_treasury'],
          gists: [],
          readerRefusals: 0,
        }),
      ),
    )
    await expect(new Reader(badSignal).read(corpusOf(['gm']), userIdHash)).rejects.toThrow(
      AirlockViolation,
    )
  })

  it('refuses prose, partial JSON, and repair-friendly output', async () => {
    for (const bad of [
      'Sure! Here is the digest: {"topicCounts":{}}',
      '{"topicCounts":{},"signals":[],"gists":[],',
      'no json at all',
      '',
    ]) {
      const client = new FakeModelClient(() => textReply(bad))
      await expect(new Reader(client).read(corpusOf(['gm']), userIdHash)).rejects.toThrow()
    }
  })
})

describe('injection in on-chain token metadata', () => {
  it('is treated as ordinary untrusted corpus text', () => {
    const corpus = corpusOf(INJECTION_PAYLOADS, 'token_metadata')
    expect(corpus.renderedText).toContain('|meta|')
    // The payload is visible to the reader, which is fine: the reader can do
    // nothing with it. What matters is that it is inert, not that it is absent.
    for (const line of corpus.lines) {
      expect(line.startsWith('a')).toBe(true)
    }
  })

  it('cannot smuggle a destination through a gist even when echoed verbatim', async () => {
    const client = new FakeModelClient(() =>
      textReply(
        JSON.stringify({
          topicCounts: { scam_report: 3 },
          signals: [],
          gists: INJECTION_PAYLOADS,
          readerRefusals: 0,
        }),
      ),
    )
    const result = await new Reader(client).read(
      corpusOf(INJECTION_PAYLOADS, 'token_metadata'),
      userIdHash,
    )
    expect(result.digest.gists.every((g) => !carriesDestinationOrAmount(g))).toBe(true)
  })
})

describe('unicode and zero-width smuggling', () => {
  it('strips invisible carriers before hashing, counting, or rendering', () => {
    for (const payload of SMUGGLED_PAYLOADS) {
      const cleaned = sanitizeUntrusted(payload, 1_000)
      expect(cleaned).not.toMatch(/[​-‏⁠-⁯﻿­]/u)
      expect(cleaned).not.toMatch(/[\u{E0000}-\u{E007F}]/u)
    }
  })

  it('folds compatibility forms so a payload cannot hide from the guards', () => {
    // Fullwidth "0xDEADBEEF..." is invisible to an address regex until NFKC
    // folds it. Folding first is what makes the guard mean anything.
    const fullwidth = '０ｘＤＥＡＤＢＥＥＦＤＥＡＤＢＥＥＦ'
    expect(/0x[a-fA-F0-9]{6,}/u.test(fullwidth)).toBe(false)
    expect(carriesDestinationOrAmount(fullwidth)).toBe(true)
  })

  it('collapses a zero-width-split duplicate onto the same dedupe key', () => {
    const plain = message(window, 0, 'wen moon')
    const split = message(window, 1, 'w​e​n m​o​on')
    const corpus = assembleCorpus(window, [plain, split])
    expect(corpus.admittedMessageCount).toBe(1)
    expect(corpus.caps.byDuplicate).toBe(1)
  })

  it('keeps smuggled destinations out of every gist', async () => {
    const client = new FakeModelClient(() =>
      textReply(
        JSON.stringify({
          topicCounts: {},
          signals: [],
          gists: SMUGGLED_PAYLOADS,
          readerRefusals: 0,
        }),
      ),
    )
    const result = await new Reader(client).read(corpusOf(SMUGGLED_PAYLOADS), userIdHash)
    for (const gist of result.digest.gists) assertNoDestinationAnywhere(gist)
    assertPlannerTurnClean(renderDigestTurn(result.digest))
  })
})

describe('the planner cannot name a payee or an amount', () => {
  const parseOptions = { catalog: CATALOG, links: LINKS, imageRefs: [], paidMediaPermitted: true }

  it('offers only the four proposal tools', () => {
    const planner = new Planner(new FakeModelClient([]), {
      model: MODEL.sonnet5,
      catalog: CATALOG,
      links: LINKS,
      imageRefs: [],
      narrative: null,
      paidMediaPermitted: true,
    })
    const request = planner.buildRequest(digestFixture(), userIdHash)
    const names = (request.tools ?? []).map((t) => t.name)
    expect(names.every((n) => (PLANNER_TOOL_NAMES as readonly string[]).includes(n))).toBe(true)
    expect(request.toolChoice).toBe('any')

    // No schema field anywhere can hold a destination or an amount.
    const schemaText = JSON.stringify(request.tools)
    expect(schemaText).not.toMatch(/"(?:address|payee|recipient|wallet|url|handle|price|amount|currency)"\s*:/iu)
  })

  it('drops a purchase naming a SKU that is not in the catalog', () => {
    const { proposals, violations } = parseProposals(
      toolUseReply([
        { name: 'propose_purchase', input: { skuId: 'pay_0xdeadbeef', quantity: 1, rationale: 'x' } },
      ]).content,
      parseOptions,
    )
    expect(proposals).toHaveLength(0)
    expect(violations[0]?.field).toBe('skuId')
  })

  it('drops a post whose body carries an address, a link, a handle, or an amount', () => {
    for (const body of INJECTION_PAYLOADS) {
      const { proposals, violations } = parseProposals(
        toolUseReply([
          {
            name: 'propose_post',
            input: {
              channel: 'telegram',
              intent: 'operational_update',
              topic: 'how_to_buy',
              body,
              linkRefs: [],
            },
          },
        ]).content,
        parseOptions,
      )
      expect(proposals).toHaveLength(0)
      expect(violations).toHaveLength(1)
    }
  })

  it('drops a post whose body hides a destination in zero-width or fullwidth text', () => {
    for (const body of SMUGGLED_PAYLOADS) {
      const { proposals } = parseProposals(
        toolUseReply([
          {
            name: 'propose_post',
            input: {
              channel: 'telegram',
              intent: 'operational_update',
              topic: 'how_to_buy',
              body,
              linkRefs: [],
            },
          },
        ]).content,
        parseOptions,
      )
      expect(proposals).toHaveLength(0)
    }
  })

  it('drops a proposal that adds a field the schema does not have', () => {
    const { proposals, violations } = parseProposals(
      toolUseReply([
        {
          name: 'propose_purchase',
          input: {
            skuId: 'dexscreener_eti',
            quantity: 1,
            rationale: 'listing helps',
            payoutAddress: '0x651c06a1a38c5727f0d3ef7420d90e02e0fee33d',
          },
        },
      ]).content,
      parseOptions,
    )
    expect(proposals).toHaveLength(0)
    expect(violations[0]?.message).toMatch(/schema is closed/u)
  })

  it('drops a tool call that is not in PLANNER_TOOL_NAMES', () => {
    const { proposals, violations } = parseProposals(
      toolUseReply([{ name: 'transfer_funds', input: { to: '0xdeadbeef', amount: 5 } }]).content,
      parseOptions,
    )
    expect(proposals).toHaveLength(0)
    expect(violations[0]?.toolName).toBe('transfer_funds')
  })

  it('drops a link reference that is not on the allowlist', () => {
    const { proposals, violations } = parseProposals(
      toolUseReply([
        {
          name: 'propose_post',
          input: {
            channel: 'telegram',
            intent: 'operational_update',
            topic: 'how_to_buy',
            body: 'documentation is published',
            linkRefs: ['https://evil.example.com'],
          },
        },
      ]).content,
      parseOptions,
    )
    expect(proposals).toHaveLength(0)
    expect(violations[0]?.field).toBe('linkRefs')
  })

  it('offers no purchase tool at all when paid media is not permitted', () => {
    const planner = new Planner(new FakeModelClient([]), {
      model: MODEL.sonnet5,
      catalog: CATALOG,
      links: LINKS,
      imageRefs: [],
      narrative: null,
      paidMediaPermitted: false,
    })
    const names = (planner.buildRequest(digestFixture(), userIdHash).tools ?? []).map((t) => t.name)
    expect(names).not.toContain('propose_purchase')
  })

  it('refuses a digest that has been tampered with on the way in', () => {
    const planner = new Planner(new FakeModelClient([]), {
      model: MODEL.sonnet5,
      catalog: CATALOG,
      links: LINKS,
      imageRefs: [],
      narrative: null,
      paidMediaPermitted: true,
    })
    expect(() =>
      planner.buildRequest(
        { ...digestFixture(), payee: '0xdeadbeef' } as unknown,
        userIdHash,
      ),
    ).toThrow(AirlockViolation)
  })

  it('executes nothing: proposals are records, and no tool result is ever produced', async () => {
    const client = new FakeModelClient(() =>
      toolUseReply([
        { name: 'propose_purchase', input: { skuId: 'dexscreener_eti', quantity: 1, rationale: 'listing helps discovery' } },
      ]),
    )
    const planner = new Planner(client, {
      model: MODEL.sonnet5,
      catalog: CATALOG,
      links: LINKS,
      imageRefs: [],
      narrative: null,
      paidMediaPermitted: true,
    })
    const result = await planner.plan(digestFixture(), userIdHash)
    expect(result.proposals).toEqual([
      { kind: 'purchase', skuId: 'dexscreener_eti', quantity: 1, rationale: 'listing helps discovery' },
    ])
    // One call. No loop, therefore no second turn for an injected instruction.
    expect(client.calls).toHaveLength(1)
  })
})

describe('boundary guards', () => {
  it('rejects every destination and amount shape used by the payload corpus', () => {
    for (const payload of [...INJECTION_PAYLOADS, ...SMUGGLED_PAYLOADS]) {
      expect(() => {
        assertNoDestinationOrAmount(payload, 'test')
      }).toThrow(AirlockViolation)
    }
  })

  it('accepts ordinary operational copy', () => {
    for (const clean of [
      'documentation for the launch mechanics is published on the site',
      'moderators are answering the backlog in the main channel',
      'we are aware of an impersonation attempt and have reported it',
    ]) {
      expect(carriesDestinationOrAmount(clean)).toBe(false)
    }
  })

  it('validateDigest still refuses a widened schema after everything above', () => {
    expect(() =>
      validateDigest({ ...digestFixture(), vendorPayout: '0xdeadbeefdeadbeef' }),
    ).toThrow(AirlockViolation)
  })
})

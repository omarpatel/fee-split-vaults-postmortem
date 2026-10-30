import { describe, expect, it } from 'vitest'
import { CORPUS_LIMITS } from '@fee-split-vaults/core'
import { assembleCorpus, CorpusBindingError } from '../corpus/assemble.js'
import { closedWindowAt, windowFor, windowsBetween } from '../corpus/window.js'
import { estimateTokens } from '../corpus/sanitize.js'
import { MODEL } from '../model/ids.js'
import { priceUsd } from '../cost/pricing.js'
import { FakeModelClient, textReply } from '../model/fake.js'
import { Reader } from '../cognition/reader.js'
import {
  COIN,
  OTHER_COIN,
  SALT,
  T0,
  VALID_EMISSION,
  floodMessages,
  message,
  testWindow,
} from './helpers.js'
import { hashUserId } from '../isolation/userId.js'

describe('fixed-schedule windows', () => {
  it('derives windows from the clock alone', () => {
    const w = windowFor(COIN, T0 + 61)
    expect(w.startUnix).toBe(T0)
    expect(w.endUnix).toBe(T0 + CORPUS_LIMITS.windowMinutes * 60)
    expect(w.windowId).toBe(`${COIN}:${String(T0)}`)
  })

  it('closedWindowAt reads the window that has just ended', () => {
    const w = closedWindowAt(COIN, T0 + 10)
    expect(w.endUnix).toBe(T0)
  })

  it('produces the same number of windows regardless of message volume', () => {
    // There is no wake-on-mention path, so the schedule is a pure function of
    // time. A day is a day whether one message arrived or a million did.
    const day = windowsBetween(COIN, T0, T0 + 86_400)
    expect(day).toHaveLength(86_400 / (CORPUS_LIMITS.windowMinutes * 60))
    expect(new Set(day.map((w) => w.windowId)).size).toBe(day.length)
  })

  it('refuses a coin reference that is not opaque', () => {
    expect(() => windowFor('0xdeadbeef:evil', T0)).toThrow(/opaque/u)
  })
})

describe('deterministic corpus assembly', () => {
  const window = testWindow()

  it('is independent of the order the ingest delivered messages in', () => {
    const messages = Array.from({ length: 50 }, (_, i) => message(window, i, `hello number ${String(i)}`))
    const forwards = assembleCorpus(window, messages)
    const backwards = assembleCorpus(window, [...messages].reverse())
    expect(backwards.renderedText).toBe(forwards.renderedText)
    expect(backwards.contentHashes).toEqual(forwards.contentHashes)
  })

  it('dedupes by content, not by source id', () => {
    const messages = [
      message(window, 0, 'WEN moon??'),
      message(window, 1, 'wen   MOON?!'),
      message(window, 2, 'wen moon'),
      message(window, 3, 'where do i buy'),
    ]
    const corpus = assembleCorpus(window, messages)
    expect(corpus.admittedMessageCount).toBe(2)
    expect(corpus.caps.byDuplicate).toBe(2)
    expect(corpus.droppedMessageCount).toBe(2)
  })

  it('caps a single author', () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      message(window, i, `spam line ${String(i)}`, { authorId: 'one-author' }),
    )
    const corpus = assembleCorpus(window, messages)
    expect(corpus.admittedMessageCount).toBe(CORPUS_LIMITS.maxMessagesPerAuthor)
    expect(corpus.caps.byAuthor).toBe(20 - CORPUS_LIMITS.maxMessagesPerAuthor)
    expect(corpus.distinctAuthorCount).toBe(1)
  })

  it('caps the window and never exceeds the token ceiling', () => {
    const corpus = assembleCorpus(window, floodMessages(window, 5_000))
    expect(corpus.admittedMessageCount).toBe(CORPUS_LIMITS.maxMessagesPerWindow)
    expect(corpus.estimatedTokens).toBeLessThanOrEqual(CORPUS_LIMITS.maxTokensPerWindow)
    expect(estimateTokens(corpus.renderedText)).toBeLessThanOrEqual(
      CORPUS_LIMITS.maxTokensPerWindow * 2,
    )
  })

  it('binds the token ceiling before the message cap when messages are long', () => {
    const long = 'x'.repeat(4_000)
    const messages = Array.from({ length: 400 }, (_, i) =>
      message(window, i, `${String(i)} ${long}`),
    )
    const corpus = assembleCorpus(window, messages)
    expect(corpus.estimatedTokens).toBeLessThanOrEqual(CORPUS_LIMITS.maxTokensPerWindow)
    expect(corpus.admittedMessageCount).toBeLessThan(CORPUS_LIMITS.maxMessagesPerWindow)
    expect(corpus.caps.byTokenCeiling).toBeGreaterThan(0)
  })

  it('refuses a message bound to another coin', () => {
    const stray = message(window, 0, 'hello', { boundCoinRef: OTHER_COIN })
    expect(() => assembleCorpus(window, [stray])).toThrow(CorpusBindingError)
  })

  it('excludes messages outside the window', () => {
    const before = message(window, 0, 'too early', { postedAtUnix: window.startUnix - 1 })
    const after = message(window, 1, 'too late', { postedAtUnix: window.endUnix })
    const inside = message(window, 2, 'just right', { postedAtUnix: window.startUnix })
    const corpus = assembleCorpus(window, [before, after, inside])
    expect(corpus.admittedMessageCount).toBe(1)
    expect(corpus.droppedMessageCount).toBe(0)
  })
})

describe('inference cost is a function of the caps, not of the input', () => {
  const window = testWindow()

  it('assembles 500 and 500,000 messages to the same size', () => {
    const small = assembleCorpus(window, floodMessages(window, 500))
    const flood = assembleCorpus(window, floodMessages(window, 500_000))

    expect(small.admittedMessageCount).toBe(CORPUS_LIMITS.maxMessagesPerWindow)
    expect(flood.admittedMessageCount).toBe(small.admittedMessageCount)
    expect(flood.distinctAuthorCount).toBe(small.distinctAuthorCount)
    expect(flood.estimatedTokens).toBe(small.estimatedTokens)
    expect(flood.renderedText.length).toBe(small.renderedText.length)

    // The flood is visible, but only as a number.
    expect(small.droppedMessageCount).toBe(100)
    expect(flood.droppedMessageCount).toBe(499_600)
  })

  it('bills identically for both', async () => {
    const userIdHash = hashUserId(SALT, COIN)

    const run = async (count: number): Promise<number> => {
      const client = new FakeModelClient(() => textReply(VALID_EMISSION))
      const corpus = assembleCorpus(window, floodMessages(window, count))
      const result = await new Reader(client).read(corpus, userIdHash)
      return priceUsd(MODEL.haiku45, result.usage)
    }

    const [small, flood] = await Promise.all([run(500), run(500_000)])
    expect(flood).toBe(small)
    expect(flood).toBeGreaterThan(0)
  })

  it('sends the reader a turn whose length does not depend on the flood size', () => {
    const client = new FakeModelClient(() => textReply(VALID_EMISSION))
    const reader = new Reader(client)
    const userIdHash = hashUserId(SALT, COIN)

    const small = reader.buildRequest(
      assembleCorpus(window, floodMessages(window, 500)),
      userIdHash,
    )
    const flood = reader.buildRequest(
      assembleCorpus(window, floodMessages(window, 500_000)),
      userIdHash,
    )
    expect(flood.userText.length).toBe(small.userText.length)
    expect(flood.system).toEqual(small.system)
  })
})

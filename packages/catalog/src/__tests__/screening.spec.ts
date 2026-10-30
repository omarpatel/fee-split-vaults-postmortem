/**
 * The screening seed data and its loaders.
 */
import { describe, expect, it } from 'vitest'
import { CatalogError } from '../errors.js'
import {
  DrainerHostList,
  HashedLexicon,
  hashTerm,
  hostMatches,
  loadScreeningSeed,
  normalizeTerm,
  parseDrainerDomainFile,
  parseHashedLexicon,
  parseMarkList,
  parseRefreshPolicy,
  RefreshPolicy,
  TERM_NORMALIZATION,
} from '../screening.js'

const seed = loadScreeningSeed()

describe('term normalisation is a published contract', () => {
  it('folds case, diacritics and punctuation to one canonical form', () => {
    expect(normalizeTerm('  Héllo,   WORLD!! ')).toBe('hello world')
    expect(normalizeTerm('N-I-K-E')).toBe('n i k e')
    expect(normalizeTerm('ＦＵＬＬＷＩＤＴＨ')).toBe('fullwidth')
  })

  it('binds the hash to the normalisation, so a changed rule cannot silently miss', () => {
    expect(TERM_NORMALIZATION).toBe('nfkd-lower-strip-diacritics-alnum-space@v1')
    expect(hashTerm('Hello World')).toBe(hashTerm('  hello   world  '))
    expect(hashTerm('hello world')).not.toBe(hashTerm('hello  worlds'))
  })

  it('refuses to hash a term that normalises to nothing', () => {
    expect(() => hashTerm('!!!')).toThrow(/empty_term/)
  })
})

describe('the hashed lexicon', () => {
  it('ships unconfigured, which forbids paid media until an operator list is loaded', () => {
    expect(seed.hashedLexicon.isConfigured).toBe(false)
    expect(seed.hashedLexicon.size).toBe(0)
    expect(seed.hashedLexiconFile.status).toBe('unconfigured')
  })

  it('publishes hate terms in plaintext and never a slur', () => {
    expect(seed.hashedLexiconFile.plaintextPhrases.length).toBeGreaterThan(0)
    for (const phrase of seed.hashedLexiconFile.plaintextPhrases) {
      // The parser already forbids category "slur" here; this asserts the
      // property that makes publishing safe, which is distinctiveness. A short
      // single word would be either a slur or a false-positive generator.
      expect(phrase.category).toBe('hate')
      const normalized = normalizeTerm(phrase.term)
      const distinctive = normalized.includes(' ') || normalized.length >= 8
      expect(distinctive).toBe(true)
    }
  })

  it('refuses a plaintext term inside the hashed list', () => {
    expect(() =>
      parseHashedLexicon(
        {
          schemaVersion: 1,
          algorithm: 'sha256',
          normalization: TERM_NORMALIZATION,
          status: 'configured',
          revision: 'x',
          publishedAtUnix: 1,
          entries: [{ id: 'a', category: 'slur', termHash: 'f'.repeat(64), tokenCount: 1, term: 'x' }],
          plaintextPhrases: [],
        },
        'test',
      ),
    ).toThrow(/plaintext_term_in_hashed_list/)
  })

  it('refuses a slur published in plaintext', () => {
    expect(() =>
      parseHashedLexicon(
        {
          schemaVersion: 1,
          algorithm: 'sha256',
          normalization: TERM_NORMALIZATION,
          status: 'unconfigured',
          revision: 'x',
          publishedAtUnix: 1,
          entries: [],
          plaintextPhrases: [{ term: 'anything', category: 'slur' }],
        },
        'test',
      ),
    ).toThrow(/plaintext_slur/)
  })

  it('refuses a list built under a different normalisation', () => {
    expect(() =>
      parseHashedLexicon(
        {
          schemaVersion: 1,
          algorithm: 'sha256',
          normalization: 'something-else@v3',
          status: 'unconfigured',
          revision: 'x',
          publishedAtUnix: 1,
          entries: [],
          plaintextPhrases: [],
        },
        'test',
      ),
    ).toThrow(/normalization_mismatch/)
  })

  it('refuses a list that claims to be configured while holding nothing', () => {
    expect(() =>
      parseHashedLexicon(
        {
          schemaVersion: 1,
          algorithm: 'sha256',
          normalization: TERM_NORMALIZATION,
          status: 'configured',
          revision: 'x',
          publishedAtUnix: 1,
          entries: [],
          plaintextPhrases: [],
        },
        'test',
      ),
    ).toThrow(/configured_but_empty/)
  })

  it('matches an n-gram without ever holding the string', () => {
    // Built here, in the test, so the repository still contains no list.
    const file = parseHashedLexicon(
      {
        schemaVersion: 1,
        algorithm: 'sha256',
        normalization: TERM_NORMALIZATION,
        status: 'configured',
        revision: 'test',
        publishedAtUnix: 1,
        entries: [
          { id: 's1', category: 'slur', termHash: hashTerm('fizzbuzz'), tokenCount: 1 },
          { id: 's2', category: 'hate', termHash: hashTerm('two word term'), tokenCount: 3 },
        ],
        plaintextPhrases: [],
      },
      'test',
    )
    const lexicon = new HashedLexicon(file)
    expect(lexicon.isConfigured).toBe(true)
    expect(lexicon.hasTerm('FizzBuzz')).toBe(true)
    expect(lexicon.hasTerm('fizz buzz')).toBe(false)

    const hits = lexicon.scan('a coin called Fizz-Buzz, no: FIZZBUZZ and a two word term here')
    expect(hits.map((hit) => hit.entryId).sort()).toEqual(['s1', 's2'])
    // Offsets point into the original text; the term itself is never returned.
    const first = hits.find((hit) => hit.entryId === 's1')
    expect(first).toBeDefined()
    expect(Object.keys(first ?? {})).toEqual(['entryId', 'category', 'startOffset', 'endOffset'])
  })
})

describe('the mark list', () => {
  it('carries trademarks and public figures and nothing else', () => {
    expect(seed.marks.entries.length).toBeGreaterThan(50)
    for (const entry of seed.marks.entries) {
      expect(['trademark', 'public_figure']).toContain(entry.category)
    }
  })

  it('sets the boundary rule explicitly on every short mark', () => {
    for (const entry of seed.marks.entries) {
      if (normalizeTerm(entry.term).replace(/ /g, '').length >= 6) continue
      expect(entry.requireBoundary).toBe(true)
    }
  })

  it('lists the marks this business is most likely to be complained about', () => {
    const terms = seed.marks.entries.map((entry) => entry.term)
    expect(terms).toContain('robinhood')
    expect(terms).toContain('venue')
  })

  it('refuses a hate term smuggled into the mark list', () => {
    expect(() =>
      parseMarkList(
        {
          schemaVersion: 1,
          revision: 'x',
          publishedAtUnix: 1,
          entries: [{ term: 'something awful', category: 'hate' }],
        },
        'test',
      ),
    ).toThrow(/bad_category/)
  })

  it('refuses a short mark with no boundary decision', () => {
    expect(() =>
      parseMarkList(
        { schemaVersion: 1, revision: 'x', publishedAtUnix: 1, entries: [{ term: 'acme', category: 'trademark' }] },
        'test',
      ),
    ).toThrow(/short_mark_without_boundary_decision/)
  })

  it('refuses a duplicate mark', () => {
    expect(() =>
      parseMarkList(
        {
          schemaVersion: 1,
          revision: 'x',
          publishedAtUnix: 1,
          entries: [
            { term: 'Widgetron', category: 'trademark' },
            { term: 'widgetron', category: 'trademark' },
          ],
        },
        'test',
      ),
    ).toThrow(/duplicate_mark/)
  })
})

describe('the drainer host list', () => {
  it('ships unconfigured with the structural half loaded', () => {
    expect(seed.drainerHosts.isConfigured).toBe(false)
    expect(seed.drainerHosts.blockedHosts).toEqual([])
    expect(seed.drainerHosts.structural.blockPunycodeHosts).toBe(true)
    expect(seed.drainerHosts.structural.blockRawIpHosts).toBe(true)
    expect(seed.drainerHosts.structural.funnelPathTokens).toContain('claim')
    expect(seed.drainerHosts.structural.funnelPathTokens).toContain('seedphrase')
  })

  it('names the feeds it expects to ingest, even before any have been loaded', () => {
    expect(seed.drainerFile.feeds.length).toBeGreaterThanOrEqual(2)
    for (const feed of seed.drainerFile.feeds) {
      expect(feed.cadence.length).toBeGreaterThan(0)
      expect(feed.uri.length).toBeGreaterThan(0)
    }
  })

  it('categorises shorteners without accusing anyone of anything', () => {
    expect(seed.drainerHosts.isShortener('bit.ly')).toBe(true)
    expect(seed.drainerHosts.isShortener('sub.bit.ly')).toBe(true)
    expect(seed.drainerHosts.isShortener('bitly.example')).toBe(false)
  })

  it('refuses a blocked host that does not cite the feed it came from', () => {
    expect(() =>
      parseDrainerDomainFile(
        {
          schemaVersion: 1,
          status: 'configured',
          revision: 'x',
          publishedAtUnix: 1,
          structural: {
            blockPunycodeHosts: true,
            blockRawIpHosts: true,
            blockShorteners: true,
            maxLookalikeEditDistance: 2,
            funnelPathTokens: ['claim'],
          },
          shorteners: [],
          feeds: [{ id: 'f1', uri: 'https://example.test/list', format: 'json_array', cadence: 'daily' }],
          operatorEntries: [{ host: 'bad.example', addedAtUnix: 1, sourceFeedId: 'nope' }],
        },
        'test',
      ),
    ).toThrow(/unknown_feed/)
  })

  it('refuses a list with no ingest feed declared', () => {
    expect(() =>
      parseDrainerDomainFile(
        {
          schemaVersion: 1,
          status: 'unconfigured',
          revision: 'x',
          publishedAtUnix: 1,
          structural: {
            blockPunycodeHosts: true,
            blockRawIpHosts: true,
            blockShorteners: true,
            maxLookalikeEditDistance: 2,
            funnelPathTokens: ['claim'],
          },
          shorteners: [],
          feeds: [],
          operatorEntries: [],
        },
        'test',
      ),
    ).toThrow(/no_feeds/)
  })

  it('matches a host and its subdomains, and nothing that merely looks similar', () => {
    const list = new DrainerHostList({
      ...seed.drainerFile,
      status: 'configured',
      operatorEntries: [
        { host: 'bad.example', addedAtUnix: 1, sourceFeedId: seed.drainerFile.feeds[0]?.id ?? 'x' },
      ],
    })
    expect(list.isBlocked('bad.example')).toBe(true)
    expect(list.isBlocked('claim.bad.example')).toBe(true)
    expect(list.isBlocked('notbad.example')).toBe(false)
    expect(hostMatches('a.b.c', 'b.c')).toBe(true)
  })
})

describe('the refresh policy', () => {
  it('governs every list this package ships', () => {
    for (const listId of ['ofac_sdn', 'hate_lexicon', 'marks', 'drainer_domains']) {
      expect(seed.refreshPolicy.listIds).toContain(listId)
    }
  })

  it('gives every list a machine-enforced budget and a refusal on staleness', () => {
    for (const rule of seed.refreshPolicyFile.rules) {
      expect(rule.maxAgeSeconds).toBeGreaterThan(0)
      expect(rule.cadence.length).toBeGreaterThan(0)
      expect(['block_paid_media', 'block_all_screening', 'block_link_posting', 'refuse_clear']).toContain(
        rule.onStale,
      )
    }
  })

  it('matches the SDN staleness window packages/screening enforces', () => {
    expect(seed.refreshPolicy.rule('ofac_sdn').maxAgeSeconds).toBe(7 * 24 * 60 * 60)
    expect(seed.refreshPolicy.rule('ofac_sdn').onStale).toBe('refuse_clear')
  })

  it('gives drainer hosts the shortest budget, because they rotate in hours', () => {
    const drainer = seed.refreshPolicy.rule('drainer_domains').maxAgeSeconds
    expect(drainer).toBeLessThan(seed.refreshPolicy.rule('hate_lexicon').maxAgeSeconds)
    expect(drainer).toBeLessThanOrEqual(2 * 24 * 60 * 60)
  })

  it('fails closed on a list with no rule at all', () => {
    expect(() => seed.refreshPolicy.rule('some_list_nobody_declared')).toThrow(CatalogError)
    expect(() => seed.refreshPolicy.rule('some_list_nobody_declared')).toThrow(/no_refresh_rule/)
  })

  it('computes staleness against the list\'s own publication time', () => {
    const policy = new RefreshPolicy(
      parseRefreshPolicy(
        {
          schemaVersion: 1,
          publishedAtUnix: 1,
          rules: [
            {
              listId: 'x',
              cadence: 'daily',
              maxAgeSeconds: 100,
              source: 'test',
              onStale: 'refuse_clear',
            },
          ],
        },
        'test',
      ),
    )
    expect(policy.isStale('x', 1_000, 1_100)).toBe(false)
    expect(policy.isStale('x', 1_000, 1_101)).toBe(true)
  })
})

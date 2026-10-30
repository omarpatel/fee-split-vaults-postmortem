import { describe, expect, it } from 'vitest'

import { narrativeSourceProblem, normalizeNarrativeSources, normalizeXHandle } from '../onboarding.js'

describe('the narrative source rule, mirrored from apps/api', () => {
  it('accepts a plain https URL on a public host', () => {
    expect(narrativeSourceProblem('https://hydrant.example/launch')).toBeNull()
    expect(narrativeSourceProblem('https://x.com/hydrant/status/1')).toBeNull()
  })

  it.each([
    ['http://hydrant.example/launch', 'insecure_scheme'],
    ['https://user:pw@hydrant.example/', 'url_carries_credentials'],
    ['https://hydrant.example:8443/', 'url_has_explicit_port'],
    ['https://127.0.0.1/', 'ip_literal_host'],
    ['https://[::1]/', 'ip_literal_host'],
    ['https://xn--hydrnt-6ya.example/', 'punycode_host'],
    ['https://localhost/', 'host_not_public'],
    ['hydrant.example/launch', 'unparseable_url'],
    ['https://hydrant.example/a b', 'url_whitespace'],
  ])('refuses %s as %s', (url, problem) => {
    expect(narrativeSourceProblem(url)).toBe(problem)
  })
})

describe('normalising what the dev typed', () => {
  it('drops blanks and duplicates but keeps order', () => {
    expect(
      normalizeNarrativeSources(['', ' https://a.example/ ', 'https://b.example/', 'https://a.example/']),
    ).toEqual(['https://a.example/', 'https://b.example/'])
  })

  it('strips the @ from a handle and refuses one the API would', () => {
    expect(normalizeXHandle('@hydrant_ops')).toBe('hydrant_ops')
    expect(normalizeXHandle('hydrant_ops')).toBe('hydrant_ops')
    expect(normalizeXHandle('')).toBeNull()
    expect(normalizeXHandle('has space')).toBeNull()
    expect(normalizeXHandle('@sixteen_chars_xx')).toBeNull()
  })
})

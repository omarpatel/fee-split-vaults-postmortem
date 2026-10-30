import { describe, expect, it } from 'vitest'
import {
  FakeCsamHashProvider,
  FakeMatcher,
  ImageNotServable,
  ImageServeGate,
  InMemoryCsamEscalationSink,
  runStage2,
  type Stage2Deps,
} from '../stage2.js'
import { makeSubject, type ImageRef } from '../types.js'
import { NOW, metadata, testEngine } from './fixtures.js'

const clean: ImageRef = { id: 'img-1', sha256: 'a'.repeat(64), byteLength: 1024, mimeType: 'image/png' }
const known: ImageRef = { id: 'img-2', sha256: 'b'.repeat(64), byteLength: 2048, mimeType: 'image/png' }
const broken: ImageRef = { id: 'img-3', sha256: 'c'.repeat(64), byteLength: 512, mimeType: 'image/png' }

function gateFor(): {
  gate: ImageServeGate
  escalation: InMemoryCsamEscalationSink
  provider: FakeCsamHashProvider
} {
  const provider = new FakeCsamHashProvider(
    new Set([known.sha256]),
    new Set([broken.sha256]),
    () => NOW,
  )
  const escalation = new InMemoryCsamEscalationSink()
  return { gate: new ImageServeGate(provider, escalation), escalation, provider }
}

describe('the child-safety hash check is mandatory before serving', () => {
  it('refuses to serve an image that was never checked', () => {
    const { gate } = gateFor()
    expect(() => gate.assertServable(clean, NOW)).toThrow(ImageNotServable)
    expect(() => gate.assertServable(clean, NOW)).toThrow(/unchecked/)
  })

  it('permits serving only after a completed negative check', async () => {
    const { gate } = gateFor()
    await gate.check(clean, NOW, '0xtoken')
    expect(() => gate.assertServable(clean, NOW)).not.toThrow()
  })

  it('expires a stale check rather than trusting it forever', async () => {
    const { gate } = gateFor()
    await gate.check(clean, NOW, '0xtoken')
    expect(() => gate.assertServable(clean, NOW + 31 * 24 * 60 * 60)).toThrow(/expired/)
  })

  it('blocks, escalates out of band, and never serves on a hash match', async () => {
    const { gate, escalation } = gateFor()
    const result = await gate.check(known, NOW, '0xtoken')

    expect(result.verdict).toBe('match')
    expect(escalation.reports).toHaveLength(1)
    expect(escalation.reports[0]?.imageSha256).toBe(known.sha256)
    expect(() => gate.assertServable(known, NOW)).toThrow(/hash_match/)
  })

  it('caches by content hash, so re-uploading the same bytes cannot skip the check', async () => {
    const { gate, provider } = gateFor()
    await gate.check(clean, NOW, '0xtoken')
    await gate.check({ ...clean, id: 'renamed' }, NOW, '0xtoken')
    expect(provider.checked).toHaveLength(1)
  })

  it('fails closed when the provider is unreachable', async () => {
    const { gate } = gateFor()
    await expect(gate.check(broken, NOW, '0xtoken')).rejects.toThrow()
    expect(() => gate.assertServable(broken, NOW)).toThrow(/unchecked/)
  })
})

describe('runStage2', () => {
  function harness(extra: { logos?: FakeMatcher; faces?: FakeMatcher } = {}): {
    deps: Stage2Deps
    gate: ImageServeGate
  } {
    const csam = new FakeCsamHashProvider(
      new Set([known.sha256]),
      new Set([broken.sha256]),
      () => NOW,
    )
    const escalation = new InMemoryCsamEscalationSink()
    const deps: Stage2Deps = { csam, escalation, maxEvidenceChars: 96, ...extra }
    return { deps, gate: new ImageServeGate(csam, escalation) }
  }

  it('raises a block flag on a hash match', async () => {
    const { deps, gate } = harness()
    const output = await runStage2(makeSubject(metadata({ imageRefs: [known] })), deps, gate, NOW)
    expect(output.flags.map((f) => f.code)).toEqual(['csam_hash_match'])
    expect(output.stages).toEqual(['perceptual'])
  })

  it('raises unavailable and unscreened when the provider errors', async () => {
    const { deps, gate } = harness()
    const output = await runStage2(makeSubject(metadata({ imageRefs: [broken] })), deps, gate, NOW)
    expect(output.flags.map((f) => f.code)).toEqual(['perceptual_unavailable', 'image_unscreened'])
  })

  it('applies score thresholds to logo and face matches', async () => {
    const { deps, gate } = harness({
      logos: new FakeMatcher(new Map([[clean.sha256, [{ id: 'brand:nintendo', score: 0.91 }]]])),
      faces: new FakeMatcher(new Map([[clean.sha256, [{ id: 'person:someone', score: 0.5 }]]])),
    })
    const output = await runStage2(makeSubject(metadata({ imageRefs: [clean] })), deps, gate, NOW)
    expect(output.flags.map((f) => f.code)).toEqual(['logo_match'])
  })

  it('runs no stage at all when there are no images', async () => {
    const { deps, gate } = harness()
    const output = await runStage2(makeSubject(metadata()), deps, gate, NOW)
    expect(output).toEqual({ stages: [], flags: [] })
  })
})

describe('the engine refuses images it cannot screen', () => {
  it('flags image_unscreened when no perceptual plane is configured', async () => {
    const engine = testEngine()
    const report = await engine.screen(metadata({ imageRefs: [clean] }))
    expect(report.flags.map((f) => f.code)).toContain('image_unscreened')
    expect(report.verdict).toBe('RESTRICTED')
  })

  it('escalates out of band on a child-safety hit found through the engine', async () => {
    const escalation = new InMemoryCsamEscalationSink()
    const engine = testEngine({
      perceptual: {
        csam: new FakeCsamHashProvider(new Set([known.sha256]), new Set(), () => NOW),
        escalation,
      },
    })

    const report = await engine.screen(metadata({ imageRefs: [known] }))

    expect(report.verdict).toBe('BLOCKED')
    expect(engine.needsOutOfBandEscalation(report)).toBe(true)
    expect(escalation.reports).toHaveLength(1)
  })
})

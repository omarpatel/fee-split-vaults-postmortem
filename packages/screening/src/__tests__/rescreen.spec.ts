import { describe, expect, it } from 'vitest'
import { InMemoryDeclineList } from '../declineList.js'
import {
  DEFAULT_RESCREEN_CONFIG,
  FakeMetadataSource,
  InMemoryRescreenStore,
  RescreenWatcher,
} from '../rescreen.js'
import { InMemoryScreeningHistory } from '../pipeline.js'
import { NOW, metadata, testEngine } from './fixtures.js'

function watcherFor(): {
  watcher: RescreenWatcher
  source: FakeMetadataSource
  store: InMemoryRescreenStore
  declines: InMemoryDeclineList
} {
  const engine = testEngine({ history: new InMemoryScreeningHistory() })
  const source = new FakeMetadataSource()
  const store = new InMemoryRescreenStore()
  const declines = new InMemoryDeclineList()
  return {
    watcher: new RescreenWatcher(engine, source, store, declines, DEFAULT_RESCREEN_CONFIG),
    source,
    store,
    declines,
  }
}

describe('continuous re-screening', () => {
  it('detects a metadata change and re-runs the whole pipeline', async () => {
    const { watcher, source } = watcherFor()
    const clean = metadata({ metadataMutable: true })
    source.set(clean)

    const first = await watcher.check(clean.token, NOW)
    expect(first.currentVerdict).toBe('CLEAR')
    expect(first.changed).toBe(false)

    source.set({ ...clean, name: 'ZORBLAT', description: 'zorblat forever' })
    const second = await watcher.check(clean.token, NOW + 60)

    expect(second.changed).toBe(true)
    expect(second.worsened).toBe(true)
    expect(second.previousVerdict).toBe('CLEAR')
    expect(second.currentVerdict).toBe('BLOCKED')
  })

  it('halts everything, publishes a decline, and releases the dev fees on a new block', async () => {
    const { watcher, source, declines } = watcherFor()
    const clean = metadata({ metadataMutable: true })
    source.set(clean)
    await watcher.check(clean.token, NOW)

    source.set({ ...clean, name: 'Official Disney Coin' })
    const outcome = await watcher.check(clean.token, NOW + 60)

    expect(outcome.actions).toContain('halt_all_publishing')
    expect(outcome.actions).toContain('publish_decline')
    expect(outcome.actions).toContain('release_dev_fees')

    const published = await declines.list()
    expect(published).toHaveLength(1)
    expect(published[0]?.devKeepsAllFees).toBe(true)
  })

  it('requeues human review when a clean subject is rewritten, even cleanly', async () => {
    const { watcher, source } = watcherFor()
    const clean = metadata({ metadataMutable: true })
    source.set(clean)
    await watcher.check(clean.token, NOW)

    source.set({ ...clean, description: 'Now with a completely different, still clean, pitch.' })
    const outcome = await watcher.check(clean.token, NOW + 60)

    expect(outcome.currentVerdict).toBe('CLEAR')
    expect(outcome.changed).toBe(true)
    expect(outcome.actions).toContain('requeue_human_review')
  })

  it('halts paid media but not organic operations on a RESTRICTED rewrite', async () => {
    const { watcher, source } = watcherFor()
    const clean = metadata({ metadataMutable: true })
    source.set(clean)
    await watcher.check(clean.token, NOW)

    source.set({ ...clean, name: 'Nintendo Fan Coin' })
    const outcome = await watcher.check(clean.token, NOW + 60)

    expect(outcome.currentVerdict).toBe('RESTRICTED')
    expect(outcome.actions).toContain('halt_paid_media')
    expect(outcome.actions).not.toContain('halt_all_publishing')
  })
})

describe('re-screening cadence', () => {
  it('puts mutable metadata on a much tighter clock than immutable metadata', async () => {
    const { watcher, source, store } = watcherFor()
    const mutable = metadata({ metadataMutable: true })
    const immutable = metadata({
      token: '0x00000000000000000000000000000000000000bb',
      metadataMutable: false,
    })
    source.set(mutable)
    source.set(immutable)

    await watcher.check(mutable.token, NOW)
    await watcher.check(immutable.token, NOW)

    const mutableState = store.get(mutable.token)
    const immutableState = store.get(immutable.token)
    expect(mutableState?.nextDueAtUnix).toBe(NOW + DEFAULT_RESCREEN_CONFIG.mutableIntervalSeconds)
    expect(immutableState?.nextDueAtUnix).toBe(NOW + DEFAULT_RESCREEN_CONFIG.intervalSeconds)
  })

  it('checks every token whose cadence has elapsed', async () => {
    const { watcher, source } = watcherFor()
    const subject = metadata({ metadataMutable: true })
    source.set(subject)
    await watcher.check(subject.token, NOW)

    expect(await watcher.checkDue(NOW)).toHaveLength(0)
    const due = await watcher.checkDue(NOW + DEFAULT_RESCREEN_CONFIG.mutableIntervalSeconds)
    expect(due).toHaveLength(1)
    expect(due[0]?.token).toBe(subject.token)
  })
})

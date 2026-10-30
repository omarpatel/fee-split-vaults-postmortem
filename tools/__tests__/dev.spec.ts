/**
 * The staleness check `npm run dev` uses before it starts apps/api.
 *
 * It matters more than a convenience: `node apps/api/dist/main.js` against a
 * stale dist runs YESTERDAY'S code with today's configuration, and the symptom
 * is a config error for a variable the current source no longer reads. The
 * check is deliberately conservative -- it rebuilds when unsure -- because a
 * spare `tsc --build` costs seconds and a stale binary costs an afternoon.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEV_SPEC, apiBuildIsStale, newestMtimeMs } from '../dev.ts'

const roots: string[] = []

function fakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'venue-dev-'))
  roots.push(root)
  mkdirSync(join(root, 'apps', 'api', 'src'), { recursive: true })
  mkdirSync(join(root, 'apps', 'api', 'dist'), { recursive: true })
  return root
}

/** Sets an mtime a whole number of seconds from the epoch, avoiding fs precision. */
function touch(path: string, contents: string, epochSeconds: number): void {
  writeFileSync(path, contents, 'utf8')
  utimesSync(path, epochSeconds, epochSeconds)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('apiBuildIsStale', () => {
  it('is stale when dist/main.js does not exist at all', () => {
    const root = fakeRepo()
    touch(join(root, 'apps', 'api', 'src', 'main.ts'), 'x', 1_000)
    expect(apiBuildIsStale(root)).toBe(true)
  })

  it('is stale when a source file is newer than the build', () => {
    const root = fakeRepo()
    touch(join(root, 'apps', 'api', 'dist', 'main.js'), 'built', 1_000)
    touch(join(root, 'apps', 'api', 'src', 'main.ts'), 'edited', 2_000)
    expect(apiBuildIsStale(root)).toBe(true)
  })

  it('is stale for a change in a NESTED source directory, not just the top level', () => {
    const root = fakeRepo()
    touch(join(root, 'apps', 'api', 'dist', 'main.js'), 'built', 2_000)
    mkdirSync(join(root, 'apps', 'api', 'src', 'http'), { recursive: true })
    touch(join(root, 'apps', 'api', 'src', 'http', 'server.ts'), 'edited', 3_000)
    expect(apiBuildIsStale(root)).toBe(true)
  })

  it('is fresh when the build is newer than every source file', () => {
    const root = fakeRepo()
    touch(join(root, 'apps', 'api', 'src', 'main.ts'), 'x', 1_000)
    touch(join(root, 'apps', 'api', 'dist', 'main.js'), 'built', 2_000)
    expect(apiBuildIsStale(root)).toBe(false)
  })

  it('ignores __tests__, which tsc does not emit and which would rebuild forever', () => {
    const root = fakeRepo()
    touch(join(root, 'apps', 'api', 'dist', 'main.js'), 'built', 2_000)
    mkdirSync(join(root, 'apps', 'api', 'src', '__tests__'), { recursive: true })
    touch(join(root, 'apps', 'api', 'src', '__tests__', 'x.spec.ts'), 'test', 9_000)
    expect(apiBuildIsStale(root)).toBe(false)
  })
})

describe('newestMtimeMs', () => {
  it('is 0 for a directory that does not exist, so a missing tree never looks fresh', () => {
    expect(newestMtimeMs(join(tmpdir(), 'venue-does-not-exist-9f3a'))).toBe(0)
  })
})

describe('the dev command surface', () => {
  it('defaults apps/web to its fixture backend and says why in --help', () => {
    const webApi = DEV_SPEC.options.find((o) => o.name === 'web-api')
    expect(webApi?.default).toBeUndefined()
    expect(webApi?.describe).toMatch(/OFF by default: .+/)
  })

  it('offers a way to run either half alone', () => {
    const names = DEV_SPEC.options.map((o) => o.name)
    expect(names).toContain('no-web')
    expect(names).toContain('no-api')
  })

  it('renders a usage line someone can actually type', () => {
    expect(DEV_SPEC.usage).toContain('npm run dev')
  })
})

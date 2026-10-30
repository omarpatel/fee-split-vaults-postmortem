/**
 * Repository scanning primitives shared by the CI gates.
 *
 * Deliberately dependency-free: these run in CI before anything is installed
 * beyond the workspace itself, and a lint gate that needs a package manager to
 * work is a lint gate that gets skipped on the day it matters.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** For a build artefact, the .ts path it would have come from. */
export function compiledSiblingSource(path: string): string | undefined {
  for (const [suffix, source] of [
    ['.d.ts.map', '.ts'],
    ['.js.map', '.ts'],
    ['.d.ts', '.ts'],
    ['.js', '.ts'],
  ] as const) {
    if (path.endsWith(suffix)) return `${path.slice(0, -suffix.length)}${source}`
  }
  return undefined
}

/** Directories never worth scanning. Build output, caches and vendored code. */
export const DEFAULT_EXCLUDED_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'out',
  'cache',
  // `.cache` and `.checkpoints`, not just `cache`. The measurement tools write
  // their eth_getLogs cache to `tools/.cache` (VENUE_CACHE_DIR) and resumable
  // scan state to `tools/.checkpoints`, and the leading dot meant neither was
  // excluded: `tools/.cache` alone held 5,550 files here — about 91% of
  // everything the rate gate scanned — and it grows with every run.
  //
  // Two things were wrong with that, and only one of them was cosmetic. The
  // scan got slower forever, AND the gate's answer depended on what the person
  // running it happened to have measured: a cached RPC response containing
  // `0.007` is a phantom violation at a path nobody edits. README.md flagged
  // this and left it open; this is the one-line fix it asked for.
  '.cache',
  '.checkpoints',
  'lib', // contracts/lib holds vendored Solidity (forge-std)
  '.next',
  '.turbo',
] as const

export interface CollectOptions {
  root: string
  /** Lowercase, with the dot. Empty means every extension. */
  extensions?: readonly string[]
  excludedDirs?: readonly string[]
  /** Repo-relative path prefixes to skip entirely. */
  excludedPaths?: readonly string[]
  maxFileBytes?: number
  /**
   * Skip a .js / .d.ts / .map that sits beside a same-named .ts.
   *
   * ops/ and config/ compile in place, so their build output shares a directory
   * with its source. Scanning both doubles every finding and, worse, reports a
   * violation at a path nobody edits. Defaults to true.
   */
  skipCompiledSiblings?: boolean
}

export interface ScannedFile {
  /** Repo-relative, forward slashes, stable across platforms. */
  path: string
  absolutePath: string
  bytes: number
}

export function toPosix(path: string): string {
  return path.split(sep).join('/')
}

export function collectFiles(options: CollectOptions): ScannedFile[] {
  const excludedDirs = new Set(options.excludedDirs ?? DEFAULT_EXCLUDED_DIRS)
  const excludedPaths = options.excludedPaths ?? []
  const extensions = options.extensions
  const maxFileBytes = options.maxFileBytes ?? 2_000_000
  const skipCompiled = options.skipCompiledSiblings ?? true
  const out: ScannedFile[] = []

  const isCompiledSibling = (absolute: string): boolean => {
    const source = compiledSiblingSource(absolute)
    return source !== undefined && existsSync(source)
  }

  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries.sort()) {
      const absolute = join(dir, entry)
      let stats
      try {
        stats = statSync(absolute)
      } catch {
        continue
      }
      const relPath = toPosix(relative(options.root, absolute))
      if (excludedPaths.some((prefix) => relPath === prefix || relPath.startsWith(`${prefix}/`))) continue
      if (stats.isDirectory()) {
        if (excludedDirs.has(entry)) continue
        walk(absolute)
        continue
      }
      if (!stats.isFile()) continue
      if (stats.size > maxFileBytes) continue
      if (skipCompiled && isCompiledSibling(absolute)) continue
      if (extensions && extensions.length > 0) {
        const dot = entry.lastIndexOf('.')
        const ext = dot === -1 ? '' : entry.slice(dot).toLowerCase()
        if (!extensions.includes(ext)) continue
      }
      out.push({ path: relPath, absolutePath: absolute, bytes: stats.size })
    }
  }

  walk(options.root)
  return out
}

export function readTextFile(absolutePath: string): string {
  return readFileSync(absolutePath, 'utf8')
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Minimal glob: `*` matches within a path segment, `**` matches across
 * segments, everything else is literal. Enough for an allowlist, and small
 * enough to be read and trusted.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '^'
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` should also match zero directories.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (ch === undefined) break
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    i += 1
  }
  out += '$'
  return new RegExp(out)
}

export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path)
}

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

export type SourceLanguage = 'c-like' | 'sql' | 'hash' | 'none'

export function languageFor(path: string): SourceLanguage {
  if (/\.(ts|tsx|js|jsx|mjs|cjs|sol|json|jsonc)$/i.test(path)) return 'c-like'
  if (/\.sql$/i.test(path)) return 'sql'
  if (/\.(ya?ml|toml|sh|dockerfile)$/i.test(path) || /(^|\/)Dockerfile[^/]*$/i.test(path)) return 'hash'
  return 'none'
}

/**
 * Replace comment bodies with spaces, preserving line and column positions so a
 * reported line number still points at the right line.
 *
 * String-literal aware, which matters: `'https://example.com'` must not be read
 * as the start of a line comment, or everything after it on the line would be
 * invisible to the scanner and a violation could hide behind a URL.
 */
export function stripComments(source: string, language: SourceLanguage): string {
  if (language === 'none') return source
  const out = source.split('')
  const n = source.length
  let i = 0

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== '\n') out[k] = ' '
    }
  }

  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]

    if (ch === '"' || ch === "'" || (language === 'c-like' && ch === '`')) {
      const quote = ch
      let j = i + 1
      while (j < n) {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === quote) break
        // An unterminated single-quoted string is far more likely to be an
        // apostrophe in prose than a real literal; stop at the newline.
        if (source[j] === '\n' && quote !== '`') break
        j += 1
      }
      i = j + 1
      continue
    }

    if (language === 'c-like' && ch === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      blank(i, end === -1 ? n : end)
      i = end === -1 ? n : end
      continue
    }
    if (language === 'c-like' && ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      blank(i, end === -1 ? n : end + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (language === 'sql' && ch === '-' && next === '-') {
      const end = source.indexOf('\n', i)
      blank(i, end === -1 ? n : end)
      i = end === -1 ? n : end
      continue
    }
    if (language === 'sql' && ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      blank(i, end === -1 ? n : end + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (language === 'hash' && ch === '#') {
      const end = source.indexOf('\n', i)
      blank(i, end === -1 ? n : end)
      i = end === -1 ? n : end
      continue
    }
    i += 1
  }

  return out.join('')
}

/** Split into lines once, so every rule reports the same line numbers. */
export function lines(source: string): string[] {
  return source.split(/\r?\n/)
}

/**
 * Character ranges of quoted string literals on one line, inclusive of quotes.
 *
 * Needed to tell a real `import ... from './x'` from the same text sitting
 * INSIDE a string literal - which is what a test fixture for an import lint
 * looks like, and what the lint would otherwise happily flag in its own tests.
 */
export function stringSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const start = i
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2
          continue
        }
        if (line[j] === ch) break
        j += 1
      }
      // An unterminated quote is far more likely an apostrophe in prose than a
      // literal, so it does not swallow the rest of the line.
      if (j < line.length) {
        spans.push([start, j])
        i = j + 1
        continue
      }
    }
    i += 1
  }
  return spans
}

export function isInsideString(line: string, index: number): boolean {
  return stringSpans(line).some(([start, end]) => index > start && index < end)
}

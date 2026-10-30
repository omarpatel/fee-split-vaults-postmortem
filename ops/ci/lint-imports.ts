/**
 * ESM IMPORT HYGIENE.
 *
 * The repository is Node 22 ESM with `"type": "module"`. Under real ESM
 * resolution a relative specifier is a URL, not a module name: `./x` does not
 * resolve to `./x.js`. TypeScript's `Bundler` resolution hides that at compile
 * time, so an extensionless relative import type-checks cleanly and then throws
 * ERR_MODULE_NOT_FOUND the first time the emitted JavaScript is executed.
 *
 * That failure mode has a nasty property: it only bites on RUNTIME imports.
 * `import type` is erased, so an extensionless type-only import works forever
 * and quietly teaches everyone that the rule is optional - until someone drops
 * the `type` keyword.
 *
 * Two other things checked here, both of which are cheap and both of which have
 * bitten ESM monorepos:
 *   - a relative import that reaches into another package's src/ (bypasses the
 *     package boundary and its build);
 *   - a `.ts` extension in a relative specifier (does not exist after compile).
 *
 * SCOPE. Fails the build only for paths under the --scope prefixes; everything
 * else is reported as a warning. That is so this gate can be introduced without
 * breaking a concurrently developed tree, and the scope can be widened once the
 * existing violations are cleared.
 *
 * Exit codes: 0 clean or warnings only, 1 in-scope violations, 2 could not run.
 */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { collectFiles, isInsideString, lines, readTextFile } from './scan.js'
import { repoRootFromHere } from './no-hardcoded-rates.js'

export type ImportViolationKind =
  | 'missing_js_extension'
  | 'ts_extension'
  | 'cross_package_src_reach'

export interface ImportViolation {
  path: string
  line: number
  kind: ImportViolationKind
  specifier: string
  /** True for `import type` / `export type`, which is erased at compile time. */
  typeOnly: boolean
  inScope: boolean
}

/** Matches static import/export specifiers and dynamic import() calls. */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\b(?:import|export)\s+type\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
  /\b(?:import|export)\b(?![\w$])(?:[^'";]*?\bfrom\s+)?['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

const TYPE_ONLY = /\b(?:import|export)\s+type\b/

const ALLOWED_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json', '.sql', '.css', '.wasm']

export interface LintImportsOptions {
  root: string
  /** Repo-relative prefixes whose violations fail the build. */
  scopes: readonly string[]
}

export function lintImports(options: LintImportsOptions): ImportViolation[] {
  const files = collectFiles({ root: options.root, extensions: ['.ts', '.tsx', '.mts'] })
  const violations: ImportViolation[] = []

  for (const file of files) {
    let source: string
    try {
      source = readTextFile(file.absolutePath)
    } catch {
      continue
    }
    const fileLines = lines(source)
    const inScope = options.scopes.some((prefix) => file.path === prefix || file.path.startsWith(`${prefix}/`))

    for (let index = 0; index < fileLines.length; index += 1) {
      const line = fileLines[index] ?? ''
      if (!line.includes('import') && !line.includes('export')) continue
      const typeOnly = TYPE_ONLY.test(line)

      for (const basePattern of SPECIFIER_PATTERNS) {
        const pattern = new RegExp(basePattern.source, basePattern.flags)
        let match: RegExpExecArray | null
        while ((match = pattern.exec(line)) !== null) {
          const specifier = match[1]
          if (specifier === undefined || !specifier.startsWith('.')) continue
          // The `import` keyword itself must be code, not the contents of a
          // string literal. Without this the lint flags its own test fixtures.
          if (isInsideString(line, match.index)) continue

          const kind = classify(specifier, file.path)
          if (kind === undefined) continue
          if (violations.some((v) => v.path === file.path && v.line === index + 1 && v.specifier === specifier)) {
            continue
          }
          violations.push({ path: file.path, line: index + 1, kind, specifier, typeOnly, inScope })
        }
      }
    }
  }

  return violations
}

function classify(specifier: string, fromPath: string): ImportViolationKind | undefined {
  if (specifier.endsWith('.ts') || specifier.endsWith('.tsx') || specifier.endsWith('.mts')) return 'ts_extension'

  const hasAllowedExtension = ALLOWED_EXTENSIONS.some((ext) => specifier.endsWith(ext))
  if (!hasAllowedExtension) return 'missing_js_extension'

  // A relative path out of packages/<a> into packages/<b>/src. The specifier is
  // resolved against the importer first: written out it is `../../b/src/y.js`,
  // which contains no package name at all, so a regex over the raw specifier
  // would never see it.
  const fromPackage = /^packages\/([^/]+)\//.exec(fromPath)?.[1]
  if (fromPackage === undefined) return undefined
  const target = resolveRelative(fromPath, specifier)
  const reachesPackage = /^packages\/([^/]+)\/src\//.exec(target)?.[1]
  if (reachesPackage !== undefined && reachesPackage !== fromPackage) return 'cross_package_src_reach'
  return undefined
}

/** POSIX-style resolution of a relative specifier against a repo-relative file. */
export function resolveRelative(fromFile: string, specifier: string): string {
  const segments = fromFile.split('/').slice(0, -1)
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      segments.pop()
      continue
    }
    segments.push(part)
  }
  return segments.join('/')
}

export const VIOLATION_HELP: Record<ImportViolationKind, string> = {
  missing_js_extension:
    'ESM resolves relative specifiers as URLs. Write the compiled extension: "./x.js", not "./x".',
  ts_extension: 'A .ts specifier does not exist after compilation. Write "./x.js".',
  cross_package_src_reach:
    'Import the other package by name (@fee-split-vaults/<name>) so the package boundary and its build still apply.',
}

export function formatImportReport(violations: readonly ImportViolation[], scopes: readonly string[]): string {
  const failing = violations.filter((v) => v.inScope)
  const warnings = violations.filter((v) => !v.inScope)
  const out: string[] = []

  out.push(
    `lint-imports: ${failing.length} violation(s) in scope [${scopes.join(', ')}], ${warnings.length} outside scope`,
  )
  for (const violation of [...failing, ...warnings]) {
    const label = violation.inScope ? 'error' : 'warn '
    const erased = violation.typeOnly ? ' (type-only, erased at compile time)' : ''
    out.push(`  ${label} ${violation.path}:${violation.line}  ${violation.kind}  "${violation.specifier}"${erased}`)
    out.push(`        -> ${VIOLATION_HELP[violation.kind]}`)
  }
  return out.join('\n')
}

export function runLintImportsCli(argv: readonly string[]): number {
  const rootFlag = argv.indexOf('--root')
  const root = rootFlag === -1 ? repoRootFromHere() : resolve(argv[rootFlag + 1] ?? '.')
  const scopes: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--scope' && argv[i + 1] !== undefined) scopes.push(String(argv[i + 1]))
  }
  if (scopes.length === 0) scopes.push('ops')

  const violations = lintImports({ root, scopes })
  process.stdout.write(`${formatImportReport(violations, scopes)}\n`)
  return violations.some((v) => v.inScope) ? 1 : 0
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (invokedDirectly) {
  try {
    process.exitCode = runLintImportsCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`lint-imports: failed: ${String(error)}\n`)
    process.exitCode = 2
  }
}

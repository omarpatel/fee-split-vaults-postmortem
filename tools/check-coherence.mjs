/**
 * Repository coherence checks. Run in CI.
 *
 * These are the checks that no single package can make about itself, and that
 * a green per-package test suite therefore cannot catch:
 *
 *   1. Every relative import resolves to a file that exists.
 *   2. Every @fee-split-vaults/* specifier resolves to a real barrel.
 *   3. Every package.json name matches its directory.
 *   4. Every workspace a package IMPORTS is declared as a dependency, and every
 *      workspace dependency it declares is actually imported.
 *   5. Every workspace dependency is also a tsconfig project reference, so
 *      `tsc --build` orders the graph correctly.
 *   6. Every package that ships a `main` has the barrel that main points at.
 *   7. The EIP-712 Consent type string in apps/api matches ConsentLib.sol
 *      character for character. Field ORDER is load-bearing: a drift there
 *      silently changes every vault address ever predicted, and TypeScript
 *      cannot see across the language boundary.
 *
 * NOT checked here: hardcoded creator rates. `ops/ci/no-hardcoded-rates.ts`
 * already does that properly - context-gated, with an allowlist and its own
 * test suite - and a second cruder copy would fire on the first one's own rule
 * definitions. Run `npm run ci:rates -w @fee-split-vaults/ops`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const fail = (msg) => problems.push(msg)
const rel = (p) => p.slice(ROOT.length + 1).replace(/\\/g, '/')

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(p)
  }
  return out
}

/** Strip comments so a doc block quoting an import is not read as one. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const projects = []
for (const group of ['packages', 'apps']) {
  const dir = join(ROOT, group)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) projects.push({ name, dir: p, group })
  }
}
projects.push({ name: 'ops', dir: join(ROOT, 'ops'), group: '.' })

// --- 1 + 2: import resolution -----------------------------------------------
const allFiles = [
  ...projects.flatMap((p) => walk(p.dir)),
  ...walk(join(ROOT, 'config')),
  ...walk(join(ROOT, 'tools')),
]

for (const file of allFiles) {
  const src = stripComments(readFileSync(file, 'utf8'))
  const specs = new Set()
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g)) {
    specs.add(m[1])
  }
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1])

  for (const spec of specs) {
    if (spec.startsWith('.')) {
      const base = resolve(dirname(file), spec)
      const candidates = [
        base,
        base.replace(/\.js$/, '.ts'),
        base.replace(/\.js$/, '.tsx'),
        `${base}.ts`,
        `${base}.tsx`,
        join(base, 'index.ts'),
      ]
      if (!candidates.some((c) => existsSync(c) && statSync(c).isFile())) {
        fail(`unresolved import: ${rel(file)} -> ${spec}`)
      }
      continue
    }
    const ws = /^@fee-split-vaults\/([a-z-]+)$/.exec(spec)
    if (ws !== null && !existsSync(join(ROOT, 'packages', ws[1], 'src', 'index.ts'))) {
      fail(`no barrel for workspace specifier: ${rel(file)} -> ${spec}`)
    }
  }
}

// --- 3 to 5, 7: package metadata -------------------------------------------
for (const project of projects) {
  const pkgPath = join(project.dir, 'package.json')
  if (!existsSync(pkgPath)) {
    fail(`${project.name}: no package.json`)
    continue
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const expected = project.group === '.' ? '@fee-split-vaults/ops' : `@fee-split-vaults/${project.name}`
  if (pkg.name !== expected) fail(`${rel(pkgPath)}: name is ${pkg.name}, expected ${expected}`)

  if (typeof pkg.main === 'string' && pkg.main.startsWith('dist/')) {
    const barrel = join(project.dir, 'src', 'index.ts')
    if (!existsSync(barrel)) fail(`${project.name}: main is ${pkg.main} but src/index.ts is missing`)
  }

  const srcDir = existsSync(join(project.dir, 'src')) ? join(project.dir, 'src') : project.dir
  const imported = new Set()
  for (const file of walk(srcDir)) {
    if (file.includes('__tests__')) continue
    for (const m of stripComments(readFileSync(file, 'utf8')).matchAll(
      /from\s+['"]@fee-split-vaults\/([a-z-]+)['"]/g,
    )) {
      imported.add(m[1])
    }
  }

  const declared = new Set(
    Object.keys(pkg.dependencies ?? {})
      .filter((d) => d.startsWith('@fee-split-vaults/'))
      .map((d) => d.slice('@fee-split-vaults/'.length)),
  )
  for (const dep of imported) {
    if (!declared.has(dep)) fail(`${project.name}: imports @fee-split-vaults/${dep} but does not declare it`)
  }
  for (const dep of declared) {
    if (!imported.has(dep)) fail(`${project.name}: declares @fee-split-vaults/${dep} but never imports it`)
  }

  const tsconfigPath = join(project.dir, 'tsconfig.json')
  if (existsSync(tsconfigPath)) {
    const refs = [...readFileSync(tsconfigPath, 'utf8').matchAll(/"path"\s*:\s*"([^"]+)"/g)].map(
      (m) => m[1],
    )
    for (const dep of imported) {
      if (!refs.some((r) => r.endsWith(`/${dep}`))) {
        fail(`${project.name}: imports @fee-split-vaults/${dep} but has no tsconfig project reference`)
      }
    }
  }
}

// --- 7: the Solidity <-> TypeScript EIP-712 seam ----------------------------
{
  const sol = join(ROOT, 'contracts', 'src', 'lib', 'ConsentLib.sol')
  const ts = join(ROOT, 'apps', 'api', 'src', 'eip712.ts')
  if (existsSync(sol) && existsSync(ts)) {
    // Solidity writes the type string as adjacent string literals inside
    // keccak256(...); TypeScript writes it as a `+` concatenation. Both reduce
    // to one string, and that string is what must match.
    const solBlock = /CONSENT_TYPEHASH\s*=\s*keccak256\(([\s\S]*?)\);/.exec(readFileSync(sol, 'utf8'))
    const tsBlock = /CONSENT_TYPE_STRING\s*=\s*([\s\S]*?)\r?\n\r?\n/.exec(readFileSync(ts, 'utf8'))
    const literals = (block) => [...block.matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]).join('')
    if (solBlock === null || tsBlock === null) {
      fail('could not read the Consent type string from ConsentLib.sol or eip712.ts')
    } else {
      const solType = literals(solBlock[1])
      const tsType = literals(tsBlock[1])
      if (solType.length === 0) fail('ConsentLib.sol yielded an empty Consent type string')
      else if (solType !== tsType) {
        fail(
          `EIP-712 Consent type string has DRIFTED between Solidity and TypeScript\n      sol: ${solType}\n      ts:  ${tsType}`,
        )
      }
    }
  }
}

// --- 8: no second copy of a destination-shape rule --------------------------
/**
 * WHY THIS CHECK EXISTS. Four independent copies of "what an address looks like"
 * lived in this tree, in airlock.ts (twice), publisher/links.ts and
 * desk/t1/grounding.ts. Every one of them was written `0x[a-fA-F0-9]{n,}` with no
 * `i` flag, so the hex body was case-insensitive and the two-character prefix was
 * not - and `0X…` was invisible to all four walls at once, end to end, from a
 * Telegram message to published bytes. Four copies of a rule is one rule with
 * four chances to be wrong. There is now exactly one definition, in
 * packages/core/src/destinations.ts, and this check fails the build on a second.
 *
 * ALLOWED, and deliberately not caught: an ANCHORED `^0x…$` validator. Those ask
 * "is this exactly a canonical address?" and must stay strict - a `0X`-prefixed
 * string is something we refuse, not something we normalise.
 */
{
  const SCANNING_ADDRESS_RE = /\/(?![^/\n]*\^)[^/\n]*0x\[[^\]\n]*[aA]-[fF][^\]\n]*\][^/\n]*\//
  const owner = join(ROOT, 'packages', 'core', 'src', 'destinations.ts')
  if (!existsSync(owner)) fail('packages/core/src/destinations.ts is missing; it owns every destination shape')
  for (const file of allFiles) {
    if (file === owner) continue
    if (file.includes('__tests__')) continue
    const source = stripComments(readFileSync(file, 'utf8'))
    for (const line of source.split('\n')) {
      if (!SCANNING_ADDRESS_RE.test(line)) continue
      fail(
        `${rel(file)}: declares a local address-scanning regex. Import the shape from ` +
          '@fee-split-vaults/core (destinations.ts) instead - a second copy is how the `0X` ' +
          `bypass survived four walls.\n      ${line.trim()}`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
if (problems.length > 0) {
  process.stderr.write(`${problems.length} coherence problem(s):\n  ${problems.join('\n  ')}\n`)
  process.exit(1)
}
process.stdout.write(
  `coherence OK: ${String(projects.length)} projects, ${String(allFiles.length)} source files\n`,
)

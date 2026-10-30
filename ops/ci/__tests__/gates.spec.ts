/**
 * The secret scan and the import lint, plus the scanning primitives both share.
 *
 * Same principle as the rate gate's tests: a positive control per rule, and a
 * negative control for the thing the rule would otherwise be annoying about.
 * Fixtures go to a temporary directory so the repository never contains a file
 * whose purpose is to trip its own gates.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SECRET_RULES, redact, scanForSecrets } from '../secret-scan.js'
import { lintImports } from '../lint-imports.js'
import { collectFiles, compiledSiblingSource, languageFor, stripComments } from '../scan.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ops-gates-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(relativePath: string, content: string): void {
  const absolute = join(root, relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf8')
}

describe('the secret scan', () => {
  it('catches a PEM private key', () => {
    write('keys/deploy.pem', '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIB\n-----END EC PRIVATE KEY-----\n')
    expect(scanForSecrets(root).findings.map((f) => f.ruleId)).toContain('pem-private-key')
  })

  it('catches a 32-byte hex value in a variable that names a key', () => {
    write('src/deploy.ts', `const deployerKey = '0x${'a1'.repeat(32)}'\n`)
    const findings = scanForSecrets(root).findings
    expect(findings.map((f) => f.ruleId)).toContain('evm-private-key')
    expect(findings[0]?.severity).toBe('critical')
  })

  it('catches an Anthropic key, a GitHub token and a Telegram bot token', () => {
    write('a.ts', "const k = 'sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQQQ'\n")
    write('b.ts', `const g = 'ghp_${'B'.repeat(36)}'\n`)
    write('c.ts', "const t = '1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'\n")
    const ids = scanForSecrets(root).findings.map((f) => f.ruleId)
    expect(ids).toContain('anthropic-api-key')
    expect(ids).toContain('github-token')
    expect(ids).toContain('telegram-bot-token')
  })

  it('ignores obvious placeholders', () => {
    write('.env.sample', 'API_KEY="your-api-key-goes-here-placeholder"\n')
    write('docs/setup.ts', "const apiKey = '<YOUR_TOKEN_HERE_REPLACE_ME_NOW>'\n")
    const report = scanForSecrets(root)
    expect(report.findings).toEqual([])
    expect(report.skippedAsPlaceholder).toBeGreaterThan(0)
  })

  it('does not flag an ordinary 32-byte hash that is not called a key', () => {
    write('src/block.ts', `const blockHash = '0x${'f3'.repeat(32)}'\n`)
    expect(scanForSecrets(root).findings).toEqual([])
  })

  it('never prints the whole secret in its own output', () => {
    const secret = `0x${'a1'.repeat(32)}`
    write('src/deploy.ts', `const privateKey = '${secret}'\n`)
    const finding = scanForSecrets(root).findings[0]
    expect(finding?.redacted).not.toContain(secret)
    expect(finding?.redacted).toContain('***')
    expect(redact('short')).toBe('sh***')
  })

  it('skips binaries and vendored contract output', () => {
    write('assets/logo.png', '-----BEGIN RSA PRIVATE KEY-----')
    write('contracts/lib/forge-std/x.sol', '-----BEGIN RSA PRIVATE KEY-----')
    expect(scanForSecrets(root).findings).toEqual([])
  })

  it('every rule has a distinct id and a description', () => {
    const ids = SECRET_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const rule of SECRET_RULES) expect(rule.description.length).toBeGreaterThan(20)
  })
})

describe('the import lint', () => {
  it('flags an extensionless relative import', () => {
    write('ops/a.ts', "import { x } from './b'\n")
    const violations = lintImports({ root, scopes: ['ops'] })
    expect(violations).toHaveLength(1)
    expect(violations[0]?.kind).toBe('missing_js_extension')
    expect(violations[0]?.inScope).toBe(true)
  })

  it('flags a .ts specifier, which does not exist after compilation', () => {
    write('ops/a.ts', "import { x } from './b.ts'\n")
    expect(lintImports({ root, scopes: ['ops'] })[0]?.kind).toBe('ts_extension')
  })

  it('notes that a type-only import is erased, but still reports it', () => {
    // The trap: `import type './b'` works forever, so the rule looks optional
    // right up until somebody drops the `type` keyword.
    write('ops/a.ts', "import type { X } from './b'\n")
    const violation = lintImports({ root, scopes: ['ops'] })[0]
    expect(violation?.typeOnly).toBe(true)
    expect(violation?.kind).toBe('missing_js_extension')
  })

  it('flags a reach into another package’s src', () => {
    write('packages/a/src/x.ts', "import { y } from '../../b/src/y.js'\n")
    const violation = lintImports({ root, scopes: ['packages'] })[0]
    expect(violation?.kind).toBe('cross_package_src_reach')
  })

  it('leaves a correct relative import and a bare specifier alone', () => {
    write('ops/a.ts', "import { x } from './b.js'\nimport type { Y } from '@fee-split-vaults/core'\nimport { z } from 'node:fs'\n")
    expect(lintImports({ root, scopes: ['ops'] })).toEqual([])
  })

  it('reports out-of-scope violations as warnings rather than failures', () => {
    write('tools/a.ts', "import { x } from './b.ts'\n")
    const violations = lintImports({ root, scopes: ['ops'] })
    expect(violations).toHaveLength(1)
    expect(violations[0]?.inScope).toBe(false)
  })

  it('does not flag an import statement that is the contents of a string', () => {
    // This test file is itself full of them. A lint that fires on its own
    // fixtures is a lint someone turns off.
    write('ops/a.ts', 'const fixture = "import { x } from \'./b\'"\nexport const y = fixture\n')
    expect(lintImports({ root, scopes: ['ops'] })).toEqual([])
  })

  it('still flags a real import on a line that also contains a string', () => {
    write('ops/a.ts', "import { x } from './b'\nconst s = \"import { q } from './r'\"\n")
    const violations = lintImports({ root, scopes: ['ops'] })
    expect(violations).toHaveLength(1)
    expect(violations[0]?.line).toBe(1)
  })
})

describe('scanning primitives', () => {
  it('skips build output that sits beside its source', () => {
    // ops/ and config/ compile in place, so the output shares a directory with
    // the source. Scanning both doubles every finding and reports it at a path
    // nobody edits.
    write('ops/a.ts', 'export const x = 1\n')
    write('ops/a.js', 'export const x = 1\n')
    write('ops/a.d.ts', 'export declare const x: number\n')
    write('ops/standalone.js', 'const y = 2\n')

    const files = collectFiles({ root, extensions: ['.ts', '.js'] }).map((f) => f.path)
    expect(files).toContain('ops/a.ts')
    expect(files).toContain('ops/standalone.js')
    expect(files).not.toContain('ops/a.js')
    expect(files).not.toContain('ops/a.d.ts')
  })

  it('can be told to scan the build output anyway', () => {
    write('ops/a.ts', 'export const x = 1\n')
    write('ops/a.js', 'export const x = 1\n')
    const files = collectFiles({ root, extensions: ['.js'], skipCompiledSiblings: false }).map((f) => f.path)
    expect(files).toContain('ops/a.js')
  })

  it('maps a build artefact back to its source', () => {
    expect(compiledSiblingSource('/x/a.js')).toBe('/x/a.ts')
    expect(compiledSiblingSource('/x/a.d.ts')).toBe('/x/a.ts')
    expect(compiledSiblingSource('/x/a.js.map')).toBe('/x/a.ts')
    expect(compiledSiblingSource('/x/a.ts')).toBeUndefined()
  })

  it('picks a comment syntax per language', () => {
    expect(languageFor('a.ts')).toBe('c-like')
    expect(languageFor('a.sol')).toBe('c-like')
    expect(languageFor('a.sql')).toBe('sql')
    expect(languageFor('ops/docker/api.Dockerfile')).toBe('hash')
    expect(languageFor('a.md')).toBe('none')
  })

  it('strips SQL and hash comments without moving line numbers', () => {
    const sql = stripComments("SELECT 1; -- gone\nSELECT '-- kept';\n", 'sql')
    expect(sql).not.toContain('gone')
    expect(sql).toContain("'-- kept'")
    expect(sql.split('\n')).toHaveLength(3)

    const yaml = stripComments('key: value # gone\nother: "# kept"\n', 'hash')
    expect(yaml).not.toContain('gone')
    expect(yaml).toContain('"# kept"')
  })

  it('does not treat an apostrophe in a comment as an unterminated string', () => {
    const source = "// don't do this\nconst secret = 0.007\n"
    const stripped = stripComments(source, 'c-like')
    expect(stripped).toContain('const secret = 0.007')
  })
})

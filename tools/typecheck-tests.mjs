/**
 * Typecheck every package's TESTS.
 *
 * The build configs exclude __tests__ so that dist/ carries no test types, which
 * means `tsc --build` at the root does NOT check them. Without this, a test file
 * can drift out of sync with the code it tests and nothing notices until the
 * suite is run - and a test that does not compile is a test that is not run.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const candidates = []
for (const group of ['packages', 'apps']) {
  const dir = join(root, group)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir)) candidates.push(join(dir, name))
}
candidates.push(join(root, 'ops'))

let failed = 0
for (const dir of candidates) {
  for (const config of ['tsconfig.test.json', 'tsconfig.spec.json']) {
    const path = join(dir, config)
    if (!existsSync(path)) continue
    process.stdout.write(`typecheck ${path.slice(root.length + 1)}\n`)
    try {
      execFileSync('npx', ['tsc', '-p', path], { cwd: root, stdio: 'inherit', shell: true })
    } catch {
      failed += 1
    }
  }
}

if (failed > 0) {
  process.stderr.write(`\n${failed} test typecheck(s) failed\n`)
  process.exit(1)
}
process.stdout.write('\nall test configs typecheck clean\n')

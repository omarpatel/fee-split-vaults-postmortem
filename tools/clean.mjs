/**
 * Remove every build output.
 *
 * The reason this exists rather than a shell one-liner: config/ compiles IN
 * PLACE (config/protocol.js next to config/protocol.ts), so a stale emitted
 * .js can shadow the TypeScript source under Vite's resolution. `npm run clean`
 * has to know about that, and a `rm -rf dist` does not.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const removed = []

function rm(path) {
  if (!existsSync(path)) return
  rmSync(path, { recursive: true, force: true })
  removed.push(path.slice(root.length + 1))
}

function walkProjects(group) {
  const dir = join(root, group)
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const project = join(dir, name)
    if (!statSync(project).isDirectory()) continue
    rm(join(project, 'dist'))
    rm(join(project, 'tsconfig.tsbuildinfo'))
  }
}

walkProjects('packages')
walkProjects('apps')
rm(join(root, 'ops', 'dist'))
rm(join(root, 'ops', 'tsconfig.tsbuildinfo'))

// config/ emits in place. Anything with a .ts sibling is a build output.
const configDir = join(root, 'config')
for (const name of readdirSync(configDir)) {
  if (/\.(js|d\.ts|js\.map|d\.ts\.map)$/.test(name)) rm(join(configDir, name))
}
rm(join(configDir, '.tsbuildinfo'))

process.stdout.write(
  removed.length === 0 ? 'nothing to clean\n' : `removed:\n  ${removed.join('\n  ')}\n`,
)

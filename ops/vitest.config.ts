import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const packagesDir = fileURLToPath(new URL('../packages/', import.meta.url))

/**
 * ops/ compiles in place (see ops/tsconfig.json), so `./x.js` has a real file
 * beside `./x.ts` whenever the project has been built. Vite would resolve the
 * import to that built file, and the tests would silently be checking the last
 * build rather than the working tree - which is precisely the failure the root
 * vitest config exists to prevent for the packages.
 *
 * This plugin prefers the TypeScript source whenever one exists.
 */
const preferTypeScriptSource = {
  name: 'ops-prefer-ts-source',
  enforce: 'pre' as const,
  resolveId(source: string, importer: string | undefined): string | null {
    if (importer === undefined) return null
    if (!source.startsWith('.') || !source.endsWith('.js')) return null
    const candidate = resolve(dirname(importer), `${source.slice(0, -'.js'.length)}.ts`)
    return existsSync(candidate) ? candidate : null
  },
}

export default defineConfig({
  plugins: [preferTypeScriptSource],
  resolve: {
    // Same rule for the workspace packages: run against SOURCE, so a stale
    // packages/*/dist cannot make a broken build look green.
    alias: [
      { find: /^@fee-split-vaults\/([^/]+)$/, replacement: `${packagesDir}$1/src/index.ts` },
      { find: /^@fee-split-vaults\/([^/]+)\/(.*)$/, replacement: `${packagesDir}$1/src/$2` },
    ],
  },
  test: {
    include: ['**/__tests__/**/*.spec.ts'],
    exclude: ['node_modules/**'],
    environment: 'node',
  },
})

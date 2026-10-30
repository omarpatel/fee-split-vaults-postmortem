import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    // Tests run against workspace SOURCE, so a failing package build cannot be
    // mistaken for a passing test run against a stale dist/.
    alias: [{ find: /^@fee-split-vaults\/(.+)$/, replacement: `${root}packages/$1/src/index.ts` }],
  },
  test: {
    // .tsx is matched too so a component test cannot be green in its own
    // workspace and invisible to the whole-tree run.
    include: [
      'packages/**/src/**/*.spec.ts',
      'apps/**/src/**/*.spec.ts',
      'apps/**/src/**/*.spec.tsx',
    ],
    environment: 'node',
  },
})

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace sibling from source so the suite runs without a
      // prior build step.
      '@fee-split-vaults/core': `${here}../core/src/index.ts`,
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    // The flood test deliberately assembles 500,000 messages.
    testTimeout: 60_000,
  },
})

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const coreSrc = fileURLToPath(new URL('../core/src/', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@fee-split-vaults\/core$/, replacement: `${coreSrc}index.ts` },
      { find: /^@fee-split-vaults\/core\/(.*)$/, replacement: `${coreSrc}$1` },
    ],
  },
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
})

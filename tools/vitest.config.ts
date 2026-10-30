import { defineConfig } from 'vitest/config'

/**
 * tools/ has its own vitest config because the root config's `include` covers
 * packages/** and apps/** only, and that file belongs to another track.
 *
 * Run from the repo root:  npx vitest run --config tools/vitest.config.ts
 *
 * Every test here runs against RECORDED FIXTURES and in-memory fakes. None of
 * them touches an RPC endpoint or a public API: a red test must always mean our
 * decoding or our arithmetic broke, never that someone else's service moved.
 */
export default defineConfig({
  test: {
    include: ['**/__tests__/**/*.spec.ts'],
    root: import.meta.dirname,
    environment: 'node',
  },
})

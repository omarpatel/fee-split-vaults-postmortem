import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Run from this workspace, tests resolve config/protocol.ts from SOURCE, so a
 * stale emitted config/protocol.js cannot make a failing change look green.
 * The root vitest config runs the same files against the workspace as a whole.
 */
const protocolSource = fileURLToPath(new URL('../../config/protocol.ts', import.meta.url)).replace(
  /\\/g,
  '/',
)

export default defineConfig({
  resolve: {
    alias: [{ find: /^\.\.\/\.\.\/\.\.\/config\/protocol\.js$/, replacement: protocolSource }],
  },
  test: {
    // .tsx as well as .ts: the agent page is asserted by rendering the real
    // route to markup, and a JSX test file is the only honest way to construct
    // the same element tree the app does.
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    environment: 'node',
  },
})

import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The workspace convention puts a `.js` extension on relative TypeScript
 * imports. Vite does not map those back to a `.ts` source, and the emitted
 * `config/protocol.js` is a build artifact this app must not depend on being
 * present, so the single crossing import is pinned to the source file.
 *
 * src/protocol.ts is deliberately the only module that reaches outside the app,
 * so this alias has exactly one subject.
 */
const protocolSource = fileURLToPath(new URL('../../config/protocol.ts', import.meta.url)).replace(
  /\\/g,
  '/',
)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: /^\.\.\/\.\.\/\.\.\/config\/protocol\.js$/, replacement: protocolSource }],
  },
  server: {
    port: 5273,
    // The public coin page lives at /<vault> so that the receipt URL the
    // publisher stamps into every disclosure resolves without a fragment.
    // Deep links must therefore fall back to index.html.
    strictPort: false,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
})

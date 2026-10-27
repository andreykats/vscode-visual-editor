import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const bridge = fileURLToPath(new URL('../../mcp-bridge', import.meta.url));
rmSync(`${pkg}/dist`, { recursive: true, force: true });
mkdirSync(`${pkg}/dist`, { recursive: true });
// Opened from the preview's "plugin not detected" banner.
copyFileSync(fileURLToPath(new URL('../../../docs/setup.md', import.meta.url)), `${pkg}/dist/setup.md`);

await Promise.all([
  build({
    entryPoints: [`${pkg}/src/extension.ts`],
    outfile: `${pkg}/dist/extension.cjs`,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    sourcemap: true,
  }),
  build({
    entryPoints: [`${pkg}/src/webview/main.ts`],
    outfile: `${pkg}/dist/webview.js`,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
  }),
  // The page client the static server injects into plain HTML pages; the Vite plugin builds the same entry.
  build({
    entryPoints: [`${pkg}/../vite-plugin/src/client/index.ts`],
    outfile: `${pkg}/dist/page-client.js`,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
  }),
  // The stdio MCP server agents launch. Self-contained: copied to ~/.vibe-visual-editor/bin on activation.
  build({
    entryPoints: [`${bridge}/src/main.ts`],
    outfile: `${pkg}/dist/mcp-bridge.mjs`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    minify: true,
    legalComments: 'none',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  }),
]);

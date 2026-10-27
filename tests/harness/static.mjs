// Serves fixtures/html-app with the static server the extension runs for plain HTML pages:
// node tests/harness/static.mjs <port> <trusted harness origin>
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const [port, trusted] = process.argv.slice(2);
if (!Number.isInteger(Number(port)) || !trusted) throw new Error('usage: static.mjs <port> <trusted origin>');

// server-core is TypeScript source: bundle it next to this script.
const out = fileURLToPath(new URL('./out/server-core.mjs', import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL('../../packages/server-core/src/index.ts', import.meta.url))],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Its npm dependencies resolve from the repo; the workspace packages are TypeScript and get bundled.
  external: ['parse5', 'entities', 'magic-string'],
  logLevel: 'warning',
});
const { createStaticServer } = await import(out);
const client = fileURLToPath(new URL('../../packages/vite-plugin/dist/client.js', import.meta.url));
const server = await createStaticServer({
  root: fileURLToPath(new URL('../../fixtures/html-app', import.meta.url)),
  clientBundle: () => readFile(client, 'utf8'),
  trustedParentOrigins: [trusted],
  port: Number(port),
});
console.log(`static html-app at ${server.url}`);

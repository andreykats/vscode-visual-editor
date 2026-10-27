import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build as rolldown } from 'rolldown';
import { dts } from 'rolldown-plugin-dts';

const pkg = fileURLToPath(new URL('..', import.meta.url));
rmSync(`${pkg}/dist`, { recursive: true, force: true });

const external = ['vite', 'oxc-parser', 'magic-string', 'parse5', 'entities'];

await Promise.all([
  // Node side: the Vite plugin. Runtime deps stay external; the protocol package is inlined.
  build({
    entryPoints: [`${pkg}/src/index.ts`],
    outfile: `${pkg}/dist/index.js`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external,
    sourcemap: true,
  }),
  // Its declarations, bundled into one self-contained dist/index.d.ts. The protocol
  // package is unpublished, so its types are inlined just like its code. zod is
  // reached only through protocol's message schemas, which the public API doesn't use.
  rolldown({
    input: { index: `${pkg}/src/index.ts` },
    cwd: pkg,
    platform: 'node',
    external: [...external, /^node:/, /^zod(\/|$)/],
    // Declarations have no side effects; keeps unused externals (zod) out of the output.
    treeshake: { moduleSideEffects: 'no-external' },
    plugins: [dts({ tsconfig: `${pkg}/../../tsconfig.vite-plugin-dts.json`, emitDtsOnly: true })],
    output: { dir: `${pkg}/dist`, format: 'es' },
    logLevel: 'warn',
  }),
  // Browser side: the injected page client, served by the plugin as a virtual module.
  build({
    entryPoints: [`${pkg}/src/client/index.ts`],
    outfile: `${pkg}/dist/client.js`,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
  }),
]);

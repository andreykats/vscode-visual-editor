import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import vibeVisualEditor from '@vibe-visual-editor/vite-plugin';

const trusted = process.env.VIBE_VISUAL_EDITOR_TRUSTED_ORIGIN;

export default defineConfig({
  base: '/html-app/',
  // Plain HTML pages need no adapter.
  plugins: [vibeVisualEditor({ trustedParentOrigins: trusted ? [trusted] : [] })],
  build: { rollupOptions: { input: { index: resolve(import.meta.dirname, 'index.html'), about: resolve(import.meta.dirname, 'about.html') } } },
});

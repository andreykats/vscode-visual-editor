import { defineConfig } from '@playwright/test';

const APP_PORT = 5301;
const REACT_PORT = 5304;
const HTML_PORT = 5305;
const STATIC_PORT = 5306;
/** Trusted harness origin (plays the webview). */
export const HARNESS = 'http://127.0.0.1:5302';
/** Same harness on an origin the client must not trust. */
export const UNTRUSTED_HARNESS = 'http://127.0.0.1:5303';
export const APP_URL = `http://localhost:${APP_PORT}/h-app/`;
export const REACT_URL = `http://localhost:${REACT_PORT}/react-app/`;
export const HTML_URL = `http://localhost:${HTML_PORT}/html-app/`;
/** The same pages served by the extension's static server, without Vite. */
export const STATIC_URL = `http://127.0.0.1:${STATIC_PORT}/`;

export default defineConfig({
  testDir: 'tests/page',
  fullyParallel: false,
  workers: 1,
  use: { browserName: 'chromium', headless: true },
  webServer: [
    {
      command: `npx vite --port ${APP_PORT} --strictPort`,
      cwd: 'fixtures/h-app',
      url: `${APP_URL}`,
      env: { VIBE_VISUAL_EDITOR_TRUSTED_ORIGIN: HARNESS },
      reuseExistingServer: false,
    },
    {
      command: `npx vite --port ${REACT_PORT} --strictPort`,
      cwd: 'fixtures/react-app',
      url: `${REACT_URL}`,
      env: { VIBE_VISUAL_EDITOR_TRUSTED_ORIGIN: HARNESS },
      reuseExistingServer: false,
    },
    {
      command: `npx vite --port ${HTML_PORT} --strictPort`,
      cwd: 'fixtures/html-app',
      url: `${HTML_URL}`,
      env: { VIBE_VISUAL_EDITOR_TRUSTED_ORIGIN: HARNESS },
      reuseExistingServer: false,
    },
    {
      command: `node tests/harness/static.mjs ${STATIC_PORT} ${HARNESS}`,
      url: STATIC_URL,
      reuseExistingServer: false,
    },
    {
      command: 'node tests/harness/serve.mjs 5302 5303',
      url: `${HARNESS}/?target=x`,
      reuseExistingServer: false,
    },
  ],
});

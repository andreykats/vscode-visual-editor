# Vibe Visual Editor

A VS Code extension plus a Vite dev plugin. It renders your running web app in a VS Code tab, where you can:

- click text, retype it, and save the change back to the source string literal;
- select any element and have Claude Code or Codex act on it through MCP.

> **Preview release.** Works with React (JSX) apps, apps that build their DOM with an `h(tag, attrs, ...children)` helper, and plain HTML pages.

## Install

1. Install the **Vibe Visual Editor** extension from the VS Code Marketplace (`andreykats.vibe-visual-editor`).
2. Add the dev plugin to your Vite app with `npm install -D @vibe-visual-editor/vite-plugin`, and register it in `vite.config.ts` with `reactAdapter()` or `hAdapter(…)`.

Setup and usage are in [docs/setup.md](docs/setup.md). The original design brief is [PLAN.md](PLAN.md), and the milestone 0 findings are in [docs/spikes.md](docs/spikes.md). Releases are described in [docs/releasing.md](docs/releasing.md).

## Layout

```
packages/
  protocol/      shared types, zod/mini schemas, literal escaping, URL checks
  vite-plugin/   @vibe-visual-editor/vite-plugin: literal index, h() and React adapters, injected page client
  extension/     VS Code extension: preview webview, edit service, URI handler, bridge server
  mcp-bridge/    stdio MCP server (bundled into the extension as dist/mcp-bridge.mjs)
fixtures/h-app/      minimal Vite app built with an h() helper
fixtures/react-app/  minimal Vite + React app
fixtures/html-app/   plain HTML pages, no framework or adapter
tests/           Playwright page-client tests, plus a harness that stands in for the webview
docs/            setup, adapter guide, spike results
```

## How it fits together

- **Vite plugin** (dev only). Indexes every string literal as modules are transformed, and the text of each HTML page as it is served, and tags where each element was created: `h(...)` calls are wrapped as `__le(h(...), loc)`, while lowercase JSX elements and the elements of HTML pages get a `data-vve-loc` attribute. Serves `/__vibe-visual-editor/resolve`, `/analyze` and `/health`. Injects the page client and writes `.vibe-visual-editor/server.json`.
- **Page client** (inside the iframe). Does all the DOM work: hover outlines, the inline plain-text editor, selection and element descriptors, keyboard forwarding, and re-applying unsaved edits after the app re-renders. Talks to the webview with `postMessage`, pinned to the webview's origin after a handshake.
- **Extension.** Owns all file writes. Edits are `WorkspaceEdit`s on `TextDocument`s, so files get the dirty marker and normal undo, and nothing reaches disk until Save. Each window runs a loopback bridge (random port plus token) and registers it in `~/.vibe-visual-editor/windows/<pid>.json`.
- **MCP bridge.** Each agent starts its own stdio process. It routes to the VS Code window whose workspace contains its `cwd`, and exposes `open_preview`, `get_selection` and `get_preview_state`, plus a `preview://selection` resource and a `selected` prompt.

## Develop

```sh
npm install
npm run build          # protocol, plugin, extension bundles
npm test               # Vitest: unit, plugin integration, MCP over stdio (needs the build)
npm run test:e2e       # Playwright: page client in a framed harness
npm run test:extension # VS Code integration tests (downloads VS Code into packages/extension/.vscode-test)
npm run typecheck
npm run package        # packages/extension/vibe-visual-editor.vsix
```

Run the fixture app with `cd fixtures/h-app && npx vite`.

## License

[MIT](LICENSE). Created by Andrey Kats. If you build on this project, keep the copyright notice, as the license requires.

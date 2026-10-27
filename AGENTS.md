# Agent instructions: Vibe Visual Editor

A VS Code extension and a Vite dev plugin. The [README](README.md) has the layout and how the parts fit together, [docs/setup.md](docs/setup.md) covers usage, and [PLAN.md](PLAN.md) is the design brief.

## Before you commit

Run all four suites. CI runs the same ones on Linux, and every commit to `main` has to pass them:

```sh
npm run typecheck
npm test               # builds first, then Vitest: unit, plugin integration, MCP over stdio
npm run test:e2e       # Playwright: page client in a framed harness
npm run test:extension # VS Code integration tests
```

The page and extension tests assert the text in `fixtures/h-app` and `fixtures/react-app` (for example "Welcome home", "Videos", "Welcome to React"). Don't commit edits made to the fixture while trying out the preview. If the user's own uncommitted edits break the tests, ask what to do with them.

## Git

- Commit **and push** at the end of every piece of work. Don't leave uncommitted changes or unpushed commits behind.
- Stage only the files you changed (`git add <paths>`). Write short messages without AI attribution lines.
- Commits are authored with the GitHub noreply address set in this repo's git config. Don't change it.
- Push `main` and release tags only. Never `git push --tags`, because local-only tags exist that must stay local.
- Don't commit references to private projects or local paths. This is a public repository.

## Releases

Releases are tag-triggered. See [docs/releasing.md](docs/releasing.md).

- Bump `version` in the package's `package.json`. An extension release also needs a `## X.Y.Z` section in `packages/extension/CHANGELOG.md`.
- Commit, push, wait for CI, then push the tag `extension-vX.Y.Z` or `vite-plugin-vX.Y.Z`. `release.yml` publishes through trusted publishing.
- Don't publish by hand, and don't tag a release, unless the user asks. Published versions can never be reused.
- `PROTOCOL_VERSION` (`packages/protocol/src/version.ts`) changes need both packages released together. Tests and the page-test harness read it, so don't hard-code version numbers.

## Things that aren't obvious

- `@vibe-visual-editor/protocol`, `server-core` and `mcp-bridge` are private. The protocol is inlined into the plugin's JS and into its bundled `dist/index.d.ts`, which `tsconfig.vite-plugin-dts.json` builds. `server-core` (the HTML index, the `/__vibe-visual-editor/*` API and the static server) is inlined into the plugin's JS and into the extension, so its npm dependencies (`parse5`, `entities`, `magic-string`) must stay dependencies of the plugin. The extension builds its own copy of the page client from `packages/vite-plugin/src/client`. That tsconfig must stay at the repo root. Inside the monorepo, the `vibe-visual-editor:source` export condition points tools at the TypeScript source. `test/package.test.ts` type-checks the packed tarball in a strict app.
- The fixtures depend on the plugin as `"*"`. With a fixed version, npm would install a published copy instead of linking the workspace whenever the versions differ.
- Changes to the extension reach the user's VS Code only after `npm run package`, `code --install-extension packages/extension/vibe-visual-editor.vsix --force`, and **Developer: Reload Window**.
- JSX text and JSX attribute strings are literal kinds of their own (`jsx`, `jsx-attr`). Their rules live in `packages/protocol/src/jsx.ts`, and `packages/vite-plugin/test/jsx.test.ts` checks them against Vite's own JSX compiler. Keep that test passing whenever the rules change.
- Only string-literal text is editable. Don't add features that rewrite tags, attributes or structure. Those go through the agent and the selection instead.
- Git commands for different repositories must not run as parallel tool calls: they share one shell and its working directory.

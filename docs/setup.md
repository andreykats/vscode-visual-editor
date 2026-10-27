# Vibe Visual Editor setup

Vibe Visual Editor shows your running Vite app in a VS Code tab. In the preview you can retype text and save the change to the source file, or select an element so Claude Code or Codex can work on it.

It works with React (JSX) apps, with apps that build their DOM with an `h()` helper, and with plain HTML pages. It has three parts:

- **The VS Code extension** (`andreykats.vibe-visual-editor`), which provides the preview tab, saving, and the agent bridge.
- **The Vite plugin** (`@vibe-visual-editor/vite-plugin`), which runs only in your app's dev server. It maps rendered text back to source.
- **Vibe Visual Editor MCP** (`vibe-visual-editor-mcp`), the MCP server, which Claude Code and Codex start. The extension installs it at `~/.vibe-visual-editor/bin/vibe-visual-editor-mcp.mjs`.

## 1. Install the extension

Install **Vibe Visual Editor** from the Extensions view, or from the command line:

```sh
code --install-extension andreykats.vibe-visual-editor
```

To try a build of this repo instead, run `npm run package` and install `packages/extension/vibe-visual-editor.vsix` with `code --install-extension <path>`.

## 2. Add the plugin to the app

```sh
npm install -D @vibe-visual-editor/vite-plugin
```

To try an unreleased build, run `npm run build -w @vibe-visual-editor/vite-plugin && (cd packages/vite-plugin && npm pack)` in this repo and install the resulting `.tgz` with `npm install -D <path>`.

Then add it to `vite.config.ts` with the adapter for how your app builds its DOM.

**React** (and other JSX libraries that render lowercase tags as DOM elements):

```ts
import react from '@vitejs/plugin-react';
import vibeVisualEditor, { reactAdapter } from '@vibe-visual-editor/vite-plugin';

export default defineConfig({
  plugins: [react(), vibeVisualEditor({ adapters: [reactAdapter()] })],
});
```

The plugin order doesn't matter: Vibe Visual Editor reads your source before `react()` compiles the JSX.

**An `h(tag, attrs, ...children)` helper:** point `from` at the module that exports it.

```ts
import vibeVisualEditor, { hAdapter } from '@vibe-visual-editor/vite-plugin';

export default defineConfig({
  plugins: [vibeVisualEditor({ adapters: [hAdapter({ factory: 'h', from: '/src/ui/dom.ts' })] })],
});
```

**Plain HTML pages:** no adapter is needed. Text in every `.html` page the dev server serves can be edited, in apps with adapters too.

```ts
import vibeVisualEditor from '@vibe-visual-editor/vite-plugin';

export default defineConfig({
  plugins: [vibeVisualEditor()],
});
```

A folder of HTML files without a build setup only needs `npm install -D vite @vibe-visual-editor/vite-plugin` and this `vite.config.ts` next to the pages. Vite serves `index.html` at `/` and every other page at its own path, for example `/about.html`. Pages in `public/` are copied as they are, so they can't be edited.

Add `.vibe-visual-editor/` to the app's `.gitignore`. While the dev server runs, the plugin writes `.vibe-visual-editor/server.json` there so the extension can find the server.

The plugin is active only in `vite` dev (`apply: 'serve'`), and production builds contain none of its code. It also does nothing when the page isn't inside the Vibe Visual Editor preview, so a normal browser tab on the same dev server is unaffected.

## 3. Connect Claude Code and Codex

Run **Vibe Visual Editor: Configure Claude Code and Codex** from the Command Palette, then choose **Run now**. This registers the MCP server with both agents, using user scope for Claude Code, and checks the result with `claude mcp list` and `codex mcp list`. If you'd rather run the commands yourself, choose **Copy commands**. They look like this:

```sh
claude mcp add --scope user vibe-visual-editor -- /path/to/node ~/.vibe-visual-editor/bin/vibe-visual-editor-mcp.mjs
codex mcp add vibe-visual-editor -- /path/to/node ~/.vibe-visual-editor/bin/vibe-visual-editor-mcp.mjs
```

If Node isn't on your PATH, the command falls back to running VS Code's own binary as Node, with `ELECTRON_RUN_AS_NODE=1`.

Codex asks for approval before each `open_preview` call, and in `codex exec` that approval request blocks the call. `open_preview` only ever opens loopback URLs. To let Codex run it without asking, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.vibe-visual-editor.tools.open_preview]
approval_mode = "approve"
```

The other tools are read-only and run without approval.

Start a new agent session afterwards so it picks up the server.

## Using it

1. Start the dev server (`npm run dev`).
2. Open the preview: ask the agent to "show me the settings page", run **Vibe Visual Editor: Open Preview**, or open a link like `vscode://andreykats.vibe-visual-editor/open?url=http%3A%2F%2Flocalhost%3A5173%2F`.
3. Pick a mode in the toolbar:
   - **Browse:** the page behaves normally.
   - **Edit text:** hovering outlines text you can edit. A solid outline means editable. A dashed outline means the text is built at runtime and can't be edited directly. Click the text, type, then press **Enter** to commit or **Esc** to cancel. **Shift+Enter** adds a line break, written to the source as `\n`. It only shows where the element's CSS keeps line breaks (`white-space: pre-line` or `pre-wrap`). Elsewhere the preview tells you it shows as a space, so you can ask the agent to change the CSS.
     Dropdowns (`<select>`) work differently, because the browser draws their option list itself. Click one to list its options in a small panel and retype them there. **Tab** saves the current option and moves to the next, **Enter** saves and closes, and **Esc** closes without saving the current option. Options built at runtime are shown greyed out.
   - **Select:** click any element to select it, then ask the agent about it ("make this bold", "move that button left"). The agent reads the selection with `get_selection`. In Claude Code you can also use `@vibe-visual-editor:preview://selection` or `/vibe-visual-editor:selected`.
4. Committed edits become unsaved changes in the source files, shown with the usual dirty marker. **Save** or **Cmd+S** writes them. **Discard** puts the original text back, and **Cmd+Z** / **Shift+Cmd+Z** in the preview undo and redo Vibe Visual Editor's edits.

## What can be edited

Only text that comes straight from your source can be edited:

- string literals (`'…'`, `"…"`, and template literals without `${}`), including dropdown option text
- in React: text between tags (`<h1>Welcome</h1>`) and string props that a component renders as text (`<Card title="Settings" />`)
- in HTML pages: text between tags in `<body>`, including text in a `<template>` that a script clones into the page

Edits are written back in the same syntax. In JSX, characters like `{` or `<` become entities (`&#123;`, `&lt;`), and text that JSX can't hold, such as a line break, becomes `{'…'}`. In HTML, `<` becomes `&lt;`, `&` becomes `&amp;` where it could be read as the start of an entity, and a non-breaking space becomes `&nbsp;`. The line breaks and indentation around multi-line HTML text stay as they are, and the editor shows only the text between them. Tags, attributes of HTML elements, classes, styles and structure can't be edited, and neither can text built at runtime. For those, select the element and ask the agent.

A few JSX texts are skipped because JSX compilers render them differently, so there's no single right answer: tabs inside the text, and character references that encode whitespace or aren't common named entities. In HTML pages, text that the browser's parser changes on its way into the page is skipped, for example text it moves out of a `<table>`. So is text in `<title>`, `<textarea>`, scripts and styles, text a script rewrites, and pages that another Vite plugin rewrites before Vibe Visual Editor sees them.

When the same text appears in several equally likely places, Vibe Visual Editor asks which one you meant. If the literal is a shared constant, the editor warns "Used in N places" because changing it changes every use.

## Troubleshooting

- **"Vibe Visual Editor plugin not detected on this dev server"**: the page didn't answer the handshake. Check that the plugin is in `vite.config.ts` and that you're running `vite` dev, not `vite preview`. Browse mode still works without it.
- **"Version mismatch"**: the extension and the plugin come from different releases. Rebuild and reinstall both.
- **An edit is refused with "changed since the page loaded"**: the file changed in a way that makes the original text ambiguous. Reload the preview and edit again. Vibe Visual Editor never guesses.
- **After Discard, a file still shows as modified**: its text is identical to what's on disk again, but VS Code keeps the dirty marker. Use **File: Revert File** on it, or save it.
- **Apps with idle timers** (for example, a settings screen that goes back to a home screen after a period without input): clicks in Edit and Select modes are swallowed, so the app doesn't count them as activity. Long pauses can therefore still navigate away. Moving the mouse still counts.
- **The agent says no VS Code window is running**: the MCP server finds windows through `~/.vibe-visual-editor/windows/`. Make sure the project folder is open in VS Code with Vibe Visual Editor installed. If none of the open windows contains the agent's working directory, the server uses the most recently focused window and says so.

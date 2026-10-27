# Vibe Visual Editor

See your running Vite app in a VS Code tab, fix its text by typing right on the page, and point Claude Code or Codex at the exact element you mean.

> **Preview release.** Works with React (JSX) apps, apps that build their DOM with an `h(tag, attrs, ...children)` helper, and plain HTML pages.

## What it does

- **Edit text in place.** Click text in the preview, type, and press Enter. The change goes into the string literal in your source file as an ordinary unsaved edit, so you review it and save it like any other change. Shift+Enter adds a line break.
- **Edit dropdowns.** Click a `<select>` to list its options in a small panel and retype them.
- **Select an element for your agent.** Click any element, then ask Claude Code or Codex to "make this bold" or "move that button left". The agent gets the element's tag, text, CSS selector and the source line that created it.
- **Agent setup in one command.** The extension ships a local MCP server and registers it with Claude Code and Codex for you.

Everything runs on your machine. The preview only opens loopback URLs, and nothing is sent anywhere.

## Requirements

- A Vite app with the [`@vibe-visual-editor/vite-plugin`](https://www.npmjs.com/package/@vibe-visual-editor/vite-plugin) dev plugin. The plugin maps rendered text back to source, and it isn't included in production builds.
- VS Code 1.140 or later.
- For the agent features: Claude Code or Codex.

## Getting started

1. Add the plugin to your app:

   ```sh
   npm install -D @vibe-visual-editor/vite-plugin
   ```

   Then register it in `vite.config.ts`. For React:

   ```ts
   import react from '@vitejs/plugin-react';
   import vibeVisualEditor, { reactAdapter } from '@vibe-visual-editor/vite-plugin';

   export default defineConfig({
     plugins: [react(), vibeVisualEditor({ adapters: [reactAdapter()] })],
   });
   ```

   For an `h()` helper, use `hAdapter({ factory: 'h', from: '/src/ui/dom.ts' })` instead, with `from` pointing at the module that exports it. For plain HTML pages, `vibeVisualEditor()` needs no adapter.

   Add `.vibe-visual-editor/` to `.gitignore`. The dev server writes a small discovery file there.

2. Start the dev server (`npm run dev`) and run **Vibe Visual Editor: Open Preview** from the Command Palette.
3. To use the agent features, run **Vibe Visual Editor: Configure Claude Code and Codex** once, then start a new agent session.

The [setup guide](https://github.com/andreykats/vscode-visual-editor/blob/main/docs/setup.md) covers every option and troubleshooting.

## Using the preview

Pick a mode in the preview's toolbar:

- **Browse:** the page behaves normally.
- **Edit text:** a solid outline marks text you can edit, and a dashed one marks text built at runtime. Enter commits an edit, Esc cancels it and Shift+Enter adds a line break. Cmd+S / Ctrl+S saves, and Cmd+Z / Ctrl+Z undoes.
- **Select:** click an element, then ask your agent about "the selected element".

Only text that comes straight from your source can be edited: string literals, text in HTML pages, and in React, text between tags and text props like `<Card title="…" />`. Tags, attributes, classes and styles can't. For those, select the element and ask the agent.

## Commands

- **Vibe Visual Editor: Open Preview**: opens a discovered dev server, or a URL you enter.
- **Vibe Visual Editor: Save Edits / Discard Edits / Undo Edit / Redo Edit**: act on the preview's unsaved edits.
- **Vibe Visual Editor: Set Mode**: switches between Browse, Edit text and Select.
- **Vibe Visual Editor: Copy Selection for Chat**: copies the selected element as Markdown, for agents without MCP.
- **Vibe Visual Editor: Configure Claude Code and Codex**: registers the `vibe-visual-editor` MCP server with both agents.

## Feedback

Report bugs and ideas on [GitHub](https://github.com/andreykats/vscode-visual-editor/issues).

## License

[MIT](https://github.com/andreykats/vscode-visual-editor/blob/main/LICENSE). Created by Andrey Kats.

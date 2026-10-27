# Changelog

## 0.3.0 (preview)

- **Plain HTML pages, with no setup.** Right-click an `.html` file (or use the button in its editor title bar) and choose **Open in Vibe Visual Editor**. The extension serves the workspace folder itself on `127.0.0.1`, so pages, links, CSS and images work without a dev server, and the preview reloads when files change. Agents' `open_preview` falls back to these pages when no dev server is running.
- **Edit text in HTML pages**, served by the extension or by Vite. Text is written back as HTML (`&lt;`, `&amp;` where needed), and the line breaks and indentation around multi-line text are left as they are. Selected elements point at their line in the page.
- The Vite plugin no longer needs an adapter: `vibeVisualEditor()` makes HTML pages editable on its own.
- Protocol version 3: use `@vibe-visual-editor/vite-plugin` 0.3 or later. An older plugin shows "plugin version mismatch".

## 0.2.0 (preview)

- **React support.** With the plugin's new `reactAdapter()`, you can edit text between JSX tags and string props that components render (`<Card title="Settings" />`), and selected elements point at their JSX line. Edits are written back in JSX syntax.
- The inline editor no longer moves the text node it edits, so frameworks that own the DOM, like React, keep working while you type.
- Protocol version 2: use `@vibe-visual-editor/vite-plugin` 0.2 or later. An older plugin shows "plugin version mismatch".

## 0.1.0 (preview)

First public preview.

- Preview a running Vite dev server in a VS Code tab, with Browse, Edit text and Select modes.
- Edit text in place: retype text that comes from a string literal, and the change becomes an unsaved edit in the source file. Save, Discard, Undo and Redo work from the preview.
- Shift+Enter adds a line break, written to the source as `\n`.
- Dropdown (`<select>`) options can be edited in a small panel next to the dropdown.
- Select an element and ask Claude Code or Codex about it. The bundled `vibe-visual-editor` MCP server gives agents `get_selection`, `get_preview_state` and `open_preview`.
- **Configure Claude Code and Codex** registers the MCP server with both agents.
- Requires the `@vibe-visual-editor/vite-plugin` in the app. v0.1 supports apps that build their DOM with an `h(tag, attrs, ...children)` helper.

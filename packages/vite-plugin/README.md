# @vibe-visual-editor/vite-plugin

The dev-server half of [Vibe Visual Editor](https://github.com/andreykats/vscode-visual-editor), a VS Code extension that shows your running Vite app in an editor tab. In the preview you can retype text and save it to the source, or select an element and ask Claude Code or Codex to change it.

This plugin maps rendered text back to the string literal, or the text in an HTML page, that produced it. It runs only in `vite` dev (`apply: 'serve'`): production builds contain none of its code. It also does nothing unless the page is open inside the Vibe Visual Editor preview, so a normal browser tab on the same dev server is unaffected.

## Install

```sh
npm install -D @vibe-visual-editor/vite-plugin
```

Then install the [Vibe Visual Editor extension](https://marketplace.visualstudio.com/items?itemName=andreykats.vibe-visual-editor) in VS Code.

## Usage

**React:**

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import vibeVisualEditor, { reactAdapter } from '@vibe-visual-editor/vite-plugin';

export default defineConfig({
  plugins: [react(), vibeVisualEditor({ adapters: [reactAdapter()] })],
});
```

**An `h()` element helper:**

```ts
import vibeVisualEditor, { hAdapter } from '@vibe-visual-editor/vite-plugin';

export default defineConfig({
  plugins: [vibeVisualEditor({ adapters: [hAdapter({ factory: 'h', from: '/src/ui/dom.ts' })] })],
});
```

**Plain HTML pages** need no adapter (and a folder of them doesn't need Vite at all: the extension can serve it itself):

```ts
import vibeVisualEditor from '@vibe-visual-editor/vite-plugin';

export default defineConfig({
  plugins: [vibeVisualEditor()],
});
```

Add `.vibe-visual-editor/` to your `.gitignore`. While the dev server runs, the plugin writes `.vibe-visual-editor/server.json` there so the extension can find the server.

### Adapters

An adapter tells the plugin how your app's scripts create elements. Text in the HTML pages Vite serves is editable with or without one, and in dev their elements get a `data-vve-loc` attribute too.

- **`reactAdapter()`** for JSX: React, and other libraries that render lowercase JSX tags as DOM elements. Text between tags and string props that components render (`<Card title="Settings" />`) are editable, and selected elements point at their JSX line. In dev, each HTML element gets a `data-vve-loc` attribute. Production builds don't have it.
- **`hAdapter({ factory, from })`** for apps that build their DOM with an `h(tag, attrs, ...children)` helper. `factory` is the helper's exported name, and `from` is the root-relative path of the module that exports it.

[Writing a source adapter](https://github.com/andreykats/vscode-visual-editor/blob/main/docs/adapters.md) describes the interface (`SourceAdapter`, which this package exports as a type).

## Requirements

- Vite 7 or later.
- The Vibe Visual Editor extension 0.3 or later. Plugin 0.3 and extension 0.3 speak protocol version 3.
- Node.js 20.19+ or 22.12+, as Vite requires.

## License

[MIT](https://github.com/andreykats/vscode-visual-editor/blob/main/LICENSE). Created by Andrey Kats.

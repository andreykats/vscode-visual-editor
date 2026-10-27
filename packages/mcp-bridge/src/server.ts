import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  formatSelectionMarkdown,
  OpenResponseSchema,
  SelectionResponseSchema,
  StateResponseSchema,
  type WindowEntry,
} from '@vibe-visual-editor/protocol';
import { pickWindow, readWindows, registryDir, type Route } from './registry';

export const VERSION = '0.1.0';

export const INSTRUCTIONS = `Vibe Visual Editor: renders the user's running web app in a VS Code tab and shares the element they selected.
When the user asks to see, show, render, open or preview a page or screen, call open_preview (pass path like "#/settings" for hash routes, or "about.html" for a plain HTML page).
When they refer to "the selected element", "this", "that button", "what I clicked", or "here", call get_selection first, then edit the source at its creationSite (file:line).
Text the user retypes in the preview is saved by them; do not redo those edits.`;

const NO_WINDOW =
  'No VS Code window with the Vibe Visual Editor extension is running. Ask the user to open this project in VS Code with Vibe Visual Editor installed, then try again.';

interface Deps {
  cwd: string;
  registry: string;
}

class BridgeError extends Error {}

async function call(route: Route, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const { entry } = route;
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${entry.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${entry.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new BridgeError(`Could not reach the VS Code window (pid ${entry.pid}): ${(err as Error).message}`);
  }
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new BridgeError(`VS Code window answered ${res.status}: ${json?.error ?? 'no details'}`);
  return json;
}

function routeNote(route: Route, cwd: string): string {
  if (route.matched) return '';
  const folders = route.entry.workspaceFolders.join(', ') || 'no folder';
  return `Note: no VS Code window has ${cwd} open, so this used the most recently focused window (${folders}).\n\n`;
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) });

/** A fresh server per connection, as serveStdio requires. */
export function createVibeVisualEditorServer(deps: Deps = { cwd: process.cwd(), registry: registryDir() }): McpServer {
  const server = new McpServer({ name: 'vibe-visual-editor', title: 'Vibe Visual Editor MCP', version: VERSION }, { instructions: INSTRUCTIONS });

  const route = (): Route => {
    const r = pickWindow(readWindows(deps.registry), deps.cwd);
    if (!r) throw new BridgeError(NO_WINDOW);
    return r;
  };

  const guarded =
    <A>(fn: (args: A) => Promise<ReturnType<typeof text>>) =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (err) {
        if (err instanceof BridgeError) return text(err.message, true);
        throw err;
      }
    };

  async function selectionMarkdown(r: Route): Promise<string> {
    const res = SelectionResponseSchema.parse(await call(r, 'GET', '/selection'));
    if (!res.selection) {
      return 'Nothing is selected in the Vibe Visual Editor preview. Ask the user to switch the preview to Select mode and click the element they mean.';
    }
    return formatSelectionMarkdown(res.selection);
  }

  server.registerTool(
    'open_preview',
    {
      title: 'Open preview',
      description:
        "Open, show, render or preview a page of the user's running web app in a VS Code tab (Vibe Visual Editor). Use when the user asks to see a page or screen. `path` is app-relative: '#/settings' for a hash route, 'admin/', or 'about.html'. Without `url`, uses the dev server discovered in the workspace; a workspace of plain HTML pages without one is served by the extension itself.",
      inputSchema: z.object({
        url: z.string().max(4096).optional().describe('Full dev server URL on localhost. Usually omit it.'),
        path: z.string().max(2048).optional().describe("App-relative path or hash route, e.g. '#/settings' or 'about.html'."),
        mode: z.enum(['browse', 'edit', 'select']).optional().describe("'select' lets the user pick an element to talk about; 'edit' lets them retype text."),
      }),
    },
    guarded(async (args: { url?: string; path?: string; mode?: 'browse' | 'edit' | 'select' }) => {
      const r = route();
      const res = OpenResponseSchema.parse(await call(r, 'POST', '/open', args));
      if (!res.ok) return text(res.error, true);
      return text(`${routeNote(r, deps.cwd)}Opened ${res.url} in the Vibe Visual Editor preview.${res.note ? ` ${res.note}` : ''}\nLink to reopen it: ${res.link}`);
    }),
  );

  server.registerTool(
    'get_selection',
    {
      title: 'Get selected element',
      description:
        "Get the element the user selected in the Vibe Visual Editor preview (\"this\", \"that button\", \"the selected element\", \"what I clicked\"): tag, text, CSS selector, computed styles, and the source file:line where it is created. Call before editing code for such requests.",
      annotations: { readOnlyHint: true },
    },
    guarded(async () => {
      const r = route();
      return text(routeNote(r, deps.cwd) + (await selectionMarkdown(r)));
    }),
  );

  server.registerTool(
    'get_preview_state',
    {
      title: 'Get preview state',
      description: 'Vibe Visual Editor preview status: open previews and their URLs, current mode, unsaved text edits, and running dev servers (including folders of HTML pages the extension serves).',
      annotations: { readOnlyHint: true },
    },
    guarded(async () => {
      const r = route();
      const s = StateResponseSchema.parse(await call(r, 'GET', '/state'));
      const lines = [
        s.previews.length ? '**Open previews:**' : 'No preview is open.',
        ...s.previews.map((p) => `- ${p.url} (mode: ${p.mode}, ${p.status}, ${p.pendingEdits} unsaved edit${p.pendingEdits === 1 ? '' : 's'}${p.active ? ', active' : ''})`),
        s.devServers.length ? '**Dev servers:**' : 'No dev server with the Vibe Visual Editor plugin was found in the workspace.',
        ...s.devServers.map((d) => `- ${d.url} (${d.running ? 'running' : 'not running'}) root ${d.root}`),
      ];
      return text(routeNote(r, deps.cwd) + lines.join('\n'));
    }),
  );

  server.registerResource(
    'selection',
    'preview://selection',
    { title: 'Selected element', description: 'The element selected in the Vibe Visual Editor preview.', mimeType: 'text/markdown' },
    async (uri) => {
      let body: string;
      try {
        body = await selectionMarkdown(route());
      } catch (err) {
        body = err instanceof BridgeError ? err.message : String(err);
      }
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: body }] };
    },
  );

  server.registerPrompt(
    'selected',
    { title: 'Selected element', description: 'Insert the element selected in the Vibe Visual Editor preview.' },
    async () => {
      let body: string;
      try {
        body = await selectionMarkdown(route());
      } catch (err) {
        body = err instanceof BridgeError ? err.message : String(err);
      }
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: body } }] };
    },
  );

  return server;
}

export type { WindowEntry };

import { existsSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { isHtml } from '@vibe-visual-editor/server-core';
import {
  formatSelectionMarkdown,
  joinAppPath,
  ModeSchema,
  parseLoopbackUrl,
  type Mode,
  type OpenRequest,
  type OpenResponse,
  type StateResponse,
} from '@vibe-visual-editor/protocol';
import { configureAgents, installLauncher } from './agentSetup';
import { BridgeServer } from './bridgeServer';
import { discoverDevServers, type DevServer } from './discovery';
import { PreviewManager, VIEW_TYPE, type PreviewPanel } from './previewPanel';
import { SelectionStore } from './selectionStore';
import { isInside, StaticPages, urlPathOf, viteAppOf } from './staticPages';
import { frameUrlFor, openLink } from './urls';

/** Returned from activate() for integration tests. */
export interface VibeVisualEditorApi {
  previews: PreviewManager;
  selection: SelectionStore;
  staticPages: StaticPages;
  handleUri(uri: vscode.Uri): Promise<PreviewPanel | undefined>;
  open(req: OpenRequest): Promise<OpenResponse>;
  openFile(uri?: vscode.Uri): Promise<PreviewPanel | undefined>;
}

const OPEN_STATIC = 'Open as Static Page';

/** Validates `vscode://andreykats.vibe-visual-editor/open?url=…&mode=…`. */
export function parseOpenUri(uri: vscode.Uri): { url: string; mode?: Mode } | { error: string } {
  if (uri.path !== '/open') return { error: `Unknown Vibe Visual Editor link: ${uri.path}` };
  const params = new URLSearchParams(uri.query);
  const url = parseLoopbackUrl(params.get('url') ?? '');
  if (!url) return { error: 'Vibe Visual Editor links can only open http(s) URLs on localhost, 127.0.0.1 or [::1].' };
  const mode = params.get('mode');
  if (mode === null) return { url: url.href };
  const parsedMode = ModeSchema.safeParse(mode);
  return parsedMode.success ? { url: url.href, mode: parsedMode.data } : { error: `Unknown mode: ${mode}` };
}

export async function activate(context: vscode.ExtensionContext): Promise<VibeVisualEditorApi> {
  const log = vscode.window.createOutputChannel('Vibe Visual Editor', { log: true });
  const selection = new SelectionStore();
  const previews = new PreviewManager({ extensionUri: context.extensionUri, selection, log });
  const staticPages = new StaticPages(context.extensionUri, log);
  context.subscriptions.push(log, selection, previews, staticPages);

  // A static page has no dev server to reload it: reload its previews when its folder changes on disk.
  staticPages.onDidChangeFiles(async (url) => {
    const origin = new URL(await frameUrlFor(url)).origin;
    for (const p of previews.all()) if (p.origin === origin) p.reload();
  });

  /** Dev servers that registered in the workspace, then the folders this window serves itself. */
  const servers = async (): Promise<DevServer[]> => [...(await discoverDevServers()), ...(await staticPages.list())];

  /**
   * The static server for the first workspace folder with an HTML page, and
   * the page to start on: the folder's index.html, else the page found.
   */
  async function staticSite(): Promise<{ root: string; start: string } | undefined> {
    const [page] = await vscode.workspace.findFiles('**/*.html', '**/node_modules/**', 1);
    const folder = page && vscode.workspace.getWorkspaceFolder(page);
    if (!folder) return undefined;
    const server = await staticPages.serverFor(folder);
    const start = existsSync(path.join(server.root, 'index.html')) ? server.url : new URL(urlPathOf(server.root, page.fsPath), server.url).href;
    return { root: server.url, start };
  }

  /**
   * Opens an HTML file: through the running dev server it belongs to, if
   * any, otherwise served by the extension as a static page.
   */
  async function openFile(uri = vscode.window.activeTextEditor?.document.uri): Promise<PreviewPanel | undefined> {
    if (!uri || uri.scheme !== 'file' || !isHtml(uri.fsPath)) {
      void vscode.window.showErrorMessage('Vibe Visual Editor: choose an .html file to open.');
      return undefined;
    }
    const file = uri.fsPath;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      void vscode.window.showErrorMessage(`Vibe Visual Editor: ${file} is outside this window's workspace folders, so its text can't be edited.`);
      return undefined;
    }
    const devServer = (await discoverDevServers()).find((s) => s.running && isInside(s.root, file));
    if (devServer) return previews.open(new URL(urlPathOf(devServer.root, file), devServer.url).href);
    const app = viteAppOf(file, folder.uri.fsPath);
    if (app) {
      const choice = await vscode.window.showWarningMessage(
        `Vibe Visual Editor: ${vscode.workspace.asRelativePath(uri)} belongs to the Vite app in ${vscode.workspace.asRelativePath(app)}. Start its dev server (npm run dev) to preview it as the app, with its scripts' text editable too.`,
        OPEN_STATIC,
      );
      if (choice !== OPEN_STATIC) return undefined;
    }
    const server = await staticPages.serverFor(folder);
    return previews.open(new URL(urlPathOf(server.root, file), server.url).href);
  }

  const target = (): PreviewPanel | undefined => {
    const p = previews.current();
    if (!p) void vscode.window.showInformationMessage('Vibe Visual Editor: no preview is open.');
    return p;
  };

  async function open(req: OpenRequest): Promise<OpenResponse> {
    let base = req.url;
    let note: string | undefined;
    if (base !== undefined && !parseLoopbackUrl(base)) {
      return { ok: false, error: `Refusing to open ${base}: only http(s) URLs on localhost, 127.0.0.1 or [::1] are allowed.` };
    }
    if (!base) {
      const running = (await servers()).filter((s) => s.running);
      const open = new Set(previews.all().map((p) => p.origin));
      const pick = running.find((s) => open.has(new URL(s.url).origin)) ?? running[0];
      if (pick) {
        base = pick.url;
        if (running.length > 1) note = `Several dev servers are running; opened ${pick.url} (others: ${running.filter((s) => s !== pick).map((s) => s.url).join(', ')}).`;
      } else {
        // No dev server: plain HTML pages are served by the extension itself.
        const site = await staticSite();
        if (!site) {
          return {
            ok: false,
            error:
              'No running dev server with the Vibe Visual Editor plugin, and no .html page, was found in this workspace. Start the dev server (for example `npm run dev`) and call open_preview again, or pass `url`.',
          };
        }
        base = req.path ? site.root : site.start;
      }
    }
    const url = req.path ? joinAppPath(base, req.path) : base;
    const panel = await previews.open(url, { mode: req.mode, preserveFocus: true });
    return { ok: true, url: panel.url, link: openLink(panel.url, req.mode), ...(note ? { note } : {}) };
  }

  async function handleUri(uri: vscode.Uri): Promise<PreviewPanel | undefined> {
    const parsed = parseOpenUri(uri);
    if ('error' in parsed) {
      void vscode.window.showErrorMessage(parsed.error);
      return undefined;
    }
    const panel = await previews.open(parsed.url, { mode: parsed.mode });
    const roots = new Set((await servers()).filter((s) => new URL(s.url).origin === panel.origin).map((s) => s.root));
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (roots.size === 0 && folders.length > 0) {
      void vscode.window.showInformationMessage('Vibe Visual Editor: this dev server is not part of this window\'s workspace, so text edits will be refused. Selection still works.');
    }
    return panel;
  }

  async function state(): Promise<StateResponse> {
    const all = await servers();
    const current = previews.current();
    return {
      previews: previews.all().map((p) => ({ url: p.url, mode: p.mode, status: p.status, pendingEdits: p.edits.pendingCount, active: p === current })),
      devServers: all.map((s) => ({ url: s.url, root: s.root, running: s.running })),
    };
  }

  context.subscriptions.push(
    vscode.window.registerUriHandler({ handleUri: (uri) => void handleUri(uri) }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: (panel, saved) => previews.restore(panel, saved),
    }),
    vscode.commands.registerCommand('vibeVisualEditor.openPreview', async (arg?: unknown) => {
      if (typeof arg === 'string') {
        const res = await open({ url: arg });
        if (!res.ok) void vscode.window.showErrorMessage(res.error);
        return;
      }
      const running = (await servers()).filter((s) => s.running);
      const editor = vscode.window.activeTextEditor?.document.uri;
      if (running.length === 0 && editor && isHtml(editor.fsPath)) return void (await openFile(editor));
      const items: (vscode.QuickPickItem & { url?: string })[] = running.map((s) => ({
        label: s.url,
        description: vscode.workspace.asRelativePath(s.root),
        url: s.url,
      }));
      items.push({ label: 'Enter a URL…' });
      const picked = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: 'Vibe Visual Editor: open preview' });
      if (!picked) return;
      const url =
        picked.url ??
        (await vscode.window.showInputBox({
          title: 'Vibe Visual Editor: dev server URL',
          value: 'http://localhost:5173/',
          validateInput: (v) => (parseLoopbackUrl(v) ? undefined : 'Use an http(s) URL on localhost, 127.0.0.1 or [::1].'),
        }));
      if (url) await previews.open(url);
    }),
    vscode.commands.registerCommand('vibeVisualEditor.openFile', (arg?: unknown) => openFile(arg instanceof vscode.Uri ? arg : undefined)),
    vscode.commands.registerCommand('vibeVisualEditor.save', () => target()?.save()),
    vscode.commands.registerCommand('vibeVisualEditor.discard', () => target()?.discard()),
    vscode.commands.registerCommand('vibeVisualEditor.undo', () => target()?.undo()),
    vscode.commands.registerCommand('vibeVisualEditor.redo', () => target()?.redo()),
    vscode.commands.registerCommand('vibeVisualEditor.setMode', async (arg?: unknown) => {
      const p = target();
      if (!p) return;
      const parsed = ModeSchema.safeParse(arg);
      const mode = parsed.success ? parsed.data : ((await vscode.window.showQuickPick(['browse', 'edit', 'select'], { title: 'Vibe Visual Editor mode' })) as Mode | undefined);
      if (mode) p.setMode(mode);
    }),
    vscode.commands.registerCommand('vibeVisualEditor.copySelectionForChat', async () => {
      const sel = selection.get();
      if (!sel) return void vscode.window.showInformationMessage('Vibe Visual Editor: nothing selected. Use Select mode and click an element.');
      await vscode.env.clipboard.writeText(formatSelectionMarkdown(sel.descriptor));
      void vscode.window.setStatusBarMessage('Vibe Visual Editor: selection copied for chat', 2500);
    }),
    vscode.commands.registerCommand('vibeVisualEditor.configureAgents', () => configureAgents(context.extensionUri, log)),
  );

  const bridge = new BridgeServer(
    {
      open,
      selection: () => {
        const sel = selection.get();
        return { selection: sel?.descriptor ?? null, previewUrl: sel?.previewUrl ?? previews.current()?.url ?? null };
      },
      state,
    },
    log,
  );
  context.subscriptions.push(bridge);
  bridge.start().catch((err: unknown) => log.error(`Bridge failed to start: ${String(err)}`));
  installLauncher(context.extensionUri).catch((err: unknown) => log.error(`Could not install the MCP launcher: ${String(err)}`));

  return { previews, selection, staticPages, handleUri, open, openFile };
}

export function deactivate(): void {}

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { PROTOCOL_VERSION } from '@vibe-visual-editor/protocol';
import { createStaticServer, toRel, type StaticServer } from '@vibe-visual-editor/server-core';
import type { DevServer } from './discovery';

/** Saves often come in bursts (a formatter, several files): reload once they settle. */
const RELOAD_DELAY_MS = 100;
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.cts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];

/** Whether `file` is inside `dir` (and isn't `dir` itself). */
export function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** `file` as a URL path relative to the server root `root`, e.g. `docs/a%20b.html`. */
export function urlPathOf(root: string, file: string): string {
  return toRel(root, file).split('/').map(encodeURIComponent).join('/');
}

/** The directory of the Vite app `file` belongs to, looking up from it to `top`, if any. */
export function viteAppOf(file: string, top: string): string | undefined {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (VITE_CONFIGS.some((name) => existsSync(path.join(dir, name)))) return dir;
    if (dir === top || !isInside(top, dir)) return undefined;
  }
}

/**
 * Plain HTML pages served by the extension itself, one loopback server per
 * workspace folder, so a page can be previewed and edited without a dev
 * server. A change to a file in the folder reloads previews of it.
 */
export class StaticPages implements vscode.Disposable {
  private readonly servers = new Map<string, Promise<StaticServer>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<string>();
  /** Fires with a server's URL after files in its folder changed on disk. */
  readonly onDidChangeFiles = this.changed.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.disposables.push(this.changed);
  }

  /** The server for `folder`, started on first use. */
  serverFor(folder: vscode.WorkspaceFolder): Promise<StaticServer> {
    const key = folder.uri.fsPath;
    let server = this.servers.get(key);
    if (!server) {
      server = this.start(folder);
      this.servers.set(key, server);
      server.catch((err: unknown) => {
        this.servers.delete(key);
        this.log.error(`Could not serve ${folder.name}: ${String(err)}`);
      });
    }
    return server;
  }

  /** The servers started so far, listed like dev servers. */
  async list(): Promise<DevServer[]> {
    const started = await Promise.allSettled(this.servers.values());
    return started
      .filter((s): s is PromiseFulfilledResult<StaticServer> => s.status === 'fulfilled')
      .map(({ value }) => ({ url: value.url, root: value.root, pid: process.pid, protocolVersion: PROTOCOL_VERSION, running: true }));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private async start(folder: vscode.WorkspaceFolder): Promise<StaticServer> {
    const bundle = vscode.Uri.joinPath(this.extensionUri, 'dist', 'page-client.js').fsPath;
    const server = await createStaticServer({ root: folder.uri.fsPath, clientBundle: () => readFile(bundle, 'utf8') });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = (uri: vscode.Uri) => {
      // Dotfiles and dot-folders (.git, .vibe-visual-editor) are never served, so they never show.
      if (toRel(server.root, uri.fsPath).split('/').some((segment) => segment.startsWith('.'))) return;
      clearTimeout(timer);
      timer = setTimeout(() => this.changed.fire(server.url), RELOAD_DELAY_MS);
    };
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
    this.disposables.push(
      watcher,
      watcher.onDidChange(onChange),
      watcher.onDidCreate(onChange),
      watcher.onDidDelete(onChange),
      {
        dispose: () => {
          clearTimeout(timer);
          void server.close();
        },
      },
    );
    this.log.info(`Serving ${folder.uri.fsPath} at ${server.url}`);
    return server;
  }
}

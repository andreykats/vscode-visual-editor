import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { PROTOCOL_VERSION, type Candidate, type ResolveResponse, type WindowEntry } from '@vibe-visual-editor/protocol';
import type { VibeVisualEditorApi } from '../../src/extension';
import type { PreviewPanel } from '../../src/previewPanel';

const DEV_URL = process.env.VIBE_VISUAL_EDITOR_TEST_DEV_URL!;
const WORKSPACE = process.env.VIBE_VISUAL_EDITOR_TEST_WORKSPACE!;
const HOME = process.env.VIBE_VISUAL_EDITOR_HOME!;
const DEV_ORIGIN = new URL(DEV_URL).origin;

const tests: { name: string; fn: () => Promise<void> }[] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push({ name, fn });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | Promise<T>, timeoutMs = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

const file = (rel: string) => path.join(WORKSPACE, rel);
const disk = (rel: string) => readFileSync(file(rel), 'utf8');

/**
 * The one candidate the dev server has for `text`. After a test saves a file,
 * Vite re-indexes it a moment later (and may briefly drop it while it reads a
 * half-written file), so this waits for the index to settle before failing.
 */
async function resolve(text: string): Promise<Candidate> {
  let candidates: Candidate[] = [];
  const deadline = Date.now() + 10_000;
  do {
    const res = await fetch(`${DEV_ORIGIN}/__vibe-visual-editor/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    candidates = ((await res.json()) as ResolveResponse).candidates;
    if (candidates.length === 1) return candidates[0]!;
    await sleep(100);
  } while (Date.now() < deadline);
  assert.equal(candidates.length, 1, `expected one candidate for ${text}`);
  return candidates[0]!;
}

async function doc(rel: string): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument(vscode.Uri.file(file(rel)));
}

/**
 * Writes `content` to a file through VS Code (edit and save), so the open
 * document matches the disk at once. Writing to disk directly would leave the
 * document waiting for the file watcher, which can lag on CI.
 */
async function restore(rel: string, content: string): Promise<void> {
  const d = await doc(rel);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(d.uri, new vscode.Range(d.positionAt(0), d.positionAt(d.getText().length)), content);
  assert.ok(await vscode.workspace.applyEdit(edit), `restore ${rel}`);
  assert.ok(await d.save(), `save ${rel}`);
  assert.equal(disk(rel), content);
}

/** Puts a file back to its on-disk content and clears its dirty state. */
async function revert(rel: string): Promise<void> {
  const d = await doc(rel);
  if (!d.isDirty) return;
  await vscode.window.showTextDocument(d);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

let api: VibeVisualEditorApi;
let panel: PreviewPanel;

test('activates and registers this window in the bridge registry', async () => {
  const ext = vscode.extensions.getExtension<VibeVisualEditorApi>('andreykats.vibe-visual-editor');
  assert.ok(ext, 'extension present');
  api = await ext.activate();
  const entryFile = path.join(HOME, 'windows', `${process.pid}.json`);
  await until('registry file', () => {
    try {
      return statSync(entryFile);
    } catch {
      return null;
    }
  });
  assert.equal(statSync(entryFile).mode & 0o777, 0o600);
  const entry = JSON.parse(readFileSync(entryFile, 'utf8')) as WindowEntry;
  assert.deepEqual(entry.workspaceFolders, [WORKSPACE]);
  assert.equal(statSync(path.join(HOME, 'bin', 'vibe-visual-editor-mcp.mjs')).isFile(), true);
});

test('URI handler rejects non-loopback URLs and unknown modes', async () => {
  for (const bad of ['http://example.com:5173/', 'file:///etc/passwd', 'http://localhost.evil.com/']) {
    const uri = vscode.Uri.parse(`${vscode.env.uriScheme}://andreykats.vibe-visual-editor/open?url=${encodeURIComponent(bad)}`);
    assert.equal(await api.handleUri(uri), undefined, bad);
  }
  const badMode = vscode.Uri.parse(`${vscode.env.uriScheme}://andreykats.vibe-visual-editor/open?url=${encodeURIComponent(DEV_URL)}&mode=paint`);
  assert.equal(await api.handleUri(badMode), undefined);
  assert.equal(api.previews.all().length, 0);
});

test('URI handler opens the preview, and the page client connects inside the webview', async () => {
  const uri = vscode.Uri.parse(`${vscode.env.uriScheme}://andreykats.vibe-visual-editor/open?url=${encodeURIComponent(DEV_URL)}&mode=select`);
  const opened = await api.handleUri(uri);
  assert.ok(opened);
  panel = opened;
  await until('page hello', () => panel.status === 'connected', 30_000);
  assert.equal(panel.mode, 'select');
  assert.equal(panel.url, DEV_URL);
});

test('HMR reaches the iframe: saving a file reloads the page', async () => {
  const before = panel.helloCount;
  const rel = 'src/strings.ts';
  const original = disk(rel);
  writeFileSync(file(rel), `${original}\n// touched\n`);
  try {
    await until('hello after reload', () => panel.helloCount > before, 20_000);
  } finally {
    writeFileSync(file(rel), original);
  }
  await until('hello after restore', () => panel.helloCount > before + 1, 20_000);
});

test('open() reuses the panel for the same origin and joins hash paths', async () => {
  const res = await api.open({ path: '#/settings', mode: 'edit' });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(api.previews.all().length, 1);
  assert.equal(res.url, `${DEV_URL}#/settings`);
  assert.match(res.link, /^[a-z-]+:\/\/andreykats\.vibe-visual-editor\/open\?url=/);
  const refused = await api.open({ url: 'http://example.com/' });
  assert.equal(refused.ok, false);
  await until('settings route', () => panel.url.endsWith('#/settings'));
});

test('edit makes the file dirty with a one-literal diff; save writes it', async () => {
  const rel = 'src/views/home.ts';
  const original = disk(rel);
  const c = await resolve('Welcome home');
  await panel.edits.edit(c, 'Hello "there"');
  const d = await doc(rel);
  assert.equal(d.isDirty, true);
  assert.equal(d.getText(), original.replace("'Welcome home'", `'Hello "there"'`));
  assert.equal(disk(rel), original, 'nothing on disk before save');
  assert.equal(panel.edits.pendingCount, 1);
  assert.deepEqual(panel.edits.pending(), [{ literalId: c.id, value: 'Hello "there"', original: 'Welcome home' }]);

  await panel.save();
  assert.equal(d.isDirty, false);
  assert.equal(disk(rel), original.replace("'Welcome home'", `'Hello "there"'`));
  assert.equal(panel.edits.pendingCount, 0);

  // Put it back for later tests.
  await restore(rel, original);
});

test('a line break is written as an escaped \\n', async () => {
  const rel = 'src/views/home.ts';
  const original = disk(rel);
  const c = await resolve('Edit me in place');
  await panel.edits.edit(c, 'Edit me\nin place');
  const d = await doc(rel);
  assert.equal(d.getText(), original.replace("'Edit me in place'", "'Edit me\\nin place'"));
  assert.deepEqual(panel.edits.pending(), [{ literalId: c.id, value: 'Edit me\nin place', original: 'Edit me in place' }]);
  await panel.discard();
  assert.equal(d.getText(), original);
  await revert(rel);
});

test('JSX text and attributes are written back in JSX syntax', async () => {
  // A React file in the h() workspace: the edit service only needs the candidate and the document.
  const rel = 'src/Hello.tsx';
  const source = `export const Hello = () => (\n  <p title="Old title">\n    Tom &amp; Jerry\n  </p>\n);\n`;
  writeFileSync(file(rel), source);
  try {
    const candidate = (raw: string, value: string, quote: Candidate['quote']): Candidate => {
      const start = source.indexOf(raw);
      return { id: `${file(rel)}:${start}`, file: file(rel), rel, line: 1, column: 1, start, end: start + raw.length, value, raw, quote, ordinal: 0, sameValueCount: 1, uses: 1 };
    };
    await panel.edits.edit(candidate('\n    Tom &amp; Jerry\n  ', 'Tom & Jerry', 'jsx'), 'Tom & {Jerry} <3');
    await panel.edits.edit(candidate('"Old title"', 'Old title', 'jsx-attr'), 'Say "hi"');
    const d = await doc(rel);
    assert.equal(d.getText(), `export const Hello = () => (\n  <p title='Say "hi"'>\n    Tom & &#123;Jerry&#125; &lt;3\n  </p>\n);\n`);
    await panel.discard();
    assert.equal(d.getText(), source);
  } finally {
    await revert(rel);
    rmSync(file(rel), { force: true });
  }
});

test('HTML page text is written back as HTML, and found again after the page moved', async () => {
  const rel = 'page.html';
  const source = '<!doctype html>\n<html>\n<body>\n  <p>\n    Tom &amp; Jerry\n  </p>\n</body>\n</html>\n';
  writeFileSync(file(rel), source);
  try {
    // Serving the page indexes it; the client would send the <p>'s data-vve-loc with the text.
    const served = await (await fetch(new URL(rel, DEV_URL))).text();
    const [start, end, line, column] = /<p data-vve-loc="[0-9a-z]+:(\d+):(\d+):(\d+):(\d+)"/.exec(served)!.slice(1).map(Number);
    const res = await fetch(`${DEV_ORIGIN}/__vibe-visual-editor/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '\n    Tom & Jerry\n  ', elementLoc: { file: file(rel), rel, start, end, line, column } }),
    });
    const [c] = ((await res.json()) as ResolveResponse).candidates;
    assert.equal(c?.raw, '\n    Tom &amp; Jerry\n  ');

    // An unsaved line above the text: the edit has to locate it again through the dev server.
    const d = await doc(rel);
    const insert = new vscode.WorkspaceEdit();
    insert.insert(d.uri, new vscode.Position(0, 0), '<!-- draft -->\n');
    assert.ok(await vscode.workspace.applyEdit(insert));
    await panel.edits.edit(c!, '\n    Tom & Jerry <3\n  ');
    assert.equal(d.getText(), `<!-- draft -->\n${source.replace('Tom &amp; Jerry', 'Tom & Jerry &lt;3')}`);
    await panel.discard();
    assert.equal(d.getText(), `<!-- draft -->\n${source}`);
  } finally {
    await revert(rel);
    rmSync(file(rel), { force: true });
  }
});

test('discard restores exactly; undo and redo step through edits', async () => {
  const rel = 'src/views/settings.ts';
  const original = disk(rel);
  await until('index refresh', async () => (await resolve('Videos')).raw === "'Videos'");
  const c = await resolve('Videos');
  await panel.edits.edit(c, 'Clips');
  await panel.edits.edit({ ...c }, 'Clips and more'); // second edit of the same literal
  const d = await doc(rel);
  assert.ok(d.getText().includes("'Clips and more'"));
  await panel.edits.undo();
  assert.ok(d.getText().includes("'Clips'"));
  await panel.edits.redo();
  assert.ok(d.getText().includes("'Clips and more'"));
  await panel.discard();
  assert.equal(d.getText(), original);
  assert.equal(panel.edits.pendingCount, 0);
  assert.equal(d.getText(), disk(rel), 'text matches disk again');
  await revert(rel);
});

test("the user's own unsaved edits survive edit, save and discard", async () => {
  const rel = 'src/views/settings.ts';
  const original = disk(rel);
  const d = await doc(rel);
  // The user types a comment at the top: offsets of everything below shift.
  const userEdit = new vscode.WorkspaceEdit();
  userEdit.insert(d.uri, new vscode.Position(0, 0), '// my note\n');
  assert.ok(await vscode.workspace.applyEdit(userEdit));

  const c = await resolve('Videos'); // offsets from disk, now stale for the document
  await panel.edits.edit(c, 'Clips');
  assert.equal(d.getText(), `// my note\n${original.replace("'Videos'", "'Clips'")}`);

  await panel.discard();
  assert.equal(d.getText(), `// my note\n${original}`, 'discard keeps the user edit');
  assert.equal(d.isDirty, true);

  await panel.edits.edit(c, 'Clips');
  // Another file the user has dirty must not be saved by Vibe Visual Editor.
  const other = await doc('src/main.ts');
  const otherEdit = new vscode.WorkspaceEdit();
  otherEdit.insert(other.uri, new vscode.Position(0, 0), '// unsaved\n');
  assert.ok(await vscode.workspace.applyEdit(otherEdit));
  await panel.save();
  assert.equal(disk(rel), `// my note\n${original.replace("'Videos'", "'Clips'")}`);
  assert.equal(other.isDirty, true, 'unrelated dirty file untouched');
  assert.ok(!disk('src/main.ts').startsWith('// unsaved'));

  await restore(rel, original);
  await revert('src/main.ts');
});

test('an edited range changed by someone else is dropped, and stale literals are refused', async () => {
  const rel = 'src/views/home.ts';
  await until('index refresh', async () => (await resolve('Welcome home')).raw === "'Welcome home'");
  const c = await resolve('Welcome home');
  await panel.edits.edit(c, 'Hi');
  const d = await doc(rel);
  const start = d.getText().indexOf("'Hi'");
  const clash = new vscode.WorkspaceEdit();
  clash.replace(d.uri, new vscode.Range(d.positionAt(start + 1), d.positionAt(start + 2)), 'X');
  assert.ok(await vscode.workspace.applyEdit(clash));
  assert.equal(panel.edits.pendingCount, 0, 'entry dropped');
  await revert(rel);

  // A candidate whose text no longer exists anywhere in the file.
  await assert.rejects(panel.edits.edit({ ...c, id: 'stale', raw: "'Gone'", value: 'Gone', start: 0, end: 6 }, 'x'), /changed since the page loaded/);
  // Files outside the workspace are refused.
  await assert.rejects(panel.edits.edit({ ...c, id: 'outside', file: '/etc/hosts' }, 'x'), /outside the workspace/);
  assert.equal((await doc(rel)).isDirty, false);
});

test('page messages: le:edit applies through the panel, le:select reaches the store', async () => {
  const c = await resolve('Back');
  const onFrame = (panel as unknown as { onFrameMessage(d: unknown): Promise<void> }).onFrameMessage.bind(panel);
  await onFrame({ type: 'le:edit', v: PROTOCOL_VERSION, requestId: 7, candidates: [c], newValue: 'Return' });
  assert.equal(panel.edits.pendingCount, 1);
  await panel.discard();
  await revert('src/views/settings.ts');

  await onFrame({ type: 'le:edit', v: PROTOCOL_VERSION, requestId: 8, candidates: [], newValue: 'x' }); // invalid: ignored
  assert.equal(panel.edits.pendingCount, 0);

  const descriptor = {
    tag: 'h2', classList: [], attributes: {}, textContent: 'Videos', selector: 'h2', outerHTML: '<h2>Videos</h2>',
    boundingRect: { x: 0, y: 0, width: 1, height: 1 }, styles: {}, creationSiteIsAncestor: false,
    pageUrl: DEV_URL, route: '', timestamp: 1,
  };
  await onFrame({ type: 'le:select', v: PROTOCOL_VERSION, descriptor });
  assert.equal(api.selection.get()?.descriptor.tag, 'h2');
  await onFrame({ type: 'le:hello', v: 99, url: DEV_URL, title: '' });
  assert.equal(panel.status, 'protocol-mismatch');
});

test('bridge: token required; selection and state served; open validated', async () => {
  const entry = JSON.parse(readFileSync(path.join(HOME, 'windows', `${process.pid}.json`), 'utf8')) as WindowEntry;
  const base = `http://127.0.0.1:${entry.port}`;
  assert.equal((await fetch(`${base}/selection`)).status, 401);
  assert.equal((await fetch(`${base}/selection`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
  const auth = { Authorization: `Bearer ${entry.token}` };
  const sel = (await (await fetch(`${base}/selection`, { headers: auth })).json()) as { selection: { tag: string } | null };
  assert.equal(sel.selection?.tag, 'h2');
  const state = (await (await fetch(`${base}/state`, { headers: auth })).json()) as { previews: unknown[]; devServers: { url: string; running: boolean }[] };
  assert.equal(state.previews.length, 1);
  assert.ok(state.devServers.some((s) => s.url === DEV_URL && s.running), JSON.stringify(state.devServers));
  const bad = await fetch(`${base}/open`, { method: 'POST', headers: auth, body: '{"mode":"paint"}' });
  assert.equal(bad.status, 400);
  const ok = (await (await fetch(`${base}/open`, { method: 'POST', headers: auth, body: '{"path":"#/"}' })).json()) as { ok: boolean };
  assert.equal(ok.ok, true);
});

test('an HTML file inside the running dev server opens on its URL', async () => {
  const rel = 'page.html';
  writeFileSync(file(rel), '<!doctype html>\n<title>Page</title>\n<h1>Page</h1>\n');
  try {
    const opened = await api.openFile(vscode.Uri.file(file(rel)));
    assert.equal(opened, panel, 'same origin, same panel');
    assert.equal(panel.url, `${DEV_URL}page.html`);
  } finally {
    rmSync(file(rel), { force: true });
  }
});

test('a plain HTML page is served by the extension: edit, save, and the preview reloads', async () => {
  const rel = 'site/index.html';
  const source = '<!doctype html>\n<html>\n<head><title>Site</title></head>\n<body>\n  <h1>Static page</h1>\n</body>\n</html>\n';
  mkdirSync(file('site'), { recursive: true });
  writeFileSync(file(rel), source);
  const server = await api.staticPages.serverFor(vscode.workspace.workspaceFolders![0]!);
  const page = await api.previews.open(new URL('site/', server.url).href);
  try {
    assert.notEqual(page, panel);
    await until('static page connects', () => page.status === 'connected', 30_000);

    const served = await (await fetch(new URL('site/', server.url))).text();
    const [start, end, line, column] = /<h1 data-vve-loc="0:(\d+):(\d+):(\d+):(\d+)"/.exec(served)!.slice(1).map(Number);
    const res = await fetch(new URL('/__vibe-visual-editor/resolve', server.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Static page', elementLoc: { file: file(rel), rel, start, end, line, column } }),
    });
    const [c] = ((await res.json()) as ResolveResponse).candidates;
    assert.equal(c?.raw, 'Static page');

    const before = page.helloCount;
    await page.edits.edit(c!, 'Edited & saved');
    await page.save();
    assert.equal(disk(rel), source.replace('Static page', 'Edited & saved'));
    await until('reload after save', () => page.helloCount > before, 20_000);
    assert.ok((await (await fetch(new URL('site/', server.url))).text()).includes('Edited & saved'));
  } finally {
    page.panel.dispose();
    await revert(rel);
    rmSync(file('site'), { recursive: true, force: true });
  }
});

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const t of tests) {
    const started = Date.now();
    try {
      await t.fn();
      console.log(`  ✓ ${t.name} (${Date.now() - started}ms)`);
    } catch (err) {
      failures.push(t.name);
      console.log(`  ✗ ${t.name}\n    ${(err as Error).stack?.split('\n').slice(0, 6).join('\n    ')}`);
    }
  }
  console.log(`\n  ${tests.length - failures.length} passed, ${failures.length} failed`);
  if (failures.length > 0) throw new Error(`${failures.length} test(s) failed`);
}

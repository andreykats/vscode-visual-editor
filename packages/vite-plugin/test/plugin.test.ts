import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@vibe-visual-editor/protocol';
import { build, createServer, type ViteDevServer } from 'vite';

const fixture = fileURLToPath(new URL('../../../fixtures/h-app', import.meta.url));
const htmlFixture = fileURLToPath(new URL('../../../fixtures/html-app', import.meta.url));

const MARKERS = /virtual:vibe-visual-editor|\/__vibe-visual-editor\/|data-vve-loc|__leFile|__le\(/;

function filesIn(dir: string): string[] {
  const files: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) files.push(...filesIn(path.join(dir, e.name)));
    else files.push(path.join(dir, e.name));
  }
  return files;
}

describe('plugin against fixtures/h-app', () => {
  let server: ViteDevServer;
  let base: string;

  beforeAll(async () => {
    server = await createServer({ root: fixture, configFile: path.join(fixture, 'vite.config.ts'), server: { port: 0 }, logLevel: 'silent' });
    await server.listen();
    const addr = server.httpServer!.address() as { port: number };
    base = `http://localhost:${addr.port}`;
  });
  afterAll(async () => {
    await server?.close();
  });

  const post = async (route: string, body: unknown) => {
    const res = await fetch(`${base}/__vibe-visual-editor/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  it('writes the discovery file', () => {
    const info = JSON.parse(readFileSync(path.join(fixture, '.vibe-visual-editor/server.json'), 'utf8'));
    expect(info).toMatchObject({ root: fixture, pid: process.pid, protocolVersion: PROTOCOL_VERSION });
    expect(info.url).toBe(`${base}/h-app/`);
  });

  it('reports health', async () => {
    const res = await fetch(`${base}/__vibe-visual-editor/health`);
    expect(await res.json()).toEqual({ protocolVersion: PROTOCOL_VERSION, adapters: ['h(h)'], root: fixture });
  });

  it('wraps creation sites and returns a source map', async () => {
    const result = await server.transformRequest('/src/views/settings.ts');
    expect(result!.code).toContain('virtual:vibe-visual-editor/runtime');
    expect(result!.code).toMatch(/__le\(h\("h2", \{\}, "Videos"\), \{/);
    expect(result!.map).toBeTruthy();
    expect((result!.map as { sources: string[] }).sources.some((s) => s.endsWith('settings.ts'))).toBe(true);
  });

  it('injects the client into index.html', async () => {
    const html = await (await fetch(`${base}/h-app/`)).text();
    expect(html).toContain('html-proxy');
    const proxy = await (await fetch(`${base}/h-app/index.html?html-proxy&index=0.js`)).text();
    expect(proxy).toContain('virtual:vibe-visual-editor/client');
  });

  it('resolves rendered text to candidates', async () => {
    await server.transformRequest('/src/main.ts');
    await server.transformRequest('/src/views/home.ts');
    await server.transformRequest('/src/strings.ts');
    const home = await post('resolve', { text: 'Welcome home' });
    expect(home.body.candidates).toHaveLength(1);
    expect(home.body.candidates[0]).toMatchObject({ rel: 'src/views/home.ts', raw: "'Welcome home'", uses: 1 });
    const shared = await post('resolve', { text: 'Shared label' });
    expect(shared.body.candidates[0]).toMatchObject({ rel: 'src/strings.ts', binding: 'SHARED_LABEL', uses: 2 });
    expect((await post('resolve', { text: 'Pressed 0 times' })).body.editable).toBe(false);
  });

  it('analyzes arbitrary code without touching the index', async () => {
    const res = await post('analyze', { file: path.join(fixture, 'src/x.ts'), code: "const a = 'Z';" });
    expect(res.body.literals.map((l: { value: string }) => l.value)).toEqual(['Z']);
    expect((await post('resolve', { text: 'Z' })).body.editable).toBe(false);
  });

  it('validates input', async () => {
    expect((await post('resolve', { text: 5 })).status).toBe(400);
    expect((await post('analyze', { file: 'relative.ts', code: '' })).status).toBe(400);
    expect((await post('analyze', { file: '/abs/x.ts', code: 'const = ;' })).status).toBe(422);
    const wrongType = await fetch(`${base}/__vibe-visual-editor/resolve`, { method: 'POST', body: '{"text":"x"}' });
    expect(wrongType.status).toBe(415);
    expect((await fetch(`${base}/__vibe-visual-editor/nope`)).status).toBe(404);
  });
});

describe('plugin against fixtures/html-app', () => {
  let server: ViteDevServer;
  let base: string;
  const page = path.join(htmlFixture, 'index.html');

  beforeAll(async () => {
    server = await createServer({ root: htmlFixture, configFile: path.join(htmlFixture, 'vite.config.ts'), server: { port: 0 }, logLevel: 'silent' });
    await server.listen();
    base = `http://localhost:${(server.httpServer!.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await server?.close();
  });

  const resolve = async (text: string, elementLoc?: unknown) => {
    const res = await fetch(`${base}/__vibe-visual-editor/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, elementLoc }) });
    return res.json();
  };
  /** The creation site in a served element's `data-vve-loc`, as the page client reads it. */
  const locIn = (html: string, before: string) => {
    const match = new RegExp(`data-vve-loc="[0-9a-z]+:(\\d+):(\\d+):(\\d+):(\\d+)"[^>]*>${before}`).exec(html)!;
    const [start, end, line, column] = match.slice(1).map(Number);
    return { file: page, rel: 'index.html', start, end, line, column };
  };

  it('runs with no adapters', async () => {
    expect(await (await fetch(`${base}/__vibe-visual-editor/health`)).json()).toMatchObject({ adapters: [] });
  });

  it('tags the elements of a served page and registers its file with the client', async () => {
    const html = await (await fetch(`${base}/html-app/`)).text();
    expect(html).toMatch(/<h1 data-vve-loc="0:\d+:\d+:9:5">\n      Plain HTML/);
    expect(html).toMatch(/<li data-vve-loc="0:\d+:\d+:16:7">Home<\/li>/);
    expect(html).toContain('<title>html-app fixture</title>');
    const proxy = await (await fetch(`${base}/html-app/index.html?html-proxy&index=0.js`)).text();
    expect(proxy).toContain('virtual:vibe-visual-editor/client');
    expect(proxy).toContain(`__leFile("0", ${JSON.stringify(page)}, "index.html")`);
  });

  it("resolves a page's text through the element it is written in", async () => {
    const html = await (await fetch(`${base}/html-app/`)).text();
    // Fetching the page's inline-script proxy must not replace the page's index.
    await fetch(`${base}/html-app/index.html?html-proxy&index=0.js`);
    const heading = await resolve('\n      Plain HTML\n    ', locIn(html, '\\n      Plain'));
    expect(heading.candidates).toEqual([expect.objectContaining({ rel: 'index.html', quote: 'html', raw: '\n      Plain HTML\n    ', line: 9 })]);
    const entity = await resolve('Tom & Jerry', locIn(html, 'Tom'));
    expect(entity.candidates).toEqual([expect.objectContaining({ raw: 'Tom &amp; Jerry', value: 'Tom & Jerry' })]);
    expect((await resolve('Tom & Jerry')).editable).toBe(false);
  });

  it('analyzes an edited page without touching the index', async () => {
    const res = await fetch(`${base}/__vibe-visual-editor/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: page, code: '<!doctype html><body><p>Draft &lt;1&gt;</p>' }),
    });
    expect((await res.json()).literals).toEqual([expect.objectContaining({ value: 'Draft <1>', raw: 'Draft &lt;1&gt;', quote: 'html' })]);
  });
});

describe('production build', () => {
  it.each([fixture, htmlFixture])('contains no Vibe Visual Editor code: %s', async (root) => {
    const outDir = path.join(root, 'dist');
    await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    const files = filesIn(outDir);
    expect(files.length).toBeGreaterThan(1);
    // The plugin's markers, not its bare name, which can also be part of the checkout's path.
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(MARKERS);
    expect(existsSync(path.join(outDir, 'index.html'))).toBe(true);
  });
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@vibe-visual-editor/protocol';
import { createStaticServer, type StaticServer } from '../src';

const CLIENT = 'export function start() {}';

/** A request exactly as written: `fetch` would normalize `..` in the path and won't send a custom Host. */
function raw(url: string, pathname: string, options: { method?: string; host?: string } = {}): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: pathname, method: options.method ?? 'GET', headers: { host: options.host ?? `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('createStaticServer', () => {
  let work: string;
  let root: string;
  let server: StaticServer;

  beforeAll(async () => {
    work = realpathSync(mkdtempSync(path.join(tmpdir(), 'vve-static-')));
    root = path.join(work, 'site');
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'index.html'), '<!doctype html>\n<html>\n<head><title>T</title></head>\n<body>\n  <h1>Welcome</h1>\n  <p>Tom &amp; Jerry</p>\n</body>\n</html>\n');
    writeFileSync(path.join(root, 'docs', 'index.html'), '<p>Docs</p>');
    writeFileSync(path.join(root, 'style.css'), 'p { color: red }');
    writeFileSync(path.join(root, '.env'), 'SECRET=1');
    writeFileSync(path.join(root, 'server.pem'), 'KEY');
    writeFileSync(path.join(work, 'outside.txt'), 'outside');
    symlinkSync(path.join(work, 'outside.txt'), path.join(root, 'link.txt'));
    server = await createStaticServer({ root, clientBundle: async () => CLIENT, trustedParentOrigins: ['http://127.0.0.1:9'] });
  });
  afterAll(async () => {
    await server?.close();
    rmSync(work, { recursive: true, force: true });
  });

  const post = (route: string, body: unknown) =>
    fetch(new URL(`/__vibe-visual-editor/${route}`, server.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('listens on loopback and reports health', async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(await (await fetch(new URL('/__vibe-visual-editor/health', server.url))).json()).toEqual({ protocolVersion: PROTOCOL_VERSION, adapters: [], root });
  });

  it('serves a page tagged, with the client started in its <head>', async () => {
    const res = await fetch(server.url);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('<head><script type="module">import { start } from "/__vibe-visual-editor/client.js";');
    expect(html).toContain(`"files":{"0":{"file":${JSON.stringify(path.join(root, 'index.html'))},"rel":"index.html"}}`);
    expect(html).toContain('"trustedParentOrigins":["http://127.0.0.1:9"]');
    expect(html).toMatch(/<h1 data-vve-loc="0:\d+:\d+:5:3">Welcome<\/h1>/);
    expect(await (await fetch(new URL('/__vibe-visual-editor/client.js', server.url))).text()).toBe(CLIENT);
  });

  it('serves other files as they are, and a directory as its index.html once its URL ends in /', async () => {
    const css = await fetch(new URL('/style.css', server.url));
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await css.text()).toBe('p { color: red }');
    const redirect = await raw(server.url, '/docs?x=1');
    expect([redirect.status, redirect.headers.location]).toEqual([301, '/docs/?x=1']);
    expect(await (await fetch(new URL('/docs/', server.url))).text()).toContain('>Docs</p>');
    expect((await raw(server.url, '/missing.html')).status).toBe(404);
  });

  it('resolves and analyzes the text of pages it served', async () => {
    const html = await (await fetch(server.url)).text();
    const [start, end, line, column] = /<p data-vve-loc="0:(\d+):(\d+):(\d+):(\d+)"/.exec(html)!.slice(1).map(Number);
    const file = path.join(root, 'index.html');
    const res = await (await post('resolve', { text: 'Tom & Jerry', elementLoc: { file, rel: 'index.html', start, end, line, column } })).json();
    expect(res.candidates).toEqual([expect.objectContaining({ raw: 'Tom &amp; Jerry', quote: 'html', rel: 'index.html' })]);
    const analyzed = await (await post('analyze', { file, code: '<p>Draft</p>' })).json();
    expect(analyzed.literals.map((l: { value: string }) => l.value)).toEqual(['Draft']);
    expect((await post('analyze', { file: path.join(root, 'x.js'), code: '' })).status).toBe(422);
  });

  it('refuses paths outside the folder, dotfiles, key files, and other methods', async () => {
    for (const p of ['/../outside.txt', '/%2e%2e/outside.txt', '/docs/..%2f..%2foutside.txt', '/link.txt', '/.env', '/server.pem', '/a%00b']) {
      expect((await raw(server.url, p)).status, p).toBe(404);
    }
    expect((await raw(server.url, '/%E0%A4%A')).status).toBe(400);
    expect((await raw(server.url, '/index.html', { method: 'POST' })).status).toBe(405);
  });

  it('refuses a Host that is not loopback, as a DNS-rebinding page would send', async () => {
    expect((await raw(server.url, '/', { host: 'evil.example:80' })).status).toBe(403);
    expect((await raw(server.url, '/', { host: `localhost:${new URL(server.url).port}` })).status).toBe(200);
  });

  it('requires JSON for the API', async () => {
    const res = await fetch(new URL('/__vibe-visual-editor/resolve', server.url), { method: 'POST', body: '{"text":"x"}' });
    expect(res.status).toBe(415);
  });
});

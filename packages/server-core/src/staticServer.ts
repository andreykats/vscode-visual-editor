import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PROTOCOL_VERSION, type ClientConfig, type HealthResponse } from '@vibe-visual-editor/protocol';
import { HttpError, serveApi, type ApiHandlers } from './api';
import { HtmlIndex, isHtml } from './html';
import { clientScript, tagPage } from './inject';
import { toRel } from './text';

export interface StaticServerOptions {
  /** Folder served at `/`. */
  root: string;
  /** The page client bundle: an ES module that exports `start`. */
  clientBundle(): Promise<string>;
  /** Parent origins to trust besides VS Code webviews. Only test harnesses need them. */
  trustedParentOrigins?: string[];
  /** Defaults to a free port. */
  port?: number;
}

export interface StaticServer {
  /** `http://127.0.0.1:<port>/` */
  readonly url: string;
  readonly root: string;
  readonly index: HtmlIndex;
  close(): Promise<void>;
}

const CLIENT_PATH = '/__vibe-visual-editor/client.js';
/** The token of a page's own file in its `data-vve-loc` attributes; a static page has no other. */
const PAGE_TOKEN = '0';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

/** Path segments never served: dotfiles and dot-folders (`.env`, `.git`, `..`) and key material. */
const DENIED_SEGMENT = /^\.|\.(?:pem|crt|key)$/i;

/** Only loopback names reach the server; any other `Host` is a DNS-rebound site trying to read the folder. */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}

/**
 * Serves a folder of HTML pages on loopback the way the Vite plugin serves an
 * app: each page is indexed and tagged and loads the page client, and the
 * `/__vibe-visual-editor/*` API answers for it. Other files are served as
 * they are. Nothing is cached, so a reload always shows the files on disk.
 */
export async function createStaticServer(options: StaticServerOptions): Promise<StaticServer> {
  const root = path.resolve(options.root);
  const realRoot = await realpath(root);
  const index = new HtmlIndex(root);
  const trustedParentOrigins = options.trustedParentOrigins ?? [];

  const api: ApiHandlers = {
    health: (): HealthResponse => ({ protocolVersion: PROTOCOL_VERSION, adapters: [], root }),
    resolve: (req) => index.resolve(req),
    analyze: (file, code) => {
      if (!isHtml(file)) throw new HttpError(422, `${file}: only HTML pages are indexed by this server`);
      return index.analyze(file, code);
    },
  };

  /** The file behind a URL path, both as the workspace sees it and with symlinks resolved, kept inside the root. */
  const locate = async (pathname: string): Promise<{ file: string; real: string }> => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Malformed URL');
    }
    const segments = decoded.split('/').filter(Boolean);
    if (decoded.includes('\0') || decoded.includes('\\') || segments.some((s) => DENIED_SEGMENT.test(s))) throw new HttpError(404, 'Not found');
    const file = path.join(root, ...segments);
    let real: string;
    try {
      real = await realpath(file);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new HttpError(404, 'Not found');
    return { file, real };
  };

  const page = (file: string, html: string): string => {
    const analysis = index.update(file, html);
    const config: ClientConfig = { trustedParentOrigins };
    if (analysis.creationSites.length > 0) config.files = { [PAGE_TOKEN]: { file, rel: toRel(root, file) } };
    const script = `<script type="module">${clientScript(CLIENT_PATH, config)}</script>`;
    return tagPage(html, analysis.creationSites, PAGE_TOKEN, { at: analysis.injectAt, text: script });
  };

  const serveFile = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === CLIENT_PATH) {
      res.setHeader('Content-Type', MIME['.js']!);
      res.end(req.method === 'HEAD' ? undefined : await options.clientBundle());
      return;
    }
    let target = await locate(url.pathname);
    let info = await stat(target.real);
    if (info.isDirectory()) {
      // Relative links in the directory's index.html resolve against the URL, so it must end in '/'.
      if (!url.pathname.endsWith('/')) {
        res.statusCode = 301;
        res.setHeader('Location', `${url.pathname}/${url.search}`);
        res.end();
        return;
      }
      target = await locate(`${url.pathname}index.html`);
      info = await stat(target.real);
    }
    if (!info.isFile()) throw new HttpError(404, 'Not found');
    const type = MIME[path.extname(target.file).toLowerCase()] ?? 'application/octet-stream';
    res.setHeader('Content-Type', type);
    if (isHtml(target.file)) {
      const body = page(target.file, await readFile(target.real, 'utf8'));
      res.setHeader('Content-Length', Buffer.byteLength(body));
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    res.setHeader('Content-Length', info.size);
    if (req.method === 'HEAD') return void res.end();
    const stream = createReadStream(target.real);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };

  const server = createServer((req, res) => {
    if (!isLoopbackHost(req.headers.host)) return sendText(res, 403, 'Forbidden host');
    if (serveApi(req, res, api)) return;
    serveFile(req, res).catch((err: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) sendText(res, err.status, err.message);
      else sendText(res, 500, err instanceof Error ? err.message : String(err));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    root,
    index,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

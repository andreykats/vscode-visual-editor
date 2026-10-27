import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import {
  AnalyzeRequestSchema,
  formatIssues,
  ResolveRequestSchema,
  type AnalyzeResponse,
  type HealthResponse,
  type LiteralEntry,
  type ResolveRequest,
  type ResolveResponse,
} from '@vibe-visual-editor/protocol';

const MAX_BODY = 6 * 1024 * 1024;
const API_ROUTE = /^\/__vibe-visual-editor\/([a-z]+)(?:\?.*)?$/;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Expected application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** What a host's index answers; the API layer validates the requests. */
export interface ApiHandlers {
  health(): HealthResponse;
  resolve(req: ResolveRequest): ResolveResponse;
  /** Literals of `code` analyzed as `file`. Throws an HttpError for code that can't be analyzed. */
  analyze(file: string, code: string): LiteralEntry[];
}

async function handle(req: IncomingMessage, res: ServerResponse, route: string, handlers: ApiHandlers): Promise<void> {
  if (route === 'health' && req.method === 'GET') return sendJson(res, 200, handlers.health());
  if (route === 'resolve' && req.method === 'POST') {
    const parsed = ResolveRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, formatIssues(parsed.error));
    return sendJson(res, 200, handlers.resolve(parsed.data));
  }
  if (route === 'analyze' && req.method === 'POST') {
    const parsed = AnalyzeRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, formatIssues(parsed.error));
    if (!path.isAbsolute(parsed.data.file)) throw new HttpError(400, 'file must be absolute');
    const body: AnalyzeResponse = { literals: handlers.analyze(parsed.data.file, parsed.data.code) };
    return sendJson(res, 200, body);
  }
  throw new HttpError(404, `Unknown endpoint ${req.method} /__vibe-visual-editor/${route}`);
}

/** Serves `/__vibe-visual-editor/<route>`. Returns false, leaving `res` alone, when the request is for something else. */
export function serveApi(req: IncomingMessage, res: ServerResponse, handlers: ApiHandlers): boolean {
  const match = API_ROUTE.exec(req.url ?? '');
  if (!match) return false;
  handle(req, res, match[1]!, handlers).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
  });
  return true;
}

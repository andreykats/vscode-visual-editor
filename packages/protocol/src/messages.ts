import * as z from 'zod/mini';
import { PROTOCOL_VERSION } from './version';

const PATH_MAX = 4096;
const TEXT_MAX = 10_000;

const str = (max: number, min = 0) => z.string().check(z.minLength(min), z.maxLength(max));
const offset = z.int().check(z.nonnegative());
const position = z.int().check(z.positive());
const array = <T extends z.ZodMiniType>(item: T, max: number, min = 0) => z.array(item).check(z.minLength(min), z.maxLength(max));

/** One-line summary of a validation failure. */
export function formatIssues(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message)).join('; ');
}

export const ModeSchema = z.enum(['browse', 'edit', 'select']);
export const QuoteSchema = z.enum(["'", '"', '`', 'jsx', 'jsx-attr', 'html']);


export const SourceLocSchema = z.object({
  file: str(PATH_MAX, 1),
  rel: str(PATH_MAX),
  line: position,
  column: position,
  start: offset,
  end: offset,
});

export const LiteralEntrySchema = z.extend(SourceLocSchema, {
  id: str(PATH_MAX + 32, 1),
  value: str(TEXT_MAX),
  raw: str(TEXT_MAX * 6 + 2),
  quote: QuoteSchema,
  owner: z.optional(offset),
  binding: z.optional(str(256)),
});

export const CandidateSchema = z.extend(LiteralEntrySchema, {
  ordinal: offset,
  sameValueCount: position,
  uses: position,
});

export const ResolveRequestSchema = z.object({
  text: str(TEXT_MAX),
  elementLoc: z.optional(SourceLocSchema),
});

export const ResolveResponseSchema = z.object({
  editable: z.boolean(),
  candidates: z.array(CandidateSchema),
});

export const AnalyzeRequestSchema = z.object({
  file: str(PATH_MAX, 1),
  code: str(5_000_000),
});

export const AnalyzeResponseSchema = z.object({
  literals: z.array(LiteralEntrySchema),
});

export const HealthResponseSchema = z.object({
  protocolVersion: z.int(),
  adapters: z.array(z.string()),
  root: z.string(),
});

export const DevServerInfoSchema = z.object({
  url: z.url(),
  root: str(PATH_MAX, 1),
  pid: position,
  protocolVersion: z.int(),
});

export const ElementDescriptorSchema = z.object({
  tag: str(64),
  id: z.optional(str(256)),
  classList: array(str(256), 32),
  testId: z.optional(str(256)),
  attributes: z.record(str(64), str(512)),
  textContent: str(300),
  selector: str(1024),
  outerHTML: str(2048),
  boundingRect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  styles: z.record(str(64), str(256)),
  creationSite: z.optional(SourceLocSchema),
  creationSiteIsAncestor: z.boolean(),
  editableText: z.optional(z.object({ value: str(TEXT_MAX), rel: str(PATH_MAX), line: position, column: position })),
  pageUrl: str(PATH_MAX),
  route: str(2048),
  timestamp: z.number(),
});

export const PendingEditSchema = z.object({
  literalId: str(PATH_MAX + 32),
  value: str(TEXT_MAX),
  original: str(TEXT_MAX),
});

const v = z.literal(PROTOCOL_VERSION);
const requestId = offset;

/** Messages the page client sends to the webview (and on to the extension). */
export const PageMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('le:hello'), v, url: str(PATH_MAX), title: str(512) }),
  /** Sent once the page accepted the handshake; until then the preview is not connected. */
  z.object({ type: z.literal('le:ready'), v, url: str(PATH_MAX) }),
  z.object({ type: z.literal('le:location'), v, url: str(PATH_MAX) }),
  z.object({
    type: z.literal('le:edit'),
    v,
    requestId,
    candidates: array(CandidateSchema, 50, 1),
    newValue: str(TEXT_MAX),
  }),
  z.object({ type: z.literal('le:select'), v, descriptor: ElementDescriptorSchema }),
  z.object({ type: z.literal('le:clearSelection'), v }),
  z.object({ type: z.literal('le:key'), v, action: z.enum(['save', 'undo', 'redo']) }),
  z.object({ type: z.literal('le:error'), v, message: str(2000) }),
]);

/** Messages the webview sends to the page client. */
export const HostMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('le:ack'), v }),
  z.object({ type: z.literal('le:setMode'), v, mode: ModeSchema }),
  z.object({ type: z.literal('le:editApplied'), v, requestId, literalId: z.string(), value: z.string() }),
  z.object({ type: z.literal('le:editRejected'), v, requestId, reason: str(2000) }),
  z.object({ type: z.literal('le:pending'), v, edits: z.array(PendingEditSchema) }),
  z.object({ type: z.literal('le:saved'), v, literalIds: z.array(z.string()) }),
  z.object({ type: z.literal('le:clearSelection'), v }),
]);

/** Loose shape used to detect a version mismatch before full validation. */
export const EnvelopeSchema = z.object({ type: z.string().check(z.startsWith('le:')), v: z.number() });

export type PageMessage = z.infer<typeof PageMessageSchema>;
export type HostMessage = z.infer<typeof HostMessageSchema>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A message without its `v` field; senders add it. */
export type Unversioned<T> = DistributiveOmit<T, 'v'>;

// ---------------------------------------------------------------------------
// Extension bridge (VS Code window <-> vibe-visual-editor-mcp stdio process)
// ---------------------------------------------------------------------------

/** One file per VS Code window in `~/.vibe-visual-editor/windows/<pid>.json`. */
export const WindowEntrySchema = z.object({
  pid: position,
  port: z.int().check(z.minimum(1), z.maximum(65535)),
  token: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
  workspaceFolders: z.array(z.string()),
  focusedAt: z.number(),
  protocolVersion: z.int(),
});
export type WindowEntry = z.infer<typeof WindowEntrySchema>;

export const OpenRequestSchema = z.object({
  url: z.optional(str(PATH_MAX)),
  path: z.optional(str(2048)),
  mode: z.optional(ModeSchema),
});
export type OpenRequest = z.infer<typeof OpenRequestSchema>;

export const OpenResponseSchema = z.union([
  z.object({ ok: z.literal(true), url: z.string(), link: z.string(), note: z.optional(z.string()) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type OpenResponse = z.infer<typeof OpenResponseSchema>;

export const SelectionResponseSchema = z.object({
  selection: z.nullable(ElementDescriptorSchema),
  previewUrl: z.nullable(z.string()),
});
export type SelectionResponse = z.infer<typeof SelectionResponseSchema>;

export const PreviewStatusSchema = z.enum(['connecting', 'connected', 'plugin-missing', 'protocol-mismatch']);
export type PreviewStatus = z.infer<typeof PreviewStatusSchema>;

export const StateResponseSchema = z.object({
  previews: z.array(
    z.object({
      url: z.string(),
      mode: ModeSchema,
      status: PreviewStatusSchema,
      pendingEdits: z.int(),
      active: z.boolean(),
    }),
  ),
  devServers: z.array(z.object({ url: z.string(), root: z.string(), running: z.boolean() })),
});
export type StateResponse = z.infer<typeof StateResponseSchema>;

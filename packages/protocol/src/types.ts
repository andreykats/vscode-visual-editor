/**
 * How a literal is written: a JS string with that quote, `'jsx'` for JSX text
 * (`<p>Hello</p>`), `'jsx-attr'` for a JSX attribute string (`title="Hi"`), or
 * `'html'` for text in an HTML page.
 */
export type Quote = "'" | '"' | '`' | 'jsx' | 'jsx-attr' | 'html';
export type Mode = 'browse' | 'edit' | 'select';

export interface Span {
  start: number;
  end: number;
}

/** A source location. Offsets are UTF-16 code units into the original module source. */
export interface SourceLoc extends Span {
  /** Absolute path. */
  file: string;
  /** Path relative to the dev server root, with forward slashes. */
  rel: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

/** One string literal, substitution-free template literal, JSX text, or HTML text in a source file. */
export interface LiteralEntry extends SourceLoc {
  /** `${file}:${start}`; stable until the module is re-indexed. */
  id: string;
  /** Cooked value. */
  value: string;
  /** Source text, including quotes for strings. */
  raw: string;
  quote: Quote;
  /** Start offset of the element-creation site that takes this literal as a direct child, if any. */
  owner?: number;
  /** Set when the literal initializes a `const NAME = …` binding. */
  binding?: string;
}

/** A resolved literal as sent to the page and the extension. */
export interface Candidate extends LiteralEntry {
  /** Index among literals in this file with the same value and quote, in source order. */
  ordinal: number;
  /** How many literals in this file share the value and quote. */
  sameValueCount: number;
  /** How many places read this literal (more than 1 for a shared constant). */
  uses: number;
}

export interface ResolveRequest {
  text: string;
  elementLoc?: SourceLoc;
}

export interface ResolveResponse {
  /** True when there is at least one candidate. */
  editable: boolean;
  /** The best-ranked candidates. More than one means the user must choose. */
  candidates: Candidate[];
}

export interface AnalyzeRequest {
  file: string;
  code: string;
}

export interface AnalyzeResponse {
  literals: LiteralEntry[];
}

export interface HealthResponse {
  protocolVersion: number;
  adapters: string[];
  root: string;
}

/** Written by the Vite plugin to `<root>/.vibe-visual-editor/server.json`. */
export interface DevServerInfo {
  url: string;
  root: string;
  pid: number;
  protocolVersion: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the agent sees about a selected element. Every field is size-bounded by the schema. */
export interface ElementDescriptor {
  tag: string;
  id?: string;
  classList: string[];
  testId?: string;
  attributes: Record<string, string>;
  textContent: string;
  selector: string;
  outerHTML: string;
  boundingRect: Rect;
  styles: Record<string, string>;
  creationSite?: SourceLoc;
  /** True when `creationSite` belongs to the nearest tagged ancestor, not the element itself. */
  creationSiteIsAncestor: boolean;
  editableText?: { value: string; rel: string; line: number; column: number };
  pageUrl: string;
  route: string;
  timestamp: number;
}

export interface PendingEdit {
  literalId: string;
  value: string;
  original: string;
}

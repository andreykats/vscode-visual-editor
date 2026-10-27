import { decodeHTML } from 'entities';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { Candidate, LiteralEntry, ResolveRequest, ResolveResponse, SourceLoc, Span } from '@vibe-visual-editor/protocol';
import { lineStarts, positionAt, toRel } from './text';

type ParentNode = DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];
type Template = DefaultTreeAdapterMap['template'];
type TextNode = DefaultTreeAdapterMap['textNode'];

/** An element written in the page, and where its `data-vve-loc` attribute goes (right after its name). */
export interface HtmlCreationSite extends SourceLoc {
  attributeAt: number;
}

export interface HtmlAnalysis {
  literals: LiteralEntry[];
  creationSites: HtmlCreationSite[];
  /** Where a host's own `<script>` goes: after `<head>`, else after `<html>`, else after the doctype. */
  injectAt: number;
}

/** Elements whose content isn't page text: raw text, RCDATA, and text the page never shows as text nodes. */
const NOT_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
/** Elements that never show anything, so they aren't tagged. */
const UNTAGGED = new Set(['script', 'style']);
/** A start tag's `<` and name, as written. */
const TAG_NAME = /<[^\s/>]+/y;

/** Pages: Vite serves them through `transformIndexHtml`, and the extension's static server serves them itself. */
export function isHtml(file: string): boolean {
  return file.endsWith('.html');
}

/**
 * Indexes the text of an HTML page as parsed by a browser (parse5 follows the
 * HTML spec). Each element written in the page's `<body>` is a creation site,
 * tagged with a `data-vve-loc` attribute, and each text node is a literal owned
 * by its element. A text node is indexed only if its source decodes to exactly
 * its DOM text, which `htmlTextRaw` relies on when it writes an edit back; text
 * the parser moved or rewrote is left alone.
 */
export function analyzeHtml(file: string, html: string, root: string): HtmlAnalysis {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const starts = lineStarts(html);
  const rel = toRel(root, file);
  const loc = (span: Span): SourceLoc => ({ file, rel, ...positionAt(starts, span.start), start: span.start, end: span.end });
  const literals: LiteralEntry[] = [];
  const creationSites: HtmlCreationSite[] = [];

  /** Tags an element written in the source; returns its start offset, which its text uses as owner. */
  const tag = (el: Element): number | undefined => {
    const where = el.sourceCodeLocation;
    if (!where?.startTag || UNTAGGED.has(el.tagName)) return undefined;
    TAG_NAME.lastIndex = where.startTag.startOffset;
    const name = TAG_NAME.exec(html);
    if (!name) return undefined;
    creationSites.push({ ...loc({ start: where.startOffset, end: where.endOffset }), attributeAt: name.index + name[0].length });
    return where.startOffset;
  };

  const addText = (node: TextNode, owner: number) => {
    const where = node.sourceCodeLocation;
    if (!where || node.value.trim() === '') return;
    const raw = html.slice(where.startOffset, where.endOffset);
    if (decodeHTML(raw.replace(/\r\n?/g, '\n')) !== node.value) return;
    literals.push({ id: `${file}:${where.startOffset}`, ...loc({ start: where.startOffset, end: where.endOffset }), value: node.value, raw, quote: 'html', owner });
  };

  /** `owner`: the creation site of `parent`, if it has one. Text is only ever resolved through the element around it. */
  const visit = (parent: ParentNode, owner: number | undefined) => {
    for (const node of parent.childNodes) {
      if (node.nodeName === '#text') {
        if (owner !== undefined) addText(node as TextNode, owner);
      } else if ('tagName' in node) {
        const site = tag(node);
        if (NOT_TEXT.has(node.tagName)) continue;
        // Text at the top of a template ends up in whatever element a script clones it into.
        if (node.tagName === 'template') visit((node as Template).content, undefined);
        else visit(node, site);
      }
    }
  };

  const htmlElement = document.childNodes.find((n): n is Element => n.nodeName === 'html');
  const head = htmlElement?.childNodes.find((n): n is Element => n.nodeName === 'head');
  const body = htmlElement?.childNodes.find((n): n is Element => n.nodeName === 'body');
  if (body) visit(body, tag(body));

  const doctype = document.childNodes.find((n) => n.nodeName === '#documentType');
  const injectAt =
    head?.sourceCodeLocation?.startTag?.endOffset ??
    htmlElement?.sourceCodeLocation?.startTag?.endOffset ??
    doctype?.sourceCodeLocation?.endOffset ??
    0;
  return { literals, creationSites, injectAt };
}

interface Page {
  literals: LiteralEntry[];
  /** Owner (element start offset) -> the text nodes directly inside it. */
  byOwner: Map<number, LiteralEntry[]>;
}

const NOT_EDITABLE: ResolveResponse = { editable: false, candidates: [] };

/** The text of every page served so far, re-indexed each time a page is served. */
export class HtmlIndex {
  private readonly pages = new Map<string, Page>();

  constructor(readonly root: string) {}

  update(file: string, html: string): HtmlAnalysis {
    const analysis = analyzeHtml(file, html, this.root);
    const byOwner = new Map<number, LiteralEntry[]>();
    for (const lit of analysis.literals) {
      const list = byOwner.get(lit.owner!) ?? [];
      list.push(lit);
      byOwner.set(lit.owner!, list);
    }
    this.pages.set(file, { literals: analysis.literals, byOwner });
    return analysis;
  }

  remove(file: string): void {
    this.pages.delete(file);
  }

  has(file: string): boolean {
    return this.pages.has(file);
  }

  /** Literals of `html` analyzed as `file`, without touching the index. */
  analyze(file: string, html: string): LiteralEntry[] {
    return analyzeHtml(file, html, this.root).literals;
  }

  /** Text in a page shows only inside the element written around it, so that element's `elementLoc` is required. */
  resolve({ text, elementLoc }: ResolveRequest): ResolveResponse {
    const page = elementLoc && this.pages.get(elementLoc.file);
    if (!page || text.trim() === '') return NOT_EDITABLE;
    const matches = (page.byOwner.get(elementLoc.start) ?? []).filter((lit) => lit.value === text);
    if (matches.length === 0) return NOT_EDITABLE;
    const same = page.literals.filter((lit) => lit.value === text);
    const candidates = matches.map((lit): Candidate => ({ ...lit, ordinal: same.indexOf(lit), sameValueCount: same.length, uses: 1 }));
    return { editable: true, candidates };
  }
}

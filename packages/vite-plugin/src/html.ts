import { decodeHTML } from 'entities';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { LiteralEntry, SourceLoc, Span } from '@vibe-visual-editor/protocol';
import { rankByOwner } from './adapters/rank';
import { lineStarts, positionAt } from './ast';
import type { CreationSiteLoc, ModuleAnalysis } from './indexer';
import { toRel } from './paths';

type ParentNode = DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];
type Template = DefaultTreeAdapterMap['template'];
type TextNode = DefaultTreeAdapterMap['textNode'];

/** Elements whose content isn't page text: raw text, RCDATA, and text the page never shows as text nodes. */
const NOT_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
/** Elements that never show anything, so they aren't tagged. */
const UNTAGGED = new Set(['script', 'style']);
/** A start tag's `<` and name, as written. */
const TAG_NAME = /<[^\s/>]+/y;

/**
 * Indexes the text of an HTML page as parsed by a browser (parse5 follows the
 * HTML spec). Each element written in the page's `<body>` is a creation site,
 * tagged with a `data-vve-loc` attribute, and each text node is a literal owned
 * by its element. A text node is indexed only if its source decodes to exactly
 * its DOM text, which `htmlTextRaw` relies on when it writes an edit back; text
 * the parser moved or rewrote is left alone.
 */
export function analyzeHtml(file: string, html: string, root: string): Omit<ModuleAnalysis, 'headerAt'> {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const starts = lineStarts(html);
  const rel = toRel(root, file);
  const loc = (span: Span): SourceLoc => ({ file, rel, ...positionAt(starts, span.start), start: span.start, end: span.end });
  const literals: LiteralEntry[] = [];
  const creationSites: CreationSiteLoc[] = [];

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
  const body = htmlElement?.childNodes.find((n): n is Element => n.nodeName === 'body');
  if (body) visit(body, tag(body));

  return {
    record: { file, rel, rank: rankByOwner, literals, refs: new Map(), exportsByLocal: new Map(), imports: [] },
    creationSites,
  };
}

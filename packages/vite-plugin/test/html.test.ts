import { htmlTextRaw, type LiteralEntry } from '@vibe-visual-editor/protocol';
import MagicString from 'magic-string';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { describe, expect, it } from 'vitest';
import { analyzeHtml } from '../src/html';
import { SourceIndex } from '../src/sourceIndex';

type Node = DefaultTreeAdapterMap['node'];

const root = '/proj';
const file = `${root}/index.html`;
const page = (body: string) => `<!doctype html>\n<html>\n<head><title>T</title></head>\n<body>\n${body}\n</body>\n</html>\n`;
const analyze = (html: string) => analyzeHtml(file, html, root);
const texts = (html: string) => analyze(html).record.literals.map((l) => l.value);

/** Text of every text node a browser would build from `html`, in document order. */
function domTexts(html: string): string[] {
  const out: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeName === '#text') out.push((node as DefaultTreeAdapterMap['textNode']).value);
    for (const child of 'childNodes' in node ? node.childNodes : []) visit(child);
  };
  visit(parse(html));
  return out;
}

describe('analyzeHtml', () => {
  it('indexes body text with its exact source span, decoded value, line and column', () => {
    const html = page('  <h1>\n    Welcome\n  </h1>\n  <p>Tom &amp; Jerry &copy; 2026</p>');
    const lits = analyze(html).record.literals;
    expect(lits.map((l) => [l.value, l.raw, l.quote, l.line, l.column])).toEqual([
      ['\n    Welcome\n  ', '\n    Welcome\n  ', 'html', 5, 7],
      ['Tom & Jerry © 2026', 'Tom &amp; Jerry &copy; 2026', 'html', 8, 6],
    ]);
    for (const l of lits) expect(html.slice(l.start, l.end)).toBe(l.raw);
  });

  it('owns each text by the element around it, which is tagged as a creation site', () => {
    const html = page('<p>One <b>two</b> three</p>');
    const { record, creationSites } = analyze(html);
    const [p, b] = creationSites.filter((s) => html.startsWith('<p>', s.start) || html.startsWith('<b>', s.start));
    expect(record.literals.map((l) => [l.value, l.owner])).toEqual([
      ['One ', p!.start],
      ['two', b!.start],
      [' three', p!.start],
    ]);
    expect(html.slice(p!.start, p!.end)).toBe('<p>One <b>two</b> three</p>');
  });

  it('tags body elements right after their name, as written, and nothing in <head>', () => {
    const html = page('<DIV class="a">x</DIV><br/><svg viewBox="0 0 1 1"><foreignObject>y</foreignObject></svg><image src="i.png">\n<script>1</script>');
    const s = new MagicString(html);
    for (const site of analyze(html).creationSites) s.appendLeft(site.attributeAt!, ' data-t');
    const out = s.toString();
    expect(out).toContain('<body data-t>');
    expect(out).toContain('<DIV data-t class="a">');
    expect(out).toContain('<br data-t/>');
    expect(out).toContain('<svg data-t viewBox="0 0 1 1"><foreignObject data-t>');
    expect(out).toContain('<image data-t src="i.png">');
    expect(out).toContain('<script>1</script>');
    expect(out).toContain('<head><title>T</title></head>');
    // Still the same document, with the attribute on every tagged element.
    expect(domTexts(out)).toEqual(domTexts(html));
  });

  it('skips scripts, styles, form fields, titles and whitespace-only text', () => {
    expect(texts(page('<script>let a = "x";</script><style>p{}</style><textarea>t</textarea><noscript>n</noscript>\n  <p>kept</p>'))).toEqual(['kept']);
  });

  it('indexes template content, which scripts clone into the page', () => {
    expect(texts(page('<template><p>From a template</p>loose</template>'))).toEqual(['From a template']);
  });

  it('skips text whose source the parser changes on the way to the DOM', () => {
    // The parser drops the first line break in <pre>, so the source has one more than the DOM.
    expect(texts(page('<pre>\n\ncode</pre>'))).toEqual([]);
    expect(texts(page('<pre>\ncode</pre>'))).toEqual(['code']);
    // NUL is dropped in body text.
    expect(texts(page('<p>a\u0000b</p>'))).toEqual([]);
    // Text the parser moves out of a table, in front of it.
    expect(texts(page('<table>moved<tr><td>cell</td></tr></table>'))).toEqual(['cell']);
  });

  it('decodes references exactly as the parser does', () => {
    expect(texts(page('<p>&notit; &amp &#128; &#x1F600; &lt;b&gt;</p>'))).toEqual(['¬it; & € 😀 <b>']);
  });

  it('normalizes CRLF line breaks like the parser', () => {
    const lits = analyze(page('<p>a\r\nb</p>')).record.literals;
    expect(lits.map((l) => [l.value, l.raw])).toEqual([['a\nb', 'a\r\nb']]);
  });

  it('owns nothing in a body the parser implied, so that text is not editable', () => {
    expect(analyze('<p>tagged</p>loose').record.literals.map((l) => l.value)).toEqual(['tagged']);
  });
});

describe('htmlTextRaw against the HTML parser', () => {
  const VALUES = [
    'Hello',
    '\n    Indented\n  ',
    'Tom & Jerry',
    'AT&T',
    '&amp; written out',
    '&copy',
    '&#169;',
    '1 < 2 and 3 > 2',
    '</p> not a tag',
    '<!-- not a comment -->',
    'a\rb\r\nc',
    'non breaking',
    'emoji 😀 and é',
    'line\nbreak',
  ];

  it.each(VALUES)('%j reads back as itself, in the DOM and in the index', (value) => {
    const html = page(`<p>${htmlTextRaw(value)}</p>`);
    expect(domTexts(html)).toContain(value);
    expect(texts(html)).toEqual([value]);
  });

  it('round-trips the source of every indexed text', () => {
    const html = page('<p>Tom &amp; Jerry &copy; 2026 &lt;3</p><p>\n  Q&amp;A\n</p>');
    for (const l of analyze(html).record.literals) {
      const rewritten = html.slice(0, l.start) + htmlTextRaw(l.value) + html.slice(l.end);
      expect(domTexts(rewritten)).toEqual(domTexts(html));
    }
  });
});

describe('SourceIndex with HTML pages', () => {
  const html = page('<ul>\n<li>Home</li>\n<li>Home</li>\n</ul>');
  const index = new SourceIndex(root, []);
  const { creationSites } = index.updateHtml(file, html);
  const items = creationSites.filter((s) => html.startsWith('<li', s.start));
  const elementLoc = (start: number) => creationSites.find((s) => s.start === start)!;

  it('resolves text to the literal inside the element showing it', () => {
    const res = index.resolve({ text: 'Home', elementLoc: elementLoc(items[1]!.start) });
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]).toMatchObject({ quote: 'html', owner: items[1]!.start, ordinal: 1, sameValueCount: 2 });
  });

  it('never offers HTML text for an element it is not written in', () => {
    expect(index.resolve({ text: 'Home' }).editable).toBe(false);
    const other = index.updateHtml(`${root}/about.html`, page('<p>Elsewhere</p>'));
    expect(index.resolve({ text: 'Home', elementLoc: other.creationSites.at(-1)! }).editable).toBe(false);
  });

  it('analyzes a detached page by its extension', () => {
    const lits: LiteralEntry[] = index.analyzeDetached(`${root}/x.html`, page('<p>Draft</p>'));
    expect(lits.map((l) => [l.value, l.quote])).toEqual([['Draft', 'html']]);
  });
});

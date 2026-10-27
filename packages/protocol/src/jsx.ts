import { escapeLiteral } from './escape';

/**
 * JSX text (`<p>Hello</p>`) and JSX attribute strings (`<Card title="Hi" />`):
 * how the JSX compiler turns their source into the rendered string ("cooking"),
 * and how to write a string back. Cooking matches oxc's JSX transform, which is
 * what Vite uses. Where JSX compilers disagree (tabs, entities that encode
 * whitespace, named entities outside the table below, line breaks in
 * attributes), cooking returns null and the text is never offered for editing.
 */

/** Common named character references and their code points. Others are treated as unknown. */
const NAMED: Readonly<Record<string, number>> = {
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, nbsp: 160, ensp: 8194, emsp: 8195, thinsp: 8201,
  zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, shy: 173, copy: 169, reg: 174, trade: 8482,
  hellip: 8230, mdash: 8212, ndash: 8211, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220,
  rdquo: 8221, bdquo: 8222, laquo: 171, raquo: 187, lsaquo: 8249, rsaquo: 8250, bull: 8226,
  middot: 183, times: 215, divide: 247, deg: 176, plusmn: 177, minus: 8722, euro: 8364, pound: 163,
  yen: 165, cent: 162, sect: 167, para: 182, iexcl: 161, iquest: 191, frac12: 189, frac14: 188,
  frac34: 190, sup1: 185, sup2: 178, sup3: 179, micro: 181, prime: 8242, Prime: 8243, infin: 8734,
  ne: 8800, le: 8804, ge: 8805, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596,
  hearts: 9829, spades: 9824, clubs: 9827, diams: 9830,
};

/** Code points that JSX compilers may trim or collapse when decoded from an entity. */
const WHITESPACE = new Set([9, 10, 11, 12, 13, 32]);

const ENTITY = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g;
/** An `&` that a JSX parser would read as the start of a character reference. */
const ENTITY_START = /&(?=#\d+;|#[xX][0-9a-fA-F]+;|[A-Za-z][A-Za-z0-9]*;)/g;
/** Characters JSX text can't hold literally. */
const NOT_IN_TEXT = /[<>{}]/g;
const TEXT_ESCAPES: Readonly<Record<string, string>> = { '<': '&lt;', '>': '&gt;', '{': '&#123;', '}': '&#125;' };
/** Characters that JSX source can't carry faithfully: tabs and line breaks. */
const UNREPRESENTABLE = /[\t\r\n\u2028\u2029]/;

function decodeEntities(s: string): string | null {
  let ok = true;
  const out = s.replace(ENTITY, (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : hex !== undefined ? Number.parseInt(hex, 16) : NAMED[name!];
    if (cp === undefined || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || WHITESPACE.has(cp)) {
      ok = false;
      return match;
    }
    return String.fromCodePoint(cp);
  });
  return ok ? out : null;
}

/**
 * The string a JSX text child renders as. Lines are trimmed of spaces and tabs
 * (except before the first line and after the last), whitespace-only lines are
 * dropped, the rest are joined with one space, and entities are decoded.
 */
export function cookJsxText(raw: string): string | null {
  const lines = raw.split(/\r\n|\n|\r/);
  const last = lines.length - 1;
  const parts: string[] = [];
  for (let i = 0; i <= last; i++) {
    let line = lines[i]!;
    if (i > 0) line = line.replace(/^[ \t]+/, '');
    if (i < last) line = line.replace(/[ \t]+$/, '');
    // Tabs inside the text, and other whitespace at a trimmed edge, are handled differently by different compilers.
    if (line.includes('\t')) return null;
    if ((i > 0 && /^\s/.test(line)) || (i < last && /\s$/.test(line))) return null;
    if (line) parts.push(line);
  }
  return decodeEntities(parts.join(' '));
}

/** The string a JSX attribute value (the text between its quotes) renders as. */
export function cookJsxAttribute(inner: string): string | null {
  if (UNREPRESENTABLE.test(inner)) return null;
  return decodeEntities(inner);
}

/** `value` as a JS string in a JSX expression container, for what JSX text and attributes can't hold. */
const asExpression = (value: string) => `{${escapeLiteral(value, "'")}}`;

/**
 * Source for a JSX text child that renders as `value`. When `value` has no
 * leading or trailing whitespace, the line breaks and indentation around
 * `original` are kept. Values with tabs or line breaks become `{'…'}`.
 */
export function jsxTextRaw(value: string, original: string): string {
  if (value === '' || UNREPRESENTABLE.test(value)) return asExpression(value);
  const core = value.replace(ENTITY_START, '&amp;').replace(NOT_IN_TEXT, (c) => TEXT_ESCAPES[c]!);
  if (value !== value.trim() || original.trim() === '') return core;
  const lead = /^\s*/.exec(original)![0];
  const trail = /\s*$/.exec(original)![0];
  return (/[\r\n]/.test(lead) ? lead : '') + core + (/[\r\n]/.test(trail) ? trail : '');
}

/**
 * Source for a JSX attribute value that renders as `value`, keeping
 * `original`'s quote style when it can. Falls back to `{'…'}`.
 */
export function jsxAttributeRaw(value: string, original: string): string {
  if (UNREPRESENTABLE.test(value)) return asExpression(value);
  const body = value.replace(ENTITY_START, '&amp;');
  const preferred = original.startsWith("'") ? ["'", '"'] : ['"', "'"];
  const quote = preferred.find((q) => !body.includes(q));
  return quote ? quote + body + quote : asExpression(value);
}

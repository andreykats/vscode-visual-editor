/**
 * Text in an HTML page (`<p>Hello</p>` in an `.html` file). The parser
 * decodes character references and turns CR and CRLF into LF; everything
 * else, whitespace included, is the text node's data exactly as written.
 * Reading it is the HTML parser's job (the Vite plugin uses parse5); this is
 * the way back.
 */

/** An `&` that the parser could read as the start of a character reference, legacy ones without `;` included. */
const AMBIGUOUS_AMPERSAND = /&(?=[#A-Za-z0-9])/g;
const SPECIAL = /[<\r ]/g;
const ESCAPES: Readonly<Record<string, string>> = { '<': '&lt;', '\r': '&#13;', ' ': '&nbsp;' };

/**
 * Source for HTML text that the parser reads back as `value`. `<` becomes
 * `&lt;`, an `&` becomes `&amp;` only where it could start a character
 * reference, a CR becomes `&#13;` (the parser would turn a raw one into LF),
 * and a non-breaking space becomes `&nbsp;` so it stays visible in the source.
 * Line breaks and indentation are written as they are.
 */
export function htmlTextRaw(value: string): string {
  return value.replace(AMBIGUOUS_AMPERSAND, '&amp;').replace(SPECIAL, (c) => ESCAPES[c]!);
}

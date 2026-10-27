import MagicString from 'magic-string';
import { LOC_ATTRIBUTE, type ClientConfig, type SourceLoc } from '@vibe-visual-editor/protocol';
import type { HtmlCreationSite } from './html';

/** A JS string literal that is also safe inside an inline `<script>`. */
export const jsString = (s: string) => JSON.stringify(s).replace(/</g, '\\u003c');

/** The ` data-vve-loc="…"` attribute that carries a creation site into the DOM. */
export const locAttribute = (token: string, site: SourceLoc) => ` ${LOC_ATTRIBUTE}="${token}:${site.start}:${site.end}:${site.line}:${site.column}"`;

/** `html` with a `data-vve-loc` attribute on each of its creation sites, and `insert.text` at `insert.at`. */
export function tagPage(html: string, sites: readonly HtmlCreationSite[], token: string, insert?: { at: number; text: string }): string {
  if (sites.length === 0 && !insert) return html;
  const s = new MagicString(html);
  for (const site of sites) s.appendLeft(site.attributeAt, locAttribute(token, site));
  if (insert) s.appendLeft(insert.at, insert.text);
  return s.toString();
}

/** The inline module a host puts in each page: it loads the page client from `specifier` and starts it. */
export function clientScript(specifier: string, config: ClientConfig): string {
  return `import { start } from ${jsString(specifier)};\nstart(${JSON.stringify(config).replace(/</g, '\\u003c')});`;
}

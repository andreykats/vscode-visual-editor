import { escapeLiteral } from './escape';
import { htmlTextRaw } from './html';
import { jsxAttributeRaw, jsxTextRaw } from './jsx';
import type { Quote } from './types';

/** Source for a literal of kind `quote` that renders as `value`. `original` is the literal's source as it was indexed. */
export function literalRaw(value: string, quote: Quote, original: string): string {
  if (quote === 'jsx') return jsxTextRaw(value, original);
  if (quote === 'jsx-attr') return jsxAttributeRaw(value, original);
  if (quote === 'html') return htmlTextRaw(value);
  return escapeLiteral(value, quote);
}

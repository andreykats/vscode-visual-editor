import { describe, expect, it } from 'vitest';
import { htmlTextRaw, literalRaw } from '../src';

describe('htmlTextRaw', () => {
  it('writes plain text, line breaks and indentation as they are', () => {
    expect(htmlTextRaw('Hello')).toBe('Hello');
    expect(htmlTextRaw('\n    Hello\n  ')).toBe('\n    Hello\n  ');
    expect(htmlTextRaw('a > b, "quoted" and \'single\'')).toBe('a > b, "quoted" and \'single\'');
  });

  it('escapes < always and & only where it could start a character reference', () => {
    expect(htmlTextRaw('1 < 2 <b>')).toBe('1 &lt; 2 &lt;b>');
    expect(htmlTextRaw('Tom & Jerry')).toBe('Tom & Jerry');
    expect(htmlTextRaw('AT&T &amp; &#32; &copy')).toBe('AT&amp;T &amp;amp; &amp;#32; &amp;copy');
    expect(htmlTextRaw('trailing &')).toBe('trailing &');
  });

  it('keeps characters the parser would change, or that are invisible, as references', () => {
    expect(htmlTextRaw('a\rb\r\nc')).toBe('a&#13;b&#13;\nc');
    expect(htmlTextRaw('10 km')).toBe('10&nbsp;km');
  });
});

describe('literalRaw', () => {
  it('writes html literals as HTML text', () => {
    expect(literalRaw('Q&A <3', 'html', 'old')).toBe('Q&amp;A &lt;3');
  });
});

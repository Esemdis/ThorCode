import { describe, it, expect } from 'vitest';
import { escapeHtml, safeHref } from './html.js';

describe('escapeHtml', () => {
  it('neutralises markup', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(escapeHtml("Guns N' Roses & friends")).toBe('Guns N&#39; Roses &amp; friends');
    expect(escapeHtml(null)).toBe('');
  });
});

describe('safeHref', () => {
  it('keeps http and https links', () => {
    expect(safeHref('https://www.songkick.com/concerts/1')).toBe('https://www.songkick.com/concerts/1');
  });

  it('drops anything a click should not run', () => {
    expect(safeHref('javascript:alert(1)')).toBe(null);
    expect(safeHref('data:text/html,<b>')).toBe(null);
    expect(safeHref('not a url')).toBe(null);
  });
});

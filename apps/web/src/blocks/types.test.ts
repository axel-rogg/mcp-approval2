/**
 * Tests fuer DOM-Helpers in blocks/types.ts — Fokus: SEC-021 URL-Scheme-Check.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { el, isSafeUrl } from './types.js';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('isSafeUrl — SEC-021', () => {
  it('akzeptiert https/http', () => {
    expect(isSafeUrl('https://example.com')).toBe(true);
    expect(isSafeUrl('http://localhost:8080')).toBe(true);
  });

  it('akzeptiert relative paths', () => {
    expect(isSafeUrl('/foo')).toBe(true);
    expect(isSafeUrl('./foo')).toBe(true);
    expect(isSafeUrl('foo/bar')).toBe(true);
  });

  it('rejected dangerous schemes', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('JavaScript:alert(1)')).toBe(false);
    expect(isSafeUrl('  javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,<script>')).toBe(false);
    expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeUrl('blob:https://evil/123')).toBe(false);
  });

  it('rejected URL-encoded scheme-injection', () => {
    // `%6A` = 'j' → decoded `javascript:alert(1)` triggers DANGEROUS_SCHEME_RE
    expect(isSafeUrl('%6Aavascript:alert(1)')).toBe(false);
    // Voll-encoded "javascript": j(6a) a(61) v(76) a(61) s(73) c(63) r(72) i(69) p(70) t(74)
    expect(isSafeUrl('%6a%61%76%61%73%63%72%69%70%74:alert(1)')).toBe(false);
  });

  it('rejected non-string + empty', () => {
    expect(isSafeUrl(null)).toBe(false);
    expect(isSafeUrl(undefined)).toBe(false);
    expect(isSafeUrl(42)).toBe(false);
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl('   ')).toBe(false);
  });
});

describe('el() — URL-attr neutralisierung (SEC-021)', () => {
  it('https-href wird gesetzt', () => {
    const a = el('a', { href: 'https://example.com', text: 'go' });
    expect(a.getAttribute('href')).toBe('https://example.com');
  });

  it('javascript:-href wird zu # neutralisiert + warn', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const a = el('a', { href: 'javascript:alert(1)', text: 'click' });
    expect(a.getAttribute('href')).toBe('#');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('rejected unsafe URL'),
    );
  });

  it('data:-src in img wird zu # neutralisiert', () => {
    const img = el('img', { src: 'data:text/html,<script>alert(1)</script>' });
    expect(img.getAttribute('src')).toBe('#');
  });

  it('formaction javascript wird neutralisiert', () => {
    const btn = el('button', { type: 'submit', formaction: 'javascript:alert(1)', text: 'submit' });
    expect(btn.getAttribute('formaction')).toBe('#');
  });

  it('case-insensitive URL-scheme matching', () => {
    // Mixed-case javascript: wird von der case-insensitive regex erkannt.
    const a = el('a', { href: 'JaVaScRiPt:alert(1)' });
    expect(a.getAttribute('href')).toBe('#');
  });

  it('case-insensitive attr-name matching (Href → href)', () => {
    // 'Href' (capital H) → lowercase im URL_ATTRS-Check → muss validiert werden.
    const a = el('a', { Href: 'javascript:alert(1)' } as never);
    // HTML-Attribute sind case-insensitive — Browser/jsdom liefern es als
    // 'href'. Wichtig: der dangerous-Wert darf NICHT durchkommen.
    expect(a.getAttribute('href')).toBe('#');
  });
});
